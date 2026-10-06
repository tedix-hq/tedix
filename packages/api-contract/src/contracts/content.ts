import "@orpc/openapi/extensions/route";
/**
 * Content Contract for oRPC
 * Type-safe API contract for Content Library endpoints
 *
 * Endpoints for managing the Cloudflare AI Search content library:
 * - search - Search content library with hybrid semantic search
 * - answer - Search + AI answer generation
 * - ingest - Ingest content from URL
 * - listSources - List content sources for an app (D1 table)
 * - addSource - Add a content source (D1 table)
 * - removeSource - Remove a content source (D1 table)
 * - ingestSource - Trigger ingestion for a single source
 * - ingestAll - Re-ingest all sources for an app
 * - sync - Sync all configured content sources (Firecrawl crawl)
 *
 * Supported source types:
 * - webpage: Single page scrape
 * - sitemap: Discovers pages via sitemap.xml parsing
 * - rss: Discovers articles via RSS/Atom feed
 * - manual: Direct URL ingestion
 *
 * All routes require appId (UUID) for multi-tenant namespace isolation.
 * Uses Firecrawl for scraping, R2 storage, and Cloudflare AI Search.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { JsonValueSchema } from "../schemas/common";
import {
	ContentDocumentSummarySchema,
	ContentSearchResultSchema,
	ContentSyncResultSchema,
} from "../schemas/content";

// =============================================================================
// Schemas
// =============================================================================

const ContentSourceSchema = z.object({
	id: z.string(),
	appId: z.string(),
	sourceType: z.enum(["webpage", "website", "sitemap", "rss", "manual", "pdf"]),
	sourceUrl: z.string(),
	title: z.string().nullable(),
	lastIngestedAt: z.string().nullable(),
	lastIngestStatus: z
		.enum(["pending", "success", "failed", "stale"])
		.nullable(),
	documentCount: z.number().nullable(),
	config: z.record(z.string(), JsonValueSchema).nullable(),
	lastError: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
});

/**
 * Binary formats accepted by the app-owned AI Search projection boundary.
 *
 * This is intentionally not an HTTP upload contract: canonical content and
 * tenant authorization remain owned by the calling product surface, which
 * passes verified bytes to the projection after storing their provenance.
 */
export const ContentNativeMediaTypeSchema = z.enum([
	"application/pdf",
	"image/bmp",
	"image/gif",
	"image/heic",
	"image/heif",
	"image/jpeg",
	"image/png",
	"image/svg+xml",
	"image/tiff",
	"image/webp",
]);

export type ContentNativeMediaType = z.infer<
	typeof ContentNativeMediaTypeSchema
>;

/**
 * Content Contract - defines the shape of all content-related endpoints
 *
 * @example Using the contract for client-side type inference:
 * ```typescript
 * import { contentContract } from '@tedix/api-contract/contracts/content';
 * import type { z } from 'zod';
 *
 * // Get input/output types from contract
 * type SearchInput = z.infer<typeof contentContract.search.InputSchema>;
 * type SearchOutput = z.infer<typeof contentContract.search.OutputSchema>;
 * ```
 */
export const contentContract = oc
	.route({ tags: ["content"], prefix: "/content" })
	.router({
		/**
		 * POST /content/apps/{appId}/answer - Search + AI answer generation
		 *
		 * Composite endpoint: searches the content library and generates an
		 * AI-synthesized answer from the results using Workers AI.
		 * AI config is read from the app's contentConfig in D1 metadata,
		 * with optional per-request overrides.
		 */
		answer: oc
			.route({
				method: "POST",
				path: "/apps/{appId}/answer",
				summary: "Search content and generate AI answer",
				description:
					"Searches the app content library and generates an AI-synthesized answer from the results. AI behavior is configurable per-app via contentConfig in app metadata.",
			})
			.input(
				z.object({
					appId: z.uuid("appId must be a valid UUID"),
					query: z.string().min(1, "Search query is required").max(500),
					limit: z.coerce.number().min(1).max(50).default(8),
					category: z.string().optional(),
					/** Override: Workers AI model ID */
					aiModel: z.string().optional(),
					/** Override: generation temperature */
					temperature: z.number().min(0).max(2).optional(),
					/** Override: max tokens for AI response */
					maxTokens: z.number().min(50).max(4000).optional(),
					/** Override: custom system prompt */
					systemPrompt: z.string().max(2000).optional(),
					/** Set false to skip AI answer and return raw sources only */
					generateAnswer: z.boolean().default(true),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					query: z.string(),
					answer: z.string().optional(),
					sources: z.array(ContentSearchResultSchema),
					total: z.number(),
					model: z.string().optional(),
					error: z.string().optional(),
				}),
			),

		/**
		 * GET /content/apps/{appId}/search - Search content library
		 */
		search: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/search",
				summary: "Search content library",
				description:
					"Search the app content library with hybrid semantic search for an app",
			})
			.input(
				z.object({
					appId: z.uuid("appId must be a valid UUID"),
					q: z.string().min(1, "Search query is required").max(500),
					limit: z.coerce.number().min(1).max(50).default(8),
					category: z.string().optional(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					sources: z.array(ContentSearchResultSchema),
					query: z.string(),
					total: z.number(),
					error: z.string().optional(),
				}),
			),

		/**
		 * POST /content/apps/{appId}/ingest - Ingest content from URL
		 */
		ingest: oc
			.route({
				method: "POST",
				path: "/apps/{appId}/ingest",
				summary: "Ingest content from URL",
				description:
					"Ingest content from a URL into the content library for an app",
			})
			.input(
				z.object({
					appId: z.uuid("appId must be a valid UUID"),
					url: z.url("url must be a valid URL"),
					category: z.string().optional(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					message: z.string().optional(),
					document: ContentDocumentSummarySchema.optional(),
					error: z.string().optional(),
				}),
			),

		// =================================================================
		// Content Source Management (D1 content_sources table)
		// =================================================================

		/** GET /content/apps/{appId}/sources — list sources */
		listSources: oc
			.route({
				method: "GET",
				path: "/apps/{appId}/sources",
				summary: "List content sources",
				description: "List all content sources for an app",
			})
			.input(
				z.object({
					appId: z.uuid(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					sources: z.array(ContentSourceSchema),
				}),
			),

		/** POST /content/apps/{appId}/sources — add a source */
		addSource: oc
			.route({
				method: "POST",
				path: "/apps/{appId}/sources",
				summary: "Add a content source",
				description: "Add a new content source to an app",
			})
			.input(
				z.object({
					appId: z.uuid(),
					sourceType: z.enum([
						"webpage",
						"website",
						"sitemap",
						"rss",
						"manual",
						"pdf",
					]),
					sourceUrl: z.url(),
					title: z.string().optional(),
					config: z
						.object({
							urlPattern: z.string().optional(),
							includePaths: z.array(z.string()).optional(),
							excludePaths: z.array(z.string()).optional(),
							maxItems: z.number().min(1).max(1000).optional(),
							browserEngine: z
								.enum(["chromium", "kitesurf"])
								.optional()
								.describe(
									"Explicit browser-engine canary selection. Kitesurf is eligible only for public external sources and falls back to Chromium once.",
								),
						})
						.optional(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					source: ContentSourceSchema,
				}),
			),

		/** DELETE /content/apps/{appId}/sources/{sourceId} — remove a source */
		removeSource: oc
			.route({
				method: "DELETE",
				path: "/apps/{appId}/sources/{sourceId}",
				summary: "Remove a content source",
				description: "Remove a content source from an app",
			})
			.input(
				z.object({
					appId: z.uuid(),
					sourceId: z.string(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
				}),
			),

		/** POST /content/apps/{appId}/sources/{sourceId}/ingest — trigger ingestion */
		ingestSource: oc
			.route({
				method: "POST",
				path: "/apps/{appId}/sources/{sourceId}/ingest",
				summary: "Trigger ingestion for a single content source",
			})
			.input(
				z.object({
					appId: z.uuid(),
					sourceId: z.string(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					message: z.string().optional(),
					workflowId: z.string().optional(),
				}),
			),

		/** POST /content/apps/{appId}/ingest-all — re-ingest all sources */
		ingestAll: oc
			.route({
				method: "POST",
				path: "/apps/{appId}/ingest-all",
				summary: "Re-ingest all content sources for an app",
			})
			.input(
				z.object({
					appId: z.uuid(),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					message: z.string().optional(),
					workflowIds: z.array(z.string()).optional(),
				}),
			),

		/**
		 * POST /content/apps/{appId}/sync - Sync content sources via Firecrawl crawl
		 *
		 * For sources that need external crawling (blog discovery, sitemap parsing).
		 * Uses Firecrawl to discover URLs and scrape content for R2 + AI Search.
		 */
		sync: oc
			.route({
				method: "POST",
				path: "/apps/{appId}/sync",
				summary: "Sync content sources via crawl",
				description:
					"Crawl and sync content sources for an app using Firecrawl",
			})
			.input(
				z.object({
					appId: z.uuid("appId must be a valid UUID"),
					sourceId: z.string().optional(),
					force: z.coerce.boolean().optional().default(false),
				}),
			)
			.output(
				z.object({
					success: z.boolean(),
					appId: z.string(),
					appName: z.string().optional(),
					sourcesProcessed: z.number().optional(),
					totalIngested: z.number().optional(),
					totalDeleted: z.number().optional(),
					results: z.array(ContentSyncResultSchema).optional(),
					error: z.string().optional(),
				}),
			),
	});

export type ContentContract = typeof contentContract;

// Re-export schemas for convenience
export {
	type ContentCategory,
	ContentCategorySchema,
	type ContentDocumentSummary,
	ContentDocumentSummarySchema,
	type ContentSearchResult,
	ContentSearchResultSchema,
	type ContentSyncResult,
	ContentSyncResultSchema,
} from "../schemas/content";
