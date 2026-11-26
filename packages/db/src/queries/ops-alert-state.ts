/**
 * Ops Alert State queries — read/persist the platform-health digest's
 * notification memory. See ../schema/ops-alert-state.ts and
 * apps/api/src/lib/health-digest.ts.
 */

import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { anyIds } from "../core-store/dialect";
import {
	type NewOpsAlertStateRow,
	type OpsAlertStateRow,
	opsAlertState,
} from "../schema/ops-alert-state";

/** All currently-open (firing) alert conditions. */
export async function listOpenAlertStates(
	db: DbClient,
): Promise<OpsAlertStateRow[]> {
	const table = coreTable(db, opsAlertState);
	return db.select().from(table).where(eq(table.status, "open"));
}

/** Read one deterministic condition, including its most recent resolved row. */
export async function getAlertState(
	db: DbClient,
	conditionKey: string,
): Promise<OpsAlertStateRow | null> {
	const table = coreTable(db, opsAlertState);
	const [row] = await db
		.select()
		.from(table)
		.where(eq(table.conditionKey, conditionKey))
		.limit(1);
	return row ?? null;
}

/**
 * Upsert one condition row keyed on `conditionKey`. The caller (reconcile)
 * computes the exact desired row — a NEW condition (including one re-firing
 * after a prior `resolved` row) carries fresh firstSeenAt/notifyCount, an
 * ONGOING condition carries the preserved originals — so the conflict update
 * overwrites every mutable field verbatim.
 */
export async function recordAlertState(
	db: DbClient,
	row: NewOpsAlertStateRow,
): Promise<void> {
	const table = coreTable(db, opsAlertState);
	await db
		.insert(table)
		.values(row)
		.onConflictDoUpdate({
			target: table.conditionKey,
			set: {
				severity: row.severity,
				metricBucket: row.metricBucket ?? "0",
				detail: row.detail ?? "",
				status: row.status ?? "open",
				firstSeenAt: row.firstSeenAt,
				lastSeenAt: row.lastSeenAt,
				lastNotifiedAt: row.lastNotifiedAt ?? null,
				notifyCount: row.notifyCount ?? 0,
				updatedAt: sql`(CURRENT_TIMESTAMP)`,
			},
		});
}

/** Close conditions that were open but are no longer firing. */
export async function markAlertsResolved(
	db: DbClient,
	conditionKeys: string[],
	resolvedAtIso: string,
): Promise<void> {
	if (conditionKeys.length === 0) return;
	const table = coreTable(db, opsAlertState);
	await db
		.update(table)
		.set({
			status: "resolved",
			lastSeenAt: resolvedAtIso,
			updatedAt: sql`(CURRENT_TIMESTAMP)`,
		})
		.where(
			and(
				eq(table.status, "open"),
				anyIds(db, table.conditionKey, [...new Set(conditionKeys)]),
			),
		);
}
