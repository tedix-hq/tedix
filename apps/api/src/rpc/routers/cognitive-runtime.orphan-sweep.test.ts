import { createApiSqliteFixture } from "./__tests__/api-sqlite";
import { chatDispatchIdempotency, tediRuntimeEvents } from "@tedix/db/schema";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	findOrphanRuns,
	getOrphanRunHealth,
	sweepOrphanRuns,
} from "./cognitive-runtime/recovery-artifacts";

type RuntimeEventRow = typeof tediRuntimeEvents.$inferSelect;
type DispatchMapping = {
	tediId: string;
	organizationId?: string | null;
	conversationId: string;
	idempotencyKey: string;
	runId: string | null;
};

const NOW = new Date("2026-05-25T20:00:00.000Z");
const OLD_BUT_ACTIVE = new Date(NOW.getTime() - 16 * 60_000).toISOString(); // 16 min old
const TWO_MIN_AGO = new Date(NOW.getTime() - 2 * 60_000).toISOString();
const TEN_MIN_AGO = new Date(NOW.getTime() - 10 * 60_000).toISOString();
const FRESH = new Date(NOW.getTime() - 3 * 60_000).toISOString(); // 3 min old

const ORG = "org-1";
const TEDI = "tedi-1";

function createFakeDb(
	initialEvents: RuntimeEventRow[],
	dispatchMappings: DispatchMapping[] = [],
) {
	const fixture = createApiSqliteFixture();
	const events = fixture.rows<RuntimeEventRow>(
		tediRuntimeEvents,
		initialEvents,
	);
	fixture.seed(
		chatDispatchIdempotency,
		dispatchMappings.map((row, index) => ({
			id: `mapping-${index}`,
			organizationId: ORG,
			createdAt: NOW.toISOString(),
			...row,
		})),
	);
	return Object.assign(fixture.db, { events });
}

function makeEvent(overrides: Partial<RuntimeEventRow>): RuntimeEventRow {
	return {
		id: overrides.id ?? `evt-${Math.random()}`,
		organizationId: overrides.organizationId ?? ORG,
		tediId: overrides.tediId ?? TEDI,
		kind: overrides.kind ?? "run.started",
		conversationId: overrides.conversationId ?? "agent:main:main",
		runId: overrides.runId ?? null,
		messageId: overrides.messageId ?? null,
		toolCallId: overrides.toolCallId ?? null,
		approvalRequestId: overrides.approvalRequestId ?? null,
		artifactId: overrides.artifactId ?? null,
		sequence: overrides.sequence ?? null,
		delta: overrides.delta ?? null,
		payload: overrides.payload ?? null,
		runtimeBackend: overrides.runtimeBackend ?? "cloudflare-agents",
		runtimeExternalId: overrides.runtimeExternalId ?? null,
		runtimeExternalUrl: overrides.runtimeExternalUrl ?? null,
		runtimeMetadata: overrides.runtimeMetadata ?? null,
		createdAt: overrides.createdAt ?? NOW.toISOString(),
	};
}

describe("orphan-run sweep", () => {
	it("sweeps a run with run.started > 15min ago, no terminator, no recent delta", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "run-started-1",
				kind: "run.started",
				runId: "run-orphan-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates.map((c) => c.runId)).toEqual(["run-orphan-1"]);

		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(result.swept).toBe(1);
		expect(result.sweptRunIds).toEqual(["run-orphan-1"]);
		expect(result.errors).toEqual([]);

		const inserted = db.events.find(
			(e) => e.runId === "run-orphan-1" && e.kind === "run.failed",
		);
		expect(inserted).toBeDefined();
		expect(
			(inserted?.runtimeMetadata as Record<string, unknown> | null)?.reason,
		).toBe("runtime_dropped");
	});

	it("invokes onSealed once per sealed child and records propagation without blocking later candidates", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "run-started-a",
				kind: "run.started",
				runId: "run-orphan-a",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "run-started-b",
				kind: "run.started",
				runId: "run-orphan-b",
				createdAt: OLD_BUT_ACTIVE,
			}),
		]);
		const sealed: Array<{ runId: string; terminalKind: string }> = [];
		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
				onSealed: async (input) => {
					sealed.push({
						runId: input.candidate.runId,
						terminalKind: input.terminalKind,
					});
					if (input.candidate.runId === "run-orphan-a") {
						throw new Error("parent write failed");
					}
					expect(input.candidate.tediId).toBe(TEDI);
					expect(input.candidate.organizationId).toBe(ORG);
					expect(input.message).toContain("Auto-failed by orphan sweep");
					return true;
				},
			},
		);
		expect(result.swept).toBe(2);
		expect(sealed).toEqual([
			{ runId: "run-orphan-a", terminalKind: "run.failed" },
			{ runId: "run-orphan-b", terminalKind: "run.failed" },
		]);
		expect(result.propagatedRunIds).toEqual(["run-orphan-b"]);
		expect(result.errors).toEqual([
			"runId=run-orphan-a: parent propagation failed: parent write failed",
		]);
		// Both children were still sealed regardless of the hook outcome.
		expect(
			db.events.filter((e) => e.kind === "run.failed").map((e) => e.runId),
		).toEqual(["run-orphan-a", "run-orphan-b"]);
	});

	it("does not invoke onSealed for a run already terminated (skipped seal)", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "run-started-1",
				kind: "run.started",
				runId: "run-orphan-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
		]);
		await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		let calls = 0;
		const second = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
				onSealed: async () => {
					calls += 1;
					return true;
				},
			},
		);
		expect(second.swept).toBe(0);
		expect(calls).toBe(0);
	});

	it("skips an orphan that still has a recent message.delta (still active)", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "run-started-2",
				kind: "run.started",
				runId: "run-active-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "delta-2",
				kind: "message.delta",
				runId: "run-active-1",
				createdAt: TWO_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);

		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(result.swept).toBe(0);
		expect(
			db.events.some(
				(e) => e.runId === "run-active-1" && e.kind === "run.failed",
			),
		).toBe(false);
	});

	it("skips a completed run", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "run-started-3",
				kind: "run.started",
				runId: "run-done-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "run-completed-3",
				kind: "run.completed",
				runId: "run-done-1",
				createdAt: TEN_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("skips a fresh run.started (less than 15min old)", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "run-started-4",
				kind: "run.started",
				runId: "run-fresh-1",
				createdAt: FRESH,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("also skips run.failed and run.canceled terminators", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-f",
				kind: "run.started",
				runId: "run-failed-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "rt-f",
				kind: "run.failed",
				runId: "run-failed-1",
				createdAt: TEN_MIN_AGO,
			}),
			makeEvent({
				id: "rs-c",
				kind: "run.started",
				runId: "run-canceled-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "rt-c",
				kind: "run.canceled",
				runId: "run-canceled-1",
				createdAt: TEN_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("respects the limit cap per tick", async () => {
		const events: RuntimeEventRow[] = [];
		for (let i = 0; i < 5; i++) {
			events.push(
				makeEvent({
					id: `rs-${i}`,
					kind: "run.started",
					runId: `run-orphan-${i}`,
					createdAt: new Date(NOW.getTime() - (16 + i) * 60_000).toISOString(),
				}),
			);
		}
		const db = createFakeDb(events);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
				limit: 3,
			},
		);
		expect(candidates).toHaveLength(3);

		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
				limit: 3,
			},
		);
		expect(result.swept).toBe(candidates.length);
		expect(result.errors).toEqual([]);
	});

	it("does not re-sweep a run already terminated in a previous tick", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-twice",
				kind: "run.started",
				runId: "run-twice-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
		]);
		const first = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(first.swept).toBe(1);
		const second = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(second.swept).toBe(0);
	});

	it("skips an orphan kept alive by a recent tool event (no assistant delta)", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-tool",
				kind: "run.started",
				runId: "run-tool-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "tool-c",
				kind: "tool.completed",
				runId: "run-tool-1",
				createdAt: TWO_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("skips an orphan kept alive by a recent message.progress heartbeat", async () => {
		// T1.1 heartbeat: a long streaming/synthesis round emits message.progress
		// with no delta and no tool events — liveness, not wall-clock, gates the sweep.
		const db = createFakeDb([
			makeEvent({
				id: "rs-hb",
				kind: "run.started",
				runId: "run-hb-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "hb-1",
				kind: "message.progress",
				runId: "run-hb-1",
				createdAt: TWO_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("skips an orphan kept alive by a recent step.retry (deploy-recovery in flight)", async () => {
		// A CHAT_TURN_WORKFLOW turn re-driving a step after a deploy writes
		// step.retry markers; sealing it runtime_dropped would race the recovery.
		const db = createFakeDb([
			makeEvent({
				id: "rs-retry",
				kind: "run.started",
				runId: "run-retry-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "retry-1",
				kind: "step.retry",
				runId: "run-retry-1",
				createdAt: TWO_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("skips a run parked on an unresolved human approval", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-appr",
				kind: "run.started",
				runId: "run-appr-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "appr-req",
				kind: "approval.requested",
				runId: "run-appr-1",
				createdAt: TEN_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("DOES sweep once the approval is resolved but the run still never terminated", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-appr2",
				kind: "run.started",
				runId: "run-appr-2",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "appr-req2",
				kind: "approval.requested",
				runId: "run-appr-2",
				createdAt: TEN_MIN_AGO,
			}),
			makeEvent({
				id: "appr-res2",
				kind: "approval.resolved",
				runId: "run-appr-2",
				createdAt: TEN_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates.map((c) => c.runId)).toEqual(["run-appr-2"]);
	});

	it("skips an optimistic container enqueue run after handoff to a completed runtime run", async () => {
		const conversationId = "agent:main:smoke-1";
		const db = createFakeDb(
			[
				makeEvent({
					id: "recv-dispatch",
					kind: "message.received",
					runId: "dispatch-key",
					conversationId,
					createdAt: OLD_BUT_ACTIVE,
				}),
				makeEvent({
					id: "rs-dispatch",
					kind: "run.started",
					runId: "dispatch-key",
					conversationId,
					createdAt: OLD_BUT_ACTIVE,
				}),
				makeEvent({
					id: "rs-backend",
					kind: "run.started",
					runId: "backend-run",
					conversationId,
					createdAt: TEN_MIN_AGO,
				}),
				makeEvent({
					id: "msg-backend",
					kind: "message.completed",
					runId: "backend-run",
					conversationId,
					createdAt: TEN_MIN_AGO,
				}),
				makeEvent({
					id: "rc-backend",
					kind: "run.completed",
					runId: "backend-run",
					conversationId,
					createdAt: TEN_MIN_AGO,
				}),
			],
			[
				{
					tediId: TEDI,
					conversationId,
					idempotencyKey: "dispatch-key",
					runId: "backend-run",
				},
			],
		);

		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);

		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(result.swept).toBe(0);
		expect(
			db.events.some(
				(e) => e.runId === "dispatch-key" && e.kind === "run.failed",
			),
		).toBe(false);
	});

	it("skips an optimistic container enqueue run while its mapped backend run is still active", async () => {
		const conversationId = "agent:main:smoke-2";
		const db = createFakeDb(
			[
				makeEvent({
					id: "rs-dispatch-active",
					kind: "run.started",
					runId: "dispatch-active-key",
					conversationId,
					createdAt: OLD_BUT_ACTIVE,
				}),
				makeEvent({
					id: "delta-backend-active",
					kind: "message.delta",
					runId: "backend-active-run",
					conversationId,
					createdAt: TWO_MIN_AGO,
				}),
			],
			[
				{
					tediId: TEDI,
					conversationId,
					idempotencyKey: "dispatch-active-key",
					runId: "backend-active-run",
				},
			],
		);

		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates).toEqual([]);
	});

	it("still sweeps an optimistic enqueue run when the mapped backend run has no proof", async () => {
		const conversationId = "agent:main:smoke-3";
		const db = createFakeDb(
			[
				makeEvent({
					id: "rs-dispatch-unproved",
					kind: "run.started",
					runId: "dispatch-unproved-key",
					conversationId,
					createdAt: OLD_BUT_ACTIVE,
				}),
			],
			[
				{
					tediId: TEDI,
					conversationId,
					idempotencyKey: "dispatch-unproved-key",
					runId: "backend-unproved-run",
				},
			],
		);

		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates.map((c) => c.runId)).toEqual(["dispatch-unproved-key"]);
	});

	it("seals a dropped-terminal SUCCESS (message.completed, no run.completed) as run.completed", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-lost",
				kind: "run.started",
				runId: "run-lost-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			// Turn produced a completed assistant message but the `run.completed`
			// write was lost. The sweep must NOT mislabel this
			// as failed/runtime_dropped.
			makeEvent({
				id: "msg-lost",
				kind: "message.completed",
				runId: "run-lost-1",
				createdAt: TEN_MIN_AGO,
			}),
		]);
		const candidates = await findOrphanRuns(
			db as unknown as Parameters<typeof findOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(candidates.map((c) => c.runId)).toEqual(["run-lost-1"]);
		expect(candidates[0]?.succeededLost).toBe(true);

		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(result.swept).toBe(1);
		expect(result.sweptRunIds).toEqual(["run-lost-1"]);

		// Sealed as success, NOT failure.
		const completed = db.events.find(
			(e) => e.runId === "run-lost-1" && e.kind === "run.completed",
		);
		expect(completed).toBeDefined();
		expect(
			db.events.some(
				(e) => e.runId === "run-lost-1" && e.kind === "run.failed",
			),
		).toBe(false);
		// `run.completed` carries no failure reason; provenance lives in metadata.
		expect(
			(completed?.payload as Record<string, unknown> | null)?.reason,
		).toBeUndefined();
		expect(
			(completed?.runtimeMetadata as Record<string, unknown> | null)
				?.recoveredFrom,
		).toBe("terminal_lost");
	});

	it.each([
		{ name: "generic artifact", kind: "artifact.created", payload: undefined },
		{
			name: "completed subprocess",
			kind: "artifact.created",
			payload: {
				artifact: {
					metadata: { eventType: "workstation.process.completed", exitCode: 0 },
				},
			},
		},
		{
			name: "failed reply",
			kind: "message.completed",
			payload: { status: "failed" },
		},
		{
			name: "error reply",
			kind: "message.completed",
			payload: { status: "error" },
		},
		{
			name: "canceled reply",
			kind: "message.completed",
			payload: { status: "canceled" },
		},
		{
			name: "cancelled reply",
			kind: "message.completed",
			payload: { status: "cancelled" },
		},
		{
			name: "error detail",
			kind: "message.completed",
			payload: { error: { message: "failed" } },
		},
	] satisfies Array<{
		name: string;
		kind: RuntimeEventRow["kind"];
		payload: RuntimeEventInsert["payload"];
	}>)("never promotes $name to a successful run", async ({ kind, payload }) => {
		const db = createFakeDb([
			makeEvent({
				id: "rs-art",
				kind: "run.started",
				runId: "run-art-1",
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "art-1",
				kind,
				payload,
				runId: "run-art-1",
				createdAt: TEN_MIN_AGO,
			}),
		]);
		const result = await sweepOrphanRuns(
			db as unknown as Parameters<typeof sweepOrphanRuns>[0],
			{
				now: NOW,
			},
		);
		expect(result.swept).toBe(1);
		expect(
			db.events.some(
				(e) => e.runId === "run-art-1" && e.kind === "run.completed",
			),
		).toBe(false);
		expect(
			db.events.some((e) => e.runId === "run-art-1" && e.kind === "run.failed"),
		).toBe(true);
	});
});

describe("orphan-run health", () => {
	it("is organization-scoped and reports an exact bounded result", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "org-1-orphan",
				runId: "org-1-run",
				organizationId: ORG,
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "org-2-orphan",
				runId: "org-2-run",
				organizationId: "org-2",
				createdAt: OLD_BUT_ACTIVE,
			}),
		]);

		const health = await getOrphanRunHealth(
			db as unknown as Parameters<typeof getOrphanRunHealth>[0],
			ORG,
			{ now: NOW, orphanAgeMinutes: 15, activityWindowMinutes: 5 },
		);

		expect(health).toMatchObject({
			organizationId: ORG,
			candidateCount: 1,
			candidateCountRelation: "exact",
			succeededLostCount: 0,
			succeededLostCountRelation: "exact",
			truncated: false,
		});
		expect(health.samples.map((sample) => sample.runId)).toEqual(["org-1-run"]);
	});

	it("does not let cross-org terminal, activity, or success rows suppress or reclassify a candidate", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "org-a-start",
				runId: "colliding-run",
				organizationId: ORG,
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "org-b-terminal",
				kind: "run.completed",
				runId: "colliding-run",
				organizationId: "org-2",
				createdAt: TEN_MIN_AGO,
			}),
			makeEvent({
				id: "org-b-progress",
				kind: "message.progress",
				runId: "colliding-run",
				organizationId: "org-2",
				createdAt: TWO_MIN_AGO,
			}),
			makeEvent({
				id: "org-b-success",
				kind: "message.completed",
				runId: "colliding-run",
				organizationId: "org-2",
				createdAt: TEN_MIN_AGO,
			}),
		]);

		const health = await getOrphanRunHealth(
			db as unknown as Parameters<typeof getOrphanRunHealth>[0],
			ORG,
			{ now: NOW, orphanAgeMinutes: 15, activityWindowMinutes: 5 },
		);

		expect(health.samples).toMatchObject([
			{ runId: "colliding-run", succeededLost: false },
		]);
	});

	it("does not let a cross-org approval resolution unpark a waiting run", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "approval-start",
				runId: "approval-run",
				organizationId: ORG,
				createdAt: OLD_BUT_ACTIVE,
			}),
			makeEvent({
				id: "approval-request",
				kind: "approval.requested",
				runId: "approval-run",
				organizationId: ORG,
				createdAt: TEN_MIN_AGO,
			}),
			makeEvent({
				id: "cross-org-resolution",
				kind: "approval.resolved",
				runId: "approval-run",
				organizationId: "org-2",
				createdAt: TEN_MIN_AGO,
			}),
		]);

		const health = await getOrphanRunHealth(
			db as unknown as Parameters<typeof getOrphanRunHealth>[0],
			ORG,
			{ now: NOW, orphanAgeMinutes: 15, activityWindowMinutes: 5 },
		);

		expect(health.candidateCount).toBe(0);
		expect(health.samples).toEqual([]);
	});

	it.each([ORG, "org-2"])(
		"ignores cross-org dispatch mappings and mapped-run evidence (%s)",
		async (mappingOrg) => {
			const conversationId = "agent:main:cross-org-map";
			const db = createFakeDb(
				[
					makeEvent({
						id: "mapped-start",
						runId: "optimistic-key",
						conversationId,
						organizationId: ORG,
						createdAt: OLD_BUT_ACTIVE,
					}),
					makeEvent({
						id: "mapped-terminal-other-org",
						kind: "run.completed",
						runId: "mapped-backend-run",
						organizationId: "org-2",
						createdAt: TEN_MIN_AGO,
					}),
				],
				[
					{
						tediId: TEDI,
						organizationId: mappingOrg,
						conversationId,
						idempotencyKey: "optimistic-key",
						runId: "mapped-backend-run",
					},
				],
			);

			const health = await getOrphanRunHealth(
				db as unknown as Parameters<typeof getOrphanRunHealth>[0],
				ORG,
				{ now: NOW, orphanAgeMinutes: 15, activityWindowMinutes: 5 },
			);

			expect(health.samples.map((sample) => sample.runId)).toEqual([
				"optimistic-key",
			]);
		},
	);

	it("labels capped counts as lower bounds and keeps succeeded-lost evidence", async () => {
		const db = createFakeDb([
			makeEvent({
				id: "oldest-start",
				runId: "oldest-success",
				createdAt: new Date(NOW.getTime() - 18 * 60_000).toISOString(),
			}),
			makeEvent({
				id: "oldest-message",
				kind: "message.completed",
				runId: "oldest-success",
				createdAt: TEN_MIN_AGO,
			}),
			makeEvent({
				id: "second-start",
				runId: "second-orphan",
				createdAt: new Date(NOW.getTime() - 17 * 60_000).toISOString(),
			}),
			makeEvent({
				id: "third-start",
				runId: "third-orphan",
				createdAt: OLD_BUT_ACTIVE,
			}),
		]);

		const health = await getOrphanRunHealth(
			db as unknown as Parameters<typeof getOrphanRunHealth>[0],
			ORG,
			{
				now: NOW,
				orphanAgeMinutes: 15,
				activityWindowMinutes: 5,
				sampleLimit: 1,
			},
		);

		expect(health).toMatchObject({
			candidateCount: 2,
			candidateCountRelation: "at_least",
			succeededLostCount: 1,
			succeededLostCountRelation: "at_least",
			truncated: true,
		});
		expect(health.samples).toMatchObject([
			{ runId: "oldest-success", succeededLost: true },
		]);
	});
});

// Silence vi unused-import lint
void vi;
