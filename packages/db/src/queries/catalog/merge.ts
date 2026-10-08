/**
 * App Catalog Queries — merge/re-parent operations.
 *
 * Store-brokered connectors that publish no MCP endpoint (e.g. GitHub's ChatGPT
 * SERVICE connector) cannot be deduplicated by endpoint hash, so historically
 * they were minted as standalone `app_catalog` rows alongside the vendor's
 * canonical runnable row (this is how `github-3` ended up beside `github`).
 * `mergeCatalogApps` is the repair primitive: it re-parents the orphan row's
 * store listings onto the canonical row (turning them into listing facets),
 * moves the audit trail, repoints the apps built from the orphan, carries its
 * scanner credential binding when the canonical row has none, drops the
 * orphan's now-redundant tool/health snapshots, and deletes the orphan
 * `app_catalog` row — all in one `db.batch()`, so a failure leaves nothing
 * half-merged. (`apps.catalog_app_id` is `ON DELETE SET NULL`: deleting the
 * orphan without repointing would silently unlink every base app and tenant
 * install built from it.)
 *
 * Going forward, vendor-identity canonicalization in `syncCatalogAppFromStore`
 * prevents new duplicates; this handles the ones already in the table.
 */

import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { apps } from "../../schema/apps";
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
import { batchNonEmpty } from "../../utils/batch";
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
	/** Apps (base apps and installs) whose `catalogAppId` moves to the canonical row. */
	repointedApps: number;
	/** Whether the orphan's scanner credential binding moves to the canonical row. */
	carriedScanConnection: boolean;
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

	const repointApps = await db
		.select({ id: apps.id })
		.from(apps)
		.where(eq(apps.catalogAppId, fromCatalogAppId));
	// The canonical row keeps its own scanner binding; the orphan's only moves
	// over when the canonical row has none, so an authenticated scan survives.
	const carriedScanConnection = Boolean(
		fromApp.scanConnectionId && !intoApp.scanConnectionId,
	);

	const result: MergeCatalogAppsResult = {
		dryRun,
		intoCatalogAppId,
		intoSlug: intoApp.slug ?? intoApp.id,
		fromCatalogAppId,
		fromSlug: fromApp.slug ?? fromApp.id,
		relistedListings: listings.length,
		droppedSnapshotRows,
		movedChangeRows: changes.length,
		repointedApps: repointApps.length,
		carriedScanConnection,
		deletedOrphan: false,
		summary: "",
	};

	const plan = `re-parent ${listings.length} listing(s) and ${changes.length} change row(s) from ${fromApp.slug} → ${intoApp.slug}, repoint ${repointApps.length} app(s)${carriedScanConnection ? ", carry the scan connection" : ""}, drop ${droppedSnapshotRows} snapshot row(s), and delete ${fromApp.slug}`;
	if (dryRun) {
		result.summary = `[DRY RUN] Would ${plan}.`;
		return result;
	}

	const fromId = fromCatalogAppId;
	const writes: BatchItem<"sqlite">[] = [
		// 1. Store listings become facets of the canonical row. A canonical app may
		//    have several listings in one store when products share an endpoint;
		//    (source, sourceAppId) remains globally unique.
		db
			.update(appCatalogStoreListings)
			.set({ catalogAppId: intoCatalogAppId })
			.where(eq(appCatalogStoreListings.catalogAppId, fromId)),
		// 2. Apps built from the orphan follow it, before the delete would null them.
		db
			.update(apps)
			.set({ catalogAppId: intoCatalogAppId })
			.where(eq(apps.catalogAppId, fromId)),
		// 3. Audit continuity: re-home change-log rows, then stamp the merge.
		db
			.update(appCatalogChanges)
			.set({ catalogAppId: intoCatalogAppId })
			.where(eq(appCatalogChanges.catalogAppId, fromId)),
		db.insert(appCatalogChanges).values({
			id: crypto.randomUUID(),
			catalogAppId: intoCatalogAppId,
			changeType: "updated",
			fieldName: "merged_catalog_app",
			oldValue: fromApp.slug,
			newValue: intoApp.slug,
			detectedAt: new Date().toISOString(),
		}),
	];
	if (carriedScanConnection) {
		writes.push(
			db
				.update(appCatalog)
				.set({
					scanConnectionId: fromApp.scanConnectionId,
					scanConnectionHeader: fromApp.scanConnectionHeader,
					scanConnectionTemplate: fromApp.scanConnectionTemplate,
					scanOrganizationId: fromApp.scanOrganizationId,
					scanClientCredentialsTokenUrl: fromApp.scanClientCredentialsTokenUrl,
				})
				.where(eq(appCatalog.id, intoCatalogAppId)),
		);
	}
	// 4. Drop the orphan's redundant snapshot rows (the canonical row owns the
	//    authoritative tool/health inventory), then the orphan itself.
	writes.push(
		db
			.delete(appCatalogMcpTools)
			.where(eq(appCatalogMcpTools.catalogAppId, fromId)),
		db
			.delete(appCatalogMcpResources)
			.where(eq(appCatalogMcpResources.catalogAppId, fromId)),
		db
			.delete(appCatalogMcpResourceTemplates)
			.where(eq(appCatalogMcpResourceTemplates.catalogAppId, fromId)),
		db
			.delete(appCatalogMcpPrompts)
			.where(eq(appCatalogMcpPrompts.catalogAppId, fromId)),
		db
			.delete(appCatalogHealthHistory)
			.where(eq(appCatalogHealthHistory.catalogAppId, fromId)),
		db
			.delete(appCatalogToolTests)
			.where(eq(appCatalogToolTests.catalogAppId, fromId)),
		db
			.delete(upstreamDriftReports)
			.where(eq(upstreamDriftReports.catalogAppId, fromId)),
		db.delete(appCatalog).where(eq(appCatalog.id, fromId)),
	);
	await db.batch(batchNonEmpty(writes));
	result.deletedOrphan = true;

	result.summary = `Merged ${fromApp.slug} → ${intoApp.slug} in one batch: ${plan}.`;
	return result;
}
