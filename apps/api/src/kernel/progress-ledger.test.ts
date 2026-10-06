import { describe, expect, it } from "vite-plus/test";
import {
	KERNEL_RECONCILIATION_METADATA_KEY,
	type LedgerApprovalRow,
	type LedgerRunRow,
	MAX_LEDGER_ACTIONS_PER_SWEEP,
	parseLedgerTimestamp,
	planRunReconciliation,
	STALL_QUEUED_MS,
	STALL_RUNNING_MS,
	terminalChildOutcomeFromStatus,
} from "./progress-ledger";

const CONVERSATION_ID = "home:main";
/** Fixed "now" for determinism (UTC). */
const NOW = Date.parse("2026-06-11T12:00:00.000Z");

function iso(msAgo: number): string {
	return new Date(NOW - msAgo).toISOString();
}

function run(input: Partial<LedgerRunRow>): LedgerRunRow {
	return {
		id: input.id ?? "run-1",
		conversationId: input.conversationId ?? CONVERSATION_ID,
		status: input.status ?? "running",
		createdAt: input.createdAt ?? iso(60 * 60 * 1000),
		updatedAt: input.updatedAt ?? iso(0),
		childRunId: input.childRunId ?? null,
		delegatedTediId: input.delegatedTediId ?? null,
		metadata: input.metadata ?? null,
	};
}

function plan(
	runs: LedgerRunRow[],
	approvals: Array<LedgerApprovalRow> = [],
	now = NOW,
) {
	return planRunReconciliation({
		runs,
		approvals: new Map(approvals.map((approval) => [approval.id, approval])),
		now,
	});
}

describe("parseLedgerTimestamp", () => {
	it("parses ISO strings", () => {
		expect(parseLedgerTimestamp("2026-06-11T12:00:00.000Z")).toBe(NOW);
	});

	it("parses D1 CURRENT_TIMESTAMP format as UTC regardless of host zone", () => {
		expect(parseLedgerTimestamp("2026-06-11 12:00:00")).toBe(NOW);
	});

	it("returns null for null/empty/garbage", () => {
		expect(parseLedgerTimestamp(null)).toBeNull();
		expect(parseLedgerTimestamp(undefined)).toBeNull();
		expect(parseLedgerTimestamp("")).toBeNull();
		expect(parseLedgerTimestamp("not-a-date")).toBeNull();
	});
});

describe("planRunReconciliation — stalled running runs", () => {
	it("takes no action on a fresh running run", () => {
		expect(
			plan([run({ status: "running", updatedAt: iso(60 * 1000) })]),
		).toEqual([]);
	});

	it("takes no action exactly at the threshold boundary minus one ms", () => {
		expect(
			plan([run({ status: "running", updatedAt: iso(STALL_RUNNING_MS - 1) })]),
		).toEqual([]);
	});

	it("marks a stale running run with no child as stalled (failed)", () => {
		const actions = plan([
			run({ status: "running", updatedAt: iso(STALL_RUNNING_MS + 1) }),
		]);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			kind: "mark_stalled",
			runId: "run-1",
			expectedStatus: "running",
			patchStatus: "failed",
			eventKind: "run.failed",
			approvalRequestId: null,
		});
	});

	it("skips a stale running run WITH a childRunId (child reconciliation owns it)", () => {
		expect(
			plan([
				run({
					status: "running",
					updatedAt: iso(STALL_RUNNING_MS + 1),
					childRunId: "child-1",
				}),
			]),
		).toEqual([]);
	});

	it("skips a stale running run with a delegatedTediId", () => {
		expect(
			plan([
				run({
					status: "running",
					updatedAt: iso(STALL_RUNNING_MS + 1),
					delegatedTediId: "tedi-1",
				}),
			]),
		).toEqual([]);
	});

	it("never re-processes a run already carrying the reconciliation marker", () => {
		expect(
			plan([
				run({
					status: "running",
					updatedAt: iso(STALL_RUNNING_MS + 1),
					metadata: {
						[KERNEL_RECONCILIATION_METADATA_KEY]: {
							action: "mark_stalled",
							at: iso(0),
						},
					},
				}),
			]),
		).toEqual([]);
	});

	it("takes no action when updatedAt is unparseable (when in doubt, no action)", () => {
		expect(plan([run({ status: "running", updatedAt: "garbage" })])).toEqual(
			[],
		);
		expect(plan([run({ status: "running", updatedAt: null })])).toEqual([]);
	});
});

describe("planRunReconciliation — queued runs", () => {
	it("takes no action on a queued run younger than the queued threshold", () => {
		// Older than the RUNNING threshold but younger than the QUEUED one —
		// proves the queued threshold (not the running one) applies.
		expect(
			plan([run({ status: "queued", updatedAt: iso(STALL_QUEUED_MS - 1) })]),
		).toEqual([]);
	});

	it("marks a stale queued run with no child/delegation as stalled", () => {
		const actions = plan([
			run({ status: "queued", updatedAt: iso(STALL_QUEUED_MS + 1) }),
		]);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			kind: "mark_stalled",
			expectedStatus: "queued",
			patchStatus: "failed",
			eventKind: "run.failed",
		});
	});

	it("skips a stale queued run with delegation metadata", () => {
		for (const metadata of [
			{ delegationWorkOrder: { goal: "x" } },
			{ homePlan: { steps: [] } },
			{ delegatedTediId: "tedi-1" },
		]) {
			expect(
				plan([
					run({
						status: "queued",
						updatedAt: iso(STALL_QUEUED_MS + 1),
						metadata,
					}),
				]),
			).toEqual([]);
		}
	});
});

describe("planRunReconciliation — requires_approval runs", () => {
	const approvalRun = (metadata: Record<string, unknown> | null) =>
		run({
			status: "requires_approval",
			updatedAt: iso(2 * 60 * 60 * 1000),
			metadata,
		});

	it("takes no action while the approval is pending and unexpired", () => {
		expect(
			plan(
				[approvalRun({ approvalRequestId: "appr-1" })],
				[{ id: "appr-1", status: "pending", expiresAt: iso(-60 * 60 * 1000) }],
			),
		).toEqual([]);
	});

	it("marks the run canceled when the pending approval's expiresAt has passed", () => {
		const actions = plan(
			[approvalRun({ approvalRequestId: "appr-1" })],
			[{ id: "appr-1", status: "pending", expiresAt: iso(60 * 1000) }],
		);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			kind: "mark_expired",
			expectedStatus: "requires_approval",
			patchStatus: "canceled",
			eventKind: "run.canceled",
			approvalRequestId: "appr-1",
		});
	});

	it("marks the run canceled when the approval row was already patched to expired", () => {
		const actions = plan(
			[approvalRun({ approvalRequestId: "appr-1" })],
			// expiresAt in the future but status already "expired" (e.g. via
			// expireStaleApprovals) — status wins.
			[{ id: "appr-1", status: "expired", expiresAt: iso(-60 * 60 * 1000) }],
		);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.kind).toBe("mark_expired");
	});

	it("takes no action on resolved (approved/rejected/cancelled) approvals", () => {
		for (const status of ["approved", "rejected", "cancelled"]) {
			expect(
				plan(
					[approvalRun({ approvalRequestId: "appr-1" })],
					[{ id: "appr-1", status, expiresAt: iso(60 * 1000) }],
				),
			).toEqual([]);
		}
	});

	it("takes no action when the approval row is missing or unreferenced", () => {
		// Missing row → cannot prove expiry.
		expect(plan([approvalRun({ approvalRequestId: "appr-1" })], [])).toEqual(
			[],
		);
		// No approvalRequestId in metadata at all.
		expect(plan([approvalRun(null)], [])).toEqual([]);
		expect(plan([approvalRun({})], [])).toEqual([]);
	});

	it("never re-processes an already-marked requires_approval run", () => {
		expect(
			plan(
				[
					approvalRun({
						approvalRequestId: "appr-1",
						[KERNEL_RECONCILIATION_METADATA_KEY]: { action: "mark_expired" },
					}),
				],
				[{ id: "appr-1", status: "expired", expiresAt: iso(60 * 1000) }],
			),
		).toEqual([]);
	});
});

describe("planRunReconciliation — batch behavior", () => {
	it("ignores terminal/unknown statuses defensively", () => {
		expect(
			plan([
				run({ status: "completed", updatedAt: iso(STALL_RUNNING_MS + 1) }),
				run({
					id: "run-2",
					status: "failed",
					updatedAt: iso(STALL_RUNNING_MS + 1),
				}),
				run({
					id: "run-3",
					status: "mystery",
					updatedAt: iso(STALL_RUNNING_MS + 1),
				}),
			]),
		).toEqual([]);
	});

	it("caps actions per sweep and reconciles oldest-first", () => {
		const runs = Array.from(
			{ length: MAX_LEDGER_ACTIONS_PER_SWEEP + 5 },
			(_, index) =>
				run({
					id: `run-${String(index).padStart(2, "0")}`,
					status: "running",
					// run-00 is the YOUNGEST eligible, run-14 the oldest.
					updatedAt: iso(STALL_RUNNING_MS + 1000 + index * 60 * 1000),
				}),
		);
		const actions = plan(runs);
		expect(actions).toHaveLength(MAX_LEDGER_ACTIONS_PER_SWEEP);
		// Oldest (largest msAgo → highest index) first; the 5 youngest are cut.
		expect(actions[0]?.runId).toBe("run-14");
		expect(actions.at(-1)?.runId).toBe("run-05");
		expect(actions.map((action) => action.runId)).not.toContain("run-00");
	});

	it("is deterministic for identical timestamps (stable id tiebreaker)", () => {
		const updatedAt = iso(STALL_RUNNING_MS + 1);
		const a = plan([
			run({ id: "run-b", updatedAt }),
			run({ id: "run-a", updatedAt }),
		]);
		const b = plan([
			run({ id: "run-a", updatedAt }),
			run({ id: "run-b", updatedAt }),
		]);
		expect(a.map((action) => action.runId)).toEqual(["run-a", "run-b"]);
		expect(b.map((action) => action.runId)).toEqual(["run-a", "run-b"]);
	});

	it("mixes stall and expiry actions in one sweep", () => {
		const actions = plan(
			[
				run({
					id: "run-stalled",
					status: "running",
					updatedAt: iso(STALL_RUNNING_MS + 1),
				}),
				run({
					id: "run-expired",
					status: "requires_approval",
					updatedAt: iso(2 * STALL_RUNNING_MS),
					metadata: { approvalRequestId: "appr-1" },
				}),
			],
			[{ id: "appr-1", status: "expired", expiresAt: iso(60 * 1000) }],
		);
		expect(actions.map((action) => [action.runId, action.kind]).sort()).toEqual(
			[
				["run-expired", "mark_expired"],
				["run-stalled", "mark_stalled"],
			],
		);
	});
});

describe("terminalChildOutcomeFromStatus", () => {
	it("propagates only a failed/canceled child outcome to the parent", () => {
		expect(terminalChildOutcomeFromStatus("failed")).toBe("failed");
		expect(terminalChildOutcomeFromStatus("canceled")).toBe("canceled");
	});

	it("leaves a completed or still-live child untouched (parent not terminalized)", () => {
		expect(terminalChildOutcomeFromStatus("completed")).toBe(null);
		expect(terminalChildOutcomeFromStatus("running")).toBe(null);
		expect(terminalChildOutcomeFromStatus("streaming")).toBe(null);
		expect(terminalChildOutcomeFromStatus("queued")).toBe(null);
		expect(terminalChildOutcomeFromStatus(undefined)).toBe(null);
		expect(terminalChildOutcomeFromStatus(null)).toBe(null);
	});
});
