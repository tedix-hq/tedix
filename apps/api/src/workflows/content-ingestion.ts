/**
 * ContentIngestionWorkflow - Cloudflare Workflow for ingesting content sources
 *
 * Handles ingestion for the content_sources table:
 * 1. Fetch source by ID from D1
 * 2. Based on sourceType: scrape webpage, parse sitemap, parse RSS
 * 3. Chunk content into ~500 token segments
 * 4. Persist content for Cloudflare AI Search indexing
 * 5. Update source status in D1
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
import { getAppById } from "@tedix/db/queries/app-records";
import {
	getContentSource,
	updateContentSourceIngestStatus,
} from "@tedix/db/queries/content-sources";
import { extractLinks } from "../integrations/browser-run/client";
import { indexContentDocument } from "../integrations/ai-search/content-index";
import {
	IngestionBrowserError,
	type IngestionBrowserTelemetry,
	isKitesurfIngestionEligible,
	scrapeIngestionPage,
} from "./content-ingestion-browser";
import { splitConvertedPdf } from "./content-ingestion-pdf";

// ============================================================================
// Types
// ============================================================================

export interface ContentIngestionParams {
	/** Content source ID (from content_sources table) */
	sourceId: string;
	/** App ID for namespace isolation */
	appId: string;
}

interface ScrapedPage {
	url: string;
	title: string;
	content: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Download a PDF and convert it to markdown with the Workers AI `toMarkdown`
 * binding.
 *
 * `toMarkdown` does the extraction inside the runtime, so no PDF library ships
 * in the apps/api bundle (a Workers bundle is a single file: `await import()`
 * defers evaluation, not bytes, and apps/api cold start is a real cost). It
 * also marks page boundaries as `### Page N`.
 *
 * Caps at ~2 MB to avoid Worker subrequest body limits + isolate memory pressure.
 */
async function extractPdf(
	ai: Ai | undefined,
	url: string,
): Promise<ScrapedPage | null> {
	const PDF_MAX_BYTES = 2 * 1024 * 1024;

	if (!ai) {
		throw new NonRetryableError("AI binding not configured");
	}

	const resp = await fetch(url, {
		headers: {
			"User-Agent": "Tedix-Content-Bot/1.0",
			Accept: "application/pdf",
		},
	});
	if (!resp.ok) {
		throw new Error(`PDF fetch failed: HTTP ${resp.status}`);
	}
	const buf = await resp.arrayBuffer();
	if (buf.byteLength > PDF_MAX_BYTES) {
		throw new NonRetryableError(
			`PDF too large: ${buf.byteLength} bytes (max ${PDF_MAX_BYTES})`,
		);
	}

	const converted = await ai.toMarkdown({
		name: url.split("/").pop() || "document.pdf",
		blob: new Blob([buf], { type: "application/pdf" }),
	});
	if (converted.format === "error") {
		// A PDF that will not parse will not parse on the retry either.
		throw new NonRetryableError(`PDF conversion failed: ${converted.error}`);
	}

	const { title, body } = splitConvertedPdf(converted.data, url);
	if (body.trim().length === 0) {
		throw new NonRetryableError("PDF text extraction returned empty");
	}

	console.log(
		`[ContentIngestion] PDF extracted: ${url} (${converted.tokens} tokens, ${body.length} chars)`,
	);
	return { url, title, content: body };
}

/**
 * Parse a sitemap XML and extract URLs
 */
async function parseSitemap(sitemapUrl: string): Promise<string[]> {
	const response = await fetch(sitemapUrl, {
		headers: { "User-Agent": "Tedix-Content-Bot/1.0" },
	});
	if (!response.ok) return [];

	const xml = await response.text();
	const urls: string[] = [];
	const locRegex = /<loc>([^<]+)<\/loc>/gi;
	let match = locRegex.exec(xml);
	while (match !== null) {
		if (match[1]) urls.push(match[1].trim());
		match = locRegex.exec(xml);
	}

	// If it's a sitemap index, recursively fetch nested sitemaps
	if (xml.includes("<sitemapindex")) {
		const nestedUrls: string[] = [];
		for (const url of urls) {
			if (url.endsWith(".xml")) {
				const nested = await parseSitemap(url);
				nestedUrls.push(...nested);
			}
		}
		return nestedUrls;
	}

	return urls;
}

/**
 * Parse an RSS feed and extract article URLs
 */
async function parseRssFeed(feedUrl: string): Promise<string[]> {
	const response = await fetch(feedUrl, {
		headers: { "User-Agent": "Tedix-Content-Bot/1.0" },
	});
	if (!response.ok) return [];

	const xml = await response.text();
	const urls: string[] = [];

	// RSS 2.0: <link>url</link> inside <item>
	const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
	const linkRegex = /<link>([^<]+)<\/link>/i;
	let match = itemRegex.exec(xml);
	while (match !== null) {
		const content = match[1] ?? "";
		const linkMatch = linkRegex.exec(content);
		if (linkMatch?.[1]) urls.push(linkMatch[1].trim());
		match = itemRegex.exec(xml);
	}

	// Atom: <entry><link href="url"/></entry>
	if (urls.length === 0) {
		const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
		const atomLinkRegex = /<link[^>]+href="([^"]+)"/i;
		match = entryRegex.exec(xml);
		while (match !== null) {
			const content = match[1] ?? "";
			const linkMatch = atomLinkRegex.exec(content);
			if (linkMatch?.[1]) urls.push(linkMatch[1].trim());
			match = entryRegex.exec(xml);
		}
	}

	return urls;
}

// ============================================================================
// Workflow
// ============================================================================

export class ContentIngestionWorkflow extends WorkflowEntrypoint<
	CloudflareEnv,
	ContentIngestionParams
> {
	async run(event: WorkflowEvent<ContentIngestionParams>, step: WorkflowStep) {
		const { sourceId, appId } = event.payload;

		console.log(`[ContentIngestion] Starting ingestion for source ${sourceId}`);

		// Step 1: Load source and app from D1
		const context = await step.do(
			"load-source",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "15 seconds" },
			async () => {
				const db = createDbClient(this.env.DB);
				const source = await getContentSource(db, sourceId);
				if (!source)
					throw new NonRetryableError(`Source not found: ${sourceId}`);
				if (source.appId !== appId) {
					throw new NonRetryableError(
						`Source ${sourceId} does not belong to app ${appId}`,
					);
				}

				const app = await getAppById(db, appId);
				if (!app) throw new NonRetryableError(`App not found: ${appId}`);

				// Mark as in-progress (we use 'pending' since that's the closest status)
				await updateContentSourceIngestStatus(db, sourceId, {
					lastIngestStatus: "pending",
					lastError: null,
				});

				return {
					source: {
						id: source.id,
						sourceType: source.sourceType,
						sourceUrl: source.sourceUrl,
						title: source.title,
						config: source.config,
					},
					appSlug: app.slug,
					appVisibility: app.visibility ?? "private",
				};
			},
		);

		const { source, appSlug, appVisibility } = context as {
			source: {
				id: string;
				sourceType: string;
				sourceUrl: string;
				title: string | null;
				config: Record<string, unknown> | null;
			};
			appSlug: string;
			appVisibility: "public" | "private" | "disabled";
		};

		// Step 2: Discover URLs to scrape
		const urlsToScrape = await step.do(
			"discover-urls",
			{
				retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
				timeout: "2 minutes",
			},
			async (): Promise<string[]> => {
				switch (source.sourceType) {
					case "webpage":
						return [source.sourceUrl];

					case "sitemap": {
						let sitemapUrl = source.sourceUrl;
						if (!sitemapUrl.endsWith(".xml")) {
							sitemapUrl = sitemapUrl.replace(/\/?$/, "/sitemap.xml");
						}
						const urls = await parseSitemap(sitemapUrl);
						// Apply config filters
						return applyUrlFilters(
							urls,
							source.config as Record<string, unknown> | null,
						);
					}

					case "rss": {
						const urls = await parseRssFeed(source.sourceUrl);
						return applyUrlFilters(
							urls,
							source.config as Record<string, unknown> | null,
						);
					}

					case "website": {
						const mappedLinks = await extractLinks(
							this.env.BROWSER,
							source.sourceUrl,
							{
								limit:
									((source.config as Record<string, unknown> | null)
										?.maxItems as number | undefined) ?? 200,
								timeoutMs: 30_000,
							},
						);
						return applyUrlFilters(
							mappedLinks.links,
							source.config as Record<string, unknown> | null,
						);
					}

					case "manual":
						// Manual sources have their content inline — just scrape the URL
						return [source.sourceUrl];

					case "pdf":
						// Single-PDF source: passthrough URL, handled in scrape step
						return [source.sourceUrl];

					default:
						throw new Error(`Unknown source type: ${source.sourceType}`);
				}
			},
		);

		const urls = urlsToScrape as string[];
		console.log(
			`[ContentIngestion] Found ${urls.length} URLs to scrape for source ${sourceId}`,
		);

		if (urls.length === 0) {
			await step.do("mark-empty", { timeout: "10 seconds" }, async () => {
				const db = createDbClient(this.env.DB);
				await updateContentSourceIngestStatus(db, sourceId, {
					lastIngestStatus: "success",
					documentCount: 0,
					lastError: null,
				});
			});
			return { success: true, sourceId, documents: 0 };
		}

		// Step 3a: validate runtime env once (so missing config fails fast
		// rather than 50 retried per-URL steps each surfacing the same error).
		await step.do(
			"validate-env",
			// `limit` is total attempts. NonRetryableError below provides the
			// deterministic fail-fast behavior; one attempt keeps the config valid.
			{ retries: { limit: 1, delay: "1 second" }, timeout: "5 seconds" },
			async () => {
				if (!this.env.BROWSER) {
					throw new NonRetryableError("BROWSER binding not configured");
				}
				if (!this.env.CONTENT_CMS_BUCKET) {
					throw new NonRetryableError(
						"CONTENT_CMS_BUCKET R2 binding not configured",
					);
				}
				if (!this.env.CONTENT_AI_SEARCH) {
					throw new NonRetryableError(
						"CONTENT_AI_SEARCH namespace binding not configured",
					);
				}
			},
		);

		// Step 3b: scrape + write each URL as its own durable step.
		// Each URL gets independent retry/timeout — one slow or transiently
		// failing page can't block the rest of the crawl. step.do natural
		// latency (~100-500ms per step) provides inherent pacing without
		// needing setTimeout.
		const isPdfSource = source.sourceType === "pdf";
		const category =
			source.sourceType === "rss"
				? "news"
				: source.sourceType === "pdf"
					? "pdf"
					: "docs";
		let docsWritten = 0;
		const failures: string[] = [];
		const browserSummary = {
			operations: 0,
			kitesurfRequested: 0,
			fallbacks: 0,
			browserMsUsed: 0,
			wallMs: 0,
		};
		for (let i = 0; i < urls.length; i++) {
			const url = urls[i]!;
			try {
				const result = await step.do(
					`scrape-${i}`,
					{
						retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
						timeout: "5 minutes",
					},
					async (): Promise<{
						browserTelemetry?: IngestionBrowserTelemetry;
					}> => {
						console.log(
							`[ContentIngestion] ${isPdfSource ? "Extracting PDF" : "Scraping"}: ${url}`,
						);
						let page: ScrapedPage | null;
						let browserTelemetry: IngestionBrowserTelemetry | undefined;
						if (isPdfSource) {
							page = await extractPdf(this.env.AI, url);
						} else {
							const browserEnv = this.env as CloudflareEnv & {
								CLOUDFLARE_API_TOKEN?: string;
							};
							let browserResult;
							try {
								browserResult = await scrapeIngestionPage(
									this.env.BROWSER,
									url,
									{
										requestKitesurf: isKitesurfIngestionEligible({
											appVisibility,
											sourceType: source.sourceType,
											config: source.config,
											url,
										}),
										rest: {
											accountId: browserEnv.CF_ACCOUNT_ID,
											apiToken: browserEnv.CLOUDFLARE_API_TOKEN ?? "",
										},
									},
								);
							} catch (error) {
								if (error instanceof IngestionBrowserError) {
									console.log(
										`[ContentIngestion] browser_operation ${JSON.stringify({
											operationId: `${sourceId}:${i}`,
											url,
											...error.telemetry,
										})}`,
									);
								}
								throw error;
							}
							page = browserResult.page;
							browserTelemetry = browserResult.telemetry;
							console.log(
								`[ContentIngestion] browser_operation ${JSON.stringify({
									operationId: `${sourceId}:${i}`,
									url,
									...browserTelemetry,
								})}`,
							);
						}
						if (!page) {
							throw new Error("Scraper returned empty page");
						}

						const db = createDbClient(this.env.DB);
						await indexContentDocument(db, this.env, {
							appId,
							appSlug,
							sourceId,
							canonicalUrl: page.url,
							title: page.title,
							contentType: category,
							visibility: appVisibility,
							markdown: page.content,
						});
						return {
							...(browserTelemetry ? { browserTelemetry } : {}),
						};
					},
				);
				if (result.browserTelemetry) {
					const telemetry = result.browserTelemetry;
					browserSummary.operations++;
					if (telemetry.requestedEngine === "kitesurf") {
						browserSummary.kitesurfRequested++;
					}
					if (telemetry.retryCount > 0) browserSummary.fallbacks++;
					browserSummary.browserMsUsed += telemetry.browserMsUsed;
					browserSummary.wallMs += telemetry.totalWallMs;
				}
				docsWritten++;
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				failures.push(`${url}: ${msg}`);
				console.log(`[ContentIngestion] Failed after retries: ${url} — ${msg}`);
			}
		}
		console.log(
			`[ContentIngestion] Indexed ${docsWritten}/${urls.length} URLs (${failures.length} failed after retries) for source ${sourceId}`,
		);
		const ingestionSucceeded = failures.length === 0;
		const lastError = ingestionSucceeded
			? null
			: failures.join("\n").slice(0, 4_000);

		// Step 4: Update source status in D1
		await step.do(
			"update-status",
			{ retries: { limit: 2, delay: "2 seconds" }, timeout: "10 seconds" },
			async () => {
				const db = createDbClient(this.env.DB);
				await updateContentSourceIngestStatus(db, sourceId, {
					lastIngestStatus: ingestionSucceeded ? "success" : "failed",
					documentCount: docsWritten,
					lastError,
				});
			},
		);

		console.log(
			`[ContentIngestion] ${ingestionSucceeded ? "Complete" : "Incomplete"}: ${docsWritten}/${urls.length} documents recorded in D1, R2, and AI Search for source ${sourceId}`,
		);

		return {
			success: ingestionSucceeded,
			sourceId,
			documents: docsWritten,
			failures,
			browser: browserSummary,
		};
	}
}

/**
 * Apply URL filters from source config (includePaths, excludePaths, maxItems)
 */
function applyUrlFilters(
	urls: string[],
	config: Record<string, unknown> | null,
): string[] {
	if (!config) return urls.slice(0, 100);

	let filtered = urls;

	const includePaths = config.includePaths as string[] | undefined;
	if (includePaths?.length) {
		filtered = filtered.filter((url) => {
			try {
				const path = new URL(url).pathname;
				return includePaths.some((p) => path.includes(p));
			} catch {
				return false;
			}
		});
	}

	const excludePaths = config.excludePaths as string[] | undefined;
	if (excludePaths?.length) {
		filtered = filtered.filter((url) => {
			try {
				const path = new URL(url).pathname;
				return !excludePaths.some((p) => path.includes(p));
			} catch {
				return true;
			}
		});
	}

	const maxItems = (config.maxItems as number) ?? 100;
	return filtered.slice(0, maxItems);
}
