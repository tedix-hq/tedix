/**
 * App Catalog Queries — Store listings operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
	appCatalog as schemaAppCatalog,
	appCatalogStoreListings as schemaAppCatalogStoreListings,
	type CatalogStoreListing,
	type NewCatalogStoreListing,
	type Source,
} from "../../schema/catalog";
import { coreTable } from "../../core-store/client";
import { anyIds } from "../../core-store/dialect";
import type { Database } from "./tool-source-policy";
import { batchNonEmpty, chunkForBoundParams } from "../../utils/batch";

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
	const appCatalogStoreListings = coreTable(db, schemaAppCatalogStoreListings);
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
 * Upsert a store listing
 */
export async function upsertCatalogStoreListing(
	db: Database,
	listing: NewCatalogStoreListing,
): Promise<CatalogStoreListing> {
	const appCatalogStoreListings = coreTable(db, schemaAppCatalogStoreListings);
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
	const appCatalogStoreListings = coreTable(db, schemaAppCatalogStoreListings);
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
	if (appIds.length === 0) return [];
	const appCatalogStoreListings = coreTable(db, schemaAppCatalogStoreListings);
	return db
		.select()
		.from(appCatalogStoreListings)
		.where(anyIds(db, appCatalogStoreListings.catalogAppId, appIds));
}

/**
 * Record that these listings were seen in a store again without rewriting
 * them. Stale-listing cleanup reads `lastSyncedAt`, so an unchanged listing
 * still has to be marked on every import. `updatedAt` stays as it is: nothing
 * about the listing changed.
 */
export async function markCatalogListingsSeen(
	db: Database,
	listings: { source: Source; sourceAppId: string }[],
	seenAt: string,
): Promise<void> {
	const appCatalog = coreTable(db, schemaAppCatalog);
	const appCatalogStoreListings = coreTable(db, schemaAppCatalogStoreListings);
	const bySource = new Map<Source, string[]>();
	for (const listing of listings) {
		const ids = bySource.get(listing.source) ?? [];
		ids.push(listing.sourceAppId);
		bySource.set(listing.source, ids);
	}
	const statements = [];
	for (const [source, ids] of bySource) {
		// The id set binds as one array parameter on both stores.
		const seen = and(
			eq(appCatalogStoreListings.source, source),
			anyIds(db, appCatalogStoreListings.sourceAppId, ids),
		);
		statements.push(
			db
				.update(appCatalogStoreListings)
				.set({ lastSyncedAt: seenAt })
				.where(seen),
			db
				.update(appCatalog)
				.set({ lastSyncedAt: seenAt })
				.where(
					// bound-params: a subquery, whose only list is the id set above
					inArray(
						appCatalog.id,
						db
							.select({ id: appCatalogStoreListings.catalogAppId })
							.from(appCatalogStoreListings)
							.where(seen),
					),
				),
		);
	}
	for (const group of chunkForBoundParams(statements, 20))
		await db.batch(batchNonEmpty(group));
}
