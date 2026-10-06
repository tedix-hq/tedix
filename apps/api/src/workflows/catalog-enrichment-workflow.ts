/**
 * CatalogEnrichmentWorkflow - Cloudflare Workflow for enriching App Catalog entries
 *
 * This workflow enriches catalog apps by scraping their ChatGPT App Store pages
 * (chatgpt.com/apps/{slug}/{sourceAppId}) and extracting:
 * - App logos (base64 webp/svg from React Router hydration data)
 * - Screenshots (estuary URLs → download and upload to R2)
 * - Example prompts (user_prompt text paired with each screenshot)
 * - SEO descriptions (rich markdown with usage instructions)
 * - App categories (PRODUCTIVITY, EDUCATION, BUSINESS, etc.)
 *
 * Data Source: React Router hydration script embedded in the page HTML
 * (window.__reactRouterContext.streamController.enqueue(...))
 *
 * Triggered by:
 * - Cron: Daily at 4am UTC (after sync completes at 3am)
 * - API: POST /rpc/catalog/enrich
 *
 * @see https://developers.cloudflare.com/workflows/
 * @see https://docs.firecrawl.dev/features/scrape
 */

import { assetsBaseUrl as resolveAssetsBaseUrl } from "./assets-base-url";
import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from "cloudflare:workers";
import { createDbClient } from "@tedix/db/client";
import { getOrganizationBySlug } from "@tedix/db/queries/organizations";
import { classifyCatalogCategory } from "../services/jev-catalog-category";
import {
	type CatalogAppEnrichmentData,
	getAppsNeedingEnrichment,
	updateCatalogAppEnrichment,
} from "@tedix/db/queries/catalog/enrichment";
import { getCatalogAppById } from "@tedix/db/queries/catalog/get-app";
import { updateCatalogAppRawEnrichmentMeta } from "@tedix/db/queries/catalog/scheduled-maintenance";
import { getCatalogStoreListings } from "@tedix/db/queries/catalog/store-listings";
import * as z from "zod";
import { scrapeBrandingFromUrl } from "../integrations/browser-run/branding";
import {
	captureScreenshot,
	extractLinks,
} from "../integrations/browser-run/client";
import { createFirecrawlClient } from "../integrations/firecrawl/client";
import { scrapeWithRetry } from "../integrations/firecrawl/retry";
import { getChatGptAppsStoreUrl } from "../lib/prompt-extractor";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Workflow parameters
 */
export interface CatalogEnrichmentWorkflowParams {
	/** Max apps to enrich in this run (default 20) */
	limit?: number;
	/** Optional specific app IDs to enrich (overrides limit) */
	appIds?: string[];
	/** Bypass transient-failure cooldown checks (defaults true for targeted appIds runs) */
	ignoreCooldown?: boolean;
	/** Automatically continue enqueueing follow-up enrichment runs until queue drains */
	drainAll?: boolean;
	/** Current chain depth for drainAll mode */
	chainDepth?: number;
	/** Maximum chained runs allowed for drainAll mode */
	maxChainDepth?: number;
	/** Re-enrich apps that have R2 PNG/JPG logos with proper website brand logos */
	forceBranding?: boolean;
	/**
	 * `full` performs ChatGPT page/screenshot enrichment. `logo-repair` only
	 * repairs missing or unusable logos from website branding data.
	 */
	mode?: "full" | "logo-repair";
}

/**
 * Serializable app data for workflow steps
 * Only includes fields needed for enrichment
 */
interface SerializableApp {
	id: string;
	name: string;
	slug: string | null;
	website: string | null;
	/** Existing description from store data */
	description: string | null;
	/** Whether the app already has an enriched description */
	hasEnrichedDescription: boolean;
	/** ChatGPT source app ID for prompt extraction */
	chatGptSourceAppId: string | null;
	/** Current logo URL (to decide whether to overwrite) */
	logoUrl: string | null;
	/** Sync-time category from D1 (e.g., "developer", "productivity") for fallback */
	category: string | null;
	/** Existing categories array from sync/enrichment */
	categories: string[] | null;
	/** Existing legal/metadata fields from sync */
	privacyPolicy: string | null;
	termsOfService: string | null;
	version: string | null;
	svgLogo: string | null;
	logoAssetStatus: string | null;
	screenshotAssetStatus: string | null;
	enrichedAt: string | null;
	enrichmentFailedAt: string | null;
	/** Normalized MCP endpoint URL for homepage derivation */
	mcpEndpointNormalized: string | null;
}

/**
 * Firecrawl Document type (from @mendable/firecrawl-js SDK)
 * @see https://docs.firecrawl.dev/sdks/node#scraping-a-url
 */
interface FirecrawlDocument {
	markdown?: string;
	html?: string;
	rawHtml?: string;
	screenshot?: string; // Base64 encoded PNG or URL
	links?: string[];
	images?: string[];
	metadata?: {
		title?: string;
		description?: string;
		ogTitle?: string;
		ogDescription?: string;
		ogImage?: string;
		ogSiteName?: string;
		twitterTitle?: string;
		twitterDescription?: string;
		author?: string;
		keywords?: string;
		[key: string]: unknown;
	};
	warning?: string;
}

/**
 * Individual enrichment result
 */
interface EnrichmentResult {
	appId: string;
	appName: string;
	success: boolean;
	screenshotUrl: string | null;
	screenshotCount: number;
	logoUrl: string | null;
	enrichedDescription: string | null;
	examplePromptsCount: number;
	categories: string[];
	hasLegalLinks: boolean;
	error: string | null;
	/** Whether this domain is blocklisted (should be permanently skipped) */
	blocklisted: boolean;
}

/**
 * Structured data extracted from ChatGPT app store page hydration script
 */
interface ChatGptAppData {
	screenshots: Array<{
		url: string;
		fileId: string;
		userPrompt: string | null;
	}>;
	logoUrl: string | null;
	seoDescription: string | null;
	categories: string[];
	developer: string | null;
	website: string | null;
	privacyPolicy: string | null;
	termsOfService: string | null;
	version: string | null;
}

/**
 * Batch enrichment summary
 */
interface EnrichmentSummary {
	total: number;
	succeeded: number;
	failed: number;
	screenshotsUploaded: number;
	blocklisted: number;
	coverage: {
		withLogo: number;
		withScreenshots: number;
		withPrompts: number;
		withLegalLinks: number;
	};
	coveragePct: {
		withLogo: number;
		withScreenshots: number;
		withPrompts: number;
		withLegalLinks: number;
	};
	errors: string[];
}

/**
 * Website branding profile normalized from rendered homepage metadata.
 */
interface BrandingProfile {
	colorScheme?: string;
	logo?: string;
	colors?: Record<string, string>;
	fonts?: Array<{ family: string }>;
	images?: {
		logo?: string;
		favicon?: string;
		ogImage?: string;
		logoHref?: string;
		logoAlt?: string;
	};
	personality?: Record<string, string>;
	[key: string]: unknown;
}

interface EnrichmentProvenance {
	confidence: number;
	provenance: Record<string, string>;
}

const SCREENSHOT_PAIR_SCHEMA = z.object({
	url: z.url(),
	fileId: z.string(),
	userPrompt: z.string().nullable(),
});

const CHATGPT_PAGE_SCHEMA = z.object({
	appName: z.string().nullable(),
	appSubtitle: z.string().nullable(),
	screenshots: z.array(SCREENSHOT_PAIR_SCHEMA).default([]),
	logoUrl: z.string().nullable(),
	seoDescription: z.string().nullable(),
	categories: z.array(z.string()).default([]),
	website: z.string().nullable(),
	privacyPolicy: z.string().nullable(),
	termsOfService: z.string().nullable(),
	version: z.string().nullable(),
});

const ESTUARY_SCREENSHOT_URL_RE =
	/^https:\/\/chatgpt\.com\/backend-api\/estuary\/content\?/i;
const ESTUARY_SCREENSHOT_URL_RE_GLOBAL =
	/https:\/\/chatgpt\.com\/backend-api\/estuary\/content\?[^\s)"'<>]+/gi;

/**
 * Known blocklist error patterns from Firecrawl
 */
const BLOCKLIST_ERROR_PATTERNS = [
	/blocklisted/i,
	/blocked.*cannot be scraped/i,
	/terms of service restrictions/i,
];

/**
 * JavaScript to execute in the Firecrawl browser context.
 * Fetches estuary screenshot images using the browser's session cookies
 * and replaces the <img> src with base64 data URLs so they appear in rawHtml.
 * The images are cross-origin gated (403 from server-side) but accessible
 * from the page's browser context via fetch with credentials.
 */
const EXTRACT_SCREENSHOTS_JS = `(async function() {
	const imgs = document.querySelectorAll('img[src*="estuary"]');
	for (const img of imgs) {
		try {
			const resp = await fetch(img.src, {credentials: 'include'});
			if (!resp.ok) continue;
			const blob = await resp.blob();
			const reader = new FileReader();
			const base64 = await new Promise((resolve, reject) => {
				reader.onload = () => resolve(reader.result);
				reader.onerror = reject;
				reader.readAsDataURL(blob);
			});
			const pngData = base64.replace('data:application/octet-stream;base64,', 'data:image/png;base64,');
			img.setAttribute('data-extracted', 'true');
			img.src = pngData;
		} catch(e) {
			img.setAttribute('data-extract-error', e.message);
		}
	}
})()`;

// =============================================================================
// WORKFLOW IMPLEMENTATION
// =============================================================================

export class CatalogEnrichmentWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	CatalogEnrichmentWorkflowParams
> {
	private readonly DEFAULT_BATCH_SIZE = 20;
	private judgmentRunId = "catalog-enrichment";
	private billingOrganization: Promise<string | null> | undefined;

	private async classifyCategory(
		db: ReturnType<typeof createDbClient>,
		app: SerializableApp,
		description: string | null | undefined,
	) {
		// The shared platform catalog is platform-owned, never charged to an arbitrary caller.
		this.billingOrganization ??= getOrganizationBySlug(db, "tedix").then(
			(org) => org?.id ?? null,
		);
		const organizationId = await this.billingOrganization;
		if (!organizationId) return null;
		return classifyCatalogCategory(
			{
				db,
				env: this.env,
				context: {
					organizationId,
					runId: this.judgmentRunId,
					sessionKey: `catalog:${app.id}`,
				},
			},
			{ name: app.name, description },
		);
	}

	private readonly SCRAPE_TIMEOUT_MS = 30000;
	private readonly DEFAULT_MAX_CHAIN_DEPTH = 12;

	private static stripD1ControlCharacters(value: string): string {
		let cleaned = "";
		for (const char of value) {
			const code = char.charCodeAt(0);
			if (
				(code >= 0 && code <= 8) ||
				code === 11 ||
				code === 12 ||
				(code >= 14 && code <= 31)
			) {
				continue;
			}
			cleaned += char;
		}
		return cleaned;
	}

	private readAssetQuality(rawData: unknown): {
		logoStatus: string | null;
		screenshotStatus: string | null;
	} {
		const raw =
			rawData && typeof rawData === "object" && !Array.isArray(rawData)
				? (rawData as Record<string, unknown>)
				: {};
		const quality =
			raw.quality &&
			typeof raw.quality === "object" &&
			!Array.isArray(raw.quality)
				? (raw.quality as Record<string, unknown>)
				: {};
		return {
			logoStatus:
				typeof quality.logoStatus === "string" ? quality.logoStatus : null,
			screenshotStatus:
				typeof quality.screenshotStatus === "string"
					? quality.screenshotStatus
					: null,
		};
	}

	async run(
		event: WorkflowEvent<CatalogEnrichmentWorkflowParams>,
		step: WorkflowStep,
	) {
		this.judgmentRunId = event.instanceId;
		const {
			limit = this.DEFAULT_BATCH_SIZE,
			appIds,
			ignoreCooldown,
			drainAll = true,
			chainDepth = 0,
			maxChainDepth = this.DEFAULT_MAX_CHAIN_DEPTH,
			forceBranding = false,
			mode = "full",
		} = event.payload;
		const bypassCooldown =
			ignoreCooldown ?? Boolean(appIds && appIds.length > 0);

		console.log(
			`[App Catalog Enrichment] Starting enrichment workflow, limit: ${limit}, appIds: ${appIds?.join(", ") || "none"}, ignoreCooldown=${bypassCooldown}, drainAll=${drainAll}, chainDepth=${chainDepth}/${maxChainDepth}, forceBranding=${forceBranding}, mode=${mode}`,
		);

		// Track results
		const summary: EnrichmentSummary = {
			total: 0,
			succeeded: 0,
			failed: 0,
			screenshotsUploaded: 0,
			blocklisted: 0,
			coverage: {
				withLogo: 0,
				withScreenshots: 0,
				withPrompts: 0,
				withLegalLinks: 0,
			},
			coveragePct: {
				withLogo: 0,
				withScreenshots: 0,
				withPrompts: 0,
				withLegalLinks: 0,
			},
			errors: [],
		};

		// Step 1: Get apps needing enrichment
		// Return serializable data only (id, name, slug, website)
		const appsJson = await step.do(
			"get-apps-needing-enrichment",
			{
				retries: { limit: 2, delay: "2 seconds" },
				timeout: "30 seconds",
			},
			async (): Promise<string> => {
				const db = createDbClient(this.env.DB);
				const apps: SerializableApp[] = [];

				if (appIds && appIds.length > 0) {
					// Specific apps requested
					for (const id of appIds) {
						const app = await getCatalogAppById(db, id);
						if (app) {
							const assetQuality = this.readAssetQuality(app.rawData);
							// Get ChatGPT store listing
							const storeListings = await getCatalogStoreListings(db, app.id);
							const chatGptListing = storeListings.find(
								(l) => l.source === "chatgpt",
							);

							apps.push({
								id: app.id,
								name: app.name,
								slug: app.slug,
								website: app.website,
								description: app.description,
								hasEnrichedDescription: !!app.richContent?.enrichedDescription,
								chatGptSourceAppId: chatGptListing?.sourceAppId ?? null,
								logoUrl: app.logoUrl,
								category: app.category ?? null,
								categories: app.categories ?? null,
								privacyPolicy: app.privacyPolicy ?? null,
								termsOfService: app.termsOfService ?? null,
								version: app.version ?? null,
								svgLogo: app.systemHints?.svgLogo ?? null,
								logoAssetStatus: assetQuality.logoStatus,
								screenshotAssetStatus: assetQuality.screenshotStatus,
								enrichedAt: app.richContent?.enrichedAt ?? null,
								enrichmentFailedAt: app.richContent?.enrichmentFailedAt ?? null,
								mcpEndpointNormalized: app.mcpEndpointNormalized ?? null,
							});
						}
					}
				} else {
					// Get apps that need enrichment
					const dbApps = await getAppsNeedingEnrichment(db, limit, 168, {
						forceBranding,
						mode,
					});

					// Fetch store listings for all apps to get ChatGPT source IDs
					for (const app of dbApps) {
						const assetQuality = this.readAssetQuality(app.rawData);
						const storeListings = await getCatalogStoreListings(db, app.id);
						const chatGptListing = storeListings.find(
							(l) => l.source === "chatgpt",
						);

						apps.push({
							id: app.id,
							name: app.name,
							slug: app.slug,
							website: app.website,
							description: app.description,
							hasEnrichedDescription: !!app.richContent?.enrichedDescription,
							chatGptSourceAppId: chatGptListing?.sourceAppId ?? null,
							logoUrl: app.logoUrl,
							category: app.category ?? null,
							categories: app.categories ?? null,
							privacyPolicy: app.privacyPolicy ?? null,
							termsOfService: app.termsOfService ?? null,
							version: app.version ?? null,
							svgLogo: app.systemHints?.svgLogo ?? null,
							logoAssetStatus: assetQuality.logoStatus,
							screenshotAssetStatus: assetQuality.screenshotStatus,
							enrichedAt: app.richContent?.enrichedAt ?? null,
							enrichmentFailedAt: app.richContent?.enrichmentFailedAt ?? null,
							mcpEndpointNormalized: app.mcpEndpointNormalized ?? null,
						});
					}
				}

				return JSON.stringify(apps);
			},
		);

		const appsToEnrich: SerializableApp[] = JSON.parse(appsJson as string);

		if (appsToEnrich.length === 0) {
			console.log("[App Catalog Enrichment] No apps need enrichment");
			return {
				success: true,
				message: "No apps need enrichment",
				summary,
			};
		}

		summary.total = appsToEnrich.length;
		console.log(
			`[App Catalog Enrichment] Found ${appsToEnrich.length} apps to enrich`,
		);

		// Step 2: Process apps sequentially
		// Batch scraping is not reliable with webhooks in Cloudflare Workflows
		// Sequential scraping is simpler and more reliable
		console.log(
			`[App Catalog Enrichment] Processing ${appsToEnrich.length} apps sequentially`,
		);

		for (const app of appsToEnrich) {
			// Enrich single app (ChatGPT store scrape or website branding fallback)
			const resultJson = await step.do(
				`enrich-app-${app.id.slice(0, 8)}`,
				{
					retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
					timeout: "2 minutes",
				},
				async (): Promise<string> => {
					return await this.enrichSingleApp(
						app,
						bypassCooldown,
						forceBranding,
						mode,
					);
				},
			);

			const result: EnrichmentResult = JSON.parse(resultJson as string);

			if (result.success) {
				summary.succeeded++;
				if (result.screenshotUrl) {
					summary.screenshotsUploaded++;
				}
				if (result.logoUrl || !this.isUnusableLogo(app.logoUrl)) {
					summary.coverage.withLogo++;
				}
				if (result.screenshotCount > 0) {
					summary.coverage.withScreenshots++;
				}
				if (result.examplePromptsCount > 0) {
					summary.coverage.withPrompts++;
				}
				if (result.hasLegalLinks) {
					summary.coverage.withLegalLinks++;
				}
			} else if (result.blocklisted) {
				summary.blocklisted++;
				console.log(
					`[App Catalog Enrichment] Blocklisted: ${result.appName} - marked as skipped`,
				);
			} else {
				summary.failed++;
				if (result.error) {
					summary.errors.push(`${result.appName}: ${result.error}`);
				}
			}

			// Small delay between requests to avoid rate limiting
			await step.sleep(`delay-after-${app.id.slice(0, 8)}`, "1 second");
		}

		// Log final summary
		console.log(
			`[App Catalog Enrichment] Complete: ${summary.succeeded} succeeded, ${summary.failed} failed, ${summary.blocklisted} blocklisted, ${summary.screenshotsUploaded} screenshots uploaded`,
		);
		const denom = Math.max(1, summary.total);
		summary.coveragePct = {
			withLogo: Number(((summary.coverage.withLogo / denom) * 100).toFixed(1)),
			withScreenshots: Number(
				((summary.coverage.withScreenshots / denom) * 100).toFixed(1),
			),
			withPrompts: Number(
				((summary.coverage.withPrompts / denom) * 100).toFixed(1),
			),
			withLegalLinks: Number(
				((summary.coverage.withLegalLinks / denom) * 100).toFixed(1),
			),
		};
		console.log(
			`[App Catalog Enrichment] Coverage: logo=${summary.coveragePct.withLogo}% screenshots=${summary.coveragePct.withScreenshots}% prompts=${summary.coveragePct.withPrompts}% legal=${summary.coveragePct.withLegalLinks}%`,
		);

		// Step 3: Optional drain mode - enqueue follow-up batch if there is likely more work.
		if (!appIds || appIds.length === 0) {
			await step.do(
				"queue-next-batch-if-needed",
				{ retries: { limit: 1, delay: "2 seconds" }, timeout: "30 seconds" },
				async () => {
					if (!drainAll) return { queued: false, reason: "drain disabled" };
					if (chainDepth >= maxChainDepth) {
						return { queued: false, reason: "max chain depth reached" };
					}
					// Avoid thrashing when a full batch made zero progress.
					if (summary.succeeded === 0 && summary.blocklisted === 0) {
						return { queued: false, reason: "no progress in this batch" };
					}

					const db = createDbClient(this.env.DB);
					const remainingProbe = await getAppsNeedingEnrichment(db, 1, 168, {
						forceBranding,
						mode,
					});
					if (remainingProbe.length === 0) {
						return { queued: false, reason: "no remaining apps" };
					}

					const enrichWorkflow = this.env.CATALOG_ENRICHMENT_WORKFLOW;
					if (!enrichWorkflow) {
						return { queued: false, reason: "workflow binding unavailable" };
					}

					const next = await enrichWorkflow.create({
						params: {
							limit,
							drainAll,
							chainDepth: chainDepth + 1,
							maxChainDepth,
							forceBranding,
							mode,
						},
					});
					console.log(
						`[App Catalog Enrichment] Queued next batch: ${next.id} (depth ${chainDepth + 1}/${maxChainDepth})`,
					);
					return { queued: true, workflowId: next.id };
				},
			);
		}

		return {
			success: summary.failed === 0,
			summary,
			errors: summary.errors.slice(0, 10), // Limit errors in response
		};
	}

	// =========================================================================
	// SEQUENTIAL SCRAPING
	// =========================================================================

	/**
	 * Check if an error indicates the domain is blocklisted
	 */
	private isBlocklistError(errorMsg: string): boolean {
		return BLOCKLIST_ERROR_PATTERNS.some((pattern) => pattern.test(errorMsg));
	}

	private shouldRetryScrapeError(error: unknown): boolean {
		const msg = (
			error instanceof Error ? error.message : String(error)
		).toLowerCase();
		// Permanent/futile classes.
		if (
			msg.includes("blocklisted") ||
			msg.includes("forbidden") ||
			msg.includes("unauthorized") ||
			msg.includes("not found")
		) {
			return false;
		}
		// Transient classes.
		if (
			msg.includes("timeout") ||
			msg.includes("rate limit") ||
			msg.includes("429") ||
			msg.includes("5xx") ||
			msg.includes("network")
		) {
			return true;
		}
		return true;
	}

	private shouldBackoffAfterRepeatedFailure(app: SerializableApp): boolean {
		if (!app.enrichmentFailedAt) return false;
		const failedAt = Date.parse(app.enrichmentFailedAt);
		if (!Number.isFinite(failedAt)) return false;
		const cooldownMs = 30 * 60 * 1000; // 30 minutes
		return Date.now() - failedAt < cooldownMs;
	}

	/**
	 * Enrich a single app using Firecrawl scraping
	 */
	/**
	 * Check if a logo URL is unusable and should be replaced
	 * connectors:// URLs are internal ChatGPT references that can't be loaded externally
	 */
	private isUnusableLogo(logoUrl: string | null): boolean {
		const trimmed = logoUrl?.trim();
		if (!trimmed) return true;
		if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
			return true;
		}
		// Public catalog pages should use stable Tedix-hosted R2 assets instead of
		// inline blobs, ChatGPT connector URLs, Google favicon fallbacks, or
		// third-party hotlinks.
		return (
			trimmed.startsWith("connectors://") ||
			trimmed.startsWith("https://www.google.com/s2/favicons") ||
			trimmed.startsWith("data:") ||
			(trimmed.startsWith("http") && !trimmed.includes("/app_catalog/"))
		);
	}

	/**
	 * Map a sync-time category value (lowercase/mixed-case string from the
	 * ChatGPT API or hydration data) to a known category enum value.
	 *
	 * The sync workflow populates `app_catalog.category` with values like
	 * "developer", "productivity", etc. This maps those to the uppercase
	 * enum values used in the `categories` JSON array.
	 */
	static mapSyncCategoryToEnum(syncCategory: string): string | null {
		const mapping: Record<string, string> = {
			// Direct lowercase-to-uppercase mappings
			productivity: "PRODUCTIVITY",
			education: "EDUCATION",
			lifestyle: "LIFESTYLE",
			research: "RESEARCH",
			programming: "PROGRAMMING",
			writing: "WRITING",
			data_analysis: "DATA_ANALYSIS",
			design: "DESIGN",
			business: "BUSINESS",
			entertainment: "ENTERTAINMENT",
			finance: "FINANCE",
			health: "HEALTH",
			travel: "TRAVEL",
			other: "OTHER",
			social: "SOCIAL",
			news: "NEWS",
			shopping: "SHOPPING",
			utilities: "UTILITIES",
			collaboration: "COLLABORATION",
			food: "FOOD",
			// ChatGPT-specific category values
			developer: "DEVELOPER_TOOLS",
			developer_tools: "DEVELOPER_TOOLS",
			developertools: "DEVELOPER_TOOLS",
			dev_tools: "DEVELOPER_TOOLS",
			business_and_analytics: "BUSINESS_AND_ANALYTICS",
			businessandanalytics: "BUSINESS_AND_ANALYTICS",
			messaging_and_social: "MESSAGING_AND_SOCIAL",
			messagingandsocial: "MESSAGING_AND_SOCIAL",
			"data analysis": "DATA_ANALYSIS",
			"developer tools": "DEVELOPER_TOOLS",
			"business and analytics": "BUSINESS_AND_ANALYTICS",
			"messaging and social": "MESSAGING_AND_SOCIAL",
		};
		return mapping[syncCategory.toLowerCase().trim()] ?? null;
	}

	private async enrichSingleApp(
		app: SerializableApp,
		ignoreCooldown: boolean,
		forceBranding = false,
		mode: "full" | "logo-repair" = "full",
	): Promise<string> {
		const result: EnrichmentResult = {
			appId: app.id,
			appName: app.name,
			success: false,
			screenshotUrl: null,
			screenshotCount: 0,
			logoUrl: null,
			enrichedDescription: null,
			examplePromptsCount: 0,
			categories: [],
			hasLegalLinks: false,
			error: null,
			blocklisted: false,
		};

		const db = createDbClient(this.env.DB);
		if (!ignoreCooldown && this.shouldBackoffAfterRepeatedFailure(app)) {
			result.error =
				"cooldown: previous enrichment failure is too recent (anti-flap backoff)";
			return JSON.stringify(result);
		}

		// Route low-confidence R2 favicon fallbacks through website branding; the
		// ChatGPT page can still be used for apps with a real store listing.
		const needsBrandLogoUpgrade =
			app.logoAssetStatus === "fallback_favicon" ||
			app.logoAssetStatus === "fetch_failed" ||
			app.logoAssetStatus === "missing" ||
			app.logoAssetStatus === "invalid" ||
			(forceBranding &&
				app.logoUrl?.includes("r2.dev") &&
				!app.logoUrl?.endsWith(".svg"));

		if (mode === "logo-repair" && !needsBrandLogoUpgrade) {
			result.success = true;
			result.logoUrl = app.logoUrl;
			return JSON.stringify(result);
		}

		// Branch: apps without ChatGPT store listing (or forceBranding candidates)
		// use website branding enrichment
		if (
			mode === "logo-repair" ||
			!app.chatGptSourceAppId ||
			needsBrandLogoUpgrade
		) {
			return await this.enrichViaWebsiteBranding(
				app,
				db,
				result,
				ignoreCooldown,
				forceBranding,
				mode,
			);
		}

		try {
			const firecrawl = createFirecrawlClient(this.env);
			// Build ChatGPT app store URL
			const chatGptUrl = getChatGptAppsStoreUrl(
				app.name,
				app.chatGptSourceAppId,
			);
			console.log(
				`[App Catalog Enrichment] Scraping ChatGPT app store page: ${chatGptUrl}`,
			);

			// Scrape with rawHtml + executeJavascript action to extract screenshots
			// The JS action fetches estuary images in-browser and injects base64 data
			// into the DOM, which then appears in the rawHtml output
			const chatGptDoc = (await scrapeWithRetry(
				firecrawl,
				chatGptUrl,
				{
					// Firecrawl currently supports: markdown, html, rawHtml, links, screenshot, ...
					// Do not request unsupported "images" format (returns 400).
					formats: ["rawHtml", "markdown", "links", "screenshot"],
					onlyMainContent: false,
					timeout: this.SCRAPE_TIMEOUT_MS,
					waitFor: 5000,
					actions: [
						{
							type: "executeJavascript",
							script: EXTRACT_SCREENSHOTS_JS,
						},
					],
				},
				{
					maxRetries: 2,
					initialDelay: 2000,
					backoffMultiplier: 2,
					maxDelay: 12000,
					useJitter: true,
					shouldRetry: (err) => this.shouldRetryScrapeError(err),
				},
			)) as FirecrawlDocument;

			// Schema-first parse from markdown/images/links, then hydrate/fallback from rawHtml.
			const schemaData = this.extractSchemaFirstData(chatGptDoc, app.name);
			const rawHtmlData = this.extractChatGptAppData(chatGptDoc.rawHtml || "");
			const appData = this.mergeExtractedAppData(schemaData, rawHtmlData);
			const provenance = this.buildProvenance(schemaData, rawHtmlData);

			console.log(
				`[App Catalog Enrichment] Parsed ${app.name}: ${appData.screenshots.length} screenshots, logo=${!!appData.logoUrl}, seo=${!!appData.seoDescription}, categories=${appData.categories.join(",")}`,
			);

			// Extract base64 screenshots from rawHtml (injected by JS action)
			const extractedScreenshots = this.extractBase64Screenshots(
				chatGptDoc.rawHtml || "",
			);
			console.log(
				`[App Catalog Enrichment] Extracted ${extractedScreenshots.length} base64 screenshots for ${app.name}`,
			);
			const filteredScreenshotPairs = appData.screenshots.filter((ss) =>
				ESTUARY_SCREENSHOT_URL_RE.test(ss.url),
			);

			// Upload extracted screenshots to R2
			const screenshotR2Urls: string[] = [];
			const screenshotMappings: Array<{
				sourceUrl: string;
				fileId: string;
				prompt: string | null;
				r2Url: string;
			}> = [];
			const uploadLimit = Math.min(
				extractedScreenshots.length,
				filteredScreenshotPairs.length,
			);
			for (let i = 0; i < uploadLimit; i++) {
				try {
					const ssUrl = await this.uploadScreenshot(
						`${app.slug || app.id}-ss-${i + 1}`,
						extractedScreenshots[i]!,
					);
					if (ssUrl) {
						screenshotR2Urls.push(ssUrl);
						screenshotMappings.push({
							sourceUrl: filteredScreenshotPairs[i]!.url,
							fileId: filteredScreenshotPairs[i]!.fileId,
							prompt: filteredScreenshotPairs[i]!.userPrompt ?? null,
							r2Url: ssUrl,
						});
					}
				} catch (ssError) {
					console.warn(
						`[App Catalog Enrichment] Failed to upload screenshot ${i + 1} for ${app.name}: ${ssError}`,
					);
				}
			}
			// Fallback to Firecrawl page screenshot if estuary extraction failed.
			if (screenshotR2Urls.length === 0 && chatGptDoc.screenshot) {
				const fallbackUrl = await this.uploadScreenshot(
					`${app.slug || app.id}-page`,
					chatGptDoc.screenshot,
				);
				if (fallbackUrl) {
					screenshotR2Urls.push(fallbackUrl);
				}
			}

			// Extract and upload logo if current one is unusable
			let logoUrl: string | null = null;
			if (appData.logoUrl && this.isUnusableLogo(app.logoUrl)) {
				logoUrl = await this.uploadLogoFromData(
					app.slug || app.id,
					appData.logoUrl,
				);
				if (logoUrl) {
					console.log(
						`[App Catalog Enrichment] Uploaded logo for ${app.name}: ${logoUrl}`,
					);
				}
			}
			// Fallback: if hydration/logo extraction did not yield a usable logo, use
			// sync-time inline SVG from system_hints when available.
			if (!logoUrl && this.isUnusableLogo(app.logoUrl) && app.svgLogo) {
				logoUrl = await this.uploadLogoFromData(
					app.slug || app.id,
					app.svgLogo,
				);
				if (logoUrl) {
					console.log(
						`[App Catalog Enrichment] Uploaded fallback SVG logo for ${app.name}: ${logoUrl}`,
					);
				}
			}

			// Build example prompts from screenshot data
			const escapedName = app.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const examplePrompts = screenshotMappings
				.filter((ss) => ss.prompt)
				.map((ss) => ({
					raw: ss.prompt!,
					cleanPrompt: ss
						.prompt!.replace(new RegExp(`@${escapedName}\\s*`, "gi"), "")
						.trim(),
					appMention: ss.prompt!.includes("@") ? `@${app.name}` : "",
					screenshotUrl: ss.r2Url,
					sourceFileId: ss.fileId,
					confidence: 0.95,
					source: provenance.provenance.examplePrompts as
						| "markdown"
						| "raw_html"
						| "sync",
				}));

			// Fall back to sync-time category if extraction found nothing
			if (appData.categories.length === 0 && app.category) {
				const mapped = CatalogEnrichmentWorkflow.mapSyncCategoryToEnum(
					app.category,
				);
				if (mapped) {
					appData.categories = [mapped];
					console.log(
						`[App Catalog Enrichment] Using sync category fallback for ${app.name}: ${app.category} → ${mapped}`,
					);
				}
			}

			// AI-based categorization fallback when no category found
			if (appData.categories.length === 0) {
				try {
					const category = await this.classifyCategory(
						db,
						app,
						app.description,
					);
					if (category) appData.categories = [category];
				} catch (err) {
					console.warn(
						`[App Catalog Enrichment] AI categorization failed for ${app.name}:`,
						err,
					);
				}
			}

			// Save enrichment data
			// Only include developer if extraction found one — omitting it (undefined)
			// prevents overwriting sync-sourced developer data with null
			const enrichmentData: CatalogAppEnrichmentData = {
				screenshotUrl:
					screenshotR2Urls.length > 0 ? screenshotR2Urls[0] : undefined,
				screenshots: screenshotR2Urls.length > 0 ? screenshotR2Urls : undefined,
				seoDescription: appData.seoDescription,
				// Only backfill categories if sync did not already provide them.
				categories:
					(!app.categories || app.categories.length === 0 || !app.category) &&
					appData.categories.length > 0
						? appData.categories
						: undefined,
				examplePrompts: examplePrompts.length > 0 ? examplePrompts : null,
				...(appData.developer ? { developer: appData.developer } : {}),
				// Fallback-only metadata (do not overwrite sync values).
				...(app.website
					? {}
					: appData.website
						? { website: appData.website }
						: {}),
				...(app.privacyPolicy
					? {}
					: appData.privacyPolicy
						? { privacyPolicy: appData.privacyPolicy }
						: {}),
				...(app.termsOfService
					? {}
					: appData.termsOfService
						? { termsOfService: appData.termsOfService }
						: {}),
				...(app.version
					? {}
					: appData.version
						? { version: appData.version }
						: {}),
				enrichmentSource: `chatgpt-store:${Math.round(
					provenance.confidence * 100,
				)}`,
			};

			// Public pages should never render third-party/private logo hotlinks. If
			// enrichment cannot repair one, clear it so the UI uses a deterministic
			// letter tile until a future Firecrawl pass finds a usable brand asset.
			if (logoUrl) {
				enrichmentData.logoUrl = logoUrl;
			} else if (this.isUnusableLogo(app.logoUrl)) {
				enrichmentData.logoUrl = null;
			}

			await updateCatalogAppEnrichment(db, app.id, enrichmentData);
			const enrichmentMeta = {
				confidence: provenance.confidence,
				provenance: provenance.provenance,
				slo: {
					hasLogo: Boolean(logoUrl || app.logoUrl || appData.logoUrl),
					hasScreenshots: screenshotR2Urls.length > 0,
					hasPrompts: examplePrompts.length > 0,
					hasLegalLinks: Boolean(
						(app.privacyPolicy ?? appData.privacyPolicy) &&
						(app.termsOfService ?? appData.termsOfService),
					),
				},
			};
			await updateCatalogAppRawEnrichmentMeta(db, app.id, enrichmentMeta);

			console.log(
				`[App Catalog Enrichment] Enriched: ${app.name} (${screenshotR2Urls.length} screenshots, ${examplePrompts.length} prompts)`,
			);

			result.success = true;
			result.screenshotUrl = screenshotR2Urls[0] ?? null;
			result.screenshotCount = screenshotR2Urls.length;
			result.logoUrl = logoUrl;
			result.enrichedDescription = appData.seoDescription;
			result.examplePromptsCount = examplePrompts.length;
			result.categories = appData.categories;
			result.hasLegalLinks = Boolean(
				(app.privacyPolicy ?? appData.privacyPolicy) &&
				(app.termsOfService ?? appData.termsOfService),
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(
				`[App Catalog Enrichment] Failed to enrich ${app.name}: ${errorMsg}`,
			);

			// Check if this is a blocklist error - mark as permanently skipped
			if (this.isBlocklistError(errorMsg)) {
				result.blocklisted = true;
				result.error = "Domain blocklisted by Firecrawl";

				await updateCatalogAppEnrichment(db, app.id, {
					enrichmentFailedAt: "failed",
					enrichmentSkipped: true,
					enrichmentSource: "chatgpt-store",
					enrichmentError: "Domain blocklisted by Firecrawl",
				});

				console.log(
					`[App Catalog Enrichment] Marked ${app.name} as blocklisted - will skip in future runs`,
				);
			} else {
				result.error = errorMsg;

				await updateCatalogAppEnrichment(db, app.id, {
					enrichmentFailedAt: "failed",
					enrichmentSource: "chatgpt-store",
					enrichmentError: errorMsg,
				});
			}
		}

		return JSON.stringify(result);
	}

	// =========================================================================
	// CHATGPT APP STORE DATA EXTRACTION
	// =========================================================================

	private extractSchemaFirstData(
		doc: FirecrawlDocument,
		appName: string,
	): ChatGptAppData & { appName: string | null; appSubtitle: string | null } {
		const markdown = doc.markdown ?? "";
		const links = doc.links ?? [];

		const titleMatch = markdown.match(/^#\s+(.+)$/m);
		// Subtitle is supplemental metadata only — match known ChatGPT subtitle patterns
		// The broad ^.{3,140}$ alternative was removed as it matched arbitrary content (e.g. "subtitle")
		const subtitleMatch = markdown.match(/^Edit, stylize, refine images$/m);
		const estuaryUrls = Array.from(
			new Set(markdown.match(ESTUARY_SCREENSHOT_URL_RE_GLOBAL) ?? []),
		);
		const logoCandidate =
			markdown.match(/data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+/)?.[0] ??
			null;
		const privacyPolicy =
			links.find((u) => /privacy/i.test(u) && /^https?:\/\//.test(u)) ?? null;
		const termsOfService =
			links.find((u) => /terms/i.test(u) && /^https?:\/\//.test(u)) ?? null;
		const website =
			links.find(
				(u) =>
					/^https?:\/\//.test(u) &&
					!u.includes("/apps") &&
					u !== privacyPolicy &&
					u !== termsOfService,
			) ?? null;
		const appMentionLower = `@${appName.toLowerCase()}`;
		const promptLines = markdown
			.split("\n")
			.map((line) => line.trim())
			// Case-insensitive: ChatGPT renders @appname in various casing
			// Also accept lines that contain (not just start with) the mention
			.filter((line) => {
				const lower = line.toLowerCase();
				return (
					lower.startsWith(appMentionLower) || lower.includes(appMentionLower)
				);
			})
			// De-duplicate (same prompt appearing in multiple positions)
			.filter((line, idx, arr) => arr.indexOf(line) === idx);
		const screenshots = estuaryUrls.map((url, idx) => {
			const fidMatch = /id=(file_[0-9a-f]+)/.exec(url);
			return {
				url,
				fileId: fidMatch?.[1] ?? `${idx + 1}`,
				userPrompt: promptLines[idx] ?? null,
			};
		});

		const parsed = CHATGPT_PAGE_SCHEMA.parse({
			appName: titleMatch?.[1] ?? null,
			appSubtitle: subtitleMatch?.[0] ?? null,
			screenshots,
			logoUrl: logoCandidate,
			seoDescription: null,
			categories: [],
			website,
			privacyPolicy,
			termsOfService,
			version: null,
		});

		return {
			appName: parsed.appName,
			appSubtitle: parsed.appSubtitle,
			screenshots: parsed.screenshots,
			logoUrl: parsed.logoUrl,
			seoDescription: parsed.seoDescription,
			categories: parsed.categories,
			developer: null,
			website: parsed.website,
			privacyPolicy: parsed.privacyPolicy,
			termsOfService: parsed.termsOfService,
			version: parsed.version,
		};
	}

	private mergeExtractedAppData(
		schemaData: ChatGptAppData,
		rawHtmlData: ChatGptAppData,
	): ChatGptAppData {
		return {
			screenshots:
				schemaData.screenshots.length > 0
					? schemaData.screenshots
					: rawHtmlData.screenshots,
			logoUrl: schemaData.logoUrl ?? rawHtmlData.logoUrl,
			seoDescription: rawHtmlData.seoDescription ?? schemaData.seoDescription,
			categories:
				rawHtmlData.categories.length > 0
					? rawHtmlData.categories
					: schemaData.categories,
			developer: rawHtmlData.developer ?? schemaData.developer,
			website: schemaData.website ?? rawHtmlData.website,
			privacyPolicy: schemaData.privacyPolicy ?? rawHtmlData.privacyPolicy,
			termsOfService: schemaData.termsOfService ?? rawHtmlData.termsOfService,
			version: rawHtmlData.version ?? schemaData.version,
		};
	}

	private buildProvenance(
		schemaData: ChatGptAppData,
		rawHtmlData: ChatGptAppData,
	): EnrichmentProvenance {
		const provenance: Record<string, string> = {
			logo:
				schemaData.logoUrl != null
					? "markdown_images"
					: rawHtmlData.logoUrl != null
						? "raw_html_hydration"
						: "missing",
			screenshots:
				schemaData.screenshots.length > 0
					? "markdown_images"
					: rawHtmlData.screenshots.length > 0
						? "raw_html_hydration"
						: "missing",
			examplePrompts: schemaData.screenshots.some((x) => Boolean(x.userPrompt))
				? "markdown"
				: rawHtmlData.screenshots.some((x) => Boolean(x.userPrompt))
					? "raw_html"
					: "sync",
			seoDescription:
				rawHtmlData.seoDescription != null ? "raw_html_hydration" : "missing",
			legal:
				schemaData.privacyPolicy || schemaData.termsOfService
					? "links_markdown"
					: rawHtmlData.privacyPolicy || rawHtmlData.termsOfService
						? "raw_html_hydration"
						: "missing",
		};
		const scored = Object.values(provenance).filter(
			(v) => v !== "missing",
		).length;
		const confidence = Number((scored / 5).toFixed(2));
		return { confidence, provenance };
	}

	/**
	 * Known field names in the ChatGPT app store React Router hydration data.
	 * Used to detect when a regex captures a field name instead of an actual value.
	 *
	 * The hydration data is a flat serialized stream where field names and values
	 * are interspersed. When a field has no value, its name is directly followed
	 * by the next field name — so a naive regex like /"developer","([^"]*)"/ may
	 * capture the next field name (e.g. "website") instead of a real value.
	 */
	private static readonly HYDRATION_FIELD_NAMES = new Set([
		"category",
		"developer",
		"website",
		"privacy_policy",
		"terms_of_service",
		"is_discoverable_app",
		"app_metadata",
		"version",
		"version_id",
		"version_notes",
		"review",
		"seo_description",
		"screenshots",
		"categories",
		"sub_categories",
		"logo_url",
		"logo_url_dark",
		"name",
		"description",
		"model_description",
		"base_url",
		"mcp_endpoint_normalized",
		"connector_type",
		"distribution_channel",
		"developer_type",
		"user_prompt",
		"url",
		"file_id",
		"keywords_for_discovery",
		"keywords_for_triggering",
		"auth_types",
		"status",
		"review_status",
		// React Router / component identifiers that may follow a field key in the stream
		"subtitle",
		"heading",
		"label",
		"placeholder",
		"children",
		"className",
		"title",
		"content",
		"text",
		"value",
		"props",
		"type",
		"data",
		"id",
	]);

	/**
	 * Extract structured app data from ChatGPT app store page HTML.
	 *
	 * Parses the React Router hydration script embedded in the page:
	 * window.__reactRouterContext.streamController.enqueue("[...]")
	 *
	 * The serialized data contains:
	 * - screenshots: array of {url, file_id, user_prompt}
	 * - logo_url: base64 data URL (webp or svg)
	 * - seo_description: rich markdown with usage instructions
	 * - categories: enum values (PRODUCTIVITY, EDUCATION, etc.)
	 * - developer: developer name
	 */
	private extractChatGptAppData(rawHtml: string): ChatGptAppData {
		// Note: rawHtml may contain base64 screenshots injected by EXTRACT_SCREENSHOTS_JS
		// Those are extracted separately by extractBase64Screenshots()
		const result: ChatGptAppData = {
			screenshots: [],
			logoUrl: null,
			seoDescription: null,
			categories: [],
			developer: null,
			website: null,
			privacyPolicy: null,
			termsOfService: null,
			version: null,
		};

		if (!rawHtml) return result;

		// Find script tags with the hydration data
		const scriptPattern = /<script[^>]*>(.*?)<\/script>/gs;
		let scriptMatch = scriptPattern.exec(rawHtml);
		let raw: string | null = null;

		while (scriptMatch !== null) {
			const script = scriptMatch[1] || "";
			if (
				!script.includes("screenshots") ||
				!script.includes("streamController")
			) {
				scriptMatch = scriptPattern.exec(rawHtml);
				continue;
			}

			const enqueueMatch = /streamController\.enqueue\("(.+?)"\);/.exec(script);
			if (enqueueMatch?.[1]) {
				// Unescape the serialized string
				raw = enqueueMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
				break;
			}
			scriptMatch = scriptPattern.exec(rawHtml);
		}

		if (!raw) return result;

		const extractField = (field: string): string | null => {
			const pattern = new RegExp(`"${field}","([^"]*)"`);
			const match = pattern.exec(raw);
			if (!match?.[1]) return null;
			return CatalogEnrichmentWorkflow.HYDRATION_FIELD_NAMES.has(match[1])
				? null
				: match[1];
		};

		// Extract screenshots section (between "screenshots" and "developer" or "version")
		// The serialized data is flat but the order varies:
		//   Case A: ..."screenshots",[...],"developer","Name","version","1.0.0",...
		//   Case B: ..."developer","","website",...,"screenshots",[...],"user_prompt","@App ...","version","1.0.0",...
		// We must stop before "developer" or "version" to avoid parsing developer/prompt text as screenshot data
		const ssStart = raw.indexOf('"screenshots"');
		// Search for "developer" both globally (for extraction) and after ssStart (for section boundary)
		const devFieldGlobal = raw.indexOf(',"developer","');
		let ssEnd = raw.indexOf(',"developer","', ssStart);
		let ssBoundedByVersion = false;
		if (ssEnd < 0) {
			ssEnd = raw.indexOf(',"version","', ssStart);
			ssBoundedByVersion = ssEnd >= 0;
		}
		if (ssStart < 0 || ssEnd < 0) return result;
		// If the developer field exists before screenshots (Case B), don't use version-bounded fallback
		// because the value before "version" is typically a user_prompt, not a developer name
		const devFieldBeforeScreenshots =
			devFieldGlobal >= 0 && devFieldGlobal < ssStart;
		if (devFieldBeforeScreenshots) {
			ssBoundedByVersion = false;
		}

		const ssSection = raw.substring(ssStart, ssEnd);

		// Find all estuary URLs in the screenshots section
		const urlPattern =
			/"(https:\/\/chatgpt\.com\/backend-api\/estuary\/content[^"]+)"/g;
		const allEstuaryUrls: string[] = [];
		let urlMatch = urlPattern.exec(ssSection);
		while (urlMatch !== null) {
			const url = (urlMatch[1] || "").replace(/\\u0026/g, "&");
			allEstuaryUrls.push(url);
			urlMatch = urlPattern.exec(ssSection);
		}

		// Deduplicate URLs by file_id
		const seenFileIds = new Set<string>();
		const uniqueUrls: Array<{ url: string; fileId: string }> = [];
		for (const url of allEstuaryUrls) {
			const fidMatch = /id=(file_[0-9a-f]+)/.exec(url);
			const fid = fidMatch?.[1] || url;
			if (!seenFileIds.has(fid)) {
				seenFileIds.add(fid);
				uniqueUrls.push({ url, fileId: fid });
			}
		}

		// Find all file_ids in the section
		const allFileIds: string[] = [];
		const fidPattern = /"(file_[0-9a-f]+)"/g;
		let fidMatch = fidPattern.exec(ssSection);
		while (fidMatch !== null) {
			if (fidMatch[1]) allFileIds.push(fidMatch[1]);
			fidMatch = fidPattern.exec(ssSection);
		}
		const uniqueFileIds = [...new Set(allFileIds)];

		// Extract developer name from the "developer" field in the hydration data
		// Use [^"]* (not [^"]+) to also match empty "" developer fields
		// Guard: if the captured value is a known field name, the developer field has no value
		const devMatch = /"developer","([^"]*)"/.exec(raw);
		if (
			devMatch?.[1] &&
			devMatch[1].length > 0 &&
			!CatalogEnrichmentWorkflow.HYDRATION_FIELD_NAMES.has(devMatch[1])
		) {
			result.developer = devMatch[1];
		}

		result.website = extractField("website");
		result.privacyPolicy = extractField("privacy_policy");
		result.termsOfService = extractField("terms_of_service");
		result.version = extractField("version");
		// When no "developer" field exists, the value just before ,"version"," is
		// typically the developer name (paired with a file_id in the screenshots data).
		// Extract it to filter from prompts and use as developer fallback.
		// GUARD: Skip this fallback if dev field existed (even empty) or if it matches prompt patterns
		let developerName = result.developer;
		if (ssBoundedByVersion && !devMatch) {
			const devFallbackMatch = /,"([^"]+)","version","/.exec(
				raw.substring(ssStart),
			);
			if (
				devFallbackMatch?.[1] &&
				!devFallbackMatch[1].startsWith("file_") &&
				!devFallbackMatch[1].startsWith("@") &&
				devFallbackMatch[1].length <= 80
			) {
				developerName = devFallbackMatch[1];
				if (!result.developer) {
					result.developer = developerName;
				}
			}
		}

		// Find prompts associated with each file_id
		// Pattern: "file_xxx","PROMPT_TEXT" where PROMPT_TEXT is not a ref object
		const promptsByFileId = new Map<string, string>();
		const promptPattern = /"(file_[0-9a-f]+)","([^{"][^"]*)"/g;
		let promptMatch = promptPattern.exec(ssSection);
		while (promptMatch !== null) {
			const fid = promptMatch[1] || "";
			const text = promptMatch[2] || "";
			// Skip if it's another file_id, a known key, or the developer name
			if (
				text.startsWith("file_") ||
				["url", "file_id", "user_prompt"].includes(text) ||
				(developerName && text === developerName)
			) {
				promptMatch = promptPattern.exec(ssSection);
				continue;
			}
			promptsByFileId.set(fid, text);
			promptMatch = promptPattern.exec(ssSection);
		}

		// Also check the first screenshot's "user_prompt","TEXT" format
		const firstPromptMatch = /"user_prompt","([^"]+)"/.exec(ssSection);
		if (firstPromptMatch?.[1] && uniqueFileIds[0]) {
			promptsByFileId.set(uniqueFileIds[0], firstPromptMatch[1]);
		}

		// Build screenshots list
		for (const { url, fileId } of uniqueUrls) {
			result.screenshots.push({
				url,
				fileId,
				userPrompt: promptsByFileId.get(fileId) || null,
			});
		}

		// Extract logo_url (base64 data URL - webp or svg)
		const logoMatch = /"logo_url","(data:[^"]+)"/.exec(raw);
		if (logoMatch?.[1]) {
			result.logoUrl = logoMatch[1];
		}

		// Extract seo_description
		// Guards:
		// 1. Known field names (e.g. "subtitle", "heading") that the serializer emits after the key
		// 2. Minimum length — real descriptions are never a single word or short label
		const seoMatch = /"seo_description","([^"]+)"/.exec(raw);
		if (
			seoMatch?.[1] &&
			seoMatch[1].length >= 20 &&
			!CatalogEnrichmentWorkflow.HYDRATION_FIELD_NAMES.has(seoMatch[1])
		) {
			result.seoDescription =
				CatalogEnrichmentWorkflow.stripD1ControlCharacters(
					seoMatch[1]
						.replace(/\\n/g, "\n")
						.replace(/\\"/g, '"')
						.replace(/\\u[\da-fA-F]{4}/g, (m) => {
							try {
								return JSON.parse(`"${m}"`);
							} catch {
								return m;
							}
						}),
				);
		}

		// Extract categories
		// All known category enum values (from both the ChatGPT hydration data
		// and the D1 schema categoryEnum)
		const categoryValues = [
			"PRODUCTIVITY",
			"EDUCATION",
			"LIFESTYLE",
			"RESEARCH",
			"PROGRAMMING",
			"WRITING",
			"DATA_ANALYSIS",
			"DESIGN",
			"BUSINESS",
			"ENTERTAINMENT",
			"FINANCE",
			"HEALTH",
			"TRAVEL",
			"OTHER",
			"DEVELOPER_TOOLS",
			"SOCIAL",
			"NEWS",
			"SHOPPING",
			"UTILITIES",
			"COLLABORATION",
			"FOOD",
			"BUSINESS_AND_ANALYTICS",
			"MESSAGING_AND_SOCIAL",
		];

		const foundCats = new Set<string>();

		// Strategy 1: Look for exact uppercase enum matches (original approach)
		const catPattern = new RegExp(`"(${categoryValues.join("|")})"`, "g");
		let catMatch = catPattern.exec(raw);
		while (catMatch !== null) {
			if (catMatch[1]) foundCats.add(catMatch[1]);
			catMatch = catPattern.exec(raw);
		}

		// Strategy 2: Look for "category","VALUE" pairs (case-insensitive)
		// Guard: in the schema section, "category" is followed by field names like
		// "developer","website",... not actual category values. Skip known field names.
		const catFieldPattern = /"category","([^"]+)"/gi;
		let catFieldMatch = catFieldPattern.exec(raw);
		while (catFieldMatch !== null) {
			if (
				catFieldMatch[1] &&
				!CatalogEnrichmentWorkflow.HYDRATION_FIELD_NAMES.has(catFieldMatch[1])
			) {
				const rawCatValue = catFieldMatch[1];
				// Try to map the lowercase/mixed-case value to a known enum
				const mapped =
					CatalogEnrichmentWorkflow.mapSyncCategoryToEnum(rawCatValue);
				if (mapped) foundCats.add(mapped);
			}
			catFieldMatch = catFieldPattern.exec(raw);
		}

		// Strategy 3: Case-insensitive scan for enum values in the raw data
		// Catches lowercase variants like "productivity" or "developer_tools"
		if (foundCats.size === 0) {
			const rawLower = raw.toLowerCase();
			for (const cat of categoryValues) {
				if (rawLower.includes(`"${cat.toLowerCase()}"`)) {
					foundCats.add(cat);
				}
			}
		}

		result.categories = [...foundCats];

		return result;
	}

	// =========================================================================
	// HELPER METHODS
	// =========================================================================

	/**
	 * Extract base64 PNG screenshots from rawHtml.
	 * The EXTRACT_SCREENSHOTS_JS action replaces estuary <img> src attributes
	 * with base64 data URLs and marks them with data-extracted="true".
	 */
	private extractBase64Screenshots(rawHtml: string): string[] {
		const screenshots: string[] = [];
		// Match img tags that were marked as extracted with base64 PNG data
		const pattern =
			/data-extracted="true"[^>]*src="(data:image\/png;base64,[^"]+)"/g;
		let match = pattern.exec(rawHtml);
		while (match !== null) {
			if (match[1]) {
				screenshots.push(match[1]);
			}
			match = pattern.exec(rawHtml);
		}
		// Also try the reverse attribute order (src before data-extracted)
		if (screenshots.length === 0) {
			const altPattern =
				/src="(data:image\/png;base64,[^"]+)"[^>]*data-extracted="true"/g;
			match = altPattern.exec(rawHtml);
			while (match !== null) {
				if (match[1]) {
					screenshots.push(match[1]);
				}
				match = altPattern.exec(rawHtml);
			}
		}
		return screenshots;
	}

	/**
	 * Upload a screenshot/page capture to R2 from base64 or URL
	 */
	private async uploadScreenshot(
		appSlug: string,
		screenshot: string,
	): Promise<string | null> {
		try {
			const screenshotKey = `app_catalog/screenshots/${appSlug}.png`;

			let screenshotBuffer: ArrayBuffer;

			if (
				screenshot.startsWith("data:") ||
				screenshot.startsWith("/9j/") ||
				screenshot.startsWith("iVBOR")
			) {
				const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, "");
				screenshotBuffer = Uint8Array.from(atob(base64Data), (c) =>
					c.charCodeAt(0),
				).buffer;
			} else if (screenshot.startsWith("http")) {
				const response = await fetch(screenshot);
				if (!response.ok) {
					throw new Error(`Failed to fetch screenshot: ${response.status}`);
				}
				screenshotBuffer = await response.arrayBuffer();
			} else {
				return null;
			}

			await this.env.R2_BUCKET.put(screenshotKey, screenshotBuffer, {
				httpMetadata: { contentType: "image/png" },
			});

			const assetsBaseUrl = resolveAssetsBaseUrl(this.env);
			return `${assetsBaseUrl}/${screenshotKey}`;
		} catch (error) {
			console.warn(
				`[App Catalog Enrichment] Failed to upload screenshot for ${appSlug}: ${error}`,
			);
			return null;
		}
	}

	private async uploadScreenshotBytes(
		appSlug: string,
		screenshotBytes: Uint8Array,
		contentType = "image/png",
	): Promise<string | null> {
		try {
			const screenshotKey = `app_catalog/screenshots/${appSlug}.png`;
			await this.env.R2_BUCKET.put(screenshotKey, screenshotBytes, {
				httpMetadata: { contentType },
			});
			const assetsBaseUrl = resolveAssetsBaseUrl(this.env);
			return `${assetsBaseUrl}/${screenshotKey}`;
		} catch (error) {
			console.warn(
				`[App Catalog Enrichment] Failed to upload screenshot for ${appSlug}: ${error}`,
			);
			return null;
		}
	}

	// =========================================================================
	// WEBSITE BRANDING ENRICHMENT (Claude, official, manual apps)
	// =========================================================================

	/**
	 * Enrich an app that has no ChatGPT store listing by rendering its website
	 * for branding (logo, OG image, description) using Browser Run.
	 *
	 * Strategy:
	 * 1. Scrape the app's website homepage for metadata (ogImage, description)
	 * 2. Try to find a logo: ogImage → favicon → inline SVG
	 * 3. Upload logo to R2 at app_catalog/logos/{slug}.{ext}
	 * 4. Optionally take a page screenshot
	 * 5. Use metadata for enriched description if missing
	 */
	private async enrichViaWebsiteBranding(
		app: SerializableApp,
		db: ReturnType<typeof createDbClient>,
		result: EnrichmentResult,
		_ignoreCooldown: boolean,
		forceBranding = false,
		mode: "full" | "logo-repair" = "full",
	): Promise<string> {
		// Derive homepage from MCP endpoint if website is missing
		// e.g. https://mcp.notion.com/mcp → https://notion.com
		let websiteUrl = app.website;
		if (!websiteUrl && app.mcpEndpointNormalized) {
			try {
				const endpointUrl = new URL(app.mcpEndpointNormalized);
				const host = endpointUrl.hostname
					.replace(/^mcp\./, "")
					.replace(/^api\./, "")
					.replace(/^mcp-server\./, "");
				websiteUrl = `https://${host}`;
				console.log(
					`[App Catalog Enrichment] Derived website from MCP endpoint for ${app.name}: ${websiteUrl}`,
				);
			} catch {
				// Invalid URL, skip
			}
		}

		if (!websiteUrl) {
			result.error = "No website URL for branding enrichment";
			return JSON.stringify(result);
		}

		try {
			console.log(
				`[App Catalog Enrichment] Scraping website branding: ${websiteUrl} (${app.name})`,
			);

			const brandingResult = await scrapeBrandingFromUrl(
				{ url: websiteUrl },
				this.env.BROWSER,
			);
			if (!brandingResult.success) {
				throw new Error(
					brandingResult.error || "Browser Run branding extraction failed",
				);
			}
			const metadata = brandingResult.metadata || {};
			const branding = brandingResult.branding as BrandingProfile | undefined;
			const links =
				(
					await extractLinks(this.env.BROWSER, websiteUrl, {
						limit: 100,
						timeoutMs: this.SCRAPE_TIMEOUT_MS,
					}).catch(() => ({ links: [] }))
				).links ?? [];

			// --- Logo extraction using branding data ---
			let logoUrl: string | null = null;

			// When forceBranding, attempt logo extraction even for apps with existing
			// R2 PNG/JPG logos. Only SVG/data-URI brand logos are accepted as upgrades;
			// if branding fails to find one, the existing logo is kept.
			const needsLogoExtraction =
				this.isUnusableLogo(app.logoUrl) || forceBranding;

			if (needsLogoExtraction) {
				const brandLogo = branding?.images?.logo || branding?.logo;
				const brandFavicon = branding?.images?.favicon;
				const brandOgImage = branding?.images?.ogImage;

				// Priority 1: Brand logo (SVG data URI or URL — the actual site logo)
				if (brandLogo) {
					if (brandLogo.startsWith("data:image/svg")) {
						// Decode URI-encoded SVG data URI to raw SVG for upload
						const decoded = decodeURIComponent(
							brandLogo.replace("data:image/svg+xml;utf8,", ""),
						);
						logoUrl = await this.uploadLogoFromData(
							app.slug || app.id,
							decoded.startsWith("<svg") ? decoded : brandLogo,
						);
					} else if (brandLogo.startsWith("data:")) {
						// In forceBranding mode, skip non-SVG data URIs — keep existing logo
						if (!forceBranding) {
							logoUrl = await this.uploadLogoFromData(
								app.slug || app.id,
								brandLogo,
							);
						}
					} else if (brandLogo.startsWith("http")) {
						// In forceBranding mode, only accept SVG URLs as upgrades
						if (!forceBranding || brandLogo.endsWith(".svg")) {
							logoUrl = await this.uploadLogoFromUrl(
								app.slug || app.id,
								brandLogo,
							);
						}
					}
					if (logoUrl) {
						console.log(
							`[App Catalog Enrichment] Uploaded brand logo for ${app.name}: ${logoUrl}`,
						);
					}
				}

				// Priority 2: Favicon from branding (often SVG or high-res)
				// In forceBranding mode, only accept SVG favicons
				if (!logoUrl && brandFavicon && brandFavicon.startsWith("http")) {
					if (!forceBranding || brandFavicon.endsWith(".svg")) {
						logoUrl = await this.uploadLogoFromUrl(
							app.slug || app.id,
							brandFavicon,
						);
						if (logoUrl) {
							console.log(
								`[App Catalog Enrichment] Uploaded brand favicon for ${app.name}: ${logoUrl}`,
							);
						}
					}
				}

				// Priority 3: OG image — skip in forceBranding mode (we already have a raster logo)
				if (!logoUrl && !forceBranding && brandOgImage?.startsWith("http")) {
					logoUrl = await this.uploadLogoFromUrl(
						app.slug || app.id,
						brandOgImage,
					);
					if (logoUrl) {
						console.log(
							`[App Catalog Enrichment] Uploaded OG image for ${app.name}: ${logoUrl}`,
						);
					}
				}

				// Priority 4: SVG logo from sync data
				if (!logoUrl && app.svgLogo) {
					logoUrl = await this.uploadLogoFromData(
						app.slug || app.id,
						app.svgLogo,
					);
					if (logoUrl) {
						console.log(
							`[App Catalog Enrichment] Uploaded fallback SVG logo for ${app.name}: ${logoUrl}`,
						);
					}
				}
			}

			// --- Screenshot ---
			let screenshotUrl: string | null = null;
			if (mode !== "logo-repair") {
				const screenshot = await captureScreenshot(
					this.env.BROWSER,
					websiteUrl,
					{
						timeoutMs: this.SCRAPE_TIMEOUT_MS,
					},
				).catch(() => null);
				if (screenshot) {
					screenshotUrl = await this.uploadScreenshotBytes(
						`${app.slug || app.id}-page`,
						screenshot.bytes,
						screenshot.contentType,
					);
				}
			}

			// --- Description from metadata ---
			const seoDescription =
				(metadata.ogDescription as string) ||
				(metadata.description as string) ||
				null;

			// --- Categories: AI-based if missing ---
			let categories: string[] = app.categories || [];
			if (categories.length === 0 && app.category) {
				const mapped = CatalogEnrichmentWorkflow.mapSyncCategoryToEnum(
					app.category,
				);
				if (mapped) categories = [mapped];
			}
			if (categories.length === 0) {
				try {
					const category = await this.classifyCategory(
						db,
						app,
						app.description || seoDescription,
					);
					if (category) categories = [category];
				} catch (err) {
					console.warn(
						`[App Catalog Enrichment] AI categorization failed for ${app.name}:`,
						err,
					);
				}
			}

			// --- Legal links from scraped page ---
			const privacyPolicy =
				links.find((u) => /privacy/i.test(u) && /^https?:\/\//.test(u)) ?? null;
			const termsOfService =
				links.find((u) => /terms/i.test(u) && /^https?:\/\//.test(u)) ?? null;

			// --- Save enrichment data ---
			const enrichmentData: CatalogAppEnrichmentData = {
				screenshotUrl: screenshotUrl || undefined,
				screenshots: screenshotUrl ? [screenshotUrl] : undefined,
				seoDescription: seoDescription
					? CatalogEnrichmentWorkflow.stripD1ControlCharacters(seoDescription)
					: undefined,
				categories:
					(!app.categories || app.categories.length === 0) &&
					categories.length > 0
						? categories
						: undefined,
				...(app.privacyPolicy ? {} : privacyPolicy ? { privacyPolicy } : {}),
				...(app.termsOfService ? {} : termsOfService ? { termsOfService } : {}),
				...(app.website ? {} : websiteUrl ? { website: websiteUrl } : {}),
				enrichmentSource: "website-branding",
			};

			if (logoUrl) {
				enrichmentData.logoUrl = logoUrl;
			} else if (this.isUnusableLogo(app.logoUrl)) {
				enrichmentData.logoUrl = null;
			}

			await updateCatalogAppEnrichment(db, app.id, enrichmentData);

			console.log(
				`[App Catalog Enrichment] Enriched via website: ${app.name} (logo=${!!logoUrl}, screenshot=${!!screenshotUrl})`,
			);

			result.success = true;
			result.screenshotUrl = screenshotUrl;
			result.screenshotCount = screenshotUrl ? 1 : 0;
			result.logoUrl = logoUrl;
			result.enrichedDescription = seoDescription;
			result.categories = categories;
			result.hasLegalLinks = Boolean(
				(app.privacyPolicy ?? privacyPolicy) &&
				(app.termsOfService ?? termsOfService),
			);
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			console.error(
				`[App Catalog Enrichment] Failed to enrich ${app.name} via website: ${errorMsg}`,
			);

			if (this.isBlocklistError(errorMsg)) {
				result.blocklisted = true;
				result.error = "Domain blocklisted by Browser Run";
				await updateCatalogAppEnrichment(db, app.id, {
					enrichmentFailedAt: "failed",
					enrichmentSkipped: true,
					enrichmentSource: "website-branding",
					enrichmentError: "Domain blocklisted by Browser Run",
				});
			} else {
				result.error = errorMsg;
				await updateCatalogAppEnrichment(db, app.id, {
					enrichmentFailedAt: "failed",
					enrichmentSource: "website-branding",
					enrichmentError: errorMsg,
				});
			}
		}

		return JSON.stringify(result);
	}

	/**
	 * Upload a logo from a remote URL to R2
	 * Fetches the image, detects format, and stores it
	 */
	private async uploadLogoFromUrl(
		appSlug: string,
		imageUrl: string,
	): Promise<string | null> {
		try {
			const response = await fetch(imageUrl);
			if (!response.ok) return null;

			const contentType = response.headers.get("content-type") || "";
			const buffer = await response.arrayBuffer();

			// Skip tiny images (likely tracking pixels) and huge images (not logos)
			if (buffer.byteLength < 100 || buffer.byteLength > 5_000_000) return null;

			let ext: string;
			let mimeType: string;
			if (contentType.includes("svg")) {
				ext = "svg";
				mimeType = "image/svg+xml";
			} else if (contentType.includes("png") || imageUrl.endsWith(".png")) {
				ext = "png";
				mimeType = "image/png";
			} else if (contentType.includes("webp") || imageUrl.endsWith(".webp")) {
				ext = "webp";
				mimeType = "image/webp";
			} else if (
				contentType.includes("jpeg") ||
				contentType.includes("jpg") ||
				imageUrl.endsWith(".jpg") ||
				imageUrl.endsWith(".jpeg")
			) {
				ext = "jpg";
				mimeType = "image/jpeg";
			} else if (contentType.includes("gif") || imageUrl.endsWith(".gif")) {
				ext = "gif";
				mimeType = "image/gif";
			} else if (contentType.includes("ico") || imageUrl.endsWith(".ico")) {
				ext = "ico";
				mimeType = "image/x-icon";
			} else {
				// Default to png for unknown types
				ext = "png";
				mimeType = "image/png";
			}

			const logoKey = `app_catalog/logos/${appSlug}.${ext}`;
			await this.env.R2_BUCKET.put(logoKey, buffer, {
				httpMetadata: { contentType: mimeType },
			});

			const assetsBaseUrl = resolveAssetsBaseUrl(this.env);
			return `${assetsBaseUrl}/${logoKey}`;
		} catch (error) {
			console.warn(
				`[App Catalog Enrichment] Failed to upload logo from URL for ${appSlug}: ${error}`,
			);
			return null;
		}
	}

	/**
	 * Upload a logo from a base64 data URL to R2
	 * Handles both webp and svg formats from the ChatGPT hydration data
	 */
	private async uploadLogoFromData(
		appSlug: string,
		dataUrl: string,
	): Promise<string | null> {
		try {
			const normalizedData = dataUrl.trim();
			const logoKeyBase = `app_catalog/logos/${appSlug}`;

			// Accept raw inline SVG markup and convert to data URL.
			if (
				!normalizedData.startsWith("data:") &&
				normalizedData.startsWith("<svg")
			) {
				const svgBytes = new TextEncoder().encode(normalizedData);
				const logoKey = `${logoKeyBase}.svg`;
				await this.env.R2_BUCKET.put(logoKey, svgBytes, {
					httpMetadata: { contentType: "image/svg+xml" },
				});
				const assetsBaseUrl = resolveAssetsBaseUrl(this.env);
				return `${assetsBaseUrl}/${logoKey}`;
			}

			// Determine format from data URL
			let contentType: string;
			let ext: string;

			if (normalizedData.startsWith("data:image/webp")) {
				contentType = "image/webp";
				ext = "webp";
			} else if (normalizedData.startsWith("data:image/svg+xml")) {
				contentType = "image/svg+xml";
				ext = "svg";
			} else if (normalizedData.startsWith("data:image/png")) {
				contentType = "image/png";
				ext = "png";
			} else {
				console.warn(
					`[App Catalog Enrichment] Unsupported logo format for ${appSlug}`,
				);
				return null;
			}

			const base64Data = normalizedData.replace(
				/^data:image\/[^;]+;base64,/,
				"",
			);
			const logoBuffer = Uint8Array.from(atob(base64Data), (c) =>
				c.charCodeAt(0),
			).buffer;

			const logoKey = `${logoKeyBase}.${ext}`;
			await this.env.R2_BUCKET.put(logoKey, logoBuffer, {
				httpMetadata: { contentType },
			});

			const assetsBaseUrl = resolveAssetsBaseUrl(this.env);
			return `${assetsBaseUrl}/${logoKey}`;
		} catch (error) {
			console.warn(
				`[App Catalog Enrichment] Failed to upload logo for ${appSlug}: ${error}`,
			);
			return null;
		}
	}
}
