/**
 * Content Sources Schema
 * Tracks external sources that feed into an app's content base (Upstash Search).
 *
 * Each app can have multiple content sources (webpages, sitemaps, RSS feeds, manual entries).
 * Sources are ingested via Firecrawl, chunked, and upserted into Upstash Search namespaced by appId.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";

export const contentSources = sqliteTable(
	"content_sources",
	{
		id: text("id").primaryKey(),

		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),

		/** Source type determines ingestion strategy */
		sourceType: text("source_type", {
			enum: ["webpage", "website", "sitemap", "rss", "manual", "pdf"],
		}).notNull(),

		/** URL to ingest from */
		sourceUrl: text("source_url").notNull(),

		/** Human-readable title for the source */
		title: text("title"),

		/** Last successful ingestion timestamp */
		lastIngestedAt: text("last_ingested_at"),

		/** Current ingestion status */
		lastIngestStatus: text("last_ingest_status", {
			enum: ["pending", "success", "failed", "stale"],
		}).default("pending"),

		/** Number of document chunks stored from this source */
		documentCount: integer("document_count").default(0),

		/** Optional configuration JSON (url patterns, include/exclude paths, max items, etc.) */
		config: text("config", { mode: "json" }).$type<ContentSourceConfigJson>(),

		/** Error message from last failed ingestion */
		lastError: text("last_error"),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_content_sources_app_id").on(table.appId),
		index("idx_content_sources_status").on(table.lastIngestStatus),
	],
);

/**
 * Canonical app-content documents. D1 owns identity and projection state;
 * R2 contains the portable markdown and AI Search is a rebuildable index.
 */
export const contentSourceDocuments = sqliteTable(
	"content_source_documents",
	{
		id: text("id").primaryKey(),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),
		sourceId: text("source_id").references(() => contentSources.id, {
			onDelete: "cascade",
		}),
		canonicalUrl: text("canonical_url").notNull(),
		sourceRevision: text("source_revision").notNull(),
		visibility: text("visibility", {
			enum: ["public", "private", "disabled"],
		}).notNull(),
		objectKey: text("object_key").notNull(),
		digest: text("digest").notNull(),
		title: text("title").notNull(),
		contentType: text("content_type").notNull(),
		aiSearchItemId: text("ai_search_item_id"),
		aiSearchStatus: text("ai_search_status", {
			enum: ["pending", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		aiSearchError: text("ai_search_error"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uq_content_source_documents_app_url").on(
			table.appId,
			table.canonicalUrl,
		),
		uniqueIndex("uq_content_source_documents_app_object").on(
			table.appId,
			table.objectKey,
		),
		index("idx_content_source_documents_source_id").on(table.sourceId),
		index("idx_content_source_documents_projection").on(table.aiSearchStatus),
	],
);

// Types
export interface ContentSourceConfigJson {
	/** URL pattern for link discovery (regex string) */
	urlPattern?: string;
	/** Include only URLs matching these path patterns */
	includePaths?: string[];
	/** Exclude URLs matching these path patterns */
	excludePaths?: string[];
	/** Max items to ingest per batch */
	maxItems?: number;
	/** Explicit one-shot Browser Run engine canary for public sources. */
	browserEngine?: "chromium" | "kitesurf";
}

export type ContentSource = typeof contentSources.$inferSelect;
export type NewContentSource = typeof contentSources.$inferInsert;
export type ContentSourceDocument = typeof contentSourceDocuments.$inferSelect;
export type NewContentSourceDocument =
	typeof contentSourceDocuments.$inferInsert;
