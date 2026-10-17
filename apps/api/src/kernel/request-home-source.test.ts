import { DatabaseSync } from "node:sqlite";
import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	kernelRequests,
	kernelRequestEvents,
} from "@tedix/db/schema/kernel-requests";
import {
	kernelRuntimeRuns,
	kernelRuntimeEvents,
	kernelConversationGrants,
} from "@tedix/db/schema/cognitive-runtime";
import {
	workItems,
	workAttempts,
	workItemComments,
} from "@tedix/db/schema/work-items";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { osOutputs, osWorkspaces } from "@tedix/db/schema/os-workspaces";
import {
	getHomeKernelRequest,
	listDueKernelRequestOrganizations,
} from "@tedix/db/queries/kernel-requests";
import type { BaseContext } from "../rpc/orpc";
import { applyKernelRequestEvent } from "./request-driver";
import type { KernelRequestEvent } from "./request-coordinator";
import {
	captureHomeKernelRequest,
	readKernelRequestPolicy,
	reconcileHomeKernelRequest,
	reconcileDueHomeKernelRequests,
} from "./request-home-source";
const config = vi.hoisted(() => ({
	value: {
		version: 1,
		enabled: true,
		nextOwner: "kernel-example",
		retryMs: 1000,
		probeTimeoutMs: 1000,
		maxProbeAttempts: 3,
		runBudgetMs: 1000,
		repositoryTargets: [],
	} as KernelRequestPolicy,
}));
vi.mock("@tedix/db/queries/kernel-runtime-support", () => ({
	getActivePolicyPackDefinition: async () => ({
		kernelRequestCoordinator: config.value,
	}),
}));
vi.mock("../rpc/routers/kernel/conversation-index", () => ({
	applyKernelConversationEvent: async () => {},
}));
const now = "2026-10-17T10:00:00.000Z";
async function fixture(revisionId = "revision-one", responseOnly = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			kernelRequests,
			kernelRequestEvents,
			kernelRuntimeRuns,
			kernelRuntimeEvents,
			kernelConversationGrants,
			workItems,
			workAttempts,
			workItemComments,
			organizationMembers,
			osOutputs,
			osWorkspaces,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const context = {
		db,
		env: {},
		authType: "user",
		user: { sub: "user-ada" },
	} as BaseContext;
	await db.insert(organizationMembers).values({
		id: "member-one",
		organizationId: "org-example",
		descopeUserId: "user-ada",
		email: "ada@example.com",
		status: "active",
	});
	await db.insert(osWorkspaces).values({
		id: "workspace-one",
		organizationId: "org-example",
		name: "Example workspace",
		visibility: "private",
		ownerUserId: "user-ada",
		createdByKind: "user",
		createdById: "user-ada",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(osOutputs).values({
		id: "output-one",
		organizationId: "org-example",
		workspaceId: "workspace-one",
		kind: "document",
		title: "Example document",
		status: "active",
		currentRevisionId: revisionId,
		createdByKind: "user",
		createdById: "user-ada",
		createdAt: now,
		updatedAt: now,
	});
	await captureHomeKernelRequest(context, {
		organizationId: "org-example",
		runId: "run-one",
		conversationId: "home-one",
		checks: responseOnly
			? []
			: [
					{
						kind: "os_output_revision",
						outputId: "output-one",
						revisionId: "revision-one",
					},
				],
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-one",
		organizationId: "org-example",
		conversationId: "home-one",
		status: "completed",
		outputMessageId: responseOnly ? "answer-one" : null,
		metadata: { workItemId: "work-one", preserveConcurrentField: "kept" },
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(workItems).values({
		id: "work-one",
		orgId: "org-example",
		title: "Read the requested revision",
		disposition: "completed",
		createdAt: now,
	});
	await db.insert(workAttempts).values({
		id: "attempt-one",
		orgId: "org-example",
		workItemId: "work-one",
		executorType: "tedi",
		executorId: "tedi-example",
		attemptNumber: 1,
		runtimeState: "finished",
		outcome: "succeeded",
		startedAt: now,
		heartbeatAt: now,
		finishedAt: now,
	});
	return { context, db };
}
describe("Home request source adapter", () => {
	it("carries a real durable source through canonical Work, target readback and acknowledged report", async () => {
		const { context, db } = await fixture();
		const row = (await getHomeKernelRequest(db, "org-example", "run-one"))!;
		expect(row.snapshot.state).toBe("received");
		const policy = (await readKernelRequestPolicy(context, "org-example"))!;
		const final = await reconcileHomeKernelRequest(context, row, policy);
		expect(final.snapshot).toMatchObject({
			state: "learned",
			outcome: "verified",
			learning: "no_new_lesson",
			workItemId: "work-one",
			attemptId: "attempt-one",
			delivery: { status: "acknowledged" },
		});
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(1);
		await reconcileHomeKernelRequest(context, final, policy);
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(1);
		expect(
			(await db.select().from(kernelRuntimeRuns))[0]?.metadata
				?.preserveConcurrentField,
		).toBe("kept");
	});
	it("keeps wrong revisions unverified and records a machine-owned repair on existing Work", async () => {
		const { context, db } = await fixture("revision-other");
		const row = (await getHomeKernelRequest(db, "org-example", "run-one"))!;
		const final = await reconcileHomeKernelRequest(
			context,
			row,
			(await readKernelRequestPolicy(context, "org-example"))!,
		);
		expect(final.snapshot).toMatchObject({
			state: "verifying",
			outcome: "failed",
		});
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(0);
		expect(await db.select().from(workItemComments)).toHaveLength(1);
		expect(final.nextOwner).toBe("kernel-example");
		expect(final.nextDueAt).not.toBeNull();
	});
	it("recovers an old empty-check request after its probe budget was exhausted", async () => {
		const { context, db } = await fixture("revision-one", true);
		const policy = (await readKernelRequestPolicy(context, "org-example"))!;
		let row = (await getHomeKernelRequest(db, "org-example", "run-one"))!;
		for (const event of [
			{ kind: "file", workItemId: "work-one" },
			{ kind: "brief", revision: 1, checks: [] },
			{ kind: "start", attemptId: "attempt-one" },
			{ kind: "terminal", attemptId: "attempt-one", outcome: "succeeded" },
		] satisfies KernelRequestEvent[])
			row = await applyKernelRequestEvent(db, row, event, policy, now);
		for (let i = 0; i < policy.maxProbeAttempts; i++)
			row = await applyKernelRequestEvent(
				db,
				row,
				{
					kind: "checked",
					acceptanceKey: row.snapshot.acceptanceKey!,
					observations: [],
				},
				policy,
				now,
			);
		expect(row.snapshot).toMatchObject({
			state: "verifying",
			checks: [],
			outcome: "unknown",
			probeAttempts: 3,
		});
		const priorVersion = row.version;
		await db.insert(kernelRuntimeEvents).values({
			id: "reply-one",
			organizationId: "org-example",
			conversationId: "home-one",
			runId: "run-one",
			messageId: "answer-one",
			kind: "message.completed",
			payload: { role: "assistant", content: "The requested summary." },
			runtimeBackend: "custom",
			createdAt: now,
		});
		const final = await reconcileHomeKernelRequest(context, row, policy);
		expect(final.snapshot).toMatchObject({
			state: "learned",
			outcome: "verified",
			briefRevision: 2,
			attemptId: "attempt-one",
			checks: [{ kind: "home_response" }],
			probeAttempts: 1,
			delivery: { status: "acknowledged" },
		});
		expect(final.version).toBeGreaterThan(priorVersion);
		expect(await db.select().from(workAttempts)).toHaveLength(1);
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(2);
	});
	it("waits for an unchecked delegation reply without exhausting probes, then verifies delivery only", async () => {
		const { context, db } = await fixture("revision-one", true);
		const policy = (await readKernelRequestPolicy(context, "org-example"))!;
		let row = (await getHomeKernelRequest(db, "org-example", "run-one"))!;
		for (let i = 0; i < 4; i++)
			row = await reconcileHomeKernelRequest(context, row, policy);
		expect(row.snapshot.state).toBe("running");
		expect(row.snapshot.probeAttempts).toBe(0);
		await db.insert(kernelRuntimeEvents).values({
			id: "reply-one",
			organizationId: "org-example",
			conversationId: "home-one",
			runId: "run-one",
			messageId: "answer-one",
			kind: "message.completed",
			payload: { role: "assistant", content: "The requested summary." },
			runtimeBackend: "custom",
			createdAt: now,
		});
		const final = await reconcileHomeKernelRequest(context, row, policy);
		expect(final.snapshot).toMatchObject({
			state: "learned",
			outcome: "verified",
			delivery: { status: "acknowledged" },
		});
		expect(final.snapshot.observations[0]?.limitations).toContain(
			"not factual correctness or external target state",
		);
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(2);
	});
	it("captures all conversations by default and restricts new capture to a configured cohort", async () => {
		const { context, db } = await fixture();
		const capture = (runId: string, conversationId: string) =>
			captureHomeKernelRequest(context, {
				organizationId: "org-example",
				runId,
				conversationId,
			});
		expect(await capture("run-two", "home-two")).toBe("home:run-two");
		config.value.homeConversationIds = ["home-one"];
		try {
			expect(await capture("run-three", "home-three")).toBeUndefined();
			expect(await capture("run-four", "home-one")).toBe("home:run-four");
			config.value.homeConversationIds = [];
			expect(await capture("run-five", "home-one")).toBeUndefined();
			expect(
				await getHomeKernelRequest(db, "org-example", "run-three"),
			).toBeUndefined();
		} finally {
			delete config.value.homeConversationIds;
		}
	});
	it("rolls back new capture while draining existing requests outside the restored cohort", async () => {
		const { context, db } = await fixture();
		config.value.homeCaptureEnabled = false;
		config.value.homeConversationIds = [];
		try {
			expect(
				await captureHomeKernelRequest(context, {
					organizationId: "org-example",
					runId: "run-disabled",
					conversationId: "home-two",
				}),
			).toBeUndefined();
			await expect(
				captureHomeKernelRequest(context, {
					organizationId: "org-example",
					runId: "run-disabled-checks",
					conversationId: "home-two",
					checks: [
						{
							kind: "os_output_revision",
							outputId: "output-one",
							revisionId: "revision-one",
						},
					],
				}),
			).rejects.toThrow("not configured");
			expect(
				await getHomeKernelRequest(db, "org-example", "run-disabled"),
			).toBeUndefined();
			await db.update(kernelRequests).set({ nextDueAt: now });
			await reconcileDueHomeKernelRequests(context, "org-example");
			expect(
				(await getHomeKernelRequest(db, "org-example", "run-one"))?.snapshot
					.state,
			).toBe("learned");
		} finally {
			delete config.value.homeCaptureEnabled;
			delete config.value.homeConversationIds;
		}
	});
	it("keeps paused requests owned while yielding the bounded tenant recovery scan", async () => {
		const { context, db } = await fixture();
		await db.update(kernelRequests).set({
			nextDueAt: now,
			updatedAt: "2026-10-17T09:59:59.000Z",
		});
		config.value.enabled = false;
		try {
			expect(await reconcileDueHomeKernelRequests(context, "org-example")).toBe(
				1,
			);
			const row = (await getHomeKernelRequest(db, "org-example", "run-one"))!;
			expect(row.snapshot.state).toBe("received");
			expect(row.nextOwner).toBe("kernel-example");
			expect(row.nextAction).toBe("restore_request_coordinator_configuration");
			expect(Date.parse(row.nextDueAt!)).toBeGreaterThan(Date.now());
			expect(
				await listDueKernelRequestOrganizations(db, new Date().toISOString()),
			).toEqual([]);
		} finally {
			config.value.enabled = true;
		}
	});
});
