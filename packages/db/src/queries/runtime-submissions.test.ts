import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { admitSubmission } from "./runtime-submissions/admission";
import {
	reopenSubmissionForOperatorRestart,
	startAttempt,
} from "./runtime-submissions/attempts";
import {
	advanceSubmissionPhase,
	requestSubmissionAbort,
	stampInputApplied,
} from "./runtime-submissions/phase-transitions";
import {
	getSubmissionById,
	listAttemptsBySubmission,
	listPendingReservedSubmissions,
} from "./runtime-submissions/read-models";
import {
	isTerminalSubmissionStatus,
	settleSubmission,
} from "./runtime-submissions/settlement";

/**
 * Minimal drizzle-shaped test double. Each terminal op kind (insert/update/
 * select) resolves to the next canned result queued for it; chain methods are
 * self-similar and the node is awaitable at any depth, so it tolerates the
 * varied builder chains (.values().onConflictDoNothing().returning(),
 * .set().where().returning(), .from().where().limit(), …) used by the queries.
 */
type Rows = unknown[];
function makeDb(script: {
	insert?: Rows[];
	update?: Rows[];
	select?: Rows[];
}): DbClient {
	const queues = {
		insert: [...(script.insert ?? [])],
		update: [...(script.update ?? [])],
		select: [...(script.select ?? [])],
	};
	const node = (kind: "insert" | "update" | "select"): unknown =>
		new Proxy(() => {}, {
			get(_target, prop) {
				if (prop === "then") {
					const rows = queues[kind].shift() ?? [];
					const settled = Promise.resolve(rows);
					return settled.then.bind(settled);
				}
				return () => node(kind);
			},
			apply() {
				return node(kind);
			},
		});
	return {
		insert: () => node("insert"),
		update: () => node("update"),
		select: () => node("select"),
	} as unknown as DbClient;
}

describe("runtime submissions", () => {
	it("classifies terminal submission statuses", () => {
		expect(isTerminalSubmissionStatus("settled")).toBe(true);
		expect(isTerminalSubmissionStatus("failed")).toBe(true);
		expect(isTerminalSubmissionStatus("canceled")).toBe(true);
		expect(isTerminalSubmissionStatus("admitted")).toBe(false);
		expect(isTerminalSubmissionStatus("running")).toBe(false);
		// The reserved latch is deliberately non-terminal: it is mid-settle and
		// the reserved sweep must be able to re-drive finalize.
		expect(isTerminalSubmissionStatus("reserved")).toBe(false);
	});

	it("admits a new submission", async () => {
		const db = makeDb({
			insert: [[{ id: "sub-1", status: "admitted", organizationId: "org-1" }]],
		});
		const sub = await admitSubmission(db, {
			organizationId: "org-1",
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
			sourceKind: "home",
		});
		expect(sub.id).toBe("sub-1");
		expect(sub.status).toBe("admitted");
	});

	it("returns the existing submission by id on conflict (idempotent re-admit)", async () => {
		const db = makeDb({
			insert: [[]],
			select: [
				[{ id: "sub:run-1", status: "running", organizationId: "org-1" }],
			],
		});
		const sub = await admitSubmission(db, {
			id: "sub:run-1",
			organizationId: "org-1",
			subjectKind: "kernel",
			subjectId: "kernel:org-1",
			sourceKind: "home",
		});
		expect(sub.id).toBe("sub:run-1");
	});

	it("starts an attempt and marks the submission running", async () => {
		const db = makeDb({
			select: [
				[
					{
						id: "sub-1",
						organizationId: "org-1",
						attemptCount: 0,
						runtimeBackend: null,
					},
				],
			],
			insert: [
				[
					{
						id: "att-x",
						submissionId: "sub-1",
						attemptNo: 1,
						status: "started",
					},
				],
			],
			update: [[{ id: "sub-1", status: "running", attemptCount: 1 }]],
		});
		const result = await startAttempt(db, {
			submissionId: "sub-1",
			organizationId: "org-1",
		});
		expect(result.attempt?.attemptNo).toBe(1);
		expect(result.submission?.status).toBe("running");
	});

	it("settles a submission exactly once (reserve→finalize)", async () => {
		const db = makeDb({
			select: [
				// settle #1: pre-read → non-terminal (running) so it reserves
				[{ id: "sub-1", status: "running", currentAttemptId: "att-1" }],
				// settle #2: pre-read → already terminal, short-circuits to no-op
				[{ id: "sub-1", status: "settled", currentAttemptId: "att-1" }],
			],
			update: [
				// settle #1 Step A: reserve CAS wins
				[{ id: "sub-1", status: "reserved", currentAttemptId: "att-1" }],
				// settle #1 Step B: finalize CAS commits the terminal transition
				[{ id: "sub-1", status: "settled", currentAttemptId: "att-1" }],
				// settle #1: attempt finalize (no row consumed by callers)
				[{ id: "att-1", status: "settled" }],
			],
		});
		const first = await settleSubmission(db, {
			submissionId: "sub-1",
			organizationId: "org-1",
			outcome: "settled",
			attemptId: "att-1",
		});
		expect(first.settled).toBe(true);

		const second = await settleSubmission(db, {
			submissionId: "sub-1",
			organizationId: "org-1",
			outcome: "settled",
			attemptId: "att-1",
		});
		expect(second.settled).toBe(false);
	});

	it("refuses to settle a newer workflow restart epoch from a stale reconciler", async () => {
		const db = makeDb({
			select: [
				[
					{
						id: "sub:run-1",
						status: "running",
						organizationId: "org-1",
						metadata: { workflowExecutionEpoch: 2 },
					},
				],
			],
		});
		const result = await settleSubmission(db, {
			submissionId: "sub:run-1",
			organizationId: "org-1",
			outcome: "settled",
			expectedWorkflowExecutionEpoch: 1,
		});
		expect(result.settled).toBe(false);
		expect(result.submission?.metadata?.workflowExecutionEpoch).toBe(2);
	});
});

const REAL_DDL = `
CREATE TABLE runtime_submissions (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL,
	subject_kind TEXT NOT NULL,
	subject_id TEXT NOT NULL,
	tedi_id TEXT,
	conversation_id TEXT,
	run_id TEXT,
	idempotency_key TEXT,
	source_kind TEXT NOT NULL,
	source_provider TEXT,
	source_delivery_id TEXT,
	status TEXT NOT NULL DEFAULT 'admitted',
	current_attempt_id TEXT,
	attempt_count INTEGER NOT NULL DEFAULT 0,
	runtime_backend TEXT,
	metadata TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	settled_at TEXT,
	timeout_at TEXT,
	phase TEXT,
	input_applied_at TEXT,
	abort_requested_at TEXT,
	max_retry INTEGER NOT NULL DEFAULT 10
);
CREATE UNIQUE INDEX uniq_runtime_submissions_delivery
	ON runtime_submissions (organization_id, source_provider, source_delivery_id);
CREATE TABLE runtime_submission_attempts (
	id TEXT PRIMARY KEY NOT NULL,
	submission_id TEXT NOT NULL,
	organization_id TEXT NOT NULL,
	attempt_no INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'started',
	runtime_backend TEXT,
	runtime_external_id TEXT,
	error TEXT,
	metadata TEXT,
	started_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	heartbeat_at TEXT,
	completed_at TEXT
);
CREATE UNIQUE INDEX uniq_runtime_submission_attempts_no
	ON runtime_submission_attempts (submission_id, attempt_no);
`;

/** Fresh in-memory SQLite engine running the real submission DDL. */
function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return createDbClient(createD1Facade(sqlite));
}

/**
 * Like realDb but also returns the raw engine, so a test can strand a row in the
 * non-terminal `reserved` latch directly — simulating a runtime that won the
 * settle CAS (Step A) and recorded its intended outcome, then died before the
 * finalize (Step B) committed. There is no public producer of that exact
 * mid-settle crash state, so we craft it.
 */
function realDbWithEngine(): { db: DbClient; sqlite: DatabaseSync } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(REAL_DDL);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

/**
 * Behavioral guard tests against a REAL in-memory SQLite engine (not the
 * op-kind test double above). These exercise the actual conditional UPDATE /
 * onConflict WHERE clauses, so deleting an exactly-once guard makes a test fail
 * — the coverage the canned double cannot give (it returns scripted rows
 * regardless of the WHERE clause).
 */
describe("runtime submissions — exactly-once guards (real sqlite)", () => {
	const base = {
		organizationId: "org-1",
		subjectKind: "kernel" as const,
		subjectId: "kernel:org-1",
		sourceKind: "home" as const,
	};

	it("settles exactly once: a duplicate settle is a no-op and never re-stamps", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:run-1", ...base });
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });

		const first = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});
		expect(first.settled).toBe(true);
		expect(first.submission?.status).toBe("settled");
		const settledRow = await getSubmissionById(db, sub.id, "org-1");
		expect(settledRow?.settledAt).toBeTruthy();

		// Second settle with a DIFFERENT outcome: the status guard matches no
		// non-terminal row, so it must be inert and must not overwrite the row.
		const second = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
		});
		expect(second.settled).toBe(false);
		const afterRow = await getSubmissionById(db, sub.id, "org-1");
		expect(afterRow?.status).toBe("settled");
		expect(afterRow?.settledAt).toBe(settledRow?.settledAt);
	});

	it("re-drives a stranded reserved row to its recorded outcome exactly once", async () => {
		const { db, sqlite } = realDbWithEngine();
		const sub = await admitSubmission(db, { id: "sub:run-r1", ...base });
		const { attempt } = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		// Strand the row mid-settle: latch won (status=reserved), intended outcome
		// recorded, finalize never ran. updated_at is backdated so the sweep sees it.
		sqlite
			.prepare(
				`UPDATE runtime_submissions
				 SET status = 'reserved',
				     metadata = ?,
				     current_attempt_id = ?,
				     updated_at = '2000-01-01T00:00:00.000Z'
				 WHERE id = ?`,
			)
			.run(
				JSON.stringify({ reservedOutcome: "failed" }),
				attempt?.id ?? null,
				sub.id,
			);

		// The reserved sweep surfaces it; isTerminal stays false.
		const pending = await listPendingReservedSubmissions(
			db,
			"org-1",
			new Date().toISOString(),
		);
		expect(pending.map((p) => p.id)).toContain(sub.id);
		expect(isTerminalSubmissionStatus("reserved")).toBe(false);

		// First re-drive finalizes from the RECORDED outcome (failed), ignoring the
		// outcome the caller passes — the latch already decided.
		const first = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});
		expect(first.settled).toBe(true);
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("failed");
		expect(row?.settledAt).toBeTruthy();
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts[0]?.status).toBe("failed");

		// A second re-drive is inert (already terminal) — exactly-once preserved.
		const second = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
		});
		expect(second.settled).toBe(false);

		// And it no longer appears in the reserved sweep.
		const afterPending = await listPendingReservedSubmissions(
			db,
			"org-1",
			new Date().toISOString(),
		);
		expect(afterPending.map((p) => p.id)).not.toContain(sub.id);
	});

	it("records reservedOutcome on the reserve step so a sweep can finalize", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:run-r2", ...base });
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });
		// A normal end-to-end settle still completes in one call (reserve+finalize),
		// and the terminal row carries the reservedOutcome stamped during Step A.
		const res = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "canceled",
		});
		expect(res.settled).toBe(true);
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("canceled");
		expect(
			(row?.metadata as Record<string, unknown> | null)?.reservedOutcome,
		).toBe("canceled");
	});

	it("does not resurrect a terminal submission via a late startAttempt", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:run-2", ...base });
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });
		await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});

		const late = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		// Guarded UPDATE matched nothing → no submission row returned, status holds.
		expect(late.submission).toBeUndefined();
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("settled");
	});

	it("reopens a terminal submission as a new CAS-guarded restart attempt", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:run-restart", ...base });
		await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});

		const restarted = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			runtimeExternalId: "run-restart",
		});
		expect(restarted).toMatchObject({
			reopened: true,
			alreadyRunning: false,
		});
		expect(restarted.attempt?.attemptNo).toBe(2);
		expect(restarted.submission?.status).toBe("running");
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.map((attempt) => attempt.status)).toEqual([
			"settled",
			"started",
		]);

		const duplicate = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		expect(duplicate).toMatchObject({
			reopened: false,
			alreadyRunning: true,
		});
		expect(await listAttemptsBySubmission(db, sub.id)).toHaveLength(2);
	});

	it("keys active and terminal-fast workflow restart attempts by restart id and epoch", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, {
			id: "sub:run-active-restart",
			...base,
		});
		await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});

		const restarted = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			restartId: "restart-1",
			executionEpoch: 1,
			runtimeExternalId: "run-active-restart",
		});
		expect(restarted).toMatchObject({
			reopened: true,
			alreadyRunning: false,
		});
		const activeAttempts = await listAttemptsBySubmission(db, sub.id);
		expect(activeAttempts.map((attempt) => attempt.status)).toEqual([
			"canceled",
			"started",
		]);
		expect(restarted.attempt?.attemptNo).toBe(2);

		await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});
		const duplicateAfterSettle = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			restartId: "restart-1",
			executionEpoch: 1,
		});
		expect(duplicateAfterSettle).toMatchObject({
			reopened: false,
			alreadyRunning: true,
		});
		expect(await listAttemptsBySubmission(db, sub.id)).toHaveLength(2);
	});

	it("burns an exact no-start operator restart epoch as canceled", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, {
			id: "sub:run-aborted-restart",
			...base,
		});
		await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});

		const reopened = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			restartId: "restart-aborted",
			executionEpoch: 1,
			runtimeExternalId: "run-aborted-restart",
		});
		expect(reopened).toMatchObject({
			reopened: true,
			alreadyRunning: false,
		});
		expect(reopened.submission?.metadata).toMatchObject({
			workflowRestartId: "restart-aborted",
			workflowExecutionEpoch: 1,
		});

		const canceled = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "canceled",
			expectedWorkflowExecutionEpoch: 1,
		});
		expect(canceled.settled).toBe(true);
		expect(canceled.submission?.status).toBe("canceled");
		expect(
			(await listAttemptsBySubmission(db, sub.id)).map(
				(attempt) => attempt.status,
			),
		).toEqual(["canceled", "canceled"]);

		const duplicateSettle = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "canceled",
			expectedWorkflowExecutionEpoch: 1,
		});
		expect(duplicateSettle.settled).toBe(false);
		expect(duplicateSettle.submission?.status).toBe("canceled");
		const duplicateOpen = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			restartId: "restart-aborted",
			executionEpoch: 1,
		});
		expect(duplicateOpen).toMatchObject({
			reopened: false,
			alreadyRunning: true,
		});
		expect(await listAttemptsBySubmission(db, sub.id)).toHaveLength(2);
	});

	it("repairs a restart epoch stranded before its attempt was appended", async () => {
		const { db, sqlite } = realDbWithEngine();
		const sub = await admitSubmission(db, {
			id: "sub:run-restart-recovery",
			...base,
		});
		await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});

		// Simulate a crash after terminal -> admitted CAS and before startAttempt.
		sqlite
			.prepare(
				`UPDATE runtime_submissions
				 SET status = 'admitted', current_attempt_id = NULL, settled_at = NULL
				 WHERE id = ?`,
			)
			.run(sub.id);

		const recovered = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			runtimeExternalId: "run-restart-recovery",
		});
		expect(recovered).toMatchObject({
			reopened: true,
			alreadyRunning: false,
		});
		expect(recovered.attempt?.attemptNo).toBe(2);
		expect(recovered.submission?.currentAttemptId).toBe(recovered.attempt?.id);
	});

	it("is idempotent on the deterministic id (re-admit returns the same row)", async () => {
		const db = realDb();
		const a = await admitSubmission(db, { id: "sub:run-3", ...base });
		const b = await admitSubmission(db, { id: "sub:run-3", ...base });
		expect(b.id).toBe(a.id);
		const row = await getSubmissionById(db, "sub:run-3", "org-1");
		expect(row?.id).toBe("sub:run-3");
	});

	it("assigns monotonic attempt numbers under the unique (submission, attemptNo) index", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:run-4", ...base });
		const a1 = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		const a2 = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		expect(a1.attempt?.attemptNo).toBe(1);
		expect(a2.attempt?.attemptNo).toBe(2);
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
	});
});

/**
 * RECOVERY-TURN leg of the fault-injection taxonomy (tau-agent: persistent-fail /
 * single-transient / mid-stream-cut / RECOVERY-TURN): a runtime crash mid-turn,
 * the kernel sweep's re-drive, and exactly-once settlement across the original
 * and recovered turns. Runs the same real in-memory SQLite engine + prod query
 * path as the guard tests above.
 *
 * The pure recovery gates (decideTediSubmissionRecovery / decideKernelRedrive in
 * apps/api/src/kernel/runtime-submission-bridge.ts) are deliberately NOT imported
 * — packages/db must not depend on apps/api — so their load-bearing inputs are
 * asserted as plain row data instead: the requeue gate demands AFFIRMATIVE
 * `phase === "admitted"` AND `inputAppliedAt == null` (a NULL phase proves
 * nothing and conservatively fails — it never requeues), and the durable budget
 * gate reads `attemptCount >= maxRetry`. These tests prove the ledger durably
 * persists those gate inputs across a crash; the gates' own branch logic is
 * covered in apps/api. The re-drive mechanics exercised here
 * (startAttempt(recovered: true)) are the kernel redrive sweep's ledger path
 * (kernel-do.ts) and the contract for the pending tedi requeue executor.
 */
describe("recovery turn (fault-injection: crash → re-drive → exactly-once settle)", () => {
	const base = {
		organizationId: "org-1",
		subjectKind: "tedi" as const,
		subjectId: "tedi-1",
		sourceKind: "tedi_message" as const,
	};

	it("re-drives a turn that crashed before input: recovered attempt appends monotonically", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, {
			id: "sub:recover-pre-input",
			...base,
		});
		const first = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		expect(first.attempt?.attemptNo).toBe(1);
		expect(first.attempt?.status).toBe("started");
		expect(first.submission?.status).toBe("running");

		// CRASH BEFORE INPUT: the runtime died before emitting run.started, so no
		// phase advance and no input stamp ever happened — the durable row reads
		// the affirmative admit-time journal stamp (phase = "admitted", written
		// atomically in the admit INSERT) + inputAppliedAt NULL. This is exactly
		// the POSITIVE evidence the tedi requeue gate demands (phase === "admitted"
		// AND input never applied). What must hold at the ledger regardless of the
		// gate's verdict: a sweep re-drive appends monotonically and never forks
		// the attempt journal.
		const crashed = await getSubmissionById(db, sub.id, "org-1");
		expect(crashed?.inputAppliedAt).toBeNull();
		expect(crashed?.phase).toBe("admitted");

		// Sweep re-drive: revive as a recovered attempt on the same submission.
		const redriven = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		expect(redriven.attempt?.attemptNo).toBe(2);
		expect(redriven.attempt?.status).toBe("recovered");
		expect(redriven.submission?.status).toBe("running");
		expect(redriven.submission?.attemptCount).toBe(2);
		expect(redriven.submission?.currentAttemptId).toBe(redriven.attempt?.id);
		// Monotonic attempt journal under the (submission, attemptNo) unique index.
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
		expect(attempts.map((a) => a.status)).toEqual(["started", "recovered"]);
	});

	it("makes a mid-execution crash visible: phase and inputAppliedAt persist and never regress", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, {
			id: "sub:recover-mid-exec",
			...base,
		});
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });

		// The runtime reached the provider before crashing: journal it.
		const advanced = await advanceSubmissionPhase(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			phase: "provider_started",
		});
		expect(advanced.advanced).toBe(true);
		const appliedAtIso = "2026-01-01T00:00:00.000Z";
		const stamped = await stampInputApplied(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			appliedAtIso,
		});
		expect(stamped.stamped).toBe(true);

		// The crash evidence is durable: a sweep reading the row sees mid-execution.
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.phase).toBe("provider_started");
		expect(row?.inputAppliedAt).toBe(appliedAtIso);

		// Monotonic contract: regressing to an earlier phase matches zero rows
		// (advanceSubmissionPhase's WHERE only accepts NULL or strictly-lower)…
		const regress = await advanceSubmissionPhase(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			phase: "admitted",
		});
		expect(regress.advanced).toBe(false);
		// …a re-sent same-phase event is equally inert…
		const resend = await advanceSubmissionPhase(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			phase: "provider_started",
		});
		expect(resend.advanced).toBe(false);
		// …forward motion still works, and the higher phase also refuses regression.
		const forward = await advanceSubmissionPhase(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			phase: "tool_request_recorded",
		});
		expect(forward.advanced).toBe(true);
		const regressFromHigher = await advanceSubmissionPhase(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			phase: "provider_started",
		});
		expect(regressFromHigher.advanced).toBe(false);
		const after = await getSubmissionById(db, sub.id, "org-1");
		expect(after?.phase).toBe("tool_request_recorded");

		// The input stamp is exactly-once: a replayed run.started never re-stamps.
		const restamp = await stampInputApplied(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			appliedAtIso: "2026-02-02T00:00:00.000Z",
		});
		expect(restamp.stamped).toBe(false);
		expect((await getSubmissionById(db, sub.id, "org-1"))?.inputAppliedAt).toBe(
			appliedAtIso,
		);

		// Plain-data replication of the requeue gate inputs: mid-execution evidence
		// means a re-drive is NOT provably safe — recovery must fail, not requeue.
		expect(after?.phase).not.toBe("admitted");
		expect(after?.inputAppliedAt).toBeTruthy();
	});

	it("settles exactly once under a recovery race: recovered turn wins, late original is inert", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:recover-race", ...base });
		const original = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		// Crash + sweep re-drive → the recovered turn now owns the submission.
		const recovered = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		expect(recovered.attempt?.attemptNo).toBe(2);

		// The recovered turn settles first.
		const winner = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
			attemptId: recovered.attempt?.id,
		});
		expect(winner.settled).toBe(true);
		const settledRow = await getSubmissionById(db, sub.id, "org-1");
		expect(settledRow?.status).toBe("settled");
		expect(settledRow?.phase).toBe("committed");
		expect(settledRow?.settledAt).toBeTruthy();

		// The late original turn reports a CONFLICTING outcome — must be a no-op:
		// not-settled, and the row keeps the first outcome and settle timestamp.
		const late = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
			attemptId: original.attempt?.id,
			error: "late original turn",
		});
		expect(late.settled).toBe(false);
		const after = await getSubmissionById(db, sub.id, "org-1");
		expect(after?.status).toBe("settled");
		expect(after?.settledAt).toBe(settledRow?.settledAt);
		// The winning settle finalized only the recovered attempt; the late loser
		// short-circuited on the terminal pre-read and never touched attempt rows.
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.map((a) => a.status)).toEqual(["started", "settled"]);
		expect(
			attempts.find((a) => a.id === original.attempt?.id)?.error,
		).toBeNull();
	});

	it("exhausts the durable requeue budget: attemptCount >= maxRetry, then fail terminalizes cleanly", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, {
			id: "sub:recover-budget",
			...base,
			maxRetry: 2,
		});
		expect(sub.maxRetry).toBe(2);

		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });
		const second = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		expect(second.submission?.attemptCount).toBe(2);

		// Plain-data replication of the pure budget gate (step 3 of
		// decideTediSubmissionRecovery / step 5 of decideKernelRedrive): the durable
		// row now satisfies attemptCount >= maxRetry, so recovery must refuse any
		// further re-drive and mandate "failed".
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.attemptCount).toBe(2);
		expect(row?.maxRetry).toBe(2);
		expect((row?.attemptCount ?? 0) >= (row?.maxRetry ?? 10)).toBe(true);

		// The sweep's mandated outcome terminalizes cleanly (reserve→finalize).
		const failed = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
			error: "requeue budget exhausted",
		});
		expect(failed.settled).toBe(true);
		expect(failed.submission?.status).toBe("failed");
		const terminal = await getSubmissionById(db, sub.id, "org-1");
		expect(terminal?.status).toBe("failed");
		expect(terminal?.settledAt).toBeTruthy();
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts[1]?.status).toBe("failed");
		expect(attempts[1]?.error).toBe("requeue budget exhausted");

		// Durability: a late revival cannot resurrect the exhausted, failed row.
		const late = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		expect(late.submission).toBeUndefined();
		expect((await getSubmissionById(db, sub.id, "org-1"))?.status).toBe(
			"failed",
		);
	});
});

/**
 * Batch 1b (Port 1) — admit-time journal stamp + the attempt-insert latch the
 * tedi requeue executor gates its re-inject on.
 */
describe("admit journal stamp + attempt latch (real sqlite)", () => {
	const base = {
		organizationId: "org-1",
		subjectKind: "tedi" as const,
		subjectId: "tedi-1",
		sourceKind: "tedi_message" as const,
	};

	it("stamps phase='admitted' atomically in the admit INSERT (affirmative requeue evidence)", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:admit-phase", ...base });
		expect(sub.phase).toBe("admitted");
		expect(sub.inputAppliedAt).toBeNull();
		// The normal choke-point advance still works from the admit stamp.
		const advanced = await advanceSubmissionPhase(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			phase: "provider_started",
		});
		expect(advanced.advanced).toBe(true);
	});

	it("a legacy NULL-phase row stays fail-conservative (no affirmative requeue evidence)", async () => {
		const { db, sqlite } = realDbWithEngine();
		// Pre-migration row shape: admitted before the phase stamp existed.
		sqlite
			.prepare(
				`INSERT INTO runtime_submissions
				 (id, organization_id, subject_kind, subject_id, source_kind, status)
				 VALUES ('sub:legacy-null', 'org-1', 'tedi', 'tedi-1', 'tedi_message', 'running')`,
			)
			.run();
		const row = await getSubmissionById(db, "sub:legacy-null", "org-1");
		expect(row?.phase).toBeNull();
		// Plain-data replication of the requeue gate: NULL proves nothing.
		expect(row?.phase === "admitted").toBe(false);
	});

	it("attempt-insert latch: the loser of the (submission, attemptNo) race gets no attempt and must not inject", async () => {
		const { db, sqlite } = realDbWithEngine();
		const sub = await admitSubmission(db, { id: "sub:latch-race", ...base });
		const first = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		expect(first.attempt?.attemptNo).toBe(1);
		// A racing executor observed the same attemptCount and inserted attemptNo 2
		// first (pointer not yet repointed) — exactly the interleaving the latch
		// exists for.
		sqlite
			.prepare(
				`INSERT INTO runtime_submission_attempts
				 (id, submission_id, organization_id, attempt_no, status)
				 VALUES ('att-racer', ?, 'org-1', 2, 'recovered')`,
			)
			.run(sub.id);
		const loser = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		// onConflictDoNothing lost → no attempt; the executor gates its inject on
		// `attempt !== undefined`, so the loser touches nothing else.
		expect(loser.attempt).toBeUndefined();
		const row = await getSubmissionById(db, sub.id, "org-1");
		// The pointer was never repointed at the discarded id.
		expect(row?.currentAttemptId).toBe(first.attempt?.id);
	});
});

/**
 * Batch 1b (Port 2) — attempt-ownership fence on settle. Only callers that PASS
 * an attemptId are fenced; attempt-agnostic callers (terminal events, sweeps)
 * are unchanged, including the reserved-row re-drive.
 */
describe("attempt-fenced settle (real sqlite)", () => {
	const base = {
		organizationId: "org-1",
		subjectKind: "tedi" as const,
		subjectId: "tedi-1",
		sourceKind: "tedi_message" as const,
	};

	it("a stale attempt settling FIRST is refused: no transition, no pointer hijack, no attempt row touched", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:fence-first", ...base });
		const original = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		const recovered = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		expect(recovered.submission?.currentAttemptId).toBe(recovered.attempt?.id);

		// INVERTED ARRIVAL ORDER: the stale original reports first, pinning the
		// attempt it owns — which no longer owns the pointer.
		const stale = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
			attemptId: original.attempt?.id,
			error: "stale original turn",
		});
		expect(stale.settled).toBe(false);
		const afterStale = await getSubmissionById(db, sub.id, "org-1");
		expect(afterStale?.status).toBe("running");
		// Pointer-hijack regression: settle never repoints currentAttemptId.
		expect(afterStale?.currentAttemptId).toBe(recovered.attempt?.id);
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.map((a) => a.status)).toEqual(["started", "recovered"]);
		expect(attempts.every((a) => a.error === null)).toBe(true);

		// The current attempt then settles normally.
		const winner = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
			attemptId: recovered.attempt?.id,
		});
		expect(winner.settled).toBe(true);
		expect(winner.submission?.status).toBe("settled");
		const finalAttempts = await listAttemptsBySubmission(db, sub.id);
		expect(finalAttempts.map((a) => a.status)).toEqual(["started", "settled"]);
	});

	it("a non-owner never help-finalizes a reserved latch; the unfenced sweep still re-drives it", async () => {
		const { db, sqlite } = realDbWithEngine();
		const sub = await admitSubmission(db, {
			id: "sub:fence-reserved",
			...base,
		});
		const original = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		const recovered = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			recovered: true,
		});
		// Strand the recovered attempt's latch mid-settle (Step A won, B never ran).
		sqlite
			.prepare(
				`UPDATE runtime_submissions
				 SET status = 'reserved', metadata = ?, updated_at = '2000-01-01T00:00:00.000Z'
				 WHERE id = ?`,
			)
			.run(JSON.stringify({ reservedOutcome: "settled" }), sub.id);

		// The stale original (fenced) must not help-finalize with its own error.
		const staleHelp = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
			attemptId: original.attempt?.id,
			error: "stale helper",
		});
		expect(staleHelp.settled).toBe(false);
		expect((await getSubmissionById(db, sub.id, "org-1"))?.status).toBe(
			"reserved",
		);

		// The attempt-agnostic reserved sweep still re-drives the recorded outcome.
		const sweep = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "failed",
		});
		expect(sweep.settled).toBe(true);
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("settled");
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.find((a) => a.id === recovered.attempt?.id)?.status).toBe(
			"settled",
		);
		expect(
			attempts.find((a) => a.id === original.attempt?.id)?.error,
		).toBeNull();
	});

	it("pointer-hijack regression: an attempt-agnostic settle NEVER writes currentAttemptId, even when a recovered attempt repoints between its pre-read and Step A", async () => {
		// This pins the removal of the old Step-A `currentAttemptId` overwrite
		// (`attemptId ?? current.currentAttemptId` written back in SET). Under the
		// fence that overwrite is a no-op ONLY when the caller passes an attemptId;
		// an attempt-agnostic caller (terminal event / sweep) that pre-read a stale
		// pointer would write the OLD attempt id back over a recovered attempt's
		// repoint — hijacking the pointer and mis-attributing the finalize. So:
		// settle must not carry its pre-read pointer into the SET at all.
		const { db, sqlite } = realDbWithEngine();
		const sub = await admitSubmission(db, { id: "sub:fence-hijack", ...base });
		const original = await startAttempt(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});

		// Interpose: the moment settleSubmission issues its FIRST update (Step A,
		// after its pre-read observed currentAttemptId = original), a recovered
		// attempt races in and repoints the pointer — the exact TOCTOU window.
		let fired = false;
		const interposed = new Proxy(db as object, {
			get(target, prop) {
				if (prop === "update" && !fired) {
					fired = true;
					sqlite
						.prepare(
							`INSERT INTO runtime_submission_attempts
							 (id, submission_id, organization_id, attempt_no, status)
							 VALUES ('att-hijack-recovered', ?, 'org-1', 2, 'recovered')`,
						)
						.run(sub.id);
					sqlite
						.prepare(
							`UPDATE runtime_submissions
							 SET current_attempt_id = 'att-hijack-recovered', attempt_count = 2
							 WHERE id = ?`,
						)
						.run(sub.id);
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function"
					? (value as (...a: unknown[]) => unknown).bind(target)
					: value;
			},
		}) as DbClient;

		// Attempt-agnostic settle (no attemptId): "settles whatever is current".
		const settle = await settleSubmission(interposed, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});
		expect(fired).toBe(true);
		expect(settle.settled).toBe(true);

		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("settled");
		// Settle never repoints: the recovered attempt still owns the pointer.
		expect(row?.currentAttemptId).toBe("att-hijack-recovered");
		// And the finalize was attributed to the CURRENT attempt, not the stale
		// pre-read one.
		const attempts = await listAttemptsBySubmission(db, sub.id);
		expect(attempts.find((a) => a.id === "att-hijack-recovered")?.status).toBe(
			"settled",
		);
		expect(attempts.find((a) => a.id === original.attempt?.id)?.status).toBe(
			"started",
		);
	});
});

/**
 * Batch 1b (Port 3) — durable operator abort intent. The stamp is idempotent,
 * refuses terminal/reserved rows, and never blocks a real completion
 * (completed-work-wins is enforced by the settle path, which ignores the stamp).
 */
describe("durable abort intent (real sqlite)", () => {
	const base = {
		organizationId: "org-1",
		subjectKind: "tedi" as const,
		subjectId: "tedi-1",
		sourceKind: "tedi_message" as const,
	};

	it("stamps abort intent exactly once (second stamp is inert, timestamp unchanged)", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:abort-once", ...base });
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });

		const first = await requestSubmissionAbort(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			requestedAtIso: "2026-07-01T00:00:00.000Z",
			reason: "operator cancel",
		});
		expect(first.requested).toBe(true);
		expect(first.submission?.abortRequestedAt).toBe("2026-07-01T00:00:00.000Z");
		expect(
			(first.submission?.metadata as Record<string, unknown> | null)
				?.abortReason,
		).toBe("operator cancel");

		const second = await requestSubmissionAbort(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			requestedAtIso: "2026-07-02T00:00:00.000Z",
			reason: "retry cancel",
		});
		expect(second.requested).toBe(false);
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.abortRequestedAt).toBe("2026-07-01T00:00:00.000Z");
		expect((row?.metadata as Record<string, unknown> | null)?.abortReason).toBe(
			"operator cancel",
		);
	});

	it("refuses to stamp terminal and reserved rows (completed work wins; a latch is never disturbed)", async () => {
		const { db, sqlite } = realDbWithEngine();
		const settled = await admitSubmission(db, {
			id: "sub:abort-term",
			...base,
		});
		await startAttempt(db, {
			submissionId: settled.id,
			organizationId: "org-1",
		});
		await settleSubmission(db, {
			submissionId: settled.id,
			organizationId: "org-1",
			outcome: "settled",
		});
		const onTerminal = await requestSubmissionAbort(db, {
			submissionId: settled.id,
			organizationId: "org-1",
		});
		expect(onTerminal.requested).toBe(false);
		expect(
			(await getSubmissionById(db, settled.id, "org-1"))?.abortRequestedAt,
		).toBeNull();

		const reserved = await admitSubmission(db, {
			id: "sub:abort-res",
			...base,
		});
		await startAttempt(db, {
			submissionId: reserved.id,
			organizationId: "org-1",
		});
		sqlite
			.prepare(
				`UPDATE runtime_submissions SET status = 'reserved', metadata = ? WHERE id = ?`,
			)
			.run(JSON.stringify({ reservedOutcome: "settled" }), reserved.id);
		const onReserved = await requestSubmissionAbort(db, {
			submissionId: reserved.id,
			organizationId: "org-1",
		});
		expect(onReserved.requested).toBe(false);
		expect(
			(await getSubmissionById(db, reserved.id, "org-1"))?.abortRequestedAt,
		).toBeNull();
	});

	it("abort-then-real-completion: the terminal settle wins over the stamped intent", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:abort-race", ...base });
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });
		const stamp = await requestSubmissionAbort(db, {
			submissionId: sub.id,
			organizationId: "org-1",
		});
		expect(stamp.requested).toBe(true);

		// The turn finishes for real before the sweep honors the abort: the settle
		// path ignores the stamp entirely — completed work wins.
		const settle = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "settled",
		});
		expect(settle.settled).toBe(true);
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("settled");
		expect(row?.abortRequestedAt).toBeTruthy();

		// A late abort-driven settle is a duplicate: inert.
		const lateAbortSettle = await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "canceled",
		});
		expect(lateAbortSettle.settled).toBe(false);
		expect((await getSubmissionById(db, sub.id, "org-1"))?.status).toBe(
			"settled",
		);
	});

	it("operator restart clears the previous epoch's abort stamp (a new epoch is new intent)", async () => {
		const db = realDb();
		const sub = await admitSubmission(db, { id: "sub:abort-reopen", ...base });
		await startAttempt(db, { submissionId: sub.id, organizationId: "org-1" });
		const stamp = await requestSubmissionAbort(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			reason: "operator cancel",
		});
		expect(stamp.requested).toBe(true);
		await settleSubmission(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			outcome: "canceled",
		});

		// Cancel → restart is a natural operator sequence. The reopened epoch must
		// NOT inherit the stale abort intent, or an abort-honoring recovery pass
		// would cancel the restarted run on sight.
		const restarted = await reopenSubmissionForOperatorRestart(db, {
			submissionId: sub.id,
			organizationId: "org-1",
			restartId: "restart-after-abort",
			executionEpoch: 1,
		});
		expect(restarted.reopened).toBe(true);
		const row = await getSubmissionById(db, sub.id, "org-1");
		expect(row?.status).toBe("running");
		expect(row?.abortRequestedAt).toBeNull();
	});
});
