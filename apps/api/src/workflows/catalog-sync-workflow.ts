import { assetsBaseUrl as resolveAssetsBaseUrl } from "./assets-base-url";
import { CatalogSnapshotSchema } from "@tedix/api-contract/schemas/catalog-snapshot";
/**
 * CatalogSyncWorkflow - Cloudflare Workflow for syncing Catalog
 *
 * Sync modes:
 * - r2: Read JSON files from R2 bucket (recommended for production)
 * - upload: Accept pre-fetched JSON data in request body (for small datasets)
 * - full: Fetch all apps from a live source directory API
 * - incremental: Fetch only changed apps (not implemented)
 *
 * Supported sources:
 * - Supplier snapshots: normalized inputs captured by private executable skills
 * - Claude: official Anthropic MCP Registry snapshots (supplemental metadata)
 *
 * Flow:
 * 1. Create sync log entry
 * 2. List/read JSON files from R2 or request body
 * 3. Auto-detect source from filename pattern
 * 4. Transform source format to common SyncCatalogAppInput
 * 5. Batch upsert (50 apps per batch for D1 compatibility)
 * 6. Detect removed apps (full sync only)
 * 7. Finalize sync log
 *
 * @see https://developers.cloudflare.com/workflows/
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { createDbClient } from "@tedix/db/client";
import { syncCatalogMcpTools } from "@tedix/db/queries/catalog/mcp-tools";
import {
	getCatalogSnapshotStats,
	listEnabledCatalogAppsForVectorSync,
} from "@tedix/db/queries/catalog/scheduled-maintenance";
import { getCatalogStoreListingBySourceId } from "@tedix/db/queries/catalog/store-listings";
import { refreshCatalogShadowedVariants } from "@tedix/db/queries/catalog/vendor-variants";
import {
	disableOrphanedCatalogApps,
	markStaleFeedStoreListingsAsRemoved,
	SNAPSHOT_FEED_MARKER,
	markStoreListingsAsRemoved,
	updateAppCatalogSyncLog,
} from "@tedix/db/queries/catalog/sync-logs";
import {
	bulkSyncCatalogAppsFromStore,
	type SyncCatalogAppInput,
} from "@tedix/db/queries/catalog/upsert-sync";
import type { Source } from "@tedix/db/schema/catalog";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	bulkUpsertCatalogApps,
	type CatalogAppVectorInput,
	getOrCreateCatalogVectorClient,
} from "@tedix/db/vector/catalog";
import { runCatalogSyncBatch } from "./catalog-sync-batch";
import { isSupportedCatalogR2Path } from "../lib/catalog-sync-source";
import {
	type DetectedSource,
	detectSourceFromFilename,
	isCatalogSyncDeployReset,
	planCatalogFileBatchOffsets,
} from "./catalog-sync-files";
import {
	mapCategory,
	mapConnectorType,
	mapDistributionChannel,
	mapDeveloperType,
	mapReviewStatus,
	mapAppStatus,
	mapAuthTypes,
	isChatGPTFormat,
	isClaudeFormat,
	isChatGPTAppsListFormat,
	isChatGPTActionsFormat,
	isClaudeServersFormat,
	transformClaudeEntry,
	transformChatGPTAppsListEntry,
	transformChatGPTActionsEntry,
	transformClaudeServerEntry,
	type RawConnector,
	type RawClaudeServerEntry,
} from "./catalog-sync-transform";

// ============================================================================
// Types
// ============================================================================

export type SyncType = "full" | "incremental" | "upload" | "r2";

const CATALOG_VECTOR_PAGE_SIZE = 100;

export interface CatalogSyncWorkflowParams {
	/** Sync mode */
	syncType: SyncType;
	searchOnly?: boolean;
	/** R2 path to JSON file or folder (for r2 mode) */
	r2Path?: string;
	/** Live source dispatch for full syncs */
	source?: "claude" | "snapshot";
	snapshotKey?: string;
	snapshotFeed?: string;
	snapshotUpstreamUrl?: string;
	snapshotProvenanceKey?: string;
	snapshotRemovalSources?: Source[];
	snapshotOwner?: string;
	snapshotInputHash?: string;
	/** For upload mode: pre-fetched JSON data */
	data?: Record<string, unknown>;
	/** Sync log ID (created before workflow starts) */
	syncLogId: string;
}

interface R2FileBatchResult {
	filename: string;
	source: Source;
	appsCount: number;
	workItemsCount: number;
	inserted: number;
	updated: number;
	failed: number;
	errors: string[];
	sourceAppIds: string[];
}

type NormalizedCatalogAsset = {
	url: string | null;
	normalized: boolean;
	status:
		| "normalized"
		| "already_normalized"
		| "missing"
		| "fetch_failed"
		| "invalid";
};

// ============================================================================
// Workflow Implementation
// ============================================================================

export class CatalogSyncWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	CatalogSyncWorkflowParams
> {
	private readonly BATCH_SIZE = 50;
	private readonly R2_BATCH_SIZE = 25;
	private readonly CATALOG_ASSET_FETCH_TIMEOUT_MS = 10_000;

	/**
	 * Detect the sync source from an R2 path prefix.
	 * e.g. "catalog/claude/" → "claude"
	 */
	private detectSourceFromR2Path(r2Path?: string): Source | null {
		if (!r2Path) return null;
		if (r2Path.includes("catalog/claude")) return "claude" as Source;
		return null;
	}

	async run(
		event: WorkflowEvent<CatalogSyncWorkflowParams>,
		step: WorkflowStep,
	) {
		const {
			syncType,
			r2Path,
			data,
			syncLogId,
			source: liveSource,
			searchOnly = false,
		} = event.payload;

		console.log(
			`[App Catalog Sync] Starting ${syncType} sync, logId: ${syncLogId}`,
		);

		const db = createDbClient(this.env.DB);

		// Detect source early from R2 path so sync log has it from the start
		const detectedSource = this.detectSourceFromR2Path(r2Path);
		if (detectedSource) {
			await updateAppCatalogSyncLog(db, syncLogId, {
				source: detectedSource,
			});
		}

		// Track results across files (store minimal data, not full apps array)
		let totalAppsDiscovered = 0;
		let totalInserted = 0;
		let totalUpdated = 0;
		let totalFailed = 0;
		const filesProcessed: string[] = [];
		const sourcesProcessed: Source[] = [];
		const allErrors: string[] = [];
		const sourceAppIds: Map<Source, string[]> = new Map();

		try {
			// Step 0: Capture catalog state before sync for changelog diff
			const beforeStats = (await step.do(
				"capture-before-stats",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					return getCatalogSnapshotStats(db);
				},
			)) as { total: number; mcpCount: number; enabledCount: number };

			if (searchOnly) {
				// Existing catalog is the input. No supplier capture or catalog writes.
			} else if (syncType === "r2") {
				// R2 mode: list and process files from R2 bucket
				if (!r2Path) {
					await this.failSync(
						db,
						syncLogId,
						"R2 mode requires r2Path parameter",
					);
					return {
						success: false,
						error: "R2 mode requires r2Path parameter",
						syncLogId,
					};
				}

				if (!isSupportedCatalogR2Path(r2Path)) {
					await this.failSync(
						db,
						syncLogId,
						"R2 sync supports only the Claude registry namespace.",
					);
					return {
						success: false,
						error: "R2 sync supports only the Claude registry namespace.",
						syncLogId,
					};
				}

				// Step 1: List files in R2
				const fileListJson = await step.do(
					"list-r2-files",
					{
						retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
						timeout: "1 minute",
					},
					async () => {
						const files = await this.listR2Files(r2Path);
						return JSON.stringify(files);
					},
				);

				const r2Files = JSON.parse(fileListJson as string) as string[];
				console.log(
					`[App Catalog Sync] Found ${r2Files.length} files in R2: ${r2Files.join(", ")}`,
				);

				if (r2Files.length === 0) {
					await this.failSync(
						db,
						syncLogId,
						`No JSON files found at R2 path: ${r2Path}`,
					);
					return { success: false, error: "No JSON files found", syncLogId };
				}

				// Step 2: Process official registry files in bounded durable batches.
				// A registry file can contain hundreds of servers, and tool projection
				// performs multiple D1 operations per server. Keeping the whole file in
				// one step exceeded Cloudflare's five-minute attempt window.
				for (const filePath of r2Files) {
					const detectedSource = detectSourceFromFilename(filePath);
					if (!detectedSource) {
						console.log(
							`[App Catalog Sync] Skipping file (not a main data file): ${filePath}`,
						);
						continue;
					}

					const stableFileName = filePath.replace(/[^a-zA-Z0-9]/g, "_");
					const firstResult = (await step.do(
						`sync-file-${stableFileName}-batch-0`,
						{
							retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
							timeout: "5 minutes",
						},
						async () => {
							return await this.processAndCheckpointR2FileBatch(
								db,
								syncLogId,
								filePath,
								detectedSource,
								0,
								this.R2_BATCH_SIZE,
								{
									appsDiscovered: totalAppsDiscovered,
									appsUpdated: totalInserted + totalUpdated,
									appsFailed: totalFailed,
								},
							);
						},
					)) as R2FileBatchResult;

					let fileInserted = firstResult.inserted;
					let fileUpdated = firstResult.updated;
					let fileFailed = firstResult.failed;
					const fileErrors = [...firstResult.errors];
					const batchOffsets = planCatalogFileBatchOffsets(
						firstResult.workItemsCount,
						this.R2_BATCH_SIZE,
					);

					for (const offset of batchOffsets.slice(1)) {
						const priorFileInserted = fileInserted;
						const priorFileUpdated = fileUpdated;
						const priorFileFailed = fileFailed;
						const batchResult = (await step.do(
							`sync-file-${stableFileName}-batch-${offset}`,
							{
								retries: {
									limit: 2,
									delay: "5 seconds",
									backoff: "exponential",
								},
								timeout: "5 minutes",
							},
							async () => {
								return await this.processAndCheckpointR2FileBatch(
									db,
									syncLogId,
									filePath,
									detectedSource,
									offset,
									this.R2_BATCH_SIZE,
									{
										appsDiscovered: totalAppsDiscovered + firstResult.appsCount,
										appsUpdated:
											totalInserted +
											totalUpdated +
											priorFileInserted +
											priorFileUpdated,
										appsFailed: totalFailed + priorFileFailed,
									},
								);
							},
						)) as R2FileBatchResult;
						fileInserted += batchResult.inserted;
						fileUpdated += batchResult.updated;
						fileFailed += batchResult.failed;
						fileErrors.push(...batchResult.errors);
					}

					console.log(
						`[App Catalog Sync] Synced ${firstResult.filename}: ${firstResult.appsCount} apps in ${batchOffsets.length} batches (${fileInserted} inserted, ${fileUpdated} updated, ${fileFailed} failed)`,
					);

					totalAppsDiscovered += firstResult.appsCount;
					totalInserted += fileInserted;
					totalUpdated += fileUpdated;
					totalFailed += fileFailed;
					filesProcessed.push(firstResult.filename);
					if (!sourcesProcessed.includes(firstResult.source)) {
						sourcesProcessed.push(firstResult.source);
					}
					allErrors.push(...fileErrors.slice(0, 10));

					// Track source app IDs for removal detection
					const existingIds = sourceAppIds.get(firstResult.source) || [];
					sourceAppIds.set(firstResult.source, [
						...existingIds,
						...firstResult.sourceAppIds,
					]);
				}
			} else if (syncType === "full" && liveSource === "snapshot") {
				if (!event.payload.snapshotKey || !event.payload.snapshotProvenanceKey)
					throw new NonRetryableError(
						"Snapshot archive and provenance are required",
					);
				const archived = await this.readR2Json(event.payload.snapshotKey);
				if (archived.inputHash !== event.payload.snapshotInputHash)
					throw new NonRetryableError("Snapshot input identity mismatch");
				const snapshot = CatalogSnapshotSchema.parse(archived.snapshot);
				totalAppsDiscovered = snapshot.items.length;
				// Mark every listing this feed writes so a registry sync's removal
				// pass for the same source leaves it to this feed's own reconciliation.
				const feedItems = snapshot.items.map((item) => ({
					...item,
					rawData: {
						...(item.rawData ?? {}),
						[SNAPSHOT_FEED_MARKER]: event.payload.snapshotProvenanceKey!,
					},
				}));
				const batches = this.splitIntoBatches(feedItems, 10);
				for (const [index, batch] of batches.entries()) {
					const result = await step.do(
						`sync-snapshot-batch-${index}`,
						{
							retries: { limit: 2, delay: "10 seconds" },
							timeout: "5 minutes",
						},
						async () => {
							const outcome = await runCatalogSyncBatch(batch, {
								normalize: (items) => this.normalizeCatalogAssets(items),
								sync: (items) =>
									bulkSyncCatalogAppsFromStore(db, items, {
										allowCreate: true,
									}),
							});
							if (outcome.failed)
								throw new Error(
									`Snapshot batch ${index} failed: ${outcome.errors.join("; ")}`,
								);
							return outcome;
						},
					);
					totalInserted += result.inserted;
					totalUpdated += result.updated;
				}
				for (const item of snapshot.items) {
					if (!sourcesProcessed.includes(item.source))
						sourcesProcessed.push(item.source);
					if (event.payload.snapshotRemovalSources?.includes(item.source)) {
						const ids = sourceAppIds.get(item.source) ?? [];
						ids.push(item.sourceAppId);
						sourceAppIds.set(item.source, ids);
					}
				}
				filesProcessed.push(event.payload.snapshotKey);
			} else if (syncType === "upload") {
				// Upload mode: process data from request body in one step
				if (!data) {
					await this.failSync(
						db,
						syncLogId,
						"Upload mode requires data parameter",
					);
					return {
						success: false,
						error: "Upload mode requires data parameter",
						syncLogId,
					};
				}

				const resultJson = await step.do(
					"sync-upload-data",
					{
						retries: { limit: 2, delay: "5 seconds" },
						timeout: "10 minutes",
					},
					async () => {
						return await this.processAndSyncUploadData(data);
					},
				);

				const result = resultJson as {
					source: Source;
					appsCount: number;
					inserted: number;
					updated: number;
					failed: number;
					errors: string[];
					sourceAppIds: string[];
				};

				totalAppsDiscovered = result.appsCount;
				totalInserted = result.inserted;
				totalUpdated = result.updated;
				totalFailed = result.failed;
				filesProcessed.push("upload");
				sourcesProcessed.push(result.source);
				allErrors.push(...result.errors);
				sourceAppIds.set(result.source, result.sourceAppIds);
			} else {
				await this.failSync(
					db,
					syncLogId,
					`Sync type "${syncType}" not supported. Use "r2", "upload", or the supplier snapshot import API.`,
				);
				return { success: false, error: "Unsupported sync type", syncLogId };
			}

			console.log(
				`[App Catalog Sync] Total: ${totalAppsDiscovered} apps discovered, ${totalInserted} inserted, ${totalUpdated} updated`,
			);

			if (!searchOnly && totalAppsDiscovered === 0) {
				await this.failSync(db, syncLogId, "No apps found in data sources");
				return { success: false, error: "No apps found", syncLogId };
			}

			// Update sync log with discovered count and sources
			const sourceSummary =
				sourcesProcessed.length === 1
					? sourcesProcessed[0]
					: (detectedSource ?? null);
			await updateAppCatalogSyncLog(db, syncLogId, {
				appsDiscovered: totalAppsDiscovered,
				source: sourceSummary as Source | null,
			});

			// Step 3: Detect removed apps per source
			let totalListingsRemoved = 0;
			let totalAppsDisabled = 0;

			for (const [source, ids] of sourceAppIds) {
				if (ids.length > 0) {
					const removedResult = await step.do(
						`detect-removals-${source}`,
						{
							retries: { limit: 2, delay: "2 seconds" },
							timeout: "2 minutes",
						},
						async () => {
							const removed =
								liveSource === "snapshot"
									? await markStaleFeedStoreListingsAsRemoved(
											db,
											source,
											event.payload.snapshotProvenanceKey!,
											ids,
										)
									: await markStoreListingsAsRemoved(db, source, ids);
							return { listingsRemoved: removed };
						},
					);

					const result = removedResult as { listingsRemoved: number };
					totalListingsRemoved += result.listingsRemoved;
					console.log(
						`[App Catalog Sync] Removed ${result.listingsRemoved} store listings for ${source}`,
					);
				}
			}

			// Disable orphaned apps (apps with no store listings)
			if (searchOnly || liveSource === "snapshot") {
				console.log(
					"[App Catalog Sync] Skipping orphan-disable pass for snapshot or search-only refresh",
				);
			} else {
				const orphanResult = await step.do(
					"disable-orphaned-apps",
					{
						retries: { limit: 2, delay: "2 seconds" },
						timeout: "1 minute",
					},
					async () => {
						const disabled = await disableOrphanedCatalogApps(db);
						return { appsDisabled: disabled };
					},
				);

				totalAppsDisabled = (orphanResult as { appsDisabled: number })
					.appsDisabled;
			}

			// Recompute which vendor variants the public catalog list hides: sync
			// adds, updates and disables rows, which can move a vendor's canonical
			// card. Non-fatal; scheduled maintenance repeats it as a safety net.
			await step
				.do(
					"refresh-shadowed-variants",
					{ retries: { limit: 2, delay: "2 seconds" }, timeout: "1 minute" },
					async () => refreshCatalogShadowedVariants(db),
				)
				.catch((error: unknown) => {
					console.warn(
						"[App Catalog Sync] Shadowed-variant refresh failed (non-fatal):",
						error instanceof Error ? error.message : String(error),
					);
				});

			// Step 4: Compute changelog diff (before vs after)
			const changelog = (await step.do(
				"compute-changelog",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					const after = await getCatalogSnapshotStats(db);

					return {
						before: beforeStats,
						after,
						netNewApps: after.total - beforeStats.total,
						netNewMcp: after.mcpCount - beforeStats.mcpCount,
						netNewEnabled: after.enabledCount - beforeStats.enabledCount,
						inserted: totalInserted,
						updated: totalUpdated,
						removed: totalAppsDisabled,
						listingsRemoved: totalListingsRemoved,
						failed: totalFailed,
						syncedAt: new Date().toISOString(),
					};
				},
			)) as {
				before: { total: number; mcpCount: number; enabledCount: number };
				after: { total: number; mcpCount: number; enabledCount: number };
				netNewApps: number;
				netNewMcp: number;
				netNewEnabled: number;
				inserted: number;
				updated: number;
				removed: number;
				listingsRemoved: number;
				failed: number;
				syncedAt: string;
			};

			console.log(
				`[CatalogSync] Changelog: ${changelog.netNewApps >= 0 ? "+" : ""}${changelog.netNewApps} net apps (${changelog.inserted} new, ${changelog.updated} updated, ${changelog.removed} removed), ` +
					`MCP: ${changelog.netNewMcp >= 0 ? "+" : ""}${changelog.netNewMcp}, total: ${changelog.after.total}`,
			);

			// Step 5: Reconcile the enabled catalog into AI Search in bounded,
			// durable pages. The former all-catalog step exceeded Cloudflare's
			// five-minute attempt window once the catalog reached 2,722 apps.
			const search = await this.reconcileSearch(
				db,
				step,
				changelog.after.enabledCount,
			);
			const success = !searchOnly || search.complete;
			// Step 6: Finalize sync log with changelog
			await step.do(
				"finalize-sync-log",
				{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					await updateAppCatalogSyncLog(db, syncLogId, {
						status: success ? "completed" : "failed",
						error: success
							? null
							: "AI Search refresh incomplete; retry searchOnly sync",
						completedAt: new Date().toISOString(),
						appsUpdated: totalInserted + totalUpdated,
						appsRemoved: totalAppsDisabled,
						appsFailed: totalFailed,
						details: {
							...(liveSource === "snapshot"
								? {
										source: event.payload.snapshotFeed ?? "snapshot",
										upstreamUrl: event.payload.snapshotUpstreamUrl ?? "",
										snapshotOwner: event.payload.snapshotOwner ?? "",
										inputHash: event.payload.snapshotInputHash ?? "",
										snapshotKey: event.payload.snapshotKey ?? "",
									}
								: {}),
							syncType,
							searchOnly,
							filesProcessed,
							sources: sourcesProcessed,
							changelog: {
								before: changelog.before,
								after: changelog.after,
								netNewApps: changelog.netNewApps,
								netNewMcp: changelog.netNewMcp,
								netNewEnabled: changelog.netNewEnabled,
							},
							inserted: totalInserted,
							updated: totalUpdated,
							listingsRemoved: totalListingsRemoved,
							appsDisabled: totalAppsDisabled,
							vector: search,
							errors: allErrors.slice(0, 10),
						},
					});
					return { success: true };
				},
			);

			console.log(
				`[App Catalog Sync] Sync complete: ${totalInserted} inserted, ${totalUpdated} updated, ${totalAppsDisabled} disabled, ${totalFailed} failed`,
			);

			return {
				success,
				search,
				syncLogId,
				appsDiscovered: totalAppsDiscovered,
				appsInserted: totalInserted,
				appsUpdated: totalUpdated,
				appsRemoved: totalAppsDisabled,
				appsFailed: totalFailed,
				filesProcessed,
				changelog: {
					before: changelog.before,
					after: changelog.after,
					netNewApps: changelog.netNewApps,
					netNewMcp: changelog.netNewMcp,
					netNewEnabled: changelog.netNewEnabled,
				},
			};
		} catch (error) {
			if (isCatalogSyncDeployReset(error)) {
				console.warn(
					"[App Catalog Sync] Deployment reset interrupted this attempt; allowing Workflow replay",
				);
				throw error;
			}

			// Ensure sync log is always finalized, even on unexpected errors
			console.error(`[App Catalog Sync] Unexpected error:`, error);
			try {
				await updateAppCatalogSyncLog(db, syncLogId, {
					status: "failed",
					completedAt: new Date().toISOString(),
					appsUpdated: totalInserted + totalUpdated,
					appsFailed: totalFailed,
					error: error instanceof Error ? error.message : String(error),
				});
			} catch (logError) {
				console.error(
					`[App Catalog Sync] Failed to update sync log:`,
					logError,
				);
			}
			return {
				success: false,
				syncLogId,
				error: error instanceof Error ? error.message : String(error),
				appsDiscovered: totalAppsDiscovered,
				appsInserted: totalInserted,
				appsUpdated: totalUpdated,
				appsFailed: totalFailed,
				filesProcessed,
			};
		}
	}

	private async reconcileSearch(
		db: ReturnType<typeof createDbClient>,
		step: WorkflowStep,
		enabledCount: number,
	) {
		let vectorReady = false;
		let vectorSynced = 0;
		let vectorFailed = 0;
		let vectorSkipped = false;
		const vectorErrors: string[] = [];
		try {
			vectorReady = (await step.do(
				"vector-index-ready",
				{
					retries: { limit: 1, delay: "2 seconds" },
					timeout: "30 seconds",
				},
				async () => {
					const vectorClient = await getOrCreateCatalogVectorClient(this.env);
					return vectorClient !== null;
				},
			)) as boolean;
			vectorSkipped = !vectorReady;
			if (!vectorReady) {
				console.log(
					"[App Catalog Sync] Catalog vector index not configured — skipping vector sync",
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error("[App Catalog Sync] Vector index setup failed", error);
			vectorSkipped = true;
			vectorErrors.push(message);
		}

		// Pages follow an id cursor, not an offset: apps that change status mid
		// run must not shift later pages and end the reconciliation early.
		// Step names keep the former offset form so a native replay can still
		// restart from the earliest failed `vector-index-sync-<n>` step.
		let vectorReachedEnd = false;
		if (vectorReady) {
			const maxPages =
				Math.ceil(enabledCount / CATALOG_VECTOR_PAGE_SIZE) * 2 + 10;
			let afterId: string | undefined;
			for (let page = 0; page < maxPages; page++) {
				const offset = page * CATALOG_VECTOR_PAGE_SIZE;
				try {
					const result = (await step.do(
						`vector-index-sync-${offset}`,
						{
							retries: { limit: 1, delay: "2 seconds" },
							timeout: "5 minutes",
						},
						async () => {
							const vectorClient = await getOrCreateCatalogVectorClient(
								this.env,
							);
							if (!vectorClient) {
								return {
									vectorSynced: 0,
									vectorFailed: 0,
									skipped: true,
									count: 0,
									lastId: null,
								};
							}
							const apps = await listEnabledCatalogAppsForVectorSync(db, {
								limit: CATALOG_VECTOR_PAGE_SIZE,
								afterId,
							});
							const vectorApps: CatalogAppVectorInput[] = apps.map((app) => ({
								id: app.id,
								slug: app.slug,
								name: app.name,
								description: app.description,
								modelDescription: app.modelDescription,
								developer: app.developer,
								category: app.category,
								categories: app.categories as string[] | null,
								keywordsForDiscovery: app.keywordsForDiscovery as
									| string[]
									| null,
								keywordsForTriggering: app.keywordsForTriggering as
									| string[]
									| null,
								seoDescription: app.seoDescription,
								healthStatus: app.healthStatus,
								mcpToolCount: app.mcpToolCount,
								mcpEndpointNormalized: app.mcpEndpointNormalized,
								connectorType: app.connectorType,
								hasWrites: app.hasWrites,
								hasInteractive: app.hasInteractive,
							}));
							const result = await bulkUpsertCatalogApps(
								vectorClient,
								vectorApps,
							);
							console.log(
								`[App Catalog Sync] Vector page ${offset}: ${result.upserted} upserted, ${result.failed} failed`,
							);
							return {
								vectorSynced: result.upserted,
								vectorFailed: result.failed,
								skipped: false,
								count: apps.length,
								lastId: apps.at(-1)?.id ?? null,
							};
						},
					)) as {
						vectorSynced: number;
						vectorFailed: number;
						skipped: boolean;
						count: number;
						lastId: string | null;
					};
					vectorSynced += result.vectorSynced;
					vectorFailed += result.vectorFailed;
					vectorSkipped ||= result.skipped;
					if (result.skipped) break;
					if (typeof result.count !== "number") {
						// A run that started on offset paging replays its cached pages
						// without a cursor; it cannot prove it reached the end.
						vectorErrors.push(
							`offset ${offset}: cached page has no cursor; rerun the refresh`,
						);
						break;
					}
					if (result.count < CATALOG_VECTOR_PAGE_SIZE || !result.lastId) {
						vectorReachedEnd = true;
						break;
					}
					afterId = result.lastId;
				} catch (error) {
					// Without the page's last id the cursor cannot advance; stop
					// and report the reconciliation incomplete.
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(
						`[App Catalog Sync] Vector page ${offset} failed after retries`,
						error,
					);
					vectorErrors.push(`offset ${offset}: ${message}`);
					break;
				}
			}
		}

		return {
			synced: vectorSynced,
			failed: vectorFailed,
			skipped: vectorSkipped,
			complete:
				!vectorSkipped &&
				vectorReachedEnd &&
				vectorFailed === 0 &&
				vectorErrors.length === 0,
			errors: vectorErrors.slice(0, 10),
		};
	}

	/**
	 * Helper to fail sync with error
	 */
	private async failSync(
		db: ReturnType<typeof createDbClient>,
		syncLogId: string,
		error: string,
	) {
		await updateAppCatalogSyncLog(db, syncLogId, {
			status: "failed",
			completedAt: new Date().toISOString(),
			error,
		});
	}

	/**
	 * List JSON files in R2 path
	 */
	private async listR2Files(r2Path: string): Promise<string[]> {
		const files: string[] = [];

		// Check if path is a single file or folder
		if (r2Path.endsWith(".json")) {
			// Single file
			const obj = await this.env.R2_BUCKET.head(r2Path);
			if (obj) {
				files.push(r2Path);
			}
		} else {
			// Folder - list all JSON files
			const prefix = r2Path.endsWith("/") ? r2Path : `${r2Path}/`;
			const listed = await this.env.R2_BUCKET.list({ prefix });

			for (const obj of listed.objects) {
				if (obj.key.endsWith(".json")) {
					files.push(obj.key);
				}
			}
		}

		return files;
	}

	/**
	 * Process and sync one bounded slice of an R2 file. Re-reading the source in
	 * each step is intentional: Workflow state receives only a compact summary,
	 * while stable upserts keep retries idempotent.
	 */
	private async processAndSyncFileBatch(
		filePath: string,
		detectedSource: DetectedSource,
		batchOffset: number,
		batchSize: number,
	): Promise<R2FileBatchResult> {
		const db = createDbClient(this.env.DB);
		const { source, filename } = detectedSource;
		const allowCreate = detectedSource.allowCreate ?? true;

		const data = await this.readR2Json(filePath);

		// Transform to apps
		const apps: SyncCatalogAppInput[] = [];
		const transformErrors: string[] = [];
		let workItemsCount = 0;

		if (source === "claude" && isClaudeFormat(data)) {
			workItemsCount = data.entries.length;
			for (const entry of data.entries) {
				try {
					const app = transformClaudeEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(`Transform failed for ${entry.id}: ${error}`);
				}
			}
		} else if (source === "claude" && isClaudeServersFormat(data)) {
			workItemsCount = data.servers.length;
			for (const entry of data.servers) {
				try {
					const app = transformClaudeServerEntry(entry);
					apps.push(app);
				} catch (error) {
					const name = entry.server?.name || entry.server?.title || "unknown";
					transformErrors.push(`Transform failed for ${name}: ${error}`);
				}
			}
		} else {
			throw new NonRetryableError(
				`Cannot process ${filename}: format doesn't match detected source ${source}`,
			);
		}

		console.log(
			`[App Catalog Sync] Transformed ${apps.length} apps from ${filename}`,
		);

		// Batch insert directly (don't return apps array)
		const batchApps = apps.slice(batchOffset, batchOffset + batchSize);
		const batches = this.splitIntoBatches(batchApps);
		let totalInserted = 0;
		let totalUpdated = 0;
		const syncErrors: string[] = [];

		for (const batch of batches) {
			try {
				const result = await bulkSyncCatalogAppsFromStore(db, batch, {
					allowCreate,
				});
				totalInserted += result.inserted;
				totalUpdated += result.updated;
				syncErrors.push(...result.errors);
			} catch (error) {
				syncErrors.push(`Batch sync failed: ${error}`);
			}
		}

		// Pre-populate tools from Claude Registry toolNames
		if (source === "claude" && isClaudeServersFormat(data)) {
			const toolsResult = await this.prePopulateToolsFromClaudeRegistry(
				data.servers.slice(batchOffset, batchOffset + batchSize),
			);
			if (toolsResult.errors.length > 0) {
				syncErrors.push(...toolsResult.errors);
			}
		}

		// Return only summary, not the apps array
		return {
			filename,
			source,
			appsCount: apps.length,
			workItemsCount: Math.max(workItemsCount, apps.length),
			inserted: totalInserted,
			updated: totalUpdated,
			failed:
				(batchOffset === 0 ? transformErrors.length : 0) + syncErrors.length,
			errors: [
				...(batchOffset === 0 ? transformErrors : []),
				...syncErrors,
			].slice(0, 10),
			sourceAppIds: batchOffset === 0 ? apps.map((app) => app.sourceAppId) : [],
		};
	}

	private async processAndCheckpointR2FileBatch(
		db: ReturnType<typeof createDbClient>,
		syncLogId: string,
		filePath: string,
		detectedSource: DetectedSource,
		batchOffset: number,
		batchSize: number,
		prior: {
			appsDiscovered: number;
			appsUpdated: number;
			appsFailed: number;
		},
	): Promise<R2FileBatchResult> {
		const result = await this.processAndSyncFileBatch(
			filePath,
			detectedSource,
			batchOffset,
			batchSize,
		);
		const processedOffset = Math.min(
			batchOffset + batchSize,
			result.workItemsCount,
		);

		await updateAppCatalogSyncLog(db, syncLogId, {
			status: "running",
			completedAt: null,
			error: null,
			appsDiscovered:
				batchOffset === 0
					? prior.appsDiscovered + result.appsCount
					: prior.appsDiscovered,
			appsUpdated: prior.appsUpdated + result.inserted + result.updated,
			appsFailed: prior.appsFailed + result.failed,
			details: {
				status: "running",
				mode: "r2",
				source: result.source,
				filePath,
				total: result.workItemsCount,
				offset: processedOffset,
				batchSize,
			},
		});

		return result;
	}

	private assetsBaseUrl(): string {
		return resolveAssetsBaseUrl(this.env);
	}

	private isTedixCatalogAsset(url: string | null | undefined): boolean {
		if (!url) return false;
		return url.startsWith(`${this.assetsBaseUrl()}/app_catalog/`);
	}

	private safeAssetSegment(value: string): string {
		return (
			value
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 140) || crypto.randomUUID()
		);
	}

	private extensionFromContentType(
		contentType: string,
		url: string,
	): { ext: string; contentType: string } {
		const lowerType = contentType.toLowerCase();
		const lowerUrl = url.toLowerCase().split("?")[0] ?? "";
		if (lowerType.includes("svg") || lowerUrl.endsWith(".svg")) {
			return { ext: "svg", contentType: "image/svg+xml" };
		}
		if (lowerType.includes("webp") || lowerUrl.endsWith(".webp")) {
			return { ext: "webp", contentType: "image/webp" };
		}
		if (lowerType.includes("png") || lowerUrl.endsWith(".png")) {
			return { ext: "png", contentType: "image/png" };
		}
		if (
			lowerType.includes("jpeg") ||
			lowerType.includes("jpg") ||
			lowerUrl.endsWith(".jpg") ||
			lowerUrl.endsWith(".jpeg")
		) {
			return { ext: "jpg", contentType: "image/jpeg" };
		}
		if (lowerType.includes("gif") || lowerUrl.endsWith(".gif")) {
			return { ext: "gif", contentType: "image/gif" };
		}
		return { ext: "png", contentType: "image/png" };
	}

	private async copyCatalogAssetToR2(
		sourceUrl: string | null | undefined,
		keyBase: string,
	): Promise<NormalizedCatalogAsset> {
		if (!sourceUrl) return { url: null, normalized: false, status: "missing" };
		const trimmed = sourceUrl.trim();
		if (!trimmed) return { url: null, normalized: false, status: "missing" };
		if (this.isTedixCatalogAsset(trimmed)) {
			return { url: trimmed, normalized: true, status: "already_normalized" };
		}

		try {
			let bytes: ArrayBuffer;
			let metadata: { ext: string; contentType: string };

			if (trimmed.startsWith("data:image/")) {
				const match = trimmed.match(/^data:([^;,]+)(;base64)?,(.*)$/);
				if (!match) return { url: null, normalized: false, status: "invalid" };
				const contentType = match[1] ?? "image/png";
				const isBase64 = Boolean(match[2]);
				const payload = match[3] ?? "";
				const text = isBase64 ? atob(payload) : decodeURIComponent(payload);
				bytes = Uint8Array.from(text, (char) => char.charCodeAt(0)).buffer;
				metadata = this.extensionFromContentType(contentType, trimmed);
			} else if (
				trimmed.startsWith("http://") ||
				trimmed.startsWith("https://")
			) {
				const response = await fetch(trimmed, {
					headers: {
						accept:
							"image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
						"user-agent": "TedixCatalogAssetSync/1.0",
					},
					signal: AbortSignal.timeout(this.CATALOG_ASSET_FETCH_TIMEOUT_MS),
				});
				if (!response.ok) {
					await response.body?.cancel();
					console.warn(
						`[App Catalog Sync] Asset fetch failed ${response.status}: ${trimmed}`,
					);
					return { url: null, normalized: false, status: "fetch_failed" };
				}
				bytes = await response.arrayBuffer();
				metadata = this.extensionFromContentType(
					response.headers.get("content-type") ?? "",
					trimmed,
				);
			} else {
				return { url: null, normalized: false, status: "invalid" };
			}

			if (bytes.byteLength < 64 || bytes.byteLength > 8_000_000) {
				return { url: null, normalized: false, status: "invalid" };
			}

			const key = `${keyBase}.${metadata.ext}`;
			await this.env.R2_BUCKET.put(key, bytes, {
				httpMetadata: {
					contentType: metadata.contentType,
					cacheControl: "public, max-age=31536000, immutable",
				},
				customMetadata: {
					sourceUrl: trimmed.slice(0, 1024),
					normalizedAt: new Date().toISOString(),
				},
			});

			return {
				url: `${this.assetsBaseUrl()}/${key}`,
				normalized: true,
				status: "normalized",
			};
		} catch (error) {
			console.warn(
				`[App Catalog Sync] Failed to normalize catalog asset ${trimmed}:`,
				error,
			);
			return { url: null, normalized: false, status: "fetch_failed" };
		}
	}

	private async normalizeCatalogAssets(
		inputs: SyncCatalogAppInput[],
	): Promise<SyncCatalogAppInput[]> {
		return Promise.all(
			inputs.map((input) => this.normalizeCatalogAssetsForInput(input)),
		);
	}

	private async normalizeCatalogAssetsForInput(
		input: SyncCatalogAppInput,
	): Promise<SyncCatalogAppInput> {
		const source = this.safeAssetSegment(input.source);
		const sourceAppId = this.safeAssetSegment(input.sourceAppId);
		const keyRoot = `app_catalog/${source}/${sourceAppId}`;
		const next: SyncCatalogAppInput = {
			...input,
			logoUrl: null,
			logoUrlDark: null,
			richContent: input.richContent ? { ...input.richContent } : null,
			screenshots: input.screenshots ? [...input.screenshots] : null,
		};

		if (input.logoUrl) {
			const logo = await this.copyCatalogAssetToR2(
				input.logoUrl,
				`${keyRoot}/logo`,
			);
			if (logo.url) {
				next.logoUrl = logo.url;
				next.rawData = this.withCatalogAssetQuality(next.rawData, {
					logoStatus: logo.status,
					logoSourceUrl: input.logoUrl,
				});
			} else {
				const fallbackLogo = await this.copyFallbackFaviconToR2(
					input,
					`${keyRoot}/logo`,
				);
				if (fallbackLogo.url) {
					next.logoUrl = fallbackLogo.url;
				}
				next.rawData = this.withCatalogAssetQuality(next.rawData, {
					logoStatus: fallbackLogo.url ? "fallback_favicon" : logo.status,
					logoSourceUrl: input.logoUrl,
				});
			}
		} else {
			const fallbackLogo = await this.copyFallbackFaviconToR2(
				input,
				`${keyRoot}/logo`,
			);
			if (fallbackLogo.url) {
				next.logoUrl = fallbackLogo.url;
			}
			next.rawData = this.withCatalogAssetQuality(next.rawData, {
				logoStatus: fallbackLogo.url ? "fallback_favicon" : "missing",
				logoSourceUrl: null,
			});
		}

		if (input.logoUrlDark) {
			const logoDark = await this.copyCatalogAssetToR2(
				input.logoUrlDark,
				`${keyRoot}/logo-dark`,
			);
			if (logoDark.url) next.logoUrlDark = logoDark.url;
		}

		const screenshotUrls = input.screenshots ?? [];
		if (screenshotUrls.length > 0) {
			const screenshotAssets = await Promise.all(
				screenshotUrls
					.slice(0, 4)
					.map((screenshot, index) =>
						this.copyCatalogAssetToR2(
							screenshot,
							`${keyRoot}/screenshots/${index + 1}`,
						),
					),
			);
			const r2Screenshots = screenshotAssets.flatMap((asset) =>
				asset.url ? [asset.url] : [],
			);
			if (r2Screenshots.length > 0) {
				next.screenshots = r2Screenshots;
				next.richContent = {
					...next.richContent,
					screenshotUrl: r2Screenshots[0] ?? null,
				};
			}
			next.rawData = this.withCatalogAssetQuality(next.rawData, {
				screenshotStatus:
					r2Screenshots.length === screenshotUrls.length
						? "normalized"
						: r2Screenshots.length > 0
							? "partial"
							: "missing",
				screenshotCount: r2Screenshots.length,
			});
		}

		return next;
	}

	private async copyFallbackFaviconToR2(
		input: SyncCatalogAppInput,
		keyBase: string,
	): Promise<NormalizedCatalogAsset> {
		const domain = this.resolveBrandDomain(input);
		if (!domain) return { url: null, normalized: false, status: "missing" };
		return this.copyCatalogAssetToR2(
			`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`,
			keyBase,
		);
	}

	private withCatalogAssetQuality(
		rawData: Record<string, unknown> | null | undefined,
		assetQuality: Record<string, unknown>,
	): ReturnType<typeof toJsonRecord> {
		const base = typeof rawData === "object" && rawData !== null ? rawData : {};
		const currentQuality =
			typeof base.quality === "object" && base.quality !== null
				? (base.quality as Record<string, unknown>)
				: {};
		return toJsonRecord({
			...base,
			quality: {
				...currentQuality,
				...assetQuality,
				lastAssetCheckedAt: new Date().toISOString(),
			},
		});
	}

	private resolveBrandDomain(input: SyncCatalogAppInput): string | null {
		for (const candidate of [input.website, input.baseUrl, input.storeUrl]) {
			if (!candidate) continue;
			try {
				const parsed = new URL(candidate);
				return parsed.hostname.replace(/^www\./, "");
			} catch {}
		}
		return null;
	}

	private async readR2Json(filePath: string): Promise<Record<string, unknown>> {
		const obj = await this.env.R2_BUCKET.get(filePath);
		if (!obj) {
			throw new NonRetryableError(`File not found in R2: ${filePath}`);
		}
		const text = await obj.text();
		return JSON.parse(text);
	}

	/**
	 * Process and sync uploaded data in one step
	 * Returns summary only (no large arrays) to avoid workflow state size limits
	 */
	private async processAndSyncUploadData(
		data: Record<string, unknown>,
	): Promise<{
		source: Source;
		appsCount: number;
		inserted: number;
		updated: number;
		failed: number;
		errors: string[];
		sourceAppIds: string[];
	}> {
		const db = createDbClient(this.env.DB);
		let source: Source;
		const apps: SyncCatalogAppInput[] = [];
		const transformErrors: string[] = [];

		// Detect format and transform
		if (isChatGPTFormat(data)) {
			source = "chatgpt" as Source;
			for (const connector of data.connectors) {
				try {
					const app = this.transformConnector(connector);
					apps.push(app);
				} catch (error) {
					transformErrors.push(
						`Transform failed for ${connector.name}: ${error}`,
					);
				}
			}
		} else if (isChatGPTAppsListFormat(data)) {
			source = "chatgpt" as Source;
			for (const entry of data.apps) {
				try {
					const app = transformChatGPTAppsListEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(`Transform failed for ${entry.id}: ${error}`);
				}
			}
		} else if (isChatGPTActionsFormat(data)) {
			source = "chatgpt" as Source;
			for (const entry of data.links) {
				try {
					const app = transformChatGPTActionsEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(
						`Transform failed for ${entry.connector_id}: ${error}`,
					);
				}
			}
		} else if (isClaudeFormat(data)) {
			source = "claude" as Source;
			for (const entry of data.entries) {
				try {
					const app = transformClaudeEntry(entry);
					apps.push(app);
				} catch (error) {
					transformErrors.push(`Transform failed for ${entry.id}: ${error}`);
				}
			}
		} else if (isClaudeServersFormat(data)) {
			source = "claude" as Source;
			for (const entry of data.servers) {
				try {
					const app = transformClaudeServerEntry(entry);
					apps.push(app);
				} catch (error) {
					const name = entry.server?.name || entry.server?.title || "unknown";
					transformErrors.push(`Transform failed for ${name}: ${error}`);
				}
			}
		} else {
			throw new NonRetryableError(
				"Unknown data format. Expected { connectors: [...] } or { entries: [...] } or { servers: [...] }",
			);
		}

		console.log(
			`[App Catalog Sync] Transformed ${apps.length} apps from upload`,
		);

		// Batch insert directly
		const batches = this.splitIntoBatches(apps);
		let totalInserted = 0;
		let totalUpdated = 0;
		const syncErrors: string[] = [];

		for (const batch of batches) {
			try {
				const result = await bulkSyncCatalogAppsFromStore(db, batch);
				totalInserted += result.inserted;
				totalUpdated += result.updated;
				syncErrors.push(...result.errors);
			} catch (error) {
				syncErrors.push(`Batch sync failed: ${error}`);
			}
		}

		return {
			source,
			appsCount: apps.length,
			inserted: totalInserted,
			updated: totalUpdated,
			failed: transformErrors.length + syncErrors.length,
			errors: [...transformErrors, ...syncErrors].slice(0, 10),
			sourceAppIds: apps.map((a) => a.sourceAppId),
		};
	}

	/**
	 * Transform a single ChatGPT connector to common format
	 * Note: rawData is omitted to avoid D1 SQLITE_TOOBIG errors
	 */
	private transformConnector(connector: RawConnector): SyncCatalogAppInput {
		const labels = connector.labels || {};

		return {
			source: "chatgpt" as Source,
			sourceAppId: connector.id,
			sourceCreatedAt: connector.created_at ?? null,
			name: connector.name,
			description: connector.description,
			modelDescription: connector.model_description,
			baseUrl: connector.base_url,
			connectorType: mapConnectorType(connector.connector_type),
			distributionChannel: mapDistributionChannel(
				connector.distribution_channel,
			),
			developerType: mapDeveloperType(connector.developer_type),
			status: mapAppStatus(connector.status),
			category: mapCategory(connector.branding?.category || null),
			developer:
				connector.branding?.developer ||
				connector.app_metadata?.developer ||
				null,
			website: connector.branding?.website,
			privacyPolicy: connector.branding?.privacy_policy,
			termsOfService: connector.branding?.terms_of_service,
			logoUrl: connector.logo_url,
			logoUrlDark: connector.logo_url_dark,
			service: connector.service,
			version: connector.app_metadata?.version || null,
			versionId: connector.app_metadata?.version_id || null,
			versionNotes: connector.app_metadata?.version_notes || null,
			seoDescription: connector.app_metadata?.seo_description || null,
			screenshots: connector.app_metadata?.screenshots || null,
			categories: connector.app_metadata?.categories || null,
			subCategories: connector.app_metadata?.sub_categories || null,
			hasWrites: labels.writes === "true" || labels.consequential === "true",
			hasInteractive: labels.interactive === "true",
			hasFileSearch:
				labels.file_search === "true" || labels.retrievable === "true",
			hasDeepResearch: labels.deep_research === "true",
			hasSync: labels.sync === "true",
			authTypes: mapAuthTypes(connector.supported_auth),
			authRequired:
				(connector.supported_auth?.length ?? 0) > 0 &&
				!connector.supported_auth?.some((a) => a.type === "NONE"),
			reviewStatus: mapReviewStatus(
				connector.app_metadata?.review?.status || null,
			),
			supportsFullActions: connector.supports_full_actions,
			scores: {
				implementsRetrievable:
					connector.conformance?.implements_retrievable ?? null,
				retrievableReason:
					connector.conformance?.reason_if_not_retrievable ?? null,
			},
			safetyStatus: connector.policy_info?.safety_status ?? null,
			isDiscoverable: connector.branding?.is_discoverable_app ?? true,
			keywordsForDiscovery: connector.keywords_for_discovery ?? null,
			keywordsForTriggering: connector.keywords_for_triggering ?? null,
			systemHints: {
				tierLevel: connector.tier_level ?? null,
			},
			// Generate ChatGPT store URL: https://chatgpt.com/apps/{slug}/{connectorId}
			storeUrl: connector.id
				? `https://chatgpt.com/apps/${encodeURIComponent(
						(connector.name || "app")
							.toLowerCase()
							.replace(/[^a-z0-9]+/g, "-")
							.replace(/^-|-$/g, ""),
					)}/${connector.id}`
				: null,
			// Omit rawData to avoid D1 size limits
			rawData: null,
		};
	}

	/**
	 * Pre-populate MCP tools from Claude Registry toolNames
	 */
	private async prePopulateToolsFromClaudeRegistry(
		servers: RawClaudeServerEntry[],
	): Promise<{ toolsSynced: number; errors: string[] }> {
		const db = createDbClient(this.env.DB);
		let toolsSynced = 0;
		const errors: string[] = [];

		for (const entry of servers) {
			const registry = entry._meta?.["com.anthropic.api/mcp-registry"];
			if (!registry?.toolNames || registry.toolNames.length === 0) continue;

			const sourceAppId =
				registry.uuid || entry.server?.name || registry.url || "unknown";

			try {
				const listing = await getCatalogStoreListingBySourceId(
					db,
					"claude",
					sourceAppId,
				);

				if (!listing) continue;

				const tools = registry.toolNames.map((name) => ({
					name,
					description: undefined,
				}));

				const result = await syncCatalogMcpTools(
					db,
					listing.catalogAppId,
					tools,
					{ mode: "partial" },
				);
				toolsSynced += result.added + result.updated;
			} catch (error) {
				const name = registry.displayName || entry.server?.name || "unknown";
				errors.push(`Claude tools pre-pop failed for ${name}: ${error}`);
			}
		}

		return { toolsSynced, errors };
	}

	// ==========================================================================
	// Batch Processing
	// ==========================================================================

	/**
	 * Split apps into batches for D1 compatibility
	 */
	private splitIntoBatches(
		apps: SyncCatalogAppInput[],
		batchSize = this.BATCH_SIZE,
	): SyncCatalogAppInput[][] {
		const batches: SyncCatalogAppInput[][] = [];
		for (let i = 0; i < apps.length; i += batchSize) {
			batches.push(apps.slice(i, i + batchSize));
		}
		return batches;
	}
}
