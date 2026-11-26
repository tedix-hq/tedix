/**
 * App Catalog Queries — Categories and stats.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { mergeCatalogCategoryCounts } from "@tedix/api-contract/utils/catalog-categories";
import { and, count, desc, eq, gt, or, sql, type SQL } from "drizzle-orm";
import {
	appCatalog as schemaAppCatalog,
	appCatalogBrowseTotals as schemaAppCatalogBrowseTotals,
	appCatalogCategoryTotals as schemaAppCatalogCategoryTotals,
	appCatalogStoreListings as schemaAppCatalogStoreListings,
} from "../../schema/catalog";
import { coreTable } from "../../core-store/client";
import { booleanValue } from "../../core-store/dialect";
import type { Database } from "./tool-source-policy";

type CatalogTable = typeof schemaAppCatalog;

/** The exact cohort exposed by unauthenticated catalog list endpoints. */
function publicCatalogCondition(appCatalog: CatalogTable): SQL | undefined {
	return and(
		eq(appCatalog.isDiscoverable, true),
		eq(appCatalog.status, "ENABLED"),
		eq(appCatalog.reviewStatus, "RELEASED"),
		or(
			eq(appCatalog.developerType, "TRUSTED_PARTNER"),
			eq(appCatalog.developerType, "OAI"),
			eq(appCatalog.developerType, "THIRD_PARTY"),
		),
	);
}

// =============================================================================
// CATEGORIES AND STATS
// =============================================================================

/**
 * Get category counts (excluding untrusted)
 */
export async function getCatalogCategories(
	db: Database,
): Promise<{ name: string; label: string; count: number }[]> {
	const appCatalogCategoryTotals = coreTable(
		db,
		schemaAppCatalogCategoryTotals,
	);
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
	const appCatalog = coreTable(db, schemaAppCatalog);
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
	const appCatalog = coreTable(db, schemaAppCatalog);
	const appCatalogBrowseTotals = coreTable(db, schemaAppCatalogBrowseTotals);
	const appCatalogStoreListings = coreTable(db, schemaAppCatalogStoreListings);
	const baseCondition = includeUntrusted
		? undefined
		: publicCatalogCondition(appCatalog);

	const [totalResult, capabilityResult] = await db.batch([
		includeUntrusted
			? db.select({ count: count() }).from(appCatalog)
			: db
					.select({ count: appCatalogBrowseTotals.total })
					.from(appCatalogBrowseTotals)
					.where(eq(appCatalogBrowseTotals.id, "public")),
		db
			.select({
				mcp: sql<number>`count(*) filter (where ${eq(appCatalog.connectorType, "MCP")})`.as(
					"mcp",
				),
				withInteractive:
					sql<number>`count(*) filter (where ${eq(appCatalog.hasInteractive, true)})`.as(
						"with_interactive",
					),
				withWrites:
					sql<number>`count(*) filter (where ${eq(appCatalog.hasWrites, true)})`.as(
						"with_writes",
					),
			})
			.from(appCatalog)
			.where(baseCondition),
	]);

	if (!includeUntrusted && !totalResult[0]) {
		throw new Error("Catalog browse totals migration is missing");
	}

	const sourceCounts = new Map<string, number>();
	let cursor: string | undefined;
	for (;;) {
		// Limit before joining/filtering so even a page of hidden apps is bounded.
		const listingPage = db.$with("listing_page").as(
			db
				.select({
					id: appCatalogStoreListings.id,
					catalogAppId: appCatalogStoreListings.catalogAppId,
					source: appCatalogStoreListings.source,
				})
				.from(appCatalogStoreListings)
				.where(
					cursor === undefined
						? undefined
						: gt(appCatalogStoreListings.id, cursor),
				)
				.orderBy(appCatalogStoreListings.id)
				.limit(1000),
		);
		const page = await db
			.with(listingPage)
			.select({
				source: listingPage.source,
				count:
					sql<number>`count(${appCatalog.id}) FILTER (WHERE ${baseCondition ?? sql`1`})`.as(
						"count",
					),
				cursor: sql<string>`max(max(${listingPage.id})) over ()`.as("cursor"),
			})
			.from(listingPage)
			.leftJoin(appCatalog, eq(listingPage.catalogAppId, appCatalog.id))
			.groupBy(listingPage.source);
		if (page.length === 0) break;
		cursor = page[0]!.cursor;
		for (const row of page) {
			const rowCount = Number(row.count ?? 0);
			if (rowCount > 0) {
				sourceCounts.set(
					row.source,
					(sourceCounts.get(row.source) ?? 0) + rowCount,
				);
			}
		}
	}

	return {
		total: Number(totalResult[0]?.count ?? 0),
		mcp: Number(capabilityResult[0]?.mcp ?? 0),
		withInteractive: Number(capabilityResult[0]?.withInteractive ?? 0),
		withWrites: Number(capabilityResult[0]?.withWrites ?? 0),
		sourceBreakdown: [...sourceCounts]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([source, count]) => ({ source, count })),
	};
}

/** Compare trigger-maintained totals in one batch snapshot; never hide drift. */
export async function checkCatalogBrowseTotals(db: Database) {
	const appCatalog = coreTable(db, schemaAppCatalog);
	const appCatalogBrowseTotals = coreTable(db, schemaAppCatalogBrowseTotals);
	const [expected, stored] = await db.batch([
		db
			.select({
				total: count(),
				exploreTotal: sql<number>`coalesce(sum(case when ${appCatalog.exploreShadowed} = ${booleanValue(db, false)} then 1 else 0 end), 0)`,
			})
			.from(appCatalog)
			.where(publicCatalogCondition(appCatalog)),
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
	const expectedTotal = Number(actual.total);
	const expectedExploreTotal = Number(actual.exploreTotal);
	const storedTotal = stored[0]?.total ?? null;
	const storedExploreTotal = stored[0]?.exploreTotal ?? null;
	return {
		expectedTotal,
		expectedExploreTotal,
		storedTotal,
		storedExploreTotal,
		matches:
			storedTotal === expectedTotal &&
			storedExploreTotal === expectedExploreTotal,
	};
}
