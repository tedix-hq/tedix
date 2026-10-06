/**
 * ExtractionWorkflow - Cloudflare Workflows for durable item extraction
 *
 * ⚠️ AGENT-ONLY MODE (Standard for all apps)
 *
 * Why agent mode?
 * - Sites have anti-bot protection (mobile.de, kleinanzeigen.de, etc.)
 * - Direct URLs get blocked/return empty pages
 * - Agent acting like human bypasses protection
 *
 * Flow:
 * 1. Load extraction config from D1 (REQUIRED - no fallbacks)
 * 2. Start Firecrawl agent with search instructions (NO URL provided)
 * 3. Agent searches for site, navigates naturally, extracts data
 * 4. Wait for the completion/failure webhook event
 * 5. Parse items using config.arrayKey
 * 6. Save items to D1 and sync CSP domains
 *
 * NOTE: console.log statements outside step.do() may replay when the workflow
 * engine restarts. This is expected behavior per Cloudflare Workflows docs.
 * These are informational logs only — all mutations and side effects are inside
 * step.do() calls. Wrapping each log in step.do() would add unnecessary steps.
 *
 * @see https://developers.cloudflare.com/workflows/
 * @see https://developers.cloudflare.com/workflows/build/rules-of-workflows/
 */

import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import { NonRetryableError } from "cloudflare:workflows";
import type { Vertical } from "@tedix/api-contract/schemas/app";
import { createDbClient } from "@tedix/db/client";
import {
	getAppById,
	getAppMetadataJson,
	updateApp,
} from "@tedix/db/queries/app-records";
import { upsertItems } from "@tedix/db/queries/items";
import {
	type ResolvedExtractionConfig,
	getExtractionConfig,
} from "../services/default-extraction-configs";
import { parseConfiguredExtractResult } from "../services/configured-extract-result";
import { validateExtraction } from "../services/extraction-validator";
import {
	type ExtractedItem,
	toItemInsert,
} from "../services/item-normalization";

// ============================================================================
// Types
// ============================================================================

export interface ExtractionWorkflowParams {
	appId: string;
	/** Site name for autonomous search (e.g., "mobile.de Germany", "AutoScout24 Germany") */
	siteName: string;
	vertical: Vertical;
	/** Optional search query to expand the extraction prompt (e.g., "BMW X3 under €40k") */
	query?: string;
	limit?: number;
}

const FirecrawlAgentStartResponseSchema = z.object({
	success: z.literal(true),
	id: z.uuid().transform((id) => id.toLowerCase()),
});

interface AgentJobResult {
	jobId: string;
}

interface ExtractionStepResult {
	success: boolean;
	items: ExtractedItem[];
	creditsUsed?: number;
}

interface SaveStepResult {
	itemsInserted: number;
	itemsUpdated: number;
}

// Workflow steps serialize the resolved configuration as JSON.
interface LoadedConfig {
	config: ResolvedExtractionConfig;
}

// ============================================================================
// Workflow Implementation
// ============================================================================

export class ExtractionWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ExtractionWorkflowParams
> {
	async run(
		event: WorkflowEvent<ExtractionWorkflowParams>,
		step: WorkflowStep,
	) {
		const { appId, siteName, vertical, query, limit = 30 } = event.payload;

		console.log(
			`[Workflow] Starting agent extraction for app ${appId}: ${siteName}`,
		);

		// Step 1: Load extraction config from app or defaults
		const configResult = await step.do(
			"load-extraction-config",
			{ retries: { limit: 2, delay: "1 second" }, timeout: "30 seconds" },
			async () => {
				const loadedConfig = await this.loadExtractionConfig(
					appId,
					vertical,
					limit,
				);
				return JSON.stringify(loadedConfig);
			},
		);

		// Extract config from the serialized workflow step result.
		const loadedConfig = JSON.parse(configResult) as LoadedConfig;
		const config = loadedConfig.config;

		console.log(
			`[Workflow] Using config: arrayKey=${config.arrayKey}, method=${config.method}`,
		);

		// Step 2: Start the configured Firecrawl Agent job with its webhook
		const agentJob = await step.do(
			"start-agent-job",
			{
				// A timed-out or lost POST response may already have created a paid job.
				// Without provider idempotency, retrying can launch another one.
				retries: { limit: 0, delay: "5 seconds" },
				timeout: "2 minutes",
			},
			async () => {
				return this.startAgentJob(
					siteName,
					config,
					query,
					event.instanceId, // Pass instance ID for webhook callback
					appId, // Pass app ID for webhook metadata
				);
			},
			{
				rollback: async ({ error, output }) => {
					// The Firecrawl agent job may have started before the subsequent
					// processing failed. Record the failure in app metadata so operators
					// can diagnose and re-trigger.
					const jobId = (output as AgentJobResult | undefined)?.jobId;
					console.error(
						`[Workflow] Extraction failed after agent job start${jobId ? ` (jobId: ${jobId})` : ""}. ` +
							`Recording failure in app metadata. Error: ${error.message.slice(0, 200)}`,
					);
					try {
						const db = createDbClient(this.env.DB);
						const app = await getAppById(db, appId);
						if (app) {
							const existingMeta = getAppMetadataJson(app) || {};
							await updateApp(db, appId, {
								metadata: {
									...existingMeta,
									itemExtractionFailedAt: new Date().toISOString(),
									itemExtractionError: error.message.slice(0, 500),
									itemExtraction: {
										...(existingMeta.itemExtraction as object),
										error: error.message.slice(0, 500),
										...(jobId ? { workflowInstanceId: jobId } : {}),
									},
								},
							});
						}
					} catch {
						// Rollback is best-effort; do not shadow the original error
					}
				},
				rollbackConfig: {
					retries: { limit: 1, delay: "2 seconds" },
					timeout: "30 seconds",
				},
			},
		);

		console.log(
			`[Workflow] Agent job started: ${(agentJob as AgentJobResult).jobId}`,
		);

		// Step 3: Wait for webhook event (NO POLLING!)
		// Firecrawl will send webhook when job completes/fails
		console.log(
			`[Workflow] Waiting for webhook event (timeout: 180 minutes)...`,
		);

		const webhookEvent = await step.waitForEvent<{
			success: boolean;
			status: "completed" | "failed" | "cancelled";
			// Use a shallow serializable type - deeper nesting handled at runtime
			data?: Record<string, string | number | boolean | null | object> | null;
			creditsUsed?: number;
			error?: string;
			firecrawlJobId: string;
		}>("wait-for-firecrawl-webhook", {
			type: `firecrawl-agent-${(agentJob as AgentJobResult).jobId}`,
			timeout: "180 minutes", // Allow up to 3 hours for complex extractions
		});

		console.log(
			`[Workflow] Received webhook: ${webhookEvent.payload.status}, credits: ${webhookEvent.payload.creditsUsed ?? 0}`,
		);

		if (
			webhookEvent.payload.firecrawlJobId !== (agentJob as AgentJobResult).jobId
		) {
			throw new Error(
				"Firecrawl callback job ID does not match the selected job",
			);
		}

		// Failure and cancellation both use the existing compensation path.
		if (
			!webhookEvent.payload.success ||
			webhookEvent.payload.status !== "completed"
		) {
			throw new Error(
				`Firecrawl agent failed: ${webhookEvent.payload.error || "Unknown error"}`,
			);
		}

		// Parse items from webhook data (same logic as before)
		const parsedItems = this.parseExtractResult(
			webhookEvent.payload.data,
			config.arrayKey,
			config.fieldMappings,
		);
		// The prompt asks for a maximum, but provider output is untrusted. Bound
		// the exact ordered set used for quality checks, D1 writes, and reporting.
		let items = parsedItems.slice(0, config.limit);
		if (parsedItems.length > config.limit) {
			console.warn(
				`[Workflow] Capped ${parsedItems.length} extracted items to configured limit ${config.limit}`,
			);
		}

		console.log(`[Workflow] Parsed ${items.length} items from webhook data`);

		// Apply quality gates from config
		const qualityConfig = config.quality;
		const minScore = qualityConfig?.minScore ?? 0.7; // Default 70% minimum
		const logWarnings = qualityConfig?.logWarnings ?? true;

		// Validate extraction quality
		const validation = validateExtraction(items, vertical, "normalized");
		console.log(
			`[Workflow] Quality score: ${(validation.score * 100).toFixed(0)}% (minimum: ${(minScore * 100).toFixed(0)}%)`,
		);

		if (logWarnings && validation.warnings.length > 0) {
			console.warn(`[Workflow] Warnings:`, validation.warnings);
		}

		if (validation.errors.length > 0) {
			console.error(`[Workflow] Errors:`, validation.errors);
		}

		if (validation.score < minScore) {
			console.warn(
				`[Workflow] LOW QUALITY extraction (${(validation.score * 100).toFixed(0)}%), missing:`,
				validation.coverage.missing,
			);
		}

		// Apply quality gate: filter out incomplete items if configured
		if (
			qualityConfig?.rejectIncomplete &&
			qualityConfig.requiredFields &&
			qualityConfig.requiredFields.length > 0
		) {
			const originalCount = items.length;
			items = this.filterByRequiredFields(items, qualityConfig.requiredFields);
			const rejectedCount = originalCount - items.length;
			if (rejectedCount > 0) {
				console.log(
					`[Workflow] Quality gate: Rejected ${rejectedCount} items missing required fields: ${qualityConfig.requiredFields.join(", ")}`,
				);
			}
		}

		// Create extraction result (compatible with rest of workflow)
		const extraction: ExtractionStepResult = {
			success: true,
			items,
			creditsUsed: webhookEvent.payload.creditsUsed,
		};

		console.log(`[Workflow] Extracted ${extraction.items.length} items`);

		// Step 4: Save items to D1
		const saveResult = await step.do(
			"save-items-to-d1",
			{
				retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
				timeout: "5 minutes",
			},
			async () => {
				return this.saveItemsToD1(appId, extraction.items, vertical, siteName);
			},
		);

		const saved = saveResult as SaveStepResult;
		console.log(
			`[Workflow] Saved ${saved.itemsInserted} new, ${saved.itemsUpdated} updated`,
		);

		// Step 5: Update app metadata
		await step.do(
			"update-app-metadata",
			{
				retries: { limit: 2, delay: "1 second", backoff: "exponential" },
				timeout: "1 minute",
			},
			async () => {
				return this.updateAppStatus(appId, {
					itemsExtracted: extraction.items.length,
					itemsInserted: saved.itemsInserted,
					itemsUpdated: saved.itemsUpdated,
					creditsUsed: extraction.creditsUsed,
				});
			},
		);

		console.log(`[Workflow] Extraction complete for app ${appId}`);

		return {
			success: true,
			appId,
			siteName,
			itemsExtracted: extraction.items.length,
			itemsInserted: saved.itemsInserted,
			itemsUpdated: saved.itemsUpdated,
			creditsUsed: extraction.creditsUsed,
		};
	}

	// ==========================================================================
	// Step Implementations
	// ==========================================================================

	/**
	 * Load extraction config from D1 app metadata
	 *
	 * ⚠️ AGENT-ONLY MODE STANDARD: All apps use autonomous search
	 *
	 * Required fields in D1 apps.metadata.extractionConfig:
	 * - prompt: Extraction instructions (what to extract from detail pages)
	 * - schema: JSON schema for structured extraction
	 * - arrayKey: Key in schema containing items array
	 * - siteSearchInstructions: How to navigate the site naturally (REQUIRED)
	 * - siteName: Site to search for (REQUIRED)
	 *
	 * The agent discovers the site unless agent.urls constrains navigation.
	 * No fallbacks. If config missing, workflow fails fast with clear error.
	 *
	 * @throws Error if app not found or extraction config not configured
	 */
	private async loadExtractionConfig(
		appId: string,
		vertical: Vertical,
		limit: number,
	): Promise<LoadedConfig> {
		const db = createDbClient(this.env.DB);
		const app = await getAppById(db, appId);

		if (!app) {
			throw new NonRetryableError(
				`[Workflow] App not found: ${appId}. Cannot load extraction config.`,
			);
		}

		const metadata = getAppMetadataJson(app);

		// REQUIRE extractionConfig in D1
		if (!metadata?.extractionConfig) {
			throw new NonRetryableError(
				`[Config Error] No extraction config for app "${app.name}" (${appId}). ` +
					`Set apps.metadata.extractionConfig in D1. ` +
					`See docs/platform/api.md for examples.`,
			);
		}

		const extractionConfig =
			metadata.extractionConfig as Partial<ResolvedExtractionConfig>;

		// Validate required fields for agent-only mode
		if (!extractionConfig.prompt) {
			throw new NonRetryableError(
				`[Config Error] Missing extraction prompt for app "${app.name}" (${appId}). ` +
					`Set apps.metadata.extractionConfig.prompt in D1.`,
			);
		}

		if (!extractionConfig.schema) {
			throw new NonRetryableError(
				`[Config Error] Missing extraction schema for app "${app.name}" (${appId}). ` +
					`Set apps.metadata.extractionConfig.schema in D1.`,
			);
		}

		if (!extractionConfig.arrayKey) {
			throw new NonRetryableError(
				`[Config Error] Missing arrayKey for app "${app.name}" (${appId}). ` +
					`Set apps.metadata.extractionConfig.arrayKey in D1.`,
			);
		}

		if (!extractionConfig.siteSearchInstructions) {
			throw new NonRetryableError(
				`[Config Error] Missing siteSearchInstructions for app "${app.name}" (${appId}). ` +
					`Agent-only mode requires navigation instructions. ` +
					`Set apps.metadata.extractionConfig.siteSearchInstructions in D1.`,
			);
		}

		// Build config from D1 with parameter overrides
		const config = getExtractionConfig(vertical, {
			limit,
			appOverrides: extractionConfig,
		});

		console.log(
			`[Workflow] Loaded agent-only config from D1 for "${app.name}": ` +
				`arrayKey=${config.arrayKey}, promptLength=${config.prompt.length} chars, ` +
				`searchInstructionsLength=${config.siteSearchInstructions?.length || 0} chars`,
		);

		return { config };
	}

	/**
	 * Start Firecrawl Agent job (AGENT-ONLY MODE)
	 *
	 * Agent searches for the site autonomously and navigates naturally.
	 * Configured agent.urls can constrain navigation.
	 *
	 * @param siteName - Site to search for (e.g., "mobile.de Germany")
	 * @param config - Extraction config from D1 with prompt/schema
	 * @param query - Optional search query to expand the prompt (e.g., "BMW X3 under €40k")
	 * @param workflowInstanceId - Workflow instance ID for webhook callback
	 * @param appId - App ID for webhook metadata
	 */
	private async startAgentJob(
		siteName: string,
		config: ResolvedExtractionConfig,
		query: string | undefined,
		workflowInstanceId: string,
		appId: string,
	): Promise<AgentJobResult> {
		const {
			prompt,
			schema,
			siteSearchInstructions,
			limit,
			agent,
			stopConditions,
		} = config;

		console.log(
			`[Workflow] Starting Firecrawl agent (agent-only: ${siteName})${query ? ` with query: "${query}"` : ""}, limit: ${limit ?? "default"}`,
		);

		// Build final prompt with search instructions prepended, limit enforcement, and stop conditions
		let finalPrompt = this.buildAgentInstructions(
			siteName,
			prompt,
			siteSearchInstructions,
			limit,
			stopConditions,
		);

		// If a custom query is provided, expand the prompt with it
		// This allows targeted searches like "BMW X3 under €40k" or "Electric car under €30k"
		if (query) {
			finalPrompt = `PRIORITY SEARCH QUERY: "${query}"

Focus your extraction on items matching this specific query. This is the user's exact search intent.

${finalPrompt}`;
		}

		const requestBody: Record<string, unknown> = {
			prompt: finalPrompt,
			schema,
		};

		// Pass agent runtime options to Firecrawl if configured
		if (agent) {
			if (agent.model) {
				requestBody.model = agent.model;
				console.log(`[Workflow] Using agent model: ${agent.model}`);
			}
			if (agent.maxCredits !== undefined) {
				requestBody.maxCredits = agent.maxCredits;
				console.log(`[Workflow] Max credits cap: ${agent.maxCredits}`);
			}
			if (agent.urls && agent.urls.length > 0) {
				requestBody.urls = agent.urls;
				console.log(
					`[Workflow] Agent constrained to ${agent.urls.length} URLs`,
				);
			}
			if (agent.strictConstrainToURLs !== undefined) {
				requestBody.strictConstrainToURLs = agent.strictConstrainToURLs;
				console.log(
					`[Workflow] Strict URL constraint: ${agent.strictConstrainToURLs}`,
				);
			}
		}

		// Completion requires a publicly reachable callback at the configured API_URL.
		const webhookBaseUrl = this.env.API_URL;

		requestBody.webhook = {
			url: `${webhookBaseUrl}/webhooks/firecrawl`,
			metadata: {
				workflowInstanceId, // Passed back in webhook to wake workflow
				appId, // For logging/debugging
			},
			events: ["completed", "failed", "cancelled"],
		};

		console.log(
			`[Workflow] Agent webhook configured: ${webhookBaseUrl}/webhooks/firecrawl`,
		);

		// URL constraints are included only when explicitly configured above.

		const response = await fetch("https://api.firecrawl.dev/v2/agent", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${this.env.FIRECRAWL_API_KEY}`,
			},
			body: JSON.stringify(requestBody),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(
				`Firecrawl agent start failed: ${response.status} - ${errorText}`,
			);
		}

		const result = FirecrawlAgentStartResponseSchema.safeParse(
			await response.json(),
		);
		if (!result.success) {
			throw new Error(
				"Firecrawl agent start failed: invalid successful job response",
			);
		}
		return { jobId: result.data.id };
	}

	/** Parse the configured object shape exactly. */
	private parseExtractResult(
		result: unknown,
		primaryArrayKey: string,
		fieldMappings?: Record<string, string[]>,
	): ExtractedItem[] {
		return parseConfiguredExtractResult(result, primaryArrayKey, fieldMappings);
	}

	/**
	 * Save extracted items to D1
	 */
	private async saveItemsToD1(
		appId: string,
		items: ExtractedItem[],
		vertical: Vertical,
		sourceUrl: string,
	): Promise<SaveStepResult> {
		if (items.length === 0) {
			return { itemsInserted: 0, itemsUpdated: 0 };
		}

		const db = createDbClient(this.env.DB);

		// Validate again before insertion to catch any transformation issues
		const preInsertValidation = validateExtraction(
			items,
			vertical,
			"pre-insert",
		);
		if (!preInsertValidation.valid) {
			console.warn(
				`[Workflow] Pre-insert validation failed (${(preInsertValidation.score * 100).toFixed(0)}%):`,
				preInsertValidation.errors,
			);
		}

		const itemInserts = items.map((item) =>
			toItemInsert(item, appId, vertical, sourceUrl),
		);

		const result = await upsertItems(db, appId, itemInserts);

		return {
			itemsInserted: result.inserted,
			itemsUpdated: result.updated,
		};
	}

	/**
	 * Update app metadata with extraction results
	 */
	private async updateAppStatus(
		appId: string,
		stats: {
			itemsExtracted: number;
			itemsInserted: number;
			itemsUpdated: number;
			creditsUsed?: number;
		},
	): Promise<void> {
		const db = createDbClient(this.env.DB);

		const app = await getAppById(db, appId);
		if (!app) {
			throw new Error(`App not found: ${appId}`);
		}

		const existingMetadata = getAppMetadataJson(app) || {};

		await updateApp(db, appId, {
			discoveryStatus:
				stats.itemsExtracted > 0 ? "scraped" : app.discoveryStatus,
			metadata: {
				...existingMetadata,
				itemExtraction: {
					...(existingMetadata.itemExtraction as object),
					lastExtractedAt: new Date().toISOString(),
					itemsExtracted: stats.itemsExtracted,
					itemsSaved: stats.itemsInserted + stats.itemsUpdated,
					creditsUsed: stats.creditsUsed,
					method: "workflow",
				},
			},
		});
	}

	// ==========================================================================
	// Agent-Only Mode (Standard for all extractions)
	// ==========================================================================

	/**
	 * Build extraction prompt with site search instructions
	 *
	 * Agent-only mode is the STANDARD for all apps (bypasses anti-bot protection).
	 * Agent searches for the site, navigates naturally, and extracts data autonomously.
	 *
	 * Instructions MUST be configured in D1:
	 *   apps.metadata.extractionConfig.siteSearchInstructions
	 *
	 * No fallbacks - if missing, throws error.
	 *
	 * @param siteName - Site name for search (e.g., "mobile.de Germany")
	 * @param basePrompt - Extraction prompt from D1 config
	 * @param customInstructions - Search instructions from D1 (REQUIRED)
	 * @param limit - Maximum items to extract (enforced via prompt)
	 * @param stopConditions - Optional stop conditions to include in prompt
	 * @throws Error if customInstructions not provided
	 */
	private buildAgentInstructions(
		siteName: string,
		basePrompt: string,
		customInstructions?: string,
		limit?: number,
		stopConditions?: ResolvedExtractionConfig["stopConditions"],
	): string {
		// REQUIRE custom instructions from D1 - no fallbacks
		if (!customInstructions) {
			throw new Error(
				`[Config Error] No siteSearchInstructions for ${siteName}. ` +
					`Set apps.metadata.extractionConfig.siteSearchInstructions in D1. ` +
					`See docs/platform/api.md for examples.`,
			);
		}

		console.log(
			`[Workflow] Using siteSearchInstructions from D1 for ${siteName}`,
		);

		// Build limit enforcement instruction if provided
		const limitInstruction = limit
			? `\n\nCRITICAL LIMIT: Extract EXACTLY ${limit} items maximum. Stop immediately after extracting ${limit} items. Do NOT continue scrolling or navigating after reaching this limit.\n`
			: "";

		// Build stop conditions instruction if provided
		let stopConditionsInstruction = "";
		if (stopConditions) {
			const conditions: string[] = [];
			if (stopConditions.maxDetailPages !== undefined) {
				conditions.push(
					`- Maximum detail pages to visit: ${stopConditions.maxDetailPages}`,
				);
			}
			if (stopConditions.maxListingPages !== undefined) {
				conditions.push(
					`- Maximum listing pages to navigate: ${stopConditions.maxListingPages}`,
				);
			}
			if (stopConditions.maxScrolls !== undefined) {
				conditions.push(
					`- Maximum scroll actions: ${stopConditions.maxScrolls}`,
				);
			}
			if (stopConditions.maxClicks !== undefined) {
				conditions.push(`- Maximum click actions: ${stopConditions.maxClicks}`);
			}

			if (conditions.length > 0) {
				stopConditionsInstruction = `

STOP CONDITIONS:
${conditions.join("\n")}
Stop immediately when ANY limit is reached. These limits are hard constraints.
`;
				console.log(
					`[Workflow] Stop conditions applied: ${conditions.length} constraints`,
				);
			}
		}

		return `${customInstructions}${limitInstruction}${stopConditionsInstruction}
EXTRACTION TASK:
${basePrompt}`;
	}

	/**
	 * Filter items by required fields from quality config
	 *
	 * @param items - Items to filter
	 * @param requiredFields - Array of field names that must be present
	 * @returns Items that have all required fields
	 */
	private filterByRequiredFields(
		items: ExtractedItem[],
		requiredFields: string[],
	): ExtractedItem[] {
		return items.filter((item) => {
			for (const field of requiredFields) {
				const value = this.getNestedFieldValue(item, field);
				if (value === undefined || value === null || value === "") {
					return false;
				}
			}
			return true;
		});
	}

	/**
	 * Get nested field value from an object
	 * Supports dot notation (e.g., "location.city")
	 */
	private getNestedFieldValue(obj: ExtractedItem, field: string): unknown {
		const parts = field.split(".");
		let value: unknown = obj;
		for (const part of parts) {
			if (!value || typeof value !== "object") return undefined;
			value = (value as Record<string, unknown>)[part];
		}
		return value;
	}
}
