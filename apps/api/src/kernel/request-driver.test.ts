import type { LaneExecutionPolicy } from "@tedix/api-contract/schemas/lane-execution";
import type { KernelExecutorRouter } from "./request-executor-routing";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	kernelRequests,
	kernelRequestEvents,
} from "@tedix/db/schema/kernel-requests";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	getKernelRequest,
	listKernelRequestEvents,
	receiveKernelRequest,
} from "@tedix/db/queries/kernel-requests";
import {
	receivedKernelRequest,
	type KernelAcceptanceReader,
} from "./request-coordinator";
import {
	applyKernelRequestEvent,
	driveKernelRequest,
	type KernelRequestSourceReader,
} from "./request-driver";
const now = () => "2026-10-17T10:00:00.000Z";
const policy = {
	nextOwner: "kernel-example",
	retryMs: 1000,
	probeTimeoutMs: 100,
	maxProbeAttempts: 3,
	runBudgetMs: 1000,
};
const scope = {
	organizationId: "org-example",
	ownerUserId: "user-ada",
	id: "request-one",
};
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(kernelRequests));
	sqlite.exec(schemaDdl(kernelRequestEvents));
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100 }),
	);
	let row = (await receiveKernelRequest(db, {
		...scope,
		sourceKind: "home",
		sourceId: "run-one",
		conversationId: "home-one",
		snapshot: receivedKernelRequest(),
		nextOwner: policy.nextOwner,
		nextAction: "file",
		nextDueAt: now(),
		lastEventId: "received",
		createdAt: now(),
		updatedAt: now(),
	}))!;
	row = await applyKernelRequestEvent(
		db,
		row,
		{ kind: "file", workItemId: "work-one" },
		policy,
		now(),
	);
	row = await applyKernelRequestEvent(
		db,
		row,
		{
			kind: "brief",
			revision: 1,
			checks: [
				{
					kind: "os_output_revision",
					outputId: "output-one",
					revisionId: "revision-one",
				},
			],
		},
		policy,
		now(),
	);
	row = await applyKernelRequestEvent(
		db,
		row,
		{ kind: "start", attemptId: "attempt-one" },
		policy,
		now(),
	);
	const reader: KernelAcceptanceReader = {
		readOutputRevision: vi.fn(async () => ({
			revisionId: "revision-one",
			evidenceRef: "output:one",
		})),
		readRepositoryDelivery: async () => {
			throw new Error("not configured");
		},
	};
	const reports = new Set<string>();
	const source: KernelRequestSourceReader = {
		readExecution: async () => ({
			attemptId: "attempt-one",
			outcome: "succeeded",
		}),
		deliverReport: vi.fn(async (_row, id) => {
			reports.add(id);
			return { status: "acknowledged" as const, receiptRef: "home:report-one" };
		}),
	};
	return { db, reader, source, reports };
}
describe("durable request driver", () => {
	it("recovers missed terminal events and records one acknowledged report without inventing a lesson", async () => {
		const { db, source, reader, reports } = await fixture();
		const row = await driveKernelRequest(
			db,
			scope,
			policy,
			source,
			reader,
			now,
		);
		expect(row?.snapshot).toMatchObject({
			state: "learned",
			outcome: "verified",
			learning: "no_new_lesson",
			delivery: { status: "acknowledged" },
		});
		expect(row?.nextDueAt).toBeNull();
		expect(reports.size).toBe(1);
		await driveKernelRequest(db, scope, policy, source, reader, now);
		expect(source.deliverReport).toHaveBeenCalledTimes(1);
		expect(
			(await listKernelRequestEvents(db, scope)).map((e) => e.snapshot.state),
		).toEqual([
			"received",
			"filed",
			"briefed",
			"running",
			"verifying",
			"verifying",
			"verifying",
			"reported",
			"learned",
		]);
	});
	it("replays a crash after delivery with the same durable report identity", async () => {
		const { db, source, reader, reports } = await fixture();
		const deliver = source.deliverReport;
		let crashed = false;
		source.deliverReport = async (row, id) => {
			const receipt = await deliver(row, id);
			if (!crashed) {
				crashed = true;
				throw new Error("eviction after delivery");
			}
			return receipt;
		};
		await expect(
			driveKernelRequest(db, scope, policy, source, reader, now),
		).rejects.toThrow("eviction");
		expect((await getKernelRequest(db, scope))?.snapshot.delivery?.status).toBe(
			"pending",
		);
		expect(
			(await driveKernelRequest(db, scope, policy, source, reader, now))
				?.snapshot.state,
		).toBe("learned");
		expect(reports.size).toBe(1);
		expect(reader.readOutputRevision).toHaveBeenCalledTimes(1);
	});
	it("keeps failed or unknown checks owned and due without success reports", async () => {
		for (const wrong of [false, true]) {
			const { db, source, reader } = await fixture();
			reader.readOutputRevision = async () => {
				if (!wrong) throw new Error("unavailable");
				return { revisionId: "wrong", evidenceRef: "output:wrong" };
			};
			const row = await driveKernelRequest(
				db,
				scope,
				policy,
				source,
				reader,
				now,
			);
			expect(row?.snapshot.state).toBe("verifying");
			expect(row?.snapshot.outcome).toBe(wrong ? "failed" : "unknown");
			expect(row?.nextDueAt).not.toBeNull();
			expect(row?.nextOwner).toBe(policy.nextOwner);
			expect(source.deliverReport).not.toHaveBeenCalled();
		}
	});
	it("ignores terminal observations from another Attempt", async () => {
		const { db, source, reader } = await fixture();
		source.readExecution = async () => ({
			attemptId: "attempt-other",
			outcome: "succeeded",
		});
		expect(
			(await driveKernelRequest(db, scope, policy, source, reader, now))
				?.snapshot.state,
		).toBe("running");
		expect(reader.readOutputRevision).not.toHaveBeenCalled();
	});
});

async function routingFixture() {
	const f = await fixture();
	const lanePolicy: LaneExecutionPolicy = {
		version: 1,
		role: "maker",
		sharedResourceKeys: ["lanes"],
		makerResourceKey: "makers",
		reservedSlots: 2,
		budgetEnvelopeIds: ["execution-budget"],
		maxAttempts: 3,
		maxDelegationDepth: 2,
		delegationDepth: 0,
		executors: [
			{
				id: "strong",
				kind: "codex",
				principalType: "external_agent",
				principalId: "codex-one",
				resourceKey: "codex",
				costMicros: 100,
				capabilities: ["read"],
			},
			{
				id: "cheap",
				kind: "skill",
				principalType: "tedi",
				principalId: "skill-one",
				resourceKey: "skill",
				costMicros: 10,
				capabilities: ["read"],
			},
		],
	};
	const state = {
		reconciled: false,
		authorized: true,
		attempts: 1,
		ack: "host:ack" as string | null,
		lostReply: false,
		writes: 0,
	};
	const receipts = new Map<
		string,
		{
			workItemId: string;
			previousAttemptId: string;
			attemptId: string;
			admissionId: string;
			hostAcknowledgmentRef: string | null;
		}
	>();
	const router: KernelExecutorRouter = {
		readContext: async () => ({
			policy: lanePolicy,
			attemptCount: state.attempts,
			requiredCapabilities: ["read"],
		}),
		readFailure: async (row) =>
			row.snapshot.attemptId === "attempt-one"
				? {
						kind: "provider_credit_exhausted",
						attemptId: "attempt-one",
						executorId: "strong",
						writeReceiptRefs: ["provider:confirmed-write"],
						uncertainWriteRefs: ["provider:uncertain-write"],
					}
				: null,
		reconcileWrites: vi.fn(async () =>
			state.reconciled ? ["provider:uncertain-write"] : [],
		),
		eligible: vi.fn(async () => state.authorized),
		continue: vi.fn(async (row, checkpoint) => {
			if (!receipts.has(checkpoint.key)) {
				state.writes++;
				receipts.set(checkpoint.key, {
					workItemId: row.snapshot.workItemId!,
					previousAttemptId: "attempt-one",
					attemptId: "attempt-two",
					admissionId: "admission-two",
					hostAcknowledgmentRef: state.ack,
				});
			}
			if (state.lostReply) {
				state.lostReply = false;
				throw new Error("lost continuation response");
			}
			return {
				...receipts.get(checkpoint.key)!,
				hostAcknowledgmentRef: state.ack,
			};
		}),
	};
	f.source.executorRouter = router;
	f.source.readExecution = async (row) => ({
		attemptId: row.snapshot.attemptId!,
		outcome: null,
	});
	const drive = (at = now()) =>
		driveKernelRequest(f.db, scope, policy, f.source, f.reader, () => at);
	return { ...f, policy: lanePolicy, state, router, drive };
}

describe("credit exhaustion continuation", () => {
	it("durably checkpoints the same request and retains its owner until uncertain writes reconcile", async () => {
		const f = await routingFixture();
		let row = await f.drive();
		expect(row?.snapshot.laneCheckpoint).toMatchObject({
			status: "reconcile",
			previousAttemptId: "attempt-one",
			writeReceiptRefs: ["provider:confirmed-write"],
		});
		expect(row?.nextOwner).toBe(policy.nextOwner);
		expect(row?.nextAction).toBe("lane_reconcile");
		expect(f.router.continue).not.toHaveBeenCalled();
		f.state.reconciled = true;
		row = await f.drive();
		expect(row?.id).toBe(scope.id);
		expect(row?.snapshot.workItemId).toBe("work-one");
		expect(row?.snapshot.attemptId).toBe("attempt-two");
		expect(row?.snapshot.laneCheckpoint).toMatchObject({
			status: "continued",
			successorExecutorId: "cheap",
			reconciledRefs: ["provider:uncertain-write"],
		});
		await f.drive();
		expect(f.state.writes).toBe(1);
	});

	it("recovers a lost dispatch response by the same checkpoint key with no repeated side effect", async () => {
		const f = await routingFixture();
		f.state.reconciled = true;
		f.state.lostReply = true;
		await expect(f.drive()).rejects.toThrow("lost continuation response");
		expect(
			(await getKernelRequest(f.db, scope))?.snapshot.laneCheckpoint?.status,
		).toBe("dispatching");
		// The successor already consumed the final allowed Attempt before the reply was lost.
		f.state.attempts = f.policy.maxAttempts;
		const row = await f.drive();
		expect(row?.snapshot.attemptId).toBe("attempt-two");
		expect(f.state.writes).toBe(1);
	});

	it("requires host acknowledgment for a local successor and rechecks authority on recovery", async () => {
		const f = await routingFixture();
		f.state.reconciled = true;
		f.state.ack = null;
		Object.assign(f.policy.executors[1]!, {
			kind: "claude",
			principalType: "external_agent",
			principalId: "claude-one",
		});
		let row = await f.drive();
		expect(row?.snapshot.attemptId).toBe("attempt-one");
		expect(row?.snapshot.laneCheckpoint?.status).toBe("dispatching");
		f.state.authorized = false;
		await f.drive();
		expect(f.router.continue).toHaveBeenCalledTimes(1);
		f.state.authorized = true;
		f.state.ack = "host:ack";
		row = await f.drive();
		expect(row?.snapshot.attemptId).toBe("attempt-two");
		expect(f.state.writes).toBe(1);
	});

	it.each(["price", "capability", "budget", "depth", "attempts"])(
		"withholds continuation when %s is unavailable",
		async (mode) => {
			const f = await routingFixture();
			f.state.reconciled = true;
			if (mode === "price") f.policy.executors[1]!.costMicros = null;
			if (mode === "capability") f.policy.executors[1]!.capabilities = [];
			if (mode === "budget") f.state.authorized = false;
			if (mode === "depth") f.policy.delegationDepth = 3;
			if (mode === "attempts") f.state.attempts = 3;
			const row = await f.drive();
			expect(row?.snapshot.attemptId).toBe("attempt-one");
			expect(f.router.continue).not.toHaveBeenCalled();
		},
	);

	it("bounds continuation time and ignores stale successor events while a write is uncertain", async () => {
		const f = await routingFixture();
		const initial = (await f.drive())!;
		const stale = await applyKernelRequestEvent(
			f.db,
			initial,
			{
				kind: "successor",
				previousAttemptId: "attempt-one",
				attemptId: "stale-attempt",
			},
			policy,
			now(),
		);
		expect(stale.snapshot.attemptId).toBe("attempt-one");
		const row = await f.drive("2026-10-17T10:01:00.000Z");
		expect(row?.snapshot.laneCheckpoint).toMatchObject({
			status: "held",
			reason: "Continuation deadline expired",
		});
		expect(f.router.continue).not.toHaveBeenCalled();
	});
});
