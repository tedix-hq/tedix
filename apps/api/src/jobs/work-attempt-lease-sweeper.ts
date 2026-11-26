import { coreDb, coreQueryDb } from "@tedix/db/core-store/scope";
import { configureLogStore } from "@tedix/db/client";
import { moveRoutineAuditEventsToLogs } from "@tedix/db/queries/audit";
import {
	reconcileWorkInteractionConditions,
	sweepObsoleteWorkInteractions,
} from "@tedix/db/queries/work-items/interactions";
import { flushWorkInteractionDigests } from "@tedix/db/queries/work-items/interaction-digests";
import { sweepElapsedWorkAttempts } from "@tedix/db/queries/work-items/attempts";
import { notifyStoppedLanes } from "@tedix/db/queries/work-items/lane-lifecycle";

/**
 * Also bounds explicit on-demand calls. Scheduled calls receive the smaller
 * batch of Attempt ids claimed from work_due.
 */
const MAX_ATTEMPTS_PER_TICK = 100;

/** True on the first two-minute tick of each UTC hour. */
export function staleDelegationSweepDue(scheduledTime: number): boolean {
	return new Date(scheduledTime).getUTCMinutes() < 2;
}
const MAX_INTERACTION_WRITES_PER_TICK = 100;
/**
 * The obsolete-request sweep re-reads every open request of up to ten
 * organizations (~5.5k rows a call on 21 Nov 2026). Every fifth minute is
 * soon enough for requests that are already obsolete.
 */
export function interactionExpirySweepDue(scheduledTime: number): boolean {
	return new Date(scheduledTime).getUTCMinutes() % 5 === 0;
}

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
 *
 * This path stays pure D1. Remote follow-through that used to share the tick —
 * kernel request reconciliation and interaction review wakes — runs under its
 * own receipts (`kernel-request-reconcile`, `interaction-review-dispatch`), so
 * a wedged tedi or Durable Object can neither strand the reaper nor make the
 * expiry receipt look like the failing component.
 */
export async function runWorkAttemptLeaseSweeperTick(
	env: CloudflareEnv,
	scheduledTime: number,
	dueIds?: string[],
): Promise<Record<string, number>> {
	return {
		...(await sweepElapsedWorkAttempts(coreQueryDb(env), {
			now: new Date(scheduledTime).toISOString(),
			limit: MAX_ATTEMPTS_PER_TICK,
			dueIds,
		})),
	};
}

export async function runWorkMaintenanceTick(
	env: CloudflareEnv,
	scheduledTime: number,
): Promise<Record<string, number>> {
	await reconcileWorkInteractionConditions(coreQueryDb(env), {
		now: new Date(scheduledTime).toISOString(),
		limit: 25,
	});
	const interactions = interactionExpirySweepDue(scheduledTime)
		? await sweepObsoleteWorkInteractions(coreQueryDb(env), {
				now: new Date(scheduledTime).toISOString(),
				limit: MAX_INTERACTION_WRITES_PER_TICK,
			})
		: { observed: 0, expired: 0, candidates: 0, writes: 0, dryRun: 0 };
	const auditDb = coreDb(env);
	configureLogStore(auditDb, env);
	return {
		// The hourly replay also catches notices made eligible by later Work edits.
		lanesNotified: await notifyStoppedLanes(
			coreQueryDb(env),
			new Date(scheduledTime).toISOString(),
			{ wholeLedger: staleDelegationSweepDue(scheduledTime) },
		),
		...(await flushWorkInteractionDigests(
			coreQueryDb(env),
			new Date(scheduledTime).toISOString(),
		)),
		interactionsExpired: interactions.expired,
		interactionExpiryCandidates: interactions.candidates,
		interactionExpiryWrites: interactions.writes,
		interactionExpiryDryRuns: interactions.dryRun,
		auditRowsMoved: await moveRoutineAuditEventsToLogs(auditDb),
	};
}
