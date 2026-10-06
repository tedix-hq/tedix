/**
 * ContentSyncWorkflow - Cloudflare Workflows for scheduled content sync
 *
 * Config-driven content sync using D1 content_sources table:
 * 1. Get all apps with content sources in D1
 * 2. Filter apps by sync interval (daily/weekly/monthly)
 * 3. For each source, trigger a ContentIngestionWorkflow
 * 4. Update source status in D1
 *
 * @see https://developers.cloudflare.com/workflows/
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import { getAppMetadataJson } from "@tedix/db/queries/app-records";
import {
	listContentSources,
	updateContentSourceIngestStatus,
} from "@tedix/db/queries/content-sources";
import { getAllApps } from "@tedix/db/queries/apps";
import type { ContentSource } from "@tedix/db/schema";

// ============================================================================
// Types
// ============================================================================

export interface ContentSyncWorkflowParams {
	/** Sync interval to filter apps by */
	interval?: "daily" | "weekly" | "monthly";
	/** Force sync even if lastIngestedAt is recent */
	force?: boolean;
	/** Specific app ID to sync (for manual/targeted sync) */
	appId?: string;
}

interface AppToSync {
	appId: string;
	appName: string;
	appSlug: string;
	sources: ContentSource[];
	syncInterval: "daily" | "weekly" | "monthly";
}

interface SourceSyncResult {
	sourceId: string;
	url: string;
	type: string;
	success: boolean;
	workflowId?: string;
	error?: string;
}

interface AppSyncResult {
	appId: string;
	appName: string;
	success: boolean;
	sourcesProcessed: number;
	results: SourceSyncResult[];
	error?: string;
}

interface GetAppsStepResult {
	apps: AppToSync[];
}

// ============================================================================
// Workflow Implementation
// ============================================================================

export class ContentSyncWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ContentSyncWorkflowParams
> {
	async run(
		event: WorkflowEvent<ContentSyncWorkflowParams>,
		step: WorkflowStep,
	) {
		const { interval, force = false, appId } = event.payload;

		console.log(
			`[ContentSync] Starting sync (interval: ${interval || "all"}, force: ${force}${appId ? `, appId: ${appId}` : ""})`,
		);

		// Step 1: Get apps with content sources from D1
		const appsResult = await step.do(
			"get-apps-to-sync",
			{
				retries: { limit: 2, delay: "2 seconds", backoff: "linear" },
				timeout: "30 seconds",
			},
			async (): Promise<GetAppsStepResult> => {
				return this.getAppsToSync(interval, appId);
			},
		);

		const appsToSync = (appsResult as GetAppsStepResult).apps;

		if (appsToSync.length === 0) {
			console.log("[ContentSync] No apps to sync");
			return {
				success: true,
				message: "No apps to sync",
				appsProcessed: 0,
				results: [],
			};
		}

		console.log(`[ContentSync] Found ${appsToSync.length} apps to sync`);

		// Step 2: Trigger ingestion workflows for each source
		const appResults: AppSyncResult[] = [];

		for (const app of appsToSync) {
			const syncResult = await step.do(
				`sync-app-${app.appSlug}`,
				{
					retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
					timeout: "5 minutes",
				},
				async () => {
					return this.triggerIngestionForApp(app, force);
				},
			);

			appResults.push(syncResult as AppSyncResult);
		}

		// Step 3: Log failures
		const failures = appResults.filter((r) => !r.success);
		if (failures.length > 0) {
			await step.do(
				"log-failures",
				{ retries: { limit: 1, delay: "1 second" }, timeout: "30 seconds" },
				async () => {
					for (const failure of failures) {
						console.error(
							`[ContentSync] FAILURE: App ${failure.appName} (${failure.appId})`,
						);
						console.error(`  Error: ${failure.error || "Unknown"}`);
						for (const source of failure.results.filter((r) => !r.success)) {
							console.error(`  Source ${source.url}: ${source.error}`);
						}
					}
					return { logged: failures.length };
				},
			);
		}

		const successCount = appResults.filter((r) => r.success).length;
		const totalSources = appResults.reduce(
			(sum, r) => sum + r.sourcesProcessed,
			0,
		);

		console.log(
			`[ContentSync] Complete: ${successCount}/${appsToSync.length} apps, ${totalSources} sources triggered`,
		);

		return {
			success: failures.length === 0,
			appsProcessed: appsToSync.length,
			appsSucceeded: successCount,
			appsFailed: failures.length,
			totalSources,
			results: appResults,
		};
	}

	// ==========================================================================
	// Step Implementations
	// ==========================================================================

	/**
	 * Get apps with content sources from the D1 content_sources table
	 */
	private async getAppsToSync(
		interval?: "daily" | "weekly" | "monthly",
		specificAppId?: string,
	): Promise<GetAppsStepResult> {
		const db = createDbClient(this.env.DB);

		// Get all apps
		const allApps = await getAllApps(db, { appId: specificAppId });

		const result: AppToSync[] = [];

		for (const app of allApps) {
			const metadata = getAppMetadataJson(app);
			const syncInterval = metadata?.contentConfig?.syncInterval ?? "daily";

			if (syncInterval === "disabled") {
				continue;
			}

			if (interval && syncInterval !== interval) {
				continue;
			}

			// Get sources from D1 table
			const sources = await listContentSources(db, app.id);
			if (sources.length === 0) continue;

			result.push({
				appId: app.id,
				appName: app.name,
				appSlug: app.slug,
				sources,
				syncInterval,
			});
		}

		return { apps: result };
	}

	/**
	 * Trigger ingestion workflows for each source in an app
	 */
	private async triggerIngestionForApp(
		app: AppToSync,
		force: boolean,
	): Promise<AppSyncResult> {
		const db = createDbClient(this.env.DB);
		const results: SourceSyncResult[] = [];

		for (const source of app.sources) {
			// Skip if recently ingested (unless force)
			if (!force && this.shouldSkipSource(source, app.syncInterval)) {
				console.log(
					`[ContentSync] Skipping ${source.sourceUrl} (recently ingested)`,
				);
				results.push({
					sourceId: source.id,
					url: source.sourceUrl,
					type: source.sourceType,
					success: true,
				});
				continue;
			}

			try {
				const workflowId = `sync-${source.id}-${Date.now()}`;
				await this.env.CONTENT_INGESTION_WORKFLOW.create({
					id: workflowId,
					params: { sourceId: source.id, appId: app.appId },
				});

				await updateContentSourceIngestStatus(db, source.id, {
					lastIngestStatus: "pending",
					lastError: null,
				});

				results.push({
					sourceId: source.id,
					url: source.sourceUrl,
					type: source.sourceType,
					success: true,
					workflowId,
				});
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : "Unknown error";
				results.push({
					sourceId: source.id,
					url: source.sourceUrl,
					type: source.sourceType,
					success: false,
					error: errorMsg,
				});
			}
		}

		return {
			appId: app.appId,
			appName: app.appName,
			success: results.every((r) => r.success),
			sourcesProcessed: results.length,
			results,
		};
	}

	// ==========================================================================
	// Helper Methods
	// ==========================================================================

	/**
	 * Check if a source should be skipped based on lastIngestedAt and interval
	 */
	private shouldSkipSource(
		source: ContentSource,
		syncInterval: "daily" | "weekly" | "monthly",
	): boolean {
		if (!source.lastIngestedAt) {
			return false; // Never ingested, should sync
		}

		const lastSync = new Date(source.lastIngestedAt);
		const now = new Date();
		const hoursSinceLastSync =
			(now.getTime() - lastSync.getTime()) / (1000 * 60 * 60);

		const minHours: Record<string, number> = {
			daily: 20,
			weekly: 144,
			monthly: 672,
		};

		return hoursSinceLastSync < (minHours[syncInterval] ?? 20);
	}
}
