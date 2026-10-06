/**
 * App Catalog Queries — Health history operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq, gte } from "drizzle-orm";
import {
	appCatalogHealthHistory,
	type CatalogHealthHistory,
	type NewCatalogHealthHistory,
} from "../../schema/catalog";
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

async function getCatalogHealthHistory(
	db: Database,
	catalogAppId: string,
	options: { limit?: number; days?: number } = {},
): Promise<CatalogHealthHistory[]> {
	const { limit = 100, days } = options;

	const conditions = [eq(appCatalogHealthHistory.catalogAppId, catalogAppId)];

	if (days) {
		const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
		conditions.push(
			gte(appCatalogHealthHistory.checkedAt, cutoff.toISOString()),
		);
	}

	return db
		.select()
		.from(appCatalogHealthHistory)
		.where(and(...conditions))
		.orderBy(desc(appCatalogHealthHistory.checkedAt))
		.limit(limit);
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
	const history = await getCatalogHealthHistory(db, catalogAppId, { days });

	// Only count checks that affect uptime
	const countableChecks = history.filter(
		(h) =>
			h.status === "healthy" ||
			h.status === "degraded" ||
			h.status === "unhealthy",
	);

	if (countableChecks.length === 0) return null; // No data

	const upChecks = countableChecks.filter(
		(h) => h.status === "healthy" || h.status === "degraded",
	);

	return (upChecks.length / countableChecks.length) * 100;
}
