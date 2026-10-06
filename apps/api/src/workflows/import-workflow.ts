/**
 * ImportWorkflow - Cloudflare Workflows for bulk item imports
 *
 * Processes raw data through the normalization pipeline in batches:
 * 1. Load app config and extract items array from data
 * 2. Process items in batches of 10 with step.do() for reliability
 * 3. Normalize items (field mapping, SKU generation, image handling)
 * 4. Convert to DB format and upsert (idempotent via externalId)
 * 5. Return quality report with field coverage metrics
 *
 * @see https://developers.cloudflare.com/workflows/
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Vertical } from "@tedix/api-contract/schemas/app";
import { createDbClient } from "@tedix/db/client";
import {
	getAppById,
	getAppMetadataJson,
	updateApp,
} from "@tedix/db/queries/app-records";
import { upsertItems } from "@tedix/db/queries/items";
import type { NewItem } from "@tedix/db/schema";
import {
	type ExtractedItem,
	normalizeItems,
	toItemInsert,
} from "../services/item-normalization";

// ============================================================================
// Types
// ============================================================================

export interface ImportWorkflowParams {
	appId: string;
	/** Raw data object containing items array */
	data: Record<string, unknown>;
	/** Key in data object containing items array */
	arrayKey: string;
	/** Vertical for item classification */
	vertical: Vertical;
	/** Optional field mappings for normalization */
	fieldMappings?: Record<string, string[]>;
	/** Optional limit on items to process */
	limit?: number;
	/** Optional source URL for item metadata */
	sourceUrl?: string;
	/** Skip writes when true */
	dryRun?: boolean;
}

interface LoadedConfig {
	app: {
		id: string;
		slug: string;
		name: string;
		vertical: Vertical;
		organizationId: string;
		primaryDomain?: string;
	};
	fieldMappings?: Record<string, string[]>;
}

interface BatchProcessResult {
	batchIndex: number;
	processed: number;
	inserted: number;
	updated: number;
	errors: string[];
}

interface QualityMetrics {
	totalRaw: number;
	totalNormalized: number;
	totalInserted: number;
	totalUpdated: number;
	fieldsComplete: Record<string, number>;
	fieldCoverage: Record<string, number>;
}

// ============================================================================
// Workflow Implementation
// ============================================================================

export class ImportWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ImportWorkflowParams
> {
	// Batch size for processing items
	private readonly BATCH_SIZE = 10;

	async run(event: WorkflowEvent<ImportWorkflowParams>, step: WorkflowStep) {
		const {
			appId,
			data,
			arrayKey,
			vertical,
			fieldMappings: inputFieldMappings,
			limit: inputLimit,
			sourceUrl,
			dryRun,
		} = event.payload;

		console.log(
			`[ImportWorkflow] Starting import for app ${appId}, arrayKey: ${arrayKey}`,
		);

		// Step 1: Load app config and validate
		const configResult = await step.do(
			"load-app-config",
			{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
			async (): Promise<LoadedConfig> => {
				return this.loadAppConfig(appId, inputFieldMappings);
			},
		);

		const loadedConfig = configResult as LoadedConfig;
		const { app, fieldMappings } = loadedConfig;

		console.log(
			`[ImportWorkflow] App config loaded: ${app.name} (${app.slug})`,
		);

		// Step 2: Extract and validate raw items array
		const rawItems = data[arrayKey];
		if (!Array.isArray(rawItems)) {
			throw new NonRetryableError(
				`No array found at key "${arrayKey}" in data. Available keys: ${Object.keys(data).join(", ")}`,
			);
		}

		const totalRaw = rawItems.length;
		if (totalRaw === 0) {
			console.log("[ImportWorkflow] No items to import");
			return {
				success: true,
				appId,
				imported: 0,
				updated: 0,
				errors: [],
				quality: {
					totalRaw: 0,
					totalNormalized: 0,
					totalInserted: 0,
					totalUpdated: 0,
					fieldsComplete: {},
					fieldCoverage: {},
				},
			};
		}

		// Apply limit if specified
		const limit = inputLimit ?? 500;
		const itemsToProcess = rawItems.slice(0, limit);
		const truncated = rawItems.length > limit;

		if (truncated) {
			console.log(
				`[ImportWorkflow] Truncated ${rawItems.length} items to ${limit} (limit)`,
			);
		}

		console.log(
			`[ImportWorkflow] Processing ${itemsToProcess.length} items in batches of ${this.BATCH_SIZE}`,
		);

		// Step 3: Normalize items (all at once for quality metrics)
		const normalized = normalizeItems(itemsToProcess, fieldMappings);
		const totalNormalized = normalized.length;

		console.log(
			`[ImportWorkflow] Normalized ${totalNormalized} items from ${itemsToProcess.length} raw items`,
		);

		// Calculate quality metrics before batching
		const qualityMetrics = this.calculateQualityMetrics(
			normalized,
			totalRaw,
			totalNormalized,
		);

		// Step 4: Process items in batches
		const batches = this.splitIntoBatches(normalized);
		const batchResults: BatchProcessResult[] = [];

		console.log(`[ImportWorkflow] Processing ${batches.length} batches...`);

		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i];
			if (!batch) {
				continue;
			}
			const batchResult = await step.do(
				`process-batch-${i}`,
				{ retries: { limit: 2, delay: "2 seconds" }, timeout: "2 minutes" },
				async () => {
					return this.processBatch(
						i,
						batch,
						appId,
						vertical,
						sourceUrl ?? app.primaryDomain ?? `https://${app.slug}.example.com`,
						dryRun ?? false,
					);
				},
			);

			batchResults.push(batchResult as BatchProcessResult);

			const result = batchResult as BatchProcessResult;
			console.log(
				`[ImportWorkflow] Batch ${i + 1}/${batches.length}: ${result.processed} processed, ${result.inserted} inserted, ${result.updated} updated`,
			);
		}

		// Step 5: Aggregate results
		const totalInserted = batchResults.reduce((sum, r) => sum + r.inserted, 0);
		const totalUpdated = batchResults.reduce((sum, r) => sum + r.updated, 0);
		const allErrors = batchResults.flatMap((r) => r.errors);

		if (truncated) {
			allErrors.push(
				`Warning: ${rawItems.length} items in source, only ${limit} processed (limit)`,
			);
		}

		// Update quality metrics with final counts
		qualityMetrics.totalInserted = totalInserted;
		qualityMetrics.totalUpdated = totalUpdated;

		console.log(
			`[ImportWorkflow] Total: ${totalInserted} inserted, ${totalUpdated} updated`,
		);

		if (!dryRun) {
			// Step 5: Update app metadata
			await step.do(
				"update-app-metadata",
				{
					retries: { limit: 2, delay: "1 second", backoff: "exponential" },
					timeout: "1 minute",
				},
				async () => {
					return this.updateAppStatus(appId, {
						itemsImported: totalNormalized,
						itemsInserted: totalInserted,
						itemsUpdated: totalUpdated,
					});
				},
			);
		}

		console.log(`[ImportWorkflow] Import complete for app ${appId}`);

		return {
			success: true,
			appId,
			imported: totalInserted,
			updated: totalUpdated,
			errors: allErrors,
			quality: qualityMetrics,
		};
	}

	// ==========================================================================
	// Step Implementations
	// ==========================================================================

	/**
	 * Load app config from D1
	 * @throws Error if app not found or not authorized
	 */
	private async loadAppConfig(
		appId: string,
		inputFieldMappings?: Record<string, string[]>,
	): Promise<LoadedConfig> {
		const db = createDbClient(this.env.DB);
		const app = await getAppById(db, appId);

		if (!app) {
			throw new NonRetryableError(`[ImportWorkflow] App not found: ${appId}`);
		}

		const metadata = getAppMetadataJson(app);
		const extractionConfig = metadata?.extractionConfig;

		// Resolve field mappings: input params > D1 config > undefined
		const fieldMappings =
			inputFieldMappings ?? extractionConfig?.fieldMappings ?? undefined;

		return {
			app: {
				id: app.id,
				slug: app.slug,
				name: app.name,
				vertical:
					((app.metadata as Record<string, unknown>)?.vertical as Vertical) ??
					"ecommerce",
				organizationId: app.organizationId ?? "",
				primaryDomain: app.primaryDomain ?? undefined,
			},
			fieldMappings,
		};
	}

	/**
	 * Split normalized items into batches
	 */
	private splitIntoBatches(items: ExtractedItem[]): ExtractedItem[][] {
		const batches: ExtractedItem[][] = [];
		for (let i = 0; i < items.length; i += this.BATCH_SIZE) {
			batches.push(items.slice(i, i + this.BATCH_SIZE));
		}
		return batches;
	}

	/**
	 * Process a batch of items
	 */
	private async processBatch(
		batchIndex: number,
		items: ExtractedItem[],
		appId: string,
		vertical: Vertical,
		sourceUrl: string,
		dryRun: boolean,
	): Promise<BatchProcessResult> {
		if (dryRun) {
			return {
				batchIndex,
				processed: items.length,
				inserted: 0,
				updated: 0,
				errors: [],
			};
		}
		const db = createDbClient(this.env.DB);
		const importedAt = new Date().toISOString();
		const errors: string[] = [];

		try {
			// Convert to DB format with import metadata
			const dbItems = items.map((item) => {
				const dbItem = toItemInsert(item, appId, vertical, sourceUrl);
				dbItem.metadata = {
					...dbItem.metadata,
					importedAt,
					importMethod: "workflow",
					importSourceUrl: sourceUrl,
					batchIndex,
				};
				return dbItem;
			});

			// Upsert to database
			const result = await upsertItems(db, appId, dbItems as NewItem[]);

			return {
				batchIndex,
				processed: items.length,
				inserted: result.inserted,
				updated: result.updated,
				errors: result.errors ?? [],
			};
		} catch (error) {
			const errorMessage = `Batch ${batchIndex} failed: ${error instanceof Error ? error.message : String(error)}`;
			console.error(`[ImportWorkflow] ${errorMessage}`);
			errors.push(errorMessage);

			return {
				batchIndex,
				processed: items.length,
				inserted: 0,
				updated: 0,
				errors,
			};
		}
	}

	/**
	 * Calculate quality metrics for normalized items
	 */
	private calculateQualityMetrics(
		normalized: ExtractedItem[],
		totalRaw: number,
		totalNormalized: number,
	): QualityMetrics {
		const fieldsComplete: Record<string, number> = {
			// Generic fields
			title: normalized.filter((i) => i.title).length,
			price: normalized.filter((i) => i.price != null).length,
			image: normalized.filter((i) => i.image).length,
			url: normalized.filter((i) => i.url).length,
			externalId: normalized.filter((i) => i.sku).length,
			features: normalized.filter((i) => i.features && i.features.length > 0)
				.length,
			location: normalized.filter((i) => i.location?.city).length,
			// Automotive-specific fields
			make: normalized.filter((i) => i.make).length,
			model: normalized.filter((i) => i.model).length,
			year: normalized.filter((i) => i.year).length,
			mileage: normalized.filter((i) => i.mileage).length,
			fuel: normalized.filter((i) => i.fuel).length,
			color: normalized.filter((i) => i.color).length,
		};

		// Calculate field coverage percentages
		const fieldCoverage: Record<string, number> = {};
		for (const [field, count] of Object.entries(fieldsComplete)) {
			fieldCoverage[field] =
				totalNormalized > 0 ? Math.round((count / totalNormalized) * 100) : 0;
		}

		return {
			totalRaw,
			totalNormalized,
			totalInserted: 0, // Will be updated after batches complete
			totalUpdated: 0, // Will be updated after batches complete
			fieldsComplete,
			fieldCoverage,
		};
	}

	/**
	 * Update app metadata with import results
	 */
	private async updateAppStatus(
		appId: string,
		stats: {
			itemsImported: number;
			itemsInserted: number;
			itemsUpdated: number;
		},
	): Promise<void> {
		const db = createDbClient(this.env.DB);

		const app = await getAppById(db, appId);
		if (!app) {
			throw new NonRetryableError(`App not found: ${appId}`);
		}

		const existingMetadata = getAppMetadataJson(app) || {};

		await updateApp(db, appId, {
			metadata: {
				...existingMetadata,
				itemImport: {
					...(existingMetadata.itemImport as object),
					lastImportedAt: new Date().toISOString(),
					itemsImported: stats.itemsImported,
					itemsSaved: stats.itemsInserted + stats.itemsUpdated,
					method: "workflow",
				},
			},
		});
	}
}
