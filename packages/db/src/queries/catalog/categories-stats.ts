/**
 * App Catalog Queries — Categories and stats.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { mergeCatalogCategoryCounts } from "@tedix/api-contract/utils/catalog-categories";
import { and, count, desc, eq, gt, or, sql } from "drizzle-orm";
import {
	appCatalog,
	appCatalogBrowseTotals,
	appCatalogCategoryTotals,
	appCatalogStoreListings,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

/** The exact cohort exposed by unauthenticated catalog list endpoints. */
const publicCatalogCondition = and(
	eq(appCatalog.isDiscoverable, true),
	eq(appCatalog.status, "ENABLED"),
	eq(appCatalog.reviewStatus, "RELEASED"),
	or(
		eq(appCatalog.developerType, "TRUSTED_PARTNER"),
		eq(appCatalog.developerType, "OAI"),
		eq(appCatalog.developerType, "THIRD_PARTY"),
	),
);

// =============================================================================
// CATEGORIES AND STATS
// =============================================================================

/**
 * Get category counts (excluding untrusted)
 */
export async function getCatalogCategories(
	db: Database,
): Promise<{ name: string; label: string; count: number }[]> {
	const result = await db
		.select({
			name: appCatalogCategoryTotals.category,
			count: appCatalogCategoryTotals.total,
		})
		.from(appCatalogCategoryTotals)
		.where(gt(appCatalogCategoryTotals.total, 0))
		.orderBy(desc(appCatalogCategoryTotals.total));

	return mergeCatalogCategoryCounts(result);
}

/**
 * Get sync status (last sync time and app count)
 */
export async function getCatalogSyncStatus(db: Database): Promise<{
	lastSyncedAt: string | null;
	appsCount: number;
	syncSource: string | null;
}> {
	const [latestApp, appsCount] = await Promise.all([
		// Get the most recent sync time
		db
			.select({
				lastSyncedAt: appCatalog.lastSyncedAt,
				syncSource: appCatalog.syncSource,
			})
			.from(appCatalog)
			.orderBy(desc(appCatalog.lastSyncedAt))
			.limit(1),
		// Get total count
		db.$count(appCatalog),
	]);

	return {
		lastSyncedAt: latestApp[0]?.lastSyncedAt ?? null,
		appsCount,
		syncSource: latestApp[0]?.syncSource ?? null,
	};
}

/**
 * Get directory stats (total, MCP count, capability counts)
 */
export async function getCatalogStats(
	db: Database,
	includeUntrusted = false,
): Promise<{
	total: number;
	mcp: number;
	withInteractive: number;
	withWrites: number;
	sourceBreakdown: { source: string; count: number }[];
}> {
	const baseCondition = includeUntrusted ? undefined : publicCatalogCondition;

	const [
		totalResult,
		mcpResult,
		interactiveResult,
		writesResult,
		sourceResult,
	] = await Promise.all([
		includeUntrusted
			? db.select({ count: count() }).from(appCatalog)
			: db
					.select({ count: appCatalogBrowseTotals.total })
					.from(appCatalogBrowseTotals)
					.where(eq(appCatalogBrowseTotals.id, "public")),
		// Get MCP count
		db
			.select({ count: count() })
			.from(appCatalog)
			.where(
				baseCondition
					? and(baseCondition, eq(appCatalog.connectorType, "MCP"))
					: eq(appCatalog.connectorType, "MCP"),
			),
		// Get interactive count
		db
			.select({ count: count() })
			.from(appCatalog)
			.where(
				baseCondition
					? and(baseCondition, eq(appCatalog.hasInteractive, true))
					: eq(appCatalog.hasInteractive, true),
			),
		// Get writes count
		db
			.select({ count: count() })
			.from(appCatalog)
			.where(
				baseCondition
					? and(baseCondition, eq(appCatalog.hasWrites, true))
					: eq(appCatalog.hasWrites, true),
			),
		// Get per-source counts from store listings
		db
			.select({
				source: appCatalogStoreListings.source,
				count: count(),
			})
			.from(appCatalogStoreListings)
			.innerJoin(
				appCatalog,
				eq(appCatalogStoreListings.catalogAppId, appCatalog.id),
			)
			.where(baseCondition)
			.groupBy(appCatalogStoreListings.source),
	]);

	if (!includeUntrusted && !totalResult[0]) {
		throw new Error("Catalog browse totals migration is missing");
	}

	return {
		total: totalResult[0]?.count ?? 0,
		mcp: mcpResult[0]?.count ?? 0,
		withInteractive: interactiveResult[0]?.count ?? 0,
		withWrites: writesResult[0]?.count ?? 0,
		sourceBreakdown: sourceResult.map((r) => ({
			source: r.source,
			count: r.count,
		})),
	};
}

/** Compare trigger-maintained totals in one D1 batch snapshot; never hide drift. */
export async function checkCatalogBrowseTotals(db: Database) {
	const [expected, stored] = await db.batch([
		db
			.select({
				total: count(),
				exploreTotal: sql<number>`coalesce(sum(case when ${appCatalog.exploreShadowed} = 0 then 1 else 0 end), 0)`,
			})
			.from(appCatalog)
			.where(publicCatalogCondition),
		db
			.select({
				total: appCatalogBrowseTotals.total,
				exploreTotal: appCatalogBrowseTotals.exploreTotal,
			})
			.from(appCatalogBrowseTotals)
			.where(eq(appCatalogBrowseTotals.id, "public")),
	]);
	const actual = expected[0];
	if (!actual) throw new Error("Catalog count query returned no row");
	return {
		expectedTotal: actual.total,
		expectedExploreTotal: actual.exploreTotal,
		storedTotal: stored[0]?.total ?? null,
		storedExploreTotal: stored[0]?.exploreTotal ?? null,
		matches:
			stored[0]?.total === actual.total &&
			stored[0]?.exploreTotal === actual.exploreTotal,
	};
}
