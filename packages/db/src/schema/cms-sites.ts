import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";
import { organizations } from "./organizations";

export interface CmsSiteConfig {
	branding?: Record<string, JsonValue>;
	socialLinks?: Record<string, JsonValue>;
	seo?: Record<string, JsonValue>;
	analytics?: Record<string, JsonValue>;
	blog?: Record<string, JsonValue>;
}

/**
 * Durable Emdash site identity. CMS sites are not MCP apps: optional MCP app
 * references describe their branded/search and authoring surfaces, while this
 * row owns routing, storage, runtime configuration, and lifecycle.
 */
export const cmsSites = sqliteTable(
	"cms_sites",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status", { enum: ["active", "paused", "provisioning"] })
			.notNull()
			.default("active"),
		restoreEpoch: integer("restore_epoch").notNull().default(0),
		canonicalUrl: text("canonical_url").notNull(),
		customDomain: text("custom_domain").unique(),
		publicPathPrefix: text("public_path_prefix"),
		templateSlug: text("template_slug").notNull().default("tedix"),
		config: text("config", { mode: "json" }).$type<CmsSiteConfig>(),
		mcpAppId: text("mcp_app_id").references(() => apps.id, {
			onDelete: "set null",
		}),
		authoringAppId: text("authoring_app_id").references(() => apps.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("cms_sites_slug_unique").on(table.slug),
		index("cms_sites_org_idx").on(table.organizationId),
		index("cms_sites_status_idx").on(table.status),
		index("cms_sites_mcp_app_idx").on(table.mcpAppId),
		index("cms_sites_authoring_app_idx").on(table.authoringAppId),
	],
);

export type CmsSite = typeof cmsSites.$inferSelect;
export type NewCmsSite = typeof cmsSites.$inferInsert;
