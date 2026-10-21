import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { policyPacks } from "@tedix/db/schema/control-plane";
import {
	kernelRequests,
	kernelRequestEvents,
} from "@tedix/db/schema/kernel-requests";
import {
	workAttempts,
	workItemComments,
	workItems,
	workEvents,
} from "@tedix/db/schema/work-items";
import { getKernelRequest } from "@tedix/db/queries/kernel-requests";
import type { BaseContext } from "../rpc/orpc";
import {
	captureDispatcherWorkAttempts,
	reconcileWorkAttemptKernelRequest,
	settledCommitShas,
	completeVerifiedDispatcherWork,
} from "./request-work-attempt-source";

const ship = vi.hoisted(() => vi.fn());
vi.mock("./request-target-readers", () => ({
	readConfiguredRepositoryDelivery: ship,
}));
beforeEach(() => {
	ship
		.mockReset()
		.mockImplementation(async (_context, _org, _policy, check) => ({
			mainSha: check.commitSha,
			shipSha: check.commitSha,
			liveSha: check.commitSha,
			shipStatus: "success",
			surface: check.surface,
			evidenceRefs: ["https://github.com/example/ops/actions/runs/1"],
		}));
});

const org = "org-example";
const observerProject = "project-observer";
const policy: KernelRequestPolicy = {
	version: 1,
	enabled: true,
	nextOwner: "kernel-example",
	retryMs: 1000,
	probeTimeoutMs: 1000,
	maxProbeAttempts: 3,
	runBudgetMs: 5000,
	repositoryTargets: [],
	workAttemptDelivery: {
		observerProjectId: observerProject,
		verifyWindowMs: 3_600_000,
	},
};
const sha = (c: string) => c.repeat(40);
const ago = (minutes: number) =>
	new Date(Date.now() - minutes * 60_000).toISOString();

async function fixture(deployedSha: string, workKind = "coding") {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			kernelRequests,
			kernelRequestEvents,
			workItems,
			workAttempts,
			workItemComments,
			workEvents,
			policyPacks,
		),
	);
	// The rendered DDL drops this index's partial WHERE; only live Attempts are unique.
	sqlite.exec("DROP INDEX IF EXISTS uniq_work_attempt_active");
	const db = createDbClient(createD1Facade(sqlite));
	const context = { db, env: { GIT_SHA: deployedSha } } as BaseContext;
	await db.insert(workItems).values({
		id: "work-one",
		orgId: org,
		projectId: "project-work",
		title: "Fix the example",
		workKind: workKind as "coding",
		disposition: "accepted",
		createdAt: ago(120),
	});
	let attemptNumber = 0;
	const attempt = async (
		id: string,
		p: {
			outcome: "succeeded" | "failed";
			startedMinutesAgo: number;
			metadata?: Record<string, unknown>;
		},
	) => {
		await db.insert(workAttempts).values({
			id,
			orgId: org,
			workItemId: "work-one",
			executorType: "external_agent",
			executorId: "agent-example",
			executorSessionId: "session-example",
			externalSessionKey: "codex:example",
			attemptNumber: ++attemptNumber,
			runtimeState: p.outcome === "succeeded" ? "finished" : "failed",
			outcome: p.outcome,
			summary: p.outcome === "failed" ? "exit 1" : "done",
			startedAt: ago(p.startedMinutesAgo),
			heartbeatAt: ago(p.startedMinutesAgo - 5),
			expiresAt: ago(p.startedMinutesAgo - 10),
			finishedAt: ago(p.startedMinutesAgo - 5),
			metadata: { dispatchVersion: 1, ...(p.metadata ?? {}) } as never,
		});
	};
	const push = async (
		id: string,
		head: string,
		minutesAgo: number,
		extra: { commitShas?: string[]; beforeSha?: string } = {},
	) =>
		db.insert(workItems).values({
			id,
			orgId: org,
			projectId: observerProject,
			title: `Commit watch ${head.slice(0, 9)}`,
			createdAt: ago(minutesAgo),
			metadata: {
				repositoryObserver: 1,
				event: {
					kind: "push",
					sha: head,
					evidenceUrl: `https://github.com/example/product/actions/runs/${id}`,
					...extra,
				},
			},
		});
	let activePolicy = structuredClone(policy);
	const enable = async (
		projectIds = ["project-work"],
		organizationId: string | null = org,
	) => {
		activePolicy = {
			...structuredClone(policy),
			workAttemptDelivery: {
				...policy.workAttemptDelivery!,
				completion: { projectIds, repositoryTargetId: "product-api" },
			},
			repositoryTargets: [
				{
					id: "product-api",
					repository: "example/product",
					shipRepository: "example/ops",
					workflowId: "ship.yml",
					surface: "api",
					liveManifestUrl: "https://api.example.com/build.json",
					maxAgeMs: 60_000,
				},
			],
		};
		await db
			.insert(policyPacks)
			.values({
				id: "policy-one",
				organizationId,
				name: "Example timer",
				slug: "example",
				status: "active",
				definition: { kernelRequestCoordinator: activePolicy },
			})
			.onConflictDoUpdate({
				target: policyPacks.id,
				set: { definition: { kernelRequestCoordinator: activePolicy } },
			});
	};
	const run = async (attemptId: string) => {
		await captureDispatcherWorkAttempts(context, org, activePolicy);
		const row = await getKernelRequest(db, {
			organizationId: org,
			ownerUserId: "agent-example",
			id: `attempt:${attemptId}`,
		});
		return reconcileWorkAttemptKernelRequest(context, row!, activePolicy);
	};
	const repairs = () =>
		db
			.select()
			.from(workItems)
			.then((rows) =>
				rows.filter((r) => r.sourceIntentId === "dispatcher-repair:work-one"),
			);
	return { db, attempt, push, run, repairs, enable, context };
}

describe("dispatcher Work Attempt request source", () => {
	it("drains an existing verified request after opt-in and completes exactly once", async () => {
		const f = await fixture(sha("a"));
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await f.push("push-a", sha("a"), 20);
		expect((await f.run("attempt-one")).nextAction).toBe("ready_to_complete");
		await f.enable();
		expect((await f.run("attempt-one")).snapshot.state).toBe("learned");
		await f.run("attempt-one");
		const work = (await f.db.select().from(workItems)).find(
			(w) => w.id === "work-one",
		)!;
		expect(work.disposition).toBe("completed");
		const events = await f.db.select().from(workEvents);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			eventType: "work.completed",
			actorType: "system",
			actorId: "request-tracker",
		});
		const notes = (await f.db.select().from(workItemComments)).filter((c) =>
			c.id.endsWith(":completed"),
		);
		expect(notes).toHaveLength(1);
		expect(notes[0]!.metadata).toMatchObject({
			policyPackId: "policy-one",
			attemptId: "attempt-one",
			evidenceRefs: expect.arrayContaining([
				"https://github.com/example/ops/actions/runs/1",
			]),
		});
	});

	it.each([
		"other-project",
		"system-default",
		"critical",
		"missing-request",
		"wrong-tenant",
	])("refuses completion authority for %s", async (mode) => {
		const f = await fixture(sha("a"));
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await f.push("push-a", sha("a"), 20);
		await f.run("attempt-one");
		await f.enable(
			mode === "other-project" ? ["another-project"] : ["project-work"],
			mode === "system-default" ? null : org,
		);
		if (mode === "critical")
			await f.db
				.update(workItems)
				.set({ riskLevel: "critical" })
				.where(eq(workItems.id, "work-one"));
		const result = await completeVerifiedDispatcherWork(f.context, {
			organizationId: mode === "wrong-tenant" ? "other-org" : org,
			workItemId: "work-one",
			requestId: mode === "missing-request" ? "missing" : "attempt:attempt-one",
			ownerUserId: "agent-example",
		});
		expect(result.status).not.toBe("completed");
		expect(await f.db.select().from(workEvents)).toHaveLength(0);
	});

	it.each(["successor", "request", "policy", "policy-definition"])(
		"atomically refuses a %s change during the Ship read",
		async (mode) => {
			const f = await fixture(sha("a"));
			await f.attempt("attempt-one", {
				outcome: "succeeded",
				startedMinutesAgo: 30,
				metadata: { commitShas: [sha("a")] },
			});
			await f.push("push-a", sha("a"), 20);
			await f.run("attempt-one");
			await f.enable();
			const normal = ship.getMockImplementation()!;
			ship.mockImplementation(async (...args) => {
				if (mode === "successor")
					await f.attempt("attempt-two", {
						outcome: "failed",
						startedMinutesAgo: 10,
					});
				if (mode === "request")
					await f.db
						.update(kernelRequests)
						.set({ version: 100 })
						.where(eq(kernelRequests.id, "attempt:attempt-one"));
				if (mode === "policy")
					await f.db
						.update(policyPacks)
						.set({ status: "retired" })
						.where(eq(policyPacks.id, "policy-one"));
				if (mode === "policy-definition")
					await f.db
						.update(policyPacks)
						.set({ definition: {} })
						.where(eq(policyPacks.id, "policy-one"));
				return normal(...args);
			});
			await f.run("attempt-one");
			expect(
				(await f.db.select().from(workItems)).find((w) => w.id === "work-one")!
					.disposition,
			).toBe("accepted");
			expect(await f.db.select().from(workEvents)).toHaveLength(0);
			expect(
				(await f.db.select().from(workItemComments)).filter((c) =>
					c.id.endsWith(":completed"),
				),
			).toHaveLength(0);
		},
	);

	it("waits for Ship then files one repair on timeout", async () => {
		const f = await fixture(sha("a"));
		await f.enable();
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await f.push("push-a", sha("a"), 20);
		ship.mockRejectedValue(new Error("Ship red"));
		expect((await f.run("attempt-one")).snapshot.outcome).toBe("unknown");
		expect(await f.repairs()).toHaveLength(0);
		await f.db
			.update(workAttempts)
			.set({ finishedAt: ago(120) })
			.where(eq(workAttempts.id, "attempt-one"));
		await f.run("attempt-one");
		expect((await f.run("attempt-one")).snapshot).toMatchObject({
			outcome: "failed",
			state: "learned",
		});
		expect(await f.repairs()).toHaveLength(1);
	});

	it("rechecks a pending verified request after a rollback and repairs it", async () => {
		const f = await fixture(sha("a"));
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await f.push("push-a", sha("a"), 20);
		await f.run("attempt-one");
		await f.enable();
		f.context.env.GIT_SHA = sha("b");
		await f.db
			.update(workAttempts)
			.set({ finishedAt: ago(120) })
			.where(eq(workAttempts.id, "attempt-one"));
		expect((await f.run("attempt-one")).snapshot).toMatchObject({
			outcome: "failed",
			state: "learned",
		});
		expect(await f.repairs()).toHaveLength(1);
		expect(await f.db.select().from(workEvents)).toHaveLength(0);
	});

	it("does not infer ancestry from the time of an unrelated later push", async () => {
		const f = await fixture(sha("b"));
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await f.push("push-a", sha("a"), 20);
		await f.push("push-b", sha("b"), 10);
		expect((await f.run("attempt-one")).snapshot.outcome).toBe("unknown");
	});

	it("reads agreed and tolerated settlement fields, never short SHAs", () => {
		expect(
			settledCommitShas({
				commitShas: [sha("a"), "abc1234"],
				commits: [{ sha: sha("B") }],
				commitSha: sha("a"),
				baseSha: sha("c"),
			}),
		).toEqual({ commitShas: [sha("a"), sha("b")], baseSha: sha("c") });
		expect(settledCommitShas({})).toEqual({ commitShas: [], baseSha: null });
	});

	it("verifies a SHA on main and deployed, records the receipt and waits on steward authority", async () => {
		const f = await fixture(sha("a"));
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")], baseSha: sha("0") },
		});
		await f.push("push-a", sha("a"), 20);
		const row = await f.run("attempt-one");
		expect(row.snapshot).toMatchObject({
			state: "verifying",
			outcome: "verified",
			delivery: { status: "pending" },
		});
		expect(row.nextAction).toBe("ready_to_complete");
		const again = await f.run("attempt-one");
		expect(again.snapshot.state).toBe("verifying");
		const comments = await f.db.select().from(workItemComments);
		expect(comments).toHaveLength(1);
		expect(comments[0]!.body).toContain("ready to complete");
		expect(comments[0]!.metadata).toMatchObject({
			deliveryVerification: { commitShas: [sha("a")] },
		});
		const [work] = await f.db.select().from(workItems);
		expect(work!.disposition).toBe("accepted");
		expect(await f.repairs()).toHaveLength(0);
	});

	it("passes after main moved past the SHA, and waits while it is not yet deployed", async () => {
		const later = await fixture(sha("e"));
		await later.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await later.push("push-d", sha("d"), 20, {
			commitShas: [sha("d"), sha("a")],
		});
		await later.push("push-e", sha("e"), 5, { beforeSha: sha("d") });
		expect((await later.run("attempt-one")).snapshot.outcome).toBe("verified");

		const stale = await fixture(sha("9"));
		await stale.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")] },
		});
		await stale.push("push-9", sha("9"), 40);
		await stale.push("push-a", sha("a"), 20);
		const pending = await stale.run("attempt-one");
		expect(pending.snapshot).toMatchObject({
			state: "verifying",
			outcome: "unknown",
			delivery: null,
		});
		expect(await stale.repairs()).toHaveLength(0);
	});

	it.each([false, true])(
		"does not verify a clean code exit that named no SHA (authority %s)",
		async (enabled) => {
			const f = await fixture(sha("a"));
			if (enabled) await f.enable();
			await f.attempt("attempt-one", {
				outcome: "succeeded",
				startedMinutesAgo: 30,
			});
			const row = await f.run("attempt-one");
			expect(row.snapshot).toMatchObject({
				state: "learned",
				outcome: "failed",
			});
			expect(row.snapshot.observations[0]!.limitations).toContain(
				"named no commit",
			);
			expect(await f.repairs()).toHaveLength(1);
		},
	);

	it("leaves non-code Work without a SHA out of scope", async () => {
		const f = await fixture(sha("a"), "research");
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
		});
		expect((await f.run("attempt-one")).snapshot.state).toBe("cancelled");
		expect(await f.repairs()).toHaveLength(0);
	});

	it.each([false, true])(
		"rejects yesterday's already-landed SHA claimed by a new Attempt (authority %s)",
		async (enabled) => {
			const f = await fixture(sha("a"));
			if (enabled) await f.enable();
			await f.push("push-a", sha("a"), 24 * 60);
			await f.attempt("attempt-one", {
				outcome: "succeeded",
				startedMinutesAgo: 30,
				metadata: { commitShas: [sha("a")], baseSha: sha("a") },
			});
			const row = await f.run("attempt-one");
			expect(row.snapshot.outcome).toBe("failed");
			expect(row.snapshot.observations[0]!.limitations).toContain(
				"already on main before this Attempt started",
			);
			expect(await f.db.select().from(workItemComments)).toHaveLength(1);
			expect(await f.repairs()).toHaveLength(1);
		},
	);

	it("rejects a SHA contained in the Attempt's reported base", async () => {
		const f = await fixture(sha("b"));
		await f.attempt("attempt-one", {
			outcome: "succeeded",
			startedMinutesAgo: 30,
			metadata: { commitShas: [sha("a")], baseSha: sha("b") },
		});
		await f.push("push-b", sha("b"), 20, { commitShas: [sha("b"), sha("a")] });
		const row = await f.run("attempt-one");
		expect(row.snapshot.observations[0]!.limitations).toContain(
			"base revision",
		);
		expect(row.snapshot.outcome).toBe("failed");
	});

	it("files exactly one repair across repeated failures", async () => {
		const f = await fixture(sha("a"));
		await f.attempt("attempt-one", {
			outcome: "failed",
			startedMinutesAgo: 60,
		});
		expect((await f.run("attempt-one")).snapshot.state).toBe("learned");
		await f.attempt("attempt-two", {
			outcome: "failed",
			startedMinutesAgo: 30,
		});
		expect((await f.run("attempt-two")).snapshot.state).toBe("learned");
		await f.run("attempt-two");
		const repairs = await f.repairs();
		expect(repairs).toHaveLength(1);
		expect(repairs[0]!.disposition).toBe("proposed");
		const notes = (await f.db.select().from(workItemComments)).filter(
			(c) => c.workItemId === repairs[0]!.id,
		);
		expect(notes.map((c) => c.body)).toEqual([
			expect.stringContaining("attempt-one"),
			expect.stringContaining("attempt-two"),
		]);
		expect(await f.db.select().from(kernelRequests)).toHaveLength(2);
	});
});
