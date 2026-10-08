/**
 * App Catalog Queries — Sync log operations.
 * Split from catalog.ts (mechanical move; bodies unchanged).
 */

import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
	type AppCatalogSyncLog,
	appCatalog,
	appCatalogStoreListings,
	appCatalogSyncLogs,
	type NewAppCatalogSyncLog,
	type Source,
} from "../../schema/catalog";
import { getAffectedRows } from "../../utils/d1-result";
import { recordCatalogChange } from "./change-tracking";
import type { Database } from "./tool-source-policy";

// =============================================================================
// SYNC LOG OPERATIONS
// =============================================================================

/**
 * Create a new sync log entry
 */
export async function createAppCatalogSyncLog(
	db: Database,
	log: Omit<NewAppCatalogSyncLog, "id">,
): Promise<AppCatalogSyncLog> {
	const id = crypto.randomUUID();

	await db.insert(appCatalogSyncLogs).values({
		id,
		...log,
	});

	const result = await db
		.select()
		.from(appCatalogSyncLogs)
		.where(eq(appCatalogSyncLogs.id, id))
		.limit(1);

	const created = result[0];
	if (!created) throw new Error(`Failed to create app catalog sync log: ${id}`);
	return created;
}

/**
 * Update a sync log entry
 */
export async function updateAppCatalogSyncLog(
	db: Database,
	id: string,
	update: Partial<Omit<NewAppCatalogSyncLog, "id" | "syncType" | "startedAt">>,
): Promise<AppCatalogSyncLog | null> {
	await db
		.update(appCatalogSyncLogs)
		.set(update)
		.where(eq(appCatalogSyncLogs.id, id));

	const result = await db
		.select()
		.from(appCatalogSyncLogs)
		.where(eq(appCatalogSyncLogs.id, id))
		.limit(1);

	return result[0] ?? null;
}

/** Repair only a still-running log after the caller verifies native terminal failure. */
export async function failRunningAppCatalogSyncLog(
	db: Database,
	id: string,
	error: string,
	completedAt: string,
) {
	const result = await db
		.update(appCatalogSyncLogs)
		.set({ status: "failed", error, completedAt })
		.where(
			and(
				eq(appCatalogSyncLogs.id, id),
				eq(appCatalogSyncLogs.status, "running"),
			),
		);
	return getAffectedRows(result);
}

/**
 * Get recent sync logs
 */
export async function getRecentAppCatalogSyncLogs(
	db: Database,
	limit = 10,
): Promise<AppCatalogSyncLog[]> {
	return db
		.select()
		.from(appCatalogSyncLogs)
		.orderBy(desc(appCatalogSyncLogs.startedAt))
		.limit(limit);
}

/**
 * Reconcile orphaned sync logs left running after their Workflow terminated.
 * The cutoff is supplied by the caller so policy and tests remain explicit.
 */
export async function failStaleAppCatalogSyncLogs(
	db: Database,
	cutoff: string,
	completedAt: string,
): Promise<number> {
	const result = await db
		.update(appCatalogSyncLogs)
		.set({
			status: "failed",
			completedAt,
			error: "Workflow did not complete before the stale sync cutoff",
		})
		.where(
			and(
				eq(appCatalogSyncLogs.status, "running"),
				lt(appCatalogSyncLogs.startedAt, cutoff),
			),
		);

	return getAffectedRows(result);
}

/**
 * Mark store listings as removed if not in current sync
 * Used during full sync to detect apps removed from a specific store
 *
 * Uses a batched approach to avoid D1/SQLite NOT IN clause limits:
 * 1. Fetches all existing source app IDs for this source
 * 2. Computes the difference in JavaScript
 * 3. Deletes orphaned listings in batches of 50
 *
 * @param source - The store source being synced (chatgpt, claude, etc.)
 * @param currentSourceAppIds - Source app IDs present in the current sync
 * @returns Count of store listings deleted
 */
/**
 * Listing `rawData` key every snapshot feed stamps on the listings it owns.
 * A feed's own provenance key is private to that feed, so this shared marker
 * is how other feeds' removal passes recognise and leave those listings alone.
 */
export const SNAPSHOT_FEED_MARKER = "snapshotFeed";

export async function markStoreListingsAsRemoved(
	db: Database,
	source: Source,
	currentSourceAppIds: string[],
): Promise<number> {
	if (currentSourceAppIds.length === 0) {
		// If no apps in current sync, don't mark anything as removed
		// (likely an error in sync)
		return 0;
	}

	// Step 1: Get existing source app IDs for this source. Listings a snapshot
	// feed owns are reconciled only by that feed, never by a registry sync.
	const existingListings = await db
		.select({
			sourceAppId: appCatalogStoreListings.sourceAppId,
			rawData: appCatalogStoreListings.rawData,
		})
		.from(appCatalogStoreListings)
		.where(eq(appCatalogStoreListings.source, source));

	const existingIds = existingListings
		.filter(
			(listing) => typeof listing.rawData?.[SNAPSHOT_FEED_MARKER] !== "string",
		)
		.map((listing) => listing.sourceAppId);

	// Step 2: Find IDs that exist in DB but not in current sync (orphaned)
	const currentIdSet = new Set(currentSourceAppIds);
	const orphanedIds = existingIds.filter((id) => !currentIdSet.has(id));

	if (orphanedIds.length === 0) {
		return 0;
	}

	// Step 3: Delete orphaned listings in batches to avoid SQL limits
	const BATCH_SIZE = 50;
	let totalDeleted = 0;

	for (let i = 0; i < orphanedIds.length; i += BATCH_SIZE) {
		const batch = orphanedIds.slice(i, i + BATCH_SIZE);

		const result = await db
			.delete(appCatalogStoreListings)
			.where(
				and(
					eq(appCatalogStoreListings.source, source),
					inArray(appCatalogStoreListings.sourceAppId, batch),
				),
			);

		totalDeleted += getAffectedRows(result);
	}

	return totalDeleted;
}

/**
 * Disable catalog apps that have no remaining store listings
 * Call this after markStoreListingsAsRemoved to clean up orphaned apps
 *
 * Uses batched updates to avoid D1/SQLite IN clause limits.
 *
 * @returns Count of apps disabled
 */
export async function disableOrphanedCatalogApps(
	db: Database,
): Promise<number> {
	// Find apps with no store listings
	const orphanedApps = await db
		.select({ id: appCatalog.id })
		.from(appCatalog)
		.leftJoin(
			appCatalogStoreListings,
			eq(appCatalog.id, appCatalogStoreListings.catalogAppId),
		)
		.where(
			and(
				sql`${appCatalog.status} != 'DISABLED'`,
				isNull(appCatalogStoreListings.id),
			),
		);

	if (orphanedApps.length === 0) return 0;

	const orphanedIds = orphanedApps.map((a) => a.id);

	// Batch updates to avoid SQL IN clause limits
	const BATCH_SIZE = 50;
	let totalDisabled = 0;

	for (let i = 0; i < orphanedIds.length; i += BATCH_SIZE) {
		const batch = orphanedIds.slice(i, i + BATCH_SIZE);

		const result = await db
			.update(appCatalog)
			.set({
				status: "DISABLED",
				updatedAt: sql`datetime('now')`,
			})
			.where(inArray(appCatalog.id, batch));

		totalDisabled += getAffectedRows(result);
	}

	// Record "removed" changes for orphaned apps.
	// This is best-effort only: change-log failures must not fail the sync.
	for (const id of orphanedIds) {
		try {
			await recordCatalogChange(db, {
				id: crypto.randomUUID(),
				catalogAppId: id,
				changeType: "removed",
				detectedAt: new Date().toISOString(),
			});
		} catch (error) {
			console.error(
				`[Catalog] Failed to record removed change for orphaned app ${id}:`,
				error,
			);
		}
	}

	return totalDisabled;
}

/** Stable snapshot identity makes dispatch retries reuse the same sync log. */
export async function ensureCatalogSnapshotSyncLog(
	db: Database,
	log: NewAppCatalogSyncLog,
): Promise<AppCatalogSyncLog> {
	await db.insert(appCatalogSyncLogs).values(log).onConflictDoNothing();
	const rows = await db
		.select()
		.from(appCatalogSyncLogs)
		.where(eq(appCatalogSyncLogs.id, log.id))
		.limit(1);
	if (!rows[0]) throw new Error("Snapshot sync log was not persisted");
	return rows[0];
}

/** Reconcile only rows carrying this feed's object provenance. */
export async function markStaleFeedStoreListingsAsRemoved(
	db: Database,
	source: Source,
	provenanceKey: string,
	currentSourceAppIds: string[],
): Promise<number> {
	if (currentSourceAppIds.length === 0) return 0;

	const existingListings = await db
		.select({
			sourceAppId: appCatalogStoreListings.sourceAppId,
			rawData: appCatalogStoreListings.rawData,
		})
		.from(appCatalogStoreListings)
		.where(eq(appCatalogStoreListings.source, source));
	const currentIds = new Set(currentSourceAppIds);
	const staleIds = existingListings
		.filter(
			(listing) =>
				typeof listing.rawData?.[provenanceKey] === "object" &&
				listing.rawData[provenanceKey] !== null &&
				!currentIds.has(listing.sourceAppId),
		)
		.map((listing) => listing.sourceAppId);

	let totalDeleted = 0;
	for (let i = 0; i < staleIds.length; i += 50) {
		const result = await db
			.delete(appCatalogStoreListings)
			.where(
				and(
					eq(appCatalogStoreListings.source, source),
					inArray(
						appCatalogStoreListings.sourceAppId,
						staleIds.slice(i, i + 50),
					),
				),
			);
		totalDeleted += getAffectedRows(result);
	}
	return totalDeleted;
}
