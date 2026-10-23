import { describe, expect, it } from "vite-plus/test";
import {
	KERNEL_RECONCILIATION_METADATA_KEY,
	homeDelegationApprovalExpiresAt,
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

describe("planRunReconciliation — held Home delegations", () => {
	const HOUR = 60 * 60 * 1000;
	const held = (input: {
		id?: string;
		createdAgoMs?: number;
		reason?: string;
		request?: string;
		target?: string;
		expiresAt?: string;
		childRunId?: string;
	}) =>
		run({
			id: input.id ?? "held-1",
			status: "requires_approval",
			createdAt: iso(input.createdAgoMs ?? HOUR),
			updatedAt: iso(input.createdAgoMs ?? HOUR),
			childRunId: input.childRunId ?? null,
			metadata: {
				approvalRequestId: null,
				homeDelegation: {
					workOrder: {
						kind: "tedi.delegate",
						status: "draft",
						targetTediId: input.target ?? "tedi-cto",
						targetTediLabel: "CTO",
						sourceContent:
							input.request ?? "Refactor the scheduler module in the repo.",
					},
					decision: {
						canAutoDispatch: false,
						mode: "needs_approval",
						reason: input.reason ?? "high risk requires human approval",
					},
					...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
				},
			},
		});
	const planWithTtl = (runs: LedgerRunRow[], approvalTtlHours?: number) =>
		planRunReconciliation({
			runs,
			approvals: new Map(),
			now: NOW,
			approvalTtlHours,
		});

	it("keeps a held delegation open inside the organization's review window", () => {
		expect(planWithTtl([held({ createdAgoMs: 23 * HOUR })], 24)).toEqual([]);
	});

	it("expires a held delegation once the review window passes, without approving it", () => {
		const actions = planWithTtl([held({ createdAgoMs: 25 * HOUR })], 24);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			kind: "mark_expired",
			runId: "held-1",
			expectedStatus: "requires_approval",
			patchStatus: "canceled",
			progressLabel: "Approval expired",
			approvalRequestId: null,
		});
		expect(actions[0]?.reason).toMatch(/^no decision before it expired at /);
		expect(actions[0]?.operatorMessage).toMatch(/Nothing was dispatched/);
	});

	it("prefers the expiry stamped when Home parked the card over the org TTL", () => {
		expect(
			planWithTtl(
				[held({ createdAgoMs: 30 * HOUR, expiresAt: iso(-HOUR) })],
				24,
			),
		).toEqual([]);
		expect(
			planWithTtl([held({ createdAgoMs: HOUR, expiresAt: iso(60_000) })]),
		).toHaveLength(1);
	});

	it("takes no TTL action when neither a stamp nor an org TTL is known", () => {
		expect(planWithTtl([held({ createdAgoMs: 900 * HOUR })])).toEqual([]);
	});

	it("expires the older of two identical requests and keeps the newest", () => {
		const actions = planWithTtl(
			[
				held({ id: "older", createdAgoMs: 2 * HOUR }),
				held({ id: "newer", createdAgoMs: HOUR }),
				held({
					id: "other-target",
					createdAgoMs: 3 * HOUR,
					target: "tedi-cfo",
				}),
			],
			24,
		);
		expect(actions.map((action) => action.runId)).toEqual(["older"]);
		expect(actions[0]?.reason).toBe(
			"a newer identical request is waiting for approval (run newer)",
		);
	});

	it("treats context tokens and whitespace as the same request", () => {
		const actions = planWithTtl(
			[
				held({
					id: "older",
					createdAgoMs: 2 * HOUR,
					request: "[[tedix-context:output:abc:Output]]\n\nShip  the fix.",
				}),
				held({ id: "newer", request: "Ship the fix." }),
			],
			24,
		);
		expect(actions.map((action) => action.runId)).toEqual(["older"]);
	});

	it("expires a human-reserved hold whose classes no longer match the request", () => {
		const actions = planWithTtl(
			[
				held({
					reason: "human-reserved: money, external_message",
					request:
						"Draft only: create an invoice draft with 7-day payment terms for order Buy-20116. Do not finalize, send or book.",
				}),
			],
			24,
		);
		expect(actions).toHaveLength(1);
		expect(actions[0]?.reason).toBe(
			"the hold reason (money, external_message) no longer applies under the current approval policy",
		);
	});

	it("keeps a human-reserved hold that still matches the request", () => {
		expect(
			planWithTtl(
				[
					held({
						reason: "human-reserved: external_message",
						request: "Email the customer that their account is closed.",
					}),
				],
				24,
			),
		).toEqual([]);
	});

	it("leaves dispatched and row-backed approvals to their own paths", () => {
		expect(
			planWithTtl(
				[held({ createdAgoMs: 900 * HOUR, childRunId: "child-1" })],
				24,
			),
		).toEqual([]);
		const rowBacked = held({ createdAgoMs: 900 * HOUR });
		rowBacked.metadata = { ...rowBacked.metadata, approvalRequestId: "appr-1" };
		expect(
			planRunReconciliation({
				runs: [rowBacked],
				approvals: new Map([
					[
						"appr-1",
						{ id: "appr-1", status: "pending", expiresAt: iso(-HOUR) },
					],
				]),
				now: NOW,
				approvalTtlHours: 24,
			}),
		).toEqual([]);
	});
});

describe("homeDelegationApprovalExpiresAt", () => {
	it("derives the window from creation plus the organization TTL", () => {
		expect(
			homeDelegationApprovalExpiresAt(
				{
					createdAt: "2026-10-20 10:00:00",
					metadata: { homeDelegation: { workOrder: {} } },
				},
				48,
			),
		).toBe("2026-10-22T10:00:00.000Z");
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
