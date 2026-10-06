/**
 * Content oRPC Router
 *
 * Contract-first development pattern for content library management.
 * Endpoints for managing the R2 + Cloudflare AI Search content library:
 * - search - Search content library with hybrid semantic search
 * - answer - Search + AI answer generation
 * - ingest - Ingest content from URL
 * - listSources / addSource / removeSource - Content source CRUD (D1 table)
 * - ingestSource / ingestAll - Trigger ingestion workflows
 * - sync - Crawl and sync content sources via Browser Run
 *
 * All routes require appId (UUID) for multi-tenant namespace isolation.
 * Uses Cloudflare Browser Run for rendered scraping and AI Search for search.
 */

import { implement } from "@orpc/server";
import { contentContract } from "@tedix/api-contract/contracts/content";
import type { DbClient } from "@tedix/db/client";
import { getAppById } from "@tedix/db/queries/app-records";
import {
	createContentSource,
	deleteContentSource,
	getContentSource,
	listContentSourceDocumentsByObjectKeys,
	listContentSources,
	updateContentSourceIngestStatus,
} from "@tedix/db/queries/content-sources";
import { requireOrgId } from "../org-scope";

// ScrapedBlogPost type for the R2 + AI Search ingestion path.
interface ScrapedBlogPost {
	url: string;
	markdown: string;
	metadata: {
		title?: string;
		ogTitle?: string;
		description?: string;
		ogDescription?: string;
		ogImage?: string;
		publishedTime?: string;
		"article:published_time"?: string;
		author?: string;
		tags?: string[];
	};
}

import type { ContentSource } from "@tedix/db/schema/content-sources";
import {
	type AiSearchEnv,
	searchContent as aiSearchContent,
} from "../../integrations/ai-search/content-search";
import {
	type ContentIndexEnv,
	indexContentDocument,
} from "../../integrations/ai-search/content-index";
import { scrapeMarkdownPage } from "../../integrations/browser-run/client";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

async function scrapePage(
	browserBinding: unknown | undefined,
	url: string,
): Promise<ScrapedBlogPost | null> {
	const page = await scrapeMarkdownPage(browserBinding, url, {
		timeoutMs: 30_000,
	});
	if (!page) return null;
	return {
		url: page.finalUrl ?? url,
		markdown: page.markdown,
		metadata: page.metadata as ScrapedBlogPost["metadata"],
	};
}

// =============================================================================
// SITEMAP / DOCS SYNC HELPERS
// =============================================================================

interface SitemapUrl {
	loc: string;
	lastmod?: string;
}

async function parseSitemapXml(sitemapUrl: string): Promise<SitemapUrl[]> {
	const response = await fetch(sitemapUrl, {
		headers: {
			"User-Agent": "Tedix-Content-Bot/1.0",
			Accept: "application/xml, text/xml, */*",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Failed to fetch sitemap: ${response.status} ${response.statusText}`,
		);
	}

	const xmlText = await response.text();
	const urls: SitemapUrl[] = [];

	if (xmlText.includes("<sitemapindex")) {
		const sitemapLocs = extractXmlElements(xmlText, "sitemap", "loc");
		for (const nestedUrl of sitemapLocs) {
			try {
				const nestedUrls = await parseSitemapXml(nestedUrl);
				urls.push(...nestedUrls);
			} catch (error) {
				console.warn(
					`[Sitemap] Failed to fetch nested sitemap ${nestedUrl}:`,
					error,
				);
			}
		}
	} else {
		const urlRegex = /<url[^>]*>([\s\S]*?)<\/url>/gi;
		const locRegex = /<loc>([^<]+)<\/loc>/i;

		let match = urlRegex.exec(xmlText);
		while (match !== null) {
			const content = match[1] ?? "";
			const locMatch = locRegex.exec(content);
			if (locMatch?.[1]) {
				urls.push({ loc: locMatch[1].trim() });
			}
			match = urlRegex.exec(xmlText);
		}
	}

	return urls;
}

function extractXmlElements(
	xml: string,
	parentTag: string,
	childTag: string,
): string[] {
	const results: string[] = [];
	const parentRegex = new RegExp(
		`<${parentTag}[^>]*>([\\s\\S]*?)<\\/${parentTag}>`,
		"gi",
	);
	const childRegex = new RegExp(`<${childTag}>([^<]+)<\\/${childTag}>`, "i");

	let match = parentRegex.exec(xml);
	while (match !== null) {
		const content = match[1] ?? "";
		const childMatch = childRegex.exec(content);
		if (childMatch?.[1]) {
			results.push(childMatch[1].trim());
		}
		match = parentRegex.exec(xml);
	}

	return results;
}

async function indexScrapedPage(
	db: DbClient,
	env: ContentIndexEnv,
	appId: string,
	appSlug: string,
	appVisibility: "public" | "private" | "disabled",
	sourceId: string | null,
	page: ScrapedBlogPost,
	category: string,
): Promise<{ id: string; objectKey: string }> {
	const title =
		page.markdown
			.match(/^#\s+(.+)$/m)?.[1]
			?.replace(/\*\*/g, "")
			.replace(/\*/g, "")
			.replace(/_/g, "")
			.trim() ||
		page.metadata.title ||
		"Untitled";

	return indexContentDocument(db, env, {
		appId,
		appSlug,
		sourceId,
		canonicalUrl: page.url,
		title,
		contentType: category,
		visibility: appVisibility,
		markdown: page.markdown,
	});
}

// =============================================================================
// SOURCE SYNC DISPATCHER
// =============================================================================

/**
 * Sync a content source by crawling its URL(s) and writing to R2.
 * AI Search auto-indexes from the content-cms R2 bucket.
 */
async function syncContentSource(
	browserBinding: unknown | undefined,
	db: DbClient,
	env: ContentIndexEnv,
	appId: string,
	appSlug: string,
	appVisibility: "public" | "private" | "disabled",
	source: ContentSource,
): Promise<{
	success: boolean;
	discovered?: number;
	ingested?: number;
	error?: string;
}> {
	const config = (source.config ?? {}) as Record<string, unknown>;

	const category = source.sourceType === "rss" ? "news" : "docs";

	try {
		// Discover URLs based on source type
		let urls: string[];
		switch (source.sourceType) {
			case "webpage":
			case "manual":
				urls = [source.sourceUrl];
				break;
			case "sitemap": {
				let sitemapUrl = source.sourceUrl;
				if (!sitemapUrl.endsWith(".xml")) {
					sitemapUrl = sitemapUrl.replace(/\/?$/, "/sitemap.xml");
				}
				const sitemapUrls = await parseSitemapXml(sitemapUrl);
				urls = applyUrlFilters(
					sitemapUrls.map((u) => u.loc),
					config,
				);
				break;
			}
			case "rss": {
				const response = await fetch(source.sourceUrl, {
					headers: { "User-Agent": "Tedix-Content-Bot/1.0" },
				});
				if (!response.ok) {
					return {
						success: false,
						error: `RSS fetch failed: ${response.status}`,
					};
				}
				const xml = await response.text();
				const rssUrls: string[] = [];
				const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
				const linkRegex = /<link>([^<]+)<\/link>/i;
				let match: RegExpExecArray | null;
				while ((match = itemRegex.exec(xml)) !== null) {
					const content = match[1] ?? "";
					const linkMatch = linkRegex.exec(content);
					if (linkMatch?.[1]) rssUrls.push(linkMatch[1].trim());
				}
				if (rssUrls.length === 0) {
					const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
					const atomLinkRegex = /<link[^>]+href="([^"]+)"/i;
					while ((match = entryRegex.exec(xml)) !== null) {
						const content = match[1] ?? "";
						const linkMatch = atomLinkRegex.exec(content);
						if (linkMatch?.[1]) rssUrls.push(linkMatch[1].trim());
					}
				}
				urls = applyUrlFilters(rssUrls, config);
				break;
			}
			default:
				return {
					success: false,
					error: `Source type "${source.sourceType}" not supported`,
				};
		}

		// Scrape each URL and write to R2
		let ingested = 0;
		for (const url of urls) {
			const page = await scrapePage(browserBinding, url);
			if (page) {
				await indexScrapedPage(
					db,
					env,
					appId,
					appSlug,
					appVisibility,
					source.id,
					page,
					category,
				);
				ingested++;
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		return { success: true, discovered: urls.length, ingested };
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}

function applyUrlFilters(
	urls: string[],
	config: Record<string, unknown>,
): string[] {
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

// =============================================================================
// CONTRACT IMPLEMENTATION
// =============================================================================

const contentOs = implement(contentContract).$context<BaseContext>();

/**
 * Resolve an app ONLY when the caller's organization owns it.
 *
 * Every handler here fetched the app with `getAppById(db, appId)` — an id-only
 * `findFirst` — purely to prove it existed, then used `app.slug` as the R2 /
 * AI-Search namespace selector. That made the whole router cross-tenant: reads
 * answered from another tenant's indexed content, and writes (ingest, sync,
 * addSource) landed objects under another tenant's slug prefix in the shared
 * content bucket.
 *
 * Returns `undefined` rather than throwing so each call site keeps its own
 * error shape — some throw NOT_FOUND, some return a soft `success: false`. A
 * foreign app now simply reads as "not found", which is also what stops the
 * endpoint confirming that another tenant's app id exists.
 */
async function getAppForOrg(db: DbClient, orgId: string, appId: string) {
	const app = await getAppById(db, appId);
	return app && app.organizationId === orgId ? app : undefined;
}

const authedContentOs = contentOs.use(withAuth);
const authedTableOs = contentOs.use(withAuth);

async function resolveContentDocuments(
	db: DbClient,
	appId: string,
	objectKeys: string[],
) {
	const documents = await listContentSourceDocumentsByObjectKeys(
		db,
		appId,
		objectKeys,
	);
	return new Map(documents.map((document) => [document.objectKey, document]));
}

// Workers AI answer generation removed — tedi is the domain expert, not a generic LLM.
// content_answer returns FAQ cache matches or raw sources for tedi/caller enrichment.

// =============================================================================
// PROCEDURE IMPLEMENTATIONS
// =============================================================================

export const answerContentProcedure = authedContentOs.answer
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const {
			appId,
			query,
			limit,
			category: _category,
			generateAnswer: _generateAnswer,
		} = input;

		try {
			const app = await getAppForOrg(db, requireOrgId(context), appId);
			if (!app) {
				return {
					success: false,
					query,
					sources: [],
					total: 0,
					error: "App not found",
				};
			}

			// CF AI Search → return raw sources (no LLM answer generation)
			const aiEnv = env as unknown as AiSearchEnv;
			const result = await aiSearchContent(aiEnv, query, {
				appId,
				limit,
				resolveDocuments: (resolvedAppId, objectKeys) =>
					resolveContentDocuments(db, resolvedAppId, objectKeys),
			});

			return {
				success: result.success,
				query,
				sources: result.sources,
				total: result.sources.length,
				...(result.error ? { error: result.error } : {}),
			};
		} catch (error) {
			console.error("[Content Answer] Error:", error);
			return {
				success: false,
				query,
				sources: [],
				total: 0,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

export const searchContentProcedure = authedContentOs.search
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId, q, limit, category: _category } = input;

		try {
			const app = await getAppForOrg(db, requireOrgId(context), appId);
			if (!app) {
				return {
					success: false,
					sources: [],
					query: q,
					total: 0,
					error: "App not found",
				};
			}

			const aiEnv = env as unknown as AiSearchEnv;
			const result = await aiSearchContent(aiEnv, q, {
				appId,
				limit,
				resolveDocuments: (resolvedAppId, objectKeys) =>
					resolveContentDocuments(db, resolvedAppId, objectKeys),
			});

			return {
				success: result.success,
				sources: result.sources,
				query: q,
				total: result.sources.length,
				...(result.error ? { error: result.error } : {}),
			};
		} catch (error) {
			console.error("[Content Search] Error:", error);
			return {
				success: false,
				sources: [],
				query: q,
				total: 0,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	});

export const ingestContentProcedure = authedContentOs.ingest
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId, url, category } = input;

		if (!env.BROWSER) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"BROWSER binding not configured",
			);
		}

		if (!env.CONTENT_CMS_BUCKET) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"CONTENT_CMS_BUCKET not configured",
			);
		}
		if (!env.CONTENT_AI_SEARCH) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"CONTENT_AI_SEARCH binding not configured",
			);
		}

		try {
			const app = await getAppForOrg(db, requireOrgId(context), appId);
			if (!app) {
				throw createError(ErrorCodes.NOT_FOUND, "App not found");
			}

			const post = await scrapePage(env.BROWSER, url);
			if (!post) {
				return { success: false, error: "Failed to scrape URL" };
			}

			const cat = category || "docs";
			const indexed = await indexScrapedPage(
				db,
				env as unknown as ContentIndexEnv,
				appId,
				app.slug,
				app.visibility ?? "private",
				null,
				post,
				cat,
			);

			const title =
				post.markdown.match(/^#\s+(.+)$/m)?.[1] ||
				post.metadata.title ||
				"Untitled";

			return {
				success: true,
				message: `Ingested and submitted to AI Search: ${title}`,
				document: {
					id: indexed.id,
					title,
					url: post.url,
					excerpt: post.metadata.description || "",
				},
			};
		} catch (error) {
			if (error instanceof Error && "code" in error) {
				throw error;
			}
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				error instanceof Error ? error.message : "Unknown error",
			);
		}
	});

// =============================================================================
// SOURCE MANAGEMENT (D1 content_sources table)
// =============================================================================

export const listSourcesProcedure = authedTableOs.listSources
	.use(AUTHZ.appsRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId } = input;

		const app = await getAppForOrg(db, requireOrgId(context), appId);
		if (!app) throw createError(ErrorCodes.NOT_FOUND, "App not found");

		const sources = await listContentSources(db, appId);
		return {
			success: true,
			sources: sources.map((s) => ({
				...s,
				config: s.config as Record<string, unknown> | null,
			})),
		};
	});

export const addSourceProcedure = authedTableOs.addSource
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, sourceType, sourceUrl, title, config } = input;

		const app = await getAppForOrg(db, requireOrgId(context), appId);
		if (!app) throw createError(ErrorCodes.NOT_FOUND, "App not found");

		const source = await createContentSource(db, {
			id: crypto.randomUUID(),
			appId,
			sourceType,
			sourceUrl,
			title: title ?? null,
			config: config ?? null,
			lastIngestStatus: "pending",
			documentCount: 0,
		});

		return {
			success: true,
			source: {
				...source,
				config: source.config as Record<string, unknown> | null,
			},
		};
	});

export const removeSourceProcedure = authedTableOs.removeSource
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { appId, sourceId } = input;

		const deleted = await deleteContentSource(db, sourceId, appId);
		if (!deleted) throw createError(ErrorCodes.NOT_FOUND, "Source not found");

		return { success: true };
	});

export const ingestSourceProcedure = authedTableOs.ingestSource
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId, sourceId } = input;

		// `source.appId !== appId` below is only a guard once appId is known to be
		// the caller's: before this, BOTH operands came from the same request, so
		// the check compared a caller-supplied value against itself and let any
		// tenant drive ingestion for another tenant's source.
		const app = await getAppForOrg(db, requireOrgId(context), appId);
		if (!app) {
			throw createError(ErrorCodes.NOT_FOUND, "App not found");
		}

		const source = await getContentSource(db, sourceId);
		if (!source || source.appId !== appId) {
			throw createError(ErrorCodes.NOT_FOUND, "Source not found");
		}

		const workflowId = `ingest-${sourceId}-${Date.now()}`;
		await env.CONTENT_INGESTION_WORKFLOW.create({
			id: workflowId,
			params: { sourceId, appId },
		});

		await updateContentSourceIngestStatus(db, sourceId, {
			lastIngestStatus: "pending",
			lastError: null,
		});

		return {
			success: true,
			message: `Ingestion workflow started for source ${sourceId}`,
			workflowId,
		};
	});

export const ingestAllProcedure = authedTableOs.ingestAll
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId } = input;

		const app = await getAppForOrg(db, requireOrgId(context), appId);
		if (!app) throw createError(ErrorCodes.NOT_FOUND, "App not found");

		const sources = await listContentSources(db, appId);
		if (sources.length === 0) {
			return {
				success: true,
				message: "No sources to ingest",
				workflowIds: [],
			};
		}

		const workflowIds: string[] = [];
		for (const source of sources) {
			const workflowId = `ingest-${source.id}-${Date.now()}`;
			await env.CONTENT_INGESTION_WORKFLOW.create({
				id: workflowId,
				params: { sourceId: source.id, appId },
			});
			await updateContentSourceIngestStatus(db, source.id, {
				lastIngestStatus: "pending",
				lastError: null,
			});
			workflowIds.push(workflowId);
		}

		return {
			success: true,
			message: `Started ${workflowIds.length} ingestion workflows`,
			workflowIds,
		};
	});

// =============================================================================
// SYNC (Browser Run rendered scrape — reads sources from D1 table)
// =============================================================================

export const syncContentProcedure = authedTableOs.sync
	.use(AUTHZ.appsWrite)
	.handler(async ({ input, context }) => {
		const { db, env } = context;
		const { appId, sourceId, force: _force } = input;

		if (!env.BROWSER) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"BROWSER binding not configured",
			);
		}

		if (!env.CONTENT_CMS_BUCKET) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"CONTENT_CMS_BUCKET not configured",
			);
		}
		if (!env.CONTENT_AI_SEARCH) {
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				"CONTENT_AI_SEARCH binding not configured",
			);
		}

		try {
			const app = await getAppForOrg(db, requireOrgId(context), appId);
			if (!app) {
				throw createError(ErrorCodes.NOT_FOUND, "App not found");
			}

			// Read sources from D1 content_sources table
			let sources = await listContentSources(db, appId);

			// Filter to specific source if requested
			if (sourceId) {
				sources = sources.filter((s) => s.id === sourceId);
			}

			if (sources.length === 0) {
				return {
					success: false,
					appId,
					error: sourceId
						? `No content source found with ID: ${sourceId}`
						: "No content sources configured for this app",
				};
			}

			const results: Array<{
				url: string;
				type: string;
				success: boolean;
				discovered?: number;
				ingested?: number;
				deleted?: number;
				error?: string;
			}> = [];

			for (const source of sources) {
				try {
					const syncResult = await syncContentSource(
						env.BROWSER,
						db,
						env as unknown as ContentIndexEnv,
						appId,
						app.slug,
						app.visibility ?? "private",
						source,
					);

					results.push({
						url: source.sourceUrl,
						type: source.sourceType,
						...syncResult,
					});

					// Update status in D1
					await updateContentSourceIngestStatus(db, source.id, {
						lastIngestStatus: syncResult.success ? "success" : "failed",
						documentCount: syncResult.ingested,
						lastError: syncResult.error ?? null,
					});
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : "Unknown error";
					results.push({
						url: source.sourceUrl,
						type: source.sourceType,
						success: false,
						error: errorMsg,
					});

					await updateContentSourceIngestStatus(db, source.id, {
						lastIngestStatus: "failed",
						lastError: errorMsg,
					});
				}
			}

			const allSuccessful = results.every((r) => r.success);
			const totalIngested = results.reduce(
				(sum, r) => sum + (r.ingested ?? 0),
				0,
			);
			const totalDeleted = results.reduce(
				(sum, r) => sum + (r.deleted ?? 0),
				0,
			);

			return {
				success: allSuccessful,
				appId,
				appName: app.name,
				sourcesProcessed: results.length,
				totalIngested,
				totalDeleted,
				results,
			};
		} catch (error) {
			if (error instanceof Error && "code" in error) {
				throw error;
			}
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				error instanceof Error ? error.message : "Unknown error",
			);
		}
	});

// =============================================================================
// ROUTER ASSEMBLY
// =============================================================================

export const contentContractRouter = contentOs.router({
	answer: answerContentProcedure,
	search: searchContentProcedure,
	ingest: ingestContentProcedure,
	listSources: listSourcesProcedure,
	addSource: addSourceProcedure,
	removeSource: removeSourceProcedure,
	ingestSource: ingestSourceProcedure,
	ingestAll: ingestAllProcedure,
	sync: syncContentProcedure,
});
