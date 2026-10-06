/**
 * App Catalog Queries — merge/re-parent operations.
 *
 * Store-brokered connectors that publish no MCP endpoint (e.g. GitHub's ChatGPT
 * SERVICE connector) cannot be deduplicated by endpoint hash, so historically
 * they were minted as standalone `app_catalog` rows alongside the vendor's
 * canonical runnable row (this is how `github-3` ended up beside `github`).
 * `mergeCatalogApps` is the repair primitive: it re-parents the orphan row's
 * store listings onto the canonical row (turning them into listing facets),
 * moves the audit trail, drops the orphan's now-redundant tool/health snapshots,
 * and deletes the orphan `app_catalog` row.
 *
 * Going forward, vendor-identity canonicalization in `syncCatalogAppFromStore`
 * prevents new duplicates; this handles the ones already in the table.
 */

import { eq } from "drizzle-orm";
import {
	appCatalog,
	appCatalogChanges,
	appCatalogHealthHistory,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpTools,
	appCatalogStoreListings,
	appCatalogToolTests,
	upstreamDriftReports,
} from "../../schema/catalog";
import { getCatalogAppById } from "./get-app";
import type { Database } from "./tool-source-policy";

export interface MergeCatalogAppsResult {
	dryRun: boolean;
	intoCatalogAppId: string;
	intoSlug: string;
	fromCatalogAppId: string;
	fromSlug: string;
	/** Store listings re-parented from the orphan row onto the canonical row. */
	relistedListings: number;
	/** Redundant snapshot rows (tools/resources/prompts/health/tests/drift) dropped. */
	droppedSnapshotRows: number;
	/** Change-log rows re-homed onto the canonical row for audit continuity. */
	movedChangeRows: number;
	/** Whether the orphan `app_catalog` row was deleted. */
	deletedOrphan: boolean;
	summary: string;
}

/**
 * Merge one catalog app (`from`, the orphan) into another (`into`, canonical).
 * Re-parents store listings + change history, deletes the orphan's snapshot
 * rows, and removes the orphan row. Idempotent: merging an already-merged /
 * missing `from` is a no-op error surfaced to the caller.
 */
export async function mergeCatalogApps(
	db: Database,
	params: {
		fromCatalogAppId: string;
		intoCatalogAppId: string;
		dryRun?: boolean;
	},
): Promise<MergeCatalogAppsResult> {
	const { fromCatalogAppId, intoCatalogAppId } = params;
	const dryRun = params.dryRun ?? false;

	if (fromCatalogAppId === intoCatalogAppId) {
		throw new Error("Cannot merge a catalog app into itself");
	}

	const fromApp = await getCatalogAppById(db, fromCatalogAppId);
	if (!fromApp) {
		throw new Error(`Source catalog app not found: ${fromCatalogAppId}`);
	}
	const intoApp = await getCatalogAppById(db, intoCatalogAppId);
	if (!intoApp) {
		throw new Error(`Target catalog app not found: ${intoCatalogAppId}`);
	}

	// Inventory the work before touching anything (also the dry-run report).
	const listings = await db
		.select({ id: appCatalogStoreListings.id })
		.from(appCatalogStoreListings)
		.where(eq(appCatalogStoreListings.catalogAppId, fromCatalogAppId));
	const changes = await db
		.select({ id: appCatalogChanges.id })
		.from(appCatalogChanges)
		.where(eq(appCatalogChanges.catalogAppId, fromCatalogAppId));

	const countRows = async (
		table:
			| typeof appCatalogMcpTools
			| typeof appCatalogMcpResources
			| typeof appCatalogMcpResourceTemplates
			| typeof appCatalogMcpPrompts
			| typeof appCatalogHealthHistory
			| typeof appCatalogToolTests
			| typeof upstreamDriftReports,
	): Promise<number> => {
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.where(eq(table.catalogAppId, fromCatalogAppId));
		return rows.length;
	};
	const droppedSnapshotRows =
		(await countRows(appCatalogMcpTools)) +
		(await countRows(appCatalogMcpResources)) +
		(await countRows(appCatalogMcpResourceTemplates)) +
		(await countRows(appCatalogMcpPrompts)) +
		(await countRows(appCatalogHealthHistory)) +
		(await countRows(appCatalogToolTests)) +
		(await countRows(upstreamDriftReports));

	const result: MergeCatalogAppsResult = {
		dryRun,
		intoCatalogAppId,
		intoSlug: intoApp.slug ?? intoApp.id,
		fromCatalogAppId,
		fromSlug: fromApp.slug ?? fromApp.id,
		relistedListings: listings.length,
		droppedSnapshotRows,
		movedChangeRows: changes.length,
		deletedOrphan: false,
		summary: "",
	};

	if (dryRun) {
		result.summary = `[DRY RUN] Would re-parent ${listings.length} listing(s) and ${changes.length} change row(s) from ${fromApp.slug} → ${intoApp.slug}, drop ${droppedSnapshotRows} snapshot row(s), and delete ${fromApp.slug}.`;
		return result;
	}

	// 1. Re-parent store listings onto the canonical row. A canonical app may
	//    have multiple listings in one store when products share an MCP endpoint;
	//    (source, sourceAppId) remains globally unique.
	await db
		.update(appCatalogStoreListings)
		.set({ catalogAppId: intoCatalogAppId })
		.where(eq(appCatalogStoreListings.catalogAppId, fromCatalogAppId));

	// 2. Preserve audit continuity: re-home change-log rows onto the canonical
	//    row, then stamp the merge itself.
	await db
		.update(appCatalogChanges)
		.set({ catalogAppId: intoCatalogAppId })
		.where(eq(appCatalogChanges.catalogAppId, fromCatalogAppId));
	await db.insert(appCatalogChanges).values({
		id: crypto.randomUUID(),
		catalogAppId: intoCatalogAppId,
		changeType: "updated",
		fieldName: "merged_catalog_app",
		oldValue: fromApp.slug,
		newValue: intoApp.slug,
		detectedAt: new Date().toISOString(),
	});

	// 3. Drop the orphan's redundant snapshot rows (the canonical row owns the
	//    authoritative tool/health inventory).
	await db
		.delete(appCatalogMcpTools)
		.where(eq(appCatalogMcpTools.catalogAppId, fromCatalogAppId));
	await db
		.delete(appCatalogMcpResources)
		.where(eq(appCatalogMcpResources.catalogAppId, fromCatalogAppId));
	await db
		.delete(appCatalogMcpResourceTemplates)
		.where(eq(appCatalogMcpResourceTemplates.catalogAppId, fromCatalogAppId));
	await db
		.delete(appCatalogMcpPrompts)
		.where(eq(appCatalogMcpPrompts.catalogAppId, fromCatalogAppId));
	await db
		.delete(appCatalogHealthHistory)
		.where(eq(appCatalogHealthHistory.catalogAppId, fromCatalogAppId));
	await db
		.delete(appCatalogToolTests)
		.where(eq(appCatalogToolTests.catalogAppId, fromCatalogAppId));
	await db
		.delete(upstreamDriftReports)
		.where(eq(upstreamDriftReports.catalogAppId, fromCatalogAppId));

	// 4. Delete the orphan catalog row.
	await db.delete(appCatalog).where(eq(appCatalog.id, fromCatalogAppId));
	result.deletedOrphan = true;

	result.summary = `Merged ${fromApp.slug} → ${intoApp.slug}: re-parented ${listings.length} listing(s) and ${changes.length} change row(s), dropped ${droppedSnapshotRows} snapshot row(s), deleted orphan row.`;
	return result;
}
