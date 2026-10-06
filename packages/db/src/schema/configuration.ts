/**
 * Configuration Schema
 * Database-driven configuration tables for MCP server flexibility
 */

import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { uuid4Default } from "./_sql-helpers";
import { appTools } from "./tools";

// ============================================
// App Tool CSP Domains Table
// Stores CSP domains per tool (resource-level CSP)
// ============================================
export const appToolCspDomains = sqliteTable("app_tool_csp_domains", {
	id: text("id").primaryKey().default(uuid4Default()),

	appToolId: text("app_tool_id")
		.notNull()
		.references(() => appTools.id, { onDelete: "cascade" }),

	// Domain configuration
	domainType: text("domain_type").notNull(), // 'connect', 'resource', 'frame', 'redirect'
	domainUrl: text("domain_url").notNull(), // e.g., 'https://owp.klarna.com'

	// Status
	active: integer("active", { mode: "boolean" }).default(true),

	// Timestamps
	createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
});

export type AppToolCspDomain = typeof appToolCspDomains.$inferSelect;
export type NewAppToolCspDomain = typeof appToolCspDomains.$inferInsert;
