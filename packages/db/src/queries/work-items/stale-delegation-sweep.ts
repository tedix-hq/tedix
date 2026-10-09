import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workAttempts, workItems } from "../../schema/work-items";
import { cancelWorkItem } from "./crud";
import { WorkFactoryError } from "./factory-state";

/** Recorded as the `work.cancelled` event's `reason`. */
export const STALE_FAILED_DELEGATION_REASON = "stale_failed_delegation";

/** A failed delegation nobody retried within this window is abandoned. */
export const STALE_FAILED_DELEGATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const KERNEL_DELEGATION_SOURCE = "kernelRuntime.directDelegation";

export interface SweepStaleFailedDelegationsResult {
	/** Abandoned delegation items observed in this bounded pass. */
	observed: number;
	/** Items this pass cancelled. */
	cancelled: number;
	/** Items a concurrent writer changed between the read and the cancel. */
	skipped: number;
}

/**
 * Cancel kernel-delegation Work Items whose latest Attempt failed and that
 * nobody retried for `STALE_FAILED_DELEGATION_AGE_MS`.
 *
 * When a delegated child run fails, Home settles the Attempt as `failed` but
 * leaves the item `accepted` so `retry_delegation` can re-admit it. Most are
 * never retried and sit on the board forever. This sweep closes them with a
 * recorded reason once both the latest Attempt's `finished_at` and the item's
 * own `updated_at` are older than the window; a retry starts a newer Attempt
 * (which either is active, or moves the window) and an edit bumps
 * `updated_at`, so either keeps the item out of the candidate set.
 *
 * Idempotent: a cancelled item leaves `accepted`. Every cancel is one
 * org-scoped `cancelWorkItem` batch fenced on the item's version and on the
 * absence of an active Attempt, so a retry that lands between the read and
 * the write wins.
 */
export async function sweepStaleFailedDelegationWorkItems(
	db: DbQueryClient,
	options: { now?: string; limit?: number } = {},
): Promise<SweepStaleFailedDelegationsResult> {
	const at = options.now ?? new Date().toISOString();
	const cutoff = new Date(
		Date.parse(at) - STALE_FAILED_DELEGATION_AGE_MS,
	).toISOString();
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100);
	const candidates = await db
		.select({ id: workItems.id, orgId: workItems.orgId })
		.from(workItems)
		.where(
			and(
				eq(workItems.disposition, "accepted"),
				sql`json_extract(${workItems.provenance}, '$.source') = ${KERNEL_DELEGATION_SOURCE}`,
				sql`COALESCE(${workItems.updatedAt}, ${workItems.createdAt}) <= ${cutoff}`,
				sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id = ${workItems.orgId} AND active_attempt.work_item_id = ${workItems.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying'))`,
				sql`EXISTS (SELECT 1 FROM ${workAttempts} latest_attempt WHERE latest_attempt.org_id = ${workItems.orgId} AND latest_attempt.work_item_id = ${workItems.id} AND latest_attempt.runtime_state = 'failed' AND latest_attempt.finished_at <= ${cutoff} AND latest_attempt.attempt_number = (SELECT MAX(any_attempt.attempt_number) FROM ${workAttempts} any_attempt WHERE any_attempt.org_id = ${workItems.orgId} AND any_attempt.work_item_id = ${workItems.id}))`,
			),
		)
		.orderBy(asc(workItems.orgId), asc(workItems.id))
		.limit(limit);
	const result: SweepStaleFailedDelegationsResult = {
		observed: candidates.length,
		cancelled: 0,
		skipped: 0,
	};
	for (const candidate of candidates) {
		try {
			await cancelWorkItem(db, {
				orgId: candidate.orgId,
				workItemId: candidate.id,
				actor: { type: "system", id: "sweeper" },
				reason: STALE_FAILED_DELEGATION_REASON,
				cancelledAt: at,
			});
			result.cancelled += 1;
		} catch (error) {
			if (!(error instanceof WorkFactoryError)) throw error;
			result.skipped += 1;
		}
	}
	return result;
}
