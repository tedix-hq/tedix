/**
 * App Catalog Queries — Catalog change tracking.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq } from "drizzle-orm";
import {
	type AppCatalogChange,
	appCatalogChanges,
	type NewAppCatalogChange,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// CATALOG CHANGE TRACKING
// =============================================================================

export async function recordCatalogChange(
	db: Database,
	change: NewAppCatalogChange,
) {
	const rows = await db.insert(appCatalogChanges).values(change).returning();
	return rows[0];
}

/**
 * Record multiple catalog changes
 */
export async function recordCatalogChanges(
	db: Database,
	changes: NewAppCatalogChange[],
) {
	if (changes.length === 0) return [];
	// D1 caps bound parameters at 100/query (not SQLite's 999 default).
	// appCatalogChanges binds up to 9 columns/row; 50 rows (450 params) was
	// silently failing every multi-change catalog sync. 10 rows (90 params)
	// is the safe margin. See packages/db/src/queries/tedi-usage.ts for the
	// same bug class (tedi_call_costs).
	const BATCH_SIZE = 10;
	const inserted: AppCatalogChange[] = [];

	for (let i = 0; i < changes.length; i += BATCH_SIZE) {
		const chunk = changes.slice(i, i + BATCH_SIZE);
		const rows = await db.insert(appCatalogChanges).values(chunk).returning();
		inserted.push(...rows);
	}

	return inserted;
}

/**
 * Get changes for a specific catalog app
 */
export async function getCatalogAppChanges(
	db: Database,
	catalogAppId: string,
	limit = 50,
) {
	return db
		.select()
		.from(appCatalogChanges)
		.where(eq(appCatalogChanges.catalogAppId, catalogAppId))
		.orderBy(desc(appCatalogChanges.detectedAt))
		.limit(limit);
}

/**
 * Get recent changes across all apps
 */
export async function getRecentCatalogChanges(
	db: Database,
	options: { limit?: number; changeType?: string } = {},
) {
	const { limit: lim = 100, changeType } = options;

	const conditions = [];
	if (changeType) {
		conditions.push(
			eq(
				appCatalogChanges.changeType,
				changeType as "added" | "removed" | "updated" | "version_bump",
			),
		);
	}

	return db
		.select()
		.from(appCatalogChanges)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(appCatalogChanges.detectedAt))
		.limit(lim);
}
