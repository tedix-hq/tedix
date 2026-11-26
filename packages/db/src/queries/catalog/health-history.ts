/**
 * App Catalog Queries — Health history operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import {
	appCatalogHealthHistory as schemaAppCatalogHealthHistory,
	type CatalogHealthHistory,
	type NewCatalogHealthHistory,
} from "../../schema/catalog";
import { coreTable } from "../../core-store/client";
import type { Database } from "./tool-source-policy";

// =============================================================================
// HEALTH HISTORY OPERATIONS
// =============================================================================

/**
 * Insert a health check record
 */
export async function insertCatalogHealthHistory(
	db: Database,
	record: Omit<NewCatalogHealthHistory, "id">,
): Promise<CatalogHealthHistory> {
	const id = crypto.randomUUID();
	const appCatalogHealthHistory = coreTable(db, schemaAppCatalogHealthHistory);

	await db.insert(appCatalogHealthHistory).values({
		id,
		...record,
	});

	const result = await db
		.select()
		.from(appCatalogHealthHistory)
		.where(eq(appCatalogHealthHistory.id, id))
		.limit(1);

	const created = result[0];
	if (!created)
		throw new Error(`Failed to create catalog health history entry: ${id}`);
	return created;
}

/**
 * Calculate uptime percentage from health history
 * Only counts checks that affect uptime (healthy, degraded, unhealthy)
 * Excludes: requires_auth, blocked, unsupported, unknown
 */
export async function calculateCatalogAppUptime(
	db: Database,
	catalogAppId: string,
	days: number = 30,
): Promise<number | null> {
	const appCatalogHealthHistory = coreTable(db, schemaAppCatalogHealthHistory);
	const conditions = [
		eq(appCatalogHealthHistory.catalogAppId, catalogAppId),
		inArray(appCatalogHealthHistory.status, [
			"healthy",
			"degraded",
			"unhealthy",
		]),
	];
	if (days) {
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		conditions.push(
			gte(appCatalogHealthHistory.checkedAt, cutoff.toISOString()),
		);
	}

	const [totals] = await db
		.select({
			eligibleChecks: count().as("eligible_checks"),
			upChecks:
				sql<number>`count(case when ${appCatalogHealthHistory.status} in ('healthy', 'degraded') then 1 end)`.as(
					"up_checks",
				),
		})
		.from(appCatalogHealthHistory)
		.where(and(...conditions));

	const eligibleChecks = Number(totals?.eligibleChecks ?? 0);
	if (!totals || eligibleChecks === 0) return null;
	return (Number(totals.upChecks) / eligibleChecks) * 100;
}
