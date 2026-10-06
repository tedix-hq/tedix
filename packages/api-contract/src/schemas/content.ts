/**
 * Content Zod Schemas for oRPC Contracts
 * Validation schemas for content management endpoints
 */

import * as z from "zod";

// =============================================================================
// CONTENT CATEGORIES
// =============================================================================

/**
 * Valid categories for content
 */
export const CONTENT_CATEGORIES = [
	"blog",
	"docs",
	"guide",
	"faq",
	"news",
	"product",
] as const;

export const ContentCategorySchema = z.enum(CONTENT_CATEGORIES);
export type ContentCategory = z.infer<typeof ContentCategorySchema>;

// =============================================================================
// CONTENT SEARCH SCHEMAS
// =============================================================================

/**
 * Content search result item schema
 */
export const ContentSearchResultSchema = z.object({
	url: z.string(),
	title: z.string(),
	snippet: z.string(),
	score: z.number(),
	thumbnail: z.string().optional(),
	category: z.string().optional(),
	publishedAt: z.string().optional(),
	author: z.string().optional(),
});
export type ContentSearchResult = z.infer<typeof ContentSearchResultSchema>;

// =============================================================================
// CONTENT SYNC SCHEMAS
// =============================================================================

/**
 * Content sync result for a single source
 */
export const ContentSyncResultSchema = z.object({
	url: z.string(),
	type: z.string(),
	success: z.boolean(),
	discovered: z.number().optional(),
	ingested: z.number().optional(),
	deleted: z.number().optional(),
	error: z.string().optional(),
});
export type ContentSyncResult = z.infer<typeof ContentSyncResultSchema>;

// =============================================================================
// CONTENT DOCUMENT SCHEMAS
// =============================================================================

/**
 * Ingested content document summary
 */
export const ContentDocumentSummarySchema = z.object({
	id: z.string(),
	title: z.string(),
	url: z.string(),
	excerpt: z.string().optional(),
});
export type ContentDocumentSummary = z.infer<
	typeof ContentDocumentSummarySchema
>;
