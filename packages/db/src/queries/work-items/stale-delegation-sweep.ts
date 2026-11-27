import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { anyIds, jsonRead, jsonType } from "../../core-store/dialect";
import {
	workAttempts as d1WorkAttempts,
	workEvents as d1WorkEvents,
	workItems as d1WorkItems,
} from "../../schema/work-items";
import { cancelWorkItem } from "./crud";
import { WorkFactoryError } from "./factory-state";

/** Recorded as the `work.cancelled` event's `reason`. */
export const STALE_FAILED_DELEGATION_REASON = "stale_failed_delegation";

/** A failed delegation nobody retried within this window is abandoned. */
export const STALE_FAILED_DELEGATION_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
	options: {
		now?: string;
		limit?: number;
		scope?: { orgId: string; ids: string[] };
	} = {},
): Promise<SweepStaleFailedDelegationsResult> {
	const at = options.now ?? new Date().toISOString();
	const cutoff = new Date(
		Date.parse(at) - STALE_FAILED_DELEGATION_AGE_MS,
	).toISOString();
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100);
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const candidates = await db
		.select({ id: workItems.id, orgId: workItems.orgId })
		.from(workItems)
		.where(
			and(
				options.scope
					? and(
							eq(workItems.orgId, options.scope.orgId),
							anyIds(db, workItems.id, options.scope.ids),
						)
					: undefined,
				eq(workItems.disposition, "accepted"),
				sql`${jsonRead(db, workItems.provenance, ["source"])} = 'kernelRuntime.directDelegation'`,
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

/** Pre-contract children cannot be assigned a historical budget or grant retroactively. */
export async function sweepUncontractedChildWorkItems(
	db: DbQueryClient,
	options: {
		now?: string;
		limit?: number;
		scope?: { orgId: string; ids: string[] };
	} = {},
): Promise<SweepStaleFailedDelegationsResult> {
	const at = options.now ?? new Date().toISOString();
	const workItems = coreTable(db, d1WorkItems);
	const workAttempts = coreTable(db, d1WorkAttempts);
	const workEvents = coreTable(db, d1WorkEvents);
	const candidates = await db
		.select({
			id: workItems.id,
			orgId: workItems.orgId,
			version: workItems.version,
		})
		.from(workItems)
		.where(
			and(
				options.scope
					? and(
							eq(workItems.orgId, options.scope.orgId),
							anyIds(db, workItems.id, options.scope.ids),
						)
					: undefined,
				inArray(workItems.disposition, ["accepted", "proposed"]),
				isNotNull(workItems.delegationRootId),
				sql`NOT EXISTS (SELECT 1 FROM ${workEvents} allocation WHERE allocation.org_id=${workItems.orgId} AND allocation.work_item_id=${workItems.id} AND allocation.id=${workItems.id} AND ${jsonType(db, sql`allocation.payload`, ["taskContract"])}='object')`,
				sql`NOT EXISTS (SELECT 1 FROM ${workAttempts} active_attempt WHERE active_attempt.org_id=${workItems.orgId} AND active_attempt.work_item_id=${workItems.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying'))`,
			),
		)
		.orderBy(asc(workItems.orgId), asc(workItems.id))
		.limit(Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100));
	const result = { observed: candidates.length, cancelled: 0, skipped: 0 };
	for (const item of candidates) {
		try {
			await cancelWorkItem(db, {
				orgId: item.orgId,
				workItemId: item.id,
				expectedWorkItemVersion: item.version,
				actor: { type: "system", id: "sweeper" },
				reason:
					"task_contract_missing: Legacy child has no original task contract allocation; recreate it under an admitted parent.",
				cancelledAt: at,
			});
			result.cancelled++;
		} catch (error) {
			if (!(error instanceof WorkFactoryError)) throw error;
			result.skipped++;
		}
	}
	return result;
}
