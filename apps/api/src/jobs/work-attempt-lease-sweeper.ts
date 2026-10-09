import { createDbQueryClient } from "@tedix/db/query-client";
import { sweepElapsedWorkAttempts } from "@tedix/db/queries/work-items/attempts";
import { sweepStaleFailedDelegationWorkItems } from "@tedix/db/queries/work-items/stale-delegation-sweep";

/**
 * Bounded per tick. The steady state is zero candidates — one index probe on
 * `idx_work_attempt_expiry` — and a backlog drains over consecutive ticks
 * instead of turning one cron invocation into an unbounded write burst.
 */
const MAX_ATTEMPTS_PER_TICK = 100;

/**
 * Retire Attempt leases that have elapsed, independently of admission.
 *
 * The ordinary reaper is `work start`: it expires the previous lease in the same
 * batch that acquires a new fence. That is correct and it is the common path,
 * but it is REACHABLE only when the Work Item can be admitted. An item whose
 * operational purpose exception has expired fails admission on the purpose gate
 * before any reaping happens, so its dead lease, its capacity reservation and
 * its budget reservation are stranded permanently — no sequence of `work start`
 * calls can ever clear them.
 *
 * This runs on the two-minute platform tick rather than as a Workflow, a queue
 * consumer or a lazy read-path hook:
 *
 * - It is pure D1 and idempotent, so it needs no durable execution, no retry
 *   state and no ordering guarantee. A Workflow would add a state machine to a
 *   job whose entire recovery strategy is "run again".
 * - Attaching it to a read would reproduce the defect being fixed: retirement
 *   must not depend on someone arriving to do something else.
 * - Two minutes is the same cadence as the other lease-shaped maintenance on
 *   this tick, and it bounds how long a wedged item stays unclaimable to about
 *   one lease heartbeat interval rather than a day.
 * - Riding `trackPlatformCronPath` gives it a receipt, so a sweep that stops
 *   running shows up as `stale` in platform cron health instead of silently
 *   accumulating stranded leases again.
 */
export async function runWorkAttemptLeaseSweeperTick(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	const result = await sweepElapsedWorkAttempts(createDbQueryClient(env.DB), {
		now: new Date(scheduledTime).toISOString(),
		limit: MAX_ATTEMPTS_PER_TICK,
	});
	if (result.expired > 0) {
		console.log(
			`[WorkAttemptLeaseSweeper] retired ${result.expired} elapsed attempt lease(s)`,
		);
	}
	// Same tick, same shape: pure D1, idempotent, zero candidates at steady state.
	// Closes kernel-delegation items whose failed Attempt nobody retried in a week.
	const stale = await sweepStaleFailedDelegationWorkItems(
		createDbQueryClient(env.DB),
		{
			now: new Date(scheduledTime).toISOString(),
			limit: MAX_ATTEMPTS_PER_TICK,
		},
	);
	if (stale.cancelled > 0) {
		console.log(
			`[WorkAttemptLeaseSweeper] cancelled ${stale.cancelled} stale failed delegation(s)`,
		);
	}
	return {
		...result,
		staleDelegationsObserved: stale.observed,
		staleDelegationsCancelled: stale.cancelled,
		staleDelegationsSkipped: stale.skipped,
	};
}
