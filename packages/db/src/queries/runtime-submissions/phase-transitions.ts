/** Monotonic runtime phase, input, and abort-intent transitions. */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	RUNTIME_SUBMISSION_PHASE_VALUES,
	type RuntimeSubmission,
	type RuntimeSubmissionPhase,
	runtimeSubmissions,
} from "../../schema/runtime-submissions";
import { getSubmissionById } from "./read-models";

export type { RuntimeSubmissionPhase };

/**
 * Monotonic phase ordering for the turn journal. Higher = further along. A NULL
 * phase (legacy/pre-migration row) ranks as `admitted` (the lowest real phase)
 * so the recovery path treats it as the coarse pre-#1 behavior. Used by
 * advanceSubmissionPhase to refuse regressions.
 */
const PHASE_RANK: Record<RuntimeSubmissionPhase, number> =
	RUNTIME_SUBMISSION_PHASE_VALUES.reduce(
		(acc, phase, index) => {
			acc[phase] = index;
			return acc;
		},
		{} as Record<RuntimeSubmissionPhase, number>,
	);

export function submissionPhaseRank(
	phase: RuntimeSubmissionPhase | null | undefined,
): number {
	// NULL/unknown ranks as the lowest real phase ("admitted").
	if (!phase) return PHASE_RANK.admitted;
	return PHASE_RANK[phase] ?? PHASE_RANK.admitted;
}

export interface AdvanceSubmissionPhaseArgs {
	submissionId: string;
	organizationId: string;
	/** Phase to advance to. Ignored if the row is already at or past it. */
	phase: RuntimeSubmissionPhase;
}

export interface AdvanceSubmissionPhaseResult {
	/** True only on the CAS that actually advanced the phase. */
	advanced: boolean;
}

/**
 * Advance a submission's turn-journal phase monotonically. Best-effort
 * telemetry: derived server-side from the runtime's
 * lifecycle events, so it must be idempotent and order-tolerant.
 *
 * Monotonicity is enforced in the WHERE clause without a SQL rank function: the
 * UPDATE only matches when the current phase is strictly lower-ranked than the
 * target (the explicit `lowerPhases` whitelist) OR NULL (legacy/unset row). A
 * re-sent or out-of-order event therefore matches zero rows and is a no-op — the
 * phase never regresses. Also CAS-guarded on a non-terminal status so a late
 * event cannot resurrect or mutate an already-settled/reserved row.
 *
 * `committed` is reserved for settle and is intentionally not advanceable here
 * (advancing TO it would require the row be non-terminal, but committed is the
 * settled state) — callers in the event path only ever pass provider_started /
 * tool_request_recorded.
 *
 * Returns `{ advanced }` for observability; callers treat this as fire-and-
 * forget and must wrap it so it never throws into a turn.
 */
export async function advanceSubmissionPhase(
	db: DbClient,
	args: AdvanceSubmissionPhaseArgs,
): Promise<AdvanceSubmissionPhaseResult> {
	const targetRank = submissionPhaseRank(args.phase);
	// Strictly-lower phases the target is allowed to advance over. Empty for
	// "admitted" (rank 0) → nothing to advance from, so the NULL branch alone
	// applies (and admitted is the default, so this is effectively never called).
	const lowerPhases = RUNTIME_SUBMISSION_PHASE_VALUES.filter(
		(p) => submissionPhaseRank(p) < targetRank,
	);

	// Monotonic guard: match rows whose phase is NULL (legacy/unset) or strictly
	// lower-ranked than the target. SQLite `IN ()` (empty list) matches nothing,
	// so when lowerPhases is empty only the `IS NULL` branch is reachable.
	const phaseGuard =
		lowerPhases.length > 0
			? // bound-params: filtered subset of RUNTIME_SUBMISSION_PHASE_VALUES
				sql`(${runtimeSubmissions.phase} IS NULL OR ${inArray(
					runtimeSubmissions.phase,
					lowerPhases,
				)})`
			: sql`${runtimeSubmissions.phase} IS NULL`;

	const [updated] = await db
		.update(runtimeSubmissions)
		.set({
			phase: args.phase,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				inArray(runtimeSubmissions.status, ["admitted", "running"]),
				phaseGuard,
			),
		)
		.returning();

	return { advanced: Boolean(updated) };
}

export interface StampInputAppliedArgs {
	submissionId: string;
	organizationId: string;
	/** ISO timestamp of when the runtime first accepted the input. */
	appliedAtIso: string;
}

export interface StampInputAppliedResult {
	/** True only on the CAS that actually stamped (the first run.started). */
	stamped: boolean;
}

/**
 * Stamp `inputAppliedAt` exactly once: the earliest "the runtime has the input
 * and started" marker, set on the first `run.started`.
 * This is the load-bearing requeue gate — recovery may only requeue a crashed
 * turn while this is NULL (proving no provider/tool side effects could have
 * fired, since run.started precedes any tool call in the runtime's emission
 * order). The `input_applied_at IS NULL` guard makes a re-sent run.started inert,
 * and the non-terminal status guard keeps a late event off a settled row.
 *
 * Best-effort: callers treat this as fire-and-forget and wrap it so it never
 * throws into a turn.
 */
export async function stampInputApplied(
	db: DbClient,
	args: StampInputAppliedArgs,
): Promise<StampInputAppliedResult> {
	const [updated] = await db
		.update(runtimeSubmissions)
		.set({
			inputAppliedAt: args.appliedAtIso,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				inArray(runtimeSubmissions.status, ["admitted", "running"]),
				sql`${runtimeSubmissions.inputAppliedAt} IS NULL`,
			),
		)
		.returning();

	return { stamped: Boolean(updated) };
}

export interface RequestSubmissionAbortArgs {
	submissionId: string;
	organizationId: string;
	/** ISO stamp for the abort intent; defaults to now. */
	requestedAtIso?: string;
	/** Recorded into metadata.abortReason for attribution. */
	reason?: string | null;
}

export interface RequestSubmissionAbortResult {
	/** True only on the CAS that actually stamped the intent (first stamp wins). */
	requested: boolean;
	submission: RuntimeSubmission | undefined;
}

/**
 * Durably record operator abort intent on an in-flight submission. The stamp
 * survives a lost/failed downstream cancel RPC; recovery honors
 * it with strict precedence completed-work-wins → abort → budget → timeout.
 *
 * CAS-guarded: only a non-terminal, non-reserved row (`admitted`/`running`) with
 * no prior stamp matches — completed work always wins, a mid-settle `reserved`
 * latch is never disturbed, and a re-sent cancel is inert (first stamp wins).
 * Callers treat this as best-effort and wrap it so it never throws into a cancel.
 */
export async function requestSubmissionAbort(
	db: DbClient,
	args: RequestSubmissionAbortArgs,
): Promise<RequestSubmissionAbortResult> {
	// Pre-read to merge metadata without clobbering; the CAS below stays the
	// idempotency authority (abort_requested_at IS NULL).
	const current = await getSubmissionById(
		db,
		args.submissionId,
		args.organizationId,
	);
	if (!current) return { requested: false, submission: undefined };
	const requestedAt = args.requestedAtIso ?? new Date().toISOString();
	const [updated] = await db
		.update(runtimeSubmissions)
		.set({
			abortRequestedAt: requestedAt,
			...(args.reason
				? {
						metadata: { ...current.metadata, abortReason: args.reason },
					}
				: {}),
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(runtimeSubmissions.id, args.submissionId),
				eq(runtimeSubmissions.organizationId, args.organizationId),
				inArray(runtimeSubmissions.status, ["admitted", "running"]),
				sql`${runtimeSubmissions.abortRequestedAt} IS NULL`,
			),
		)
		.returning();
	return { requested: Boolean(updated), submission: updated ?? current };
}
