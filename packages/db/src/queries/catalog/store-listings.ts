/**
 * App Catalog Queries — Store listings operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
	appCatalogStoreListings,
	type CatalogStoreListing,
	type NewCatalogStoreListing,
	type Source,
} from "../../schema/catalog";
import type { Database } from "./tool-source-policy";

// =============================================================================
// STORE LISTINGS OPERATIONS
// =============================================================================

/**
 * Get store listing by source and sourceAppId
 */
export async function getCatalogStoreListingBySourceId(
	db: Database,
	source: Source,
	sourceAppId: string,
): Promise<CatalogStoreListing | null> {
	const result = await db
		.select()
		.from(appCatalogStoreListings)
		.where(
			and(
				eq(appCatalogStoreListings.source, source),
				eq(appCatalogStoreListings.sourceAppId, sourceAppId),
			),
		)
		.limit(1);

	return result[0] ?? null;
}

/**
 * Get store listing by app and source
 */
export async function getCatalogStoreListingByAppSource(
	db: Database,
	catalogAppId: string,
	source: Source,
): Promise<CatalogStoreListing | null> {
	const result = await db
		.select()
		.from(appCatalogStoreListings)
		.where(
			and(
				eq(appCatalogStoreListings.catalogAppId, catalogAppId),
				eq(appCatalogStoreListings.source, source),
			),
		)
		.limit(1);

	return result[0] ?? null;
}

/**
 * Upsert a store listing
 */
export async function upsertCatalogStoreListing(
	db: Database,
	listing: NewCatalogStoreListing,
): Promise<CatalogStoreListing> {
	const result = await db
		.insert(appCatalogStoreListings)
		.values(listing)
		.onConflictDoUpdate({
			target: [
				appCatalogStoreListings.source,
				appCatalogStoreListings.sourceAppId,
			],
			set: {
				catalogAppId: listing.catalogAppId,
				regions: listing.regions,
				storeUrl: listing.storeUrl,
				reviewStatus: listing.reviewStatus,
				authRequired: listing.authRequired,
				storeLogoUrl: listing.storeLogoUrl,
				storeDescription: listing.storeDescription,
				popularityScore: listing.popularityScore,
				trendingScore: listing.trendingScore,
				rank: listing.rank,
				worksWith: listing.worksWith,
				lastSyncedAt: listing.lastSyncedAt,
				rawData: listing.rawData,
			},
		})
		.returning();

	const created = result[0];
	if (!created)
		throw new Error(
			`Failed to create catalog store listing: ${listing.catalogAppId}`,
		);
	return created;
}

/**
 * Get store listings for a catalog app
 */
export async function getCatalogStoreListings(
	db: Database,
	catalogAppId: string,
): Promise<CatalogStoreListing[]> {
	return db
		.select()
		.from(appCatalogStoreListings)
		.where(eq(appCatalogStoreListings.catalogAppId, catalogAppId))
		.orderBy(desc(appCatalogStoreListings.lastSyncedAt));
}

export async function listCatalogStoreListingsByAppIds(
	db: Database,
	appIds: string[],
): Promise<CatalogStoreListing[]> {
	const rows: CatalogStoreListing[] = [];
	for (let index = 0; index < appIds.length; index += 50) {
		rows.push(
			...(await db
				.select()
				.from(appCatalogStoreListings)
				.where(
					inArray(
						appCatalogStoreListings.catalogAppId,
						appIds.slice(index, index + 50),
					),
				)),
		);
	}
	return rows;
}
