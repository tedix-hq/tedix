/** Exactly-once submission settlement and terminal status helpers. */

import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type RuntimeSubmission,
	type RuntimeSubmissionStatus,
	runtimeSubmissionAttempts,
	runtimeSubmissions,
} from "../../schema/runtime-submissions";
import { toJsonRecord } from "../../utils/json";
import { getSubmissionById } from "./read-models";

export type { RuntimeSubmissionStatus };

const TERMINAL_OUTCOMES = ["settled", "failed", "canceled"] as const;
export type SubmissionSettleOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * Recovery-only decision verb. A superset of the settle outcomes with the
 * recovery-exclusive `"requeue"` (re-dispatch a turn
 * that crashed before any side effects) and `null` (leave it alone — still
 * within lease / live). Deliberately distinct from `SubmissionSettleOutcome` so
 * the settle path's type stays a clean 3-valued terminal union; `requeue` is not
 * a terminal status and must never flow into settleSubmission's `outcome`.
 */
export type TediRecoveryDecision = SubmissionSettleOutcome | "requeue" | null;

export function isTerminalSubmissionStatus(
	status: RuntimeSubmissionStatus,
): boolean {
	return (TERMINAL_OUTCOMES as readonly string[]).includes(status);
}

export interface SettleSubmissionArgs {
	submissionId: string;
	organizationId: string;
	outcome: SubmissionSettleOutcome;
	/**
	 * Optional attempt-ownership fence. When set, the settle only proceeds while
	 * this attempt still owns `currentAttemptId` — a stale attempt of the same
	 * epoch can neither drive the terminal transition nor stamp its error onto
	 * another attempt. Omit for attempt-agnostic settles (terminal runtime
	 * events, recovery sweeps), which settle whatever is current.
	 */
	attemptId?: string | null;
	error?: string | null;
	/**
	 * Optional workflow restart epoch fence. Epoch 0 accepts legacy metadata
	 * without an explicit epoch; later epochs must match exactly.
	 */
	expectedWorkflowExecutionEpoch?: number;
}

export interface SettleSubmissionResult {
	/** True only on the transition that actually settled the submission. */
	settled: boolean;
	submission: RuntimeSubmission | undefined;
}

/**
 * Settle a submission exactly once via a crash-safe two-step reserve→finalize.
 *
 * Step A (reserve, the latch): a single CAS flips a non-terminal row
 * (admitted|running) to `reserved`, stamping the intended terminal outcome into
 * `metadata.reservedOutcome` and pinning `currentAttemptId`. SQLite executes the
 * UPDATE atomically, so exactly one concurrent caller matches the non-terminal
 * row and wins the latch; every other caller matches zero rows.
 *
 * Step B (finalize): only the latch winner (or the recovery sweep re-driving an
 * abandoned `reserved` row) flips `reserved` → outcome and finalizes the attempt.
 * Step B is itself CAS-guarded on `status = 'reserved'`, so two racing re-drives
 * settle exactly once. `{ settled: true }` is returned only by the caller whose
 * Step B actually committed the terminal transition — the exactly-once witness.
 *
 * If the runtime dies between A and B the row sits in `reserved` with a stale
 * `updatedAt`; the kernel reserved sweep (listPendingReservedSubmissions) re-runs
 * Step B from the recorded `reservedOutcome`, so no row stays reserved forever.
 */
export async function settleSubmission(
	db: DbClient,
	args: SettleSubmissionArgs,
): Promise<SettleSubmissionResult> {
	// Pre-read once: lets us short-circuit already-terminal rows, merge metadata
	// without clobbering, and recover an already-reserved row by re-driving Step B.
	const current = await getSubmissionById(
		db,
		args.submissionId,
		args.organizationId,
	);
	if (!current) {
		return { settled: false, submission: undefined };
	}
	const expectedWorkflowExecutionEpoch = args.expectedWorkflowExecutionEpoch;
	const currentWorkflowExecutionEpoch =
		current.metadata?.workflowExecutionEpoch;
	const epochMatches =
		expectedWorkflowExecutionEpoch === undefined ||
		(expectedWorkflowExecutionEpoch === 0
			? currentWorkflowExecutionEpoch == null ||
				currentWorkflowExecutionEpoch === 0
			: currentWorkflowExecutionEpoch === expectedWorkflowExecutionEpoch);
	if (!epochMatches) {
		return { settled: false, submission: current };
	}
	if (isTerminalSubmissionStatus(current.status)) {
		// Duplicate settle on an already-terminal row: no-op.
		return { settled: false, submission: current };
	}

	// Recovery / re-drive path: the latch was already won (status === "reserved").
	// Re-running Step A would no-op and wrongly report settled:false, dropping the
	// terminal transition — so finalize directly from `reserved`. Attempt fence: a
	// caller that pins an attemptId it no longer owns (currentAttemptId moved to a
	// recovered attempt) must never help-finalize with its own error/attribution;
	// the unfenced reserved sweep still re-drives an abandoned latch.
	if (current.status === "reserved") {
		if (args.attemptId != null && current.currentAttemptId !== args.attemptId) {
			return { settled: false, submission: current };
		}
		const reservedOutcome =
			(current.metadata?.reservedOutcome as
				| SubmissionSettleOutcome
				| undefined) ?? args.outcome;
		return finalizeReservedSubmission(db, {
			submissionId: args.submissionId,
			organizationId: args.organizationId,
			outcome: reservedOutcome,
			attemptId: args.attemptId ?? current.currentAttemptId,
			error: args.error ?? null,
		});
	}

	// Step A — reserve (the latch). Record the intended outcome durably so the
	// reserved sweep can finalize deterministically even if this caller dies.
	// Settle never repoints currentAttemptId: when the caller pins an attemptId
	// the CAS below only matches while that attempt still owns the pointer, so a
	// stale attempt can neither hijack the pointer nor drive the transition.
	const reservedMetadata = toJsonRecord({
		...current.metadata,
		reservedOutcome: args.outcome,
	});
	const [reserved] = await db
		.update(runtimeSubmissions)
		.set({
			status: "reserved",
			metadata: reservedMetadata,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				inArray(runtimeSubmissions.status, ["admitted", "running"]),
				args.attemptId != null
					? eq(runtimeSubmissions.currentAttemptId, args.attemptId)
					: undefined,
				expectedWorkflowExecutionEpoch === undefined
					? undefined
					: expectedWorkflowExecutionEpoch === 0
						? or(
								sql`json_extract(${runtimeSubmissions.metadata}, '$.workflowExecutionEpoch') IS NULL`,
								sql`json_extract(${runtimeSubmissions.metadata}, '$.workflowExecutionEpoch') = 0`,
							)
						: sql`json_extract(${runtimeSubmissions.metadata}, '$.workflowExecutionEpoch') = ${expectedWorkflowExecutionEpoch}`,
			),
		)
		.returning();

	if (!reserved) {
		// Lost the latch. Another caller is mid-settle. If it has reached `reserved`
		// (and not yet finalized) we may help re-drive; otherwise it's terminal.
		const after = await getSubmissionById(
			db,
			args.submissionId,
			args.organizationId,
		);
		const afterEpoch = after?.metadata?.workflowExecutionEpoch;
		const afterEpochMatches =
			expectedWorkflowExecutionEpoch === undefined ||
			(expectedWorkflowExecutionEpoch === 0
				? afterEpoch == null || afterEpoch === 0
				: afterEpoch === expectedWorkflowExecutionEpoch);
		if (!afterEpochMatches) {
			return { settled: false, submission: after };
		}
		// Attempt fence (mirror of the reserved re-drive path above): a non-owner
		// never help-finalizes another attempt's latch with its own error.
		if (
			args.attemptId != null &&
			after != null &&
			after.currentAttemptId !== args.attemptId
		) {
			return { settled: false, submission: after };
		}
		if (after?.status === "reserved") {
			const reservedOutcome =
				(after.metadata?.reservedOutcome as
					| SubmissionSettleOutcome
					| undefined) ?? args.outcome;
			return finalizeReservedSubmission(db, {
				submissionId: args.submissionId,
				organizationId: args.organizationId,
				outcome: reservedOutcome,
				attemptId: args.attemptId ?? after.currentAttemptId,
				error: args.error ?? null,
			});
		}
		return { settled: false, submission: after };
	}

	// Step B — finalize. We won the latch; drive the terminal transition.
	return finalizeReservedSubmission(db, {
		submissionId: args.submissionId,
		organizationId: args.organizationId,
		outcome: args.outcome,
		attemptId: args.attemptId ?? reserved.currentAttemptId,
		error: args.error ?? null,
	});
}

/**
 * Step B of the two-step settle: flip a `reserved` row to its terminal outcome
 * and finalize the owning attempt. CAS-guarded on `status = 'reserved'`, so when
 * multiple callers (latch winner + recovery sweep) race this, exactly one commits
 * the terminal transition and returns `{ settled: true }`; the rest see zero rows
 * (already terminal) and return `{ settled: false }`. This preserves exactly-once.
 */
async function finalizeReservedSubmission(
	db: DbClient,
	args: {
		submissionId: string;
		organizationId: string;
		outcome: SubmissionSettleOutcome;
		attemptId?: string | null;
		error?: string | null;
	},
): Promise<SettleSubmissionResult> {
	const [submission] = await db
		.update(runtimeSubmissions)
		.set({
			status: args.outcome,
			// Audit-only: a terminal settle records the journal as committed. The CAS
			// guard below (status = 'reserved') is the exactly-once witness and is
			// unchanged; phase is purely a recovery/observability marker.
			phase: "committed",
			settledAt: sql`(CURRENT_TIMESTAMP)`,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				eq(runtimeSubmissions.status, "reserved"),
			),
		)
		.returning();

	if (!submission) {
		// Another racer already finalized this reserved row: no-op.
		return { settled: false, submission: undefined };
	}

	const attemptId = args.attemptId ?? submission.currentAttemptId;
	if (attemptId) {
		await db
			.update(runtimeSubmissionAttempts)
			.set({
				status: args.outcome,
				error: args.error ?? null,
				completedAt: sql`(CURRENT_TIMESTAMP)`,
			})
			.where(
				and(
					eq(runtimeSubmissionAttempts.id, attemptId),
					inArray(runtimeSubmissionAttempts.status, ["started", "recovered"]),
				),
			);
	}

	return { settled: true, submission };
}

export function failSubmission(
	db: DbClient,
	args: Omit<SettleSubmissionArgs, "outcome">,
): Promise<SettleSubmissionResult> {
	return settleSubmission(db, { ...args, outcome: "failed" });
}

export function cancelSubmission(
	db: DbClient,
	args: Omit<SettleSubmissionArgs, "outcome">,
): Promise<SettleSubmissionResult> {
	return settleSubmission(db, { ...args, outcome: "canceled" });
}
