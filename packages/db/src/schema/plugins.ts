/**
 * Plugins Schema
 * Plugin system for extending tedi capabilities
 *
 * Plugin types:
 * - mcp_server: External MCP servers tedis connect to as clients
 * - tool: Pre-built tool packages running inside tedi sandbox
 * - channel: Custom messaging surfaces (webhook-based)
 * - workflow: Multi-step automations with durable execution
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

// =============================================================================
// ENUMS
// =============================================================================

export const PLUGIN_TYPE_VALUES = [
	"mcp_server",
	"tool",
	"channel",
	"workflow",
] as const;
export type PluginType = (typeof PLUGIN_TYPE_VALUES)[number];

export const PLUGIN_STATUS_VALUES = [
	"draft",
	"published",
	"suspended",
] as const;
export type PluginStatus = (typeof PLUGIN_STATUS_VALUES)[number];

export const PLUGIN_INSTALL_STATUS_VALUES = [
	"installed",
	"active",
	"disabled",
	"error",
] as const;
export type PluginInstallStatus = (typeof PLUGIN_INSTALL_STATUS_VALUES)[number];

export const PLUGIN_EVENT_STATUS_VALUES = [
	"pending",
	"processing",
	"completed",
	"failed",
] as const;
export type PluginEventStatus = (typeof PLUGIN_EVENT_STATUS_VALUES)[number];

// =============================================================================
// TEDI PLUGINS TABLE (marketplace registry)
// =============================================================================

export const tediPlugins = sqliteTable(
	"tedi_plugins",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull().unique(),
		name: text("name").notNull(),
		description: text("description"),
		type: text("type", { enum: [...PLUGIN_TYPE_VALUES] }).notNull(),
		version: text("version").notNull(), // semver
		manifest: text("manifest", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(), // Full PluginManifest JSON
		status: text("status", { enum: [...PLUGIN_STATUS_VALUES] }).default(
			"draft",
		),
		authorOrgId: text("author_org_id").references(() => organizations.id, {
			onDelete: "set null",
		}),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_plugins_type").on(table.type),
		index("idx_plugins_status").on(table.status),
		index("idx_plugins_author").on(table.authorOrgId),
	],
);

export type TediPlugin = typeof tediPlugins.$inferSelect;
export type NewTediPlugin = typeof tediPlugins.$inferInsert;

// =============================================================================
// TEDI PLUGIN INSTALLS TABLE (per-org/tedi installations)
// =============================================================================

export const tediPluginInstalls = sqliteTable(
	"tedi_plugin_installs",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		pluginId: text("plugin_id")
			.notNull()
			.references(() => tediPlugins.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		config: text("config", { mode: "json" }).$type<Record<string, JsonValue>>(), // encrypted JSON
		permissionsGranted: text("permissions_granted", { mode: "json" }).$type<
			string[]
		>(), // approved permissions
		status: text("status", {
			enum: [...PLUGIN_INSTALL_STATUS_VALUES],
		}).default("installed"),
		installedAt: text("installed_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_plugin_installs_org").on(table.orgId),
		index("idx_plugin_installs_plugin").on(table.pluginId),
		index("idx_plugin_installs_tedi").on(table.tediId),
		index("idx_plugin_installs_status").on(table.status),
	],
);

export type TediPluginInstall = typeof tediPluginInstalls.$inferSelect;
export type NewTediPluginInstall = typeof tediPluginInstalls.$inferInsert;

// =============================================================================
// TEDI PLUGIN EVENTS TABLE (event log for plugin processing)
// =============================================================================

export const tediPluginEvents = sqliteTable(
	"tedi_plugin_events",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		pluginId: text("plugin_id")
			.notNull()
			.references(() => tediPlugins.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		eventType: text("event_type").notNull(),
		payload: text("payload", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		status: text("status", {
			enum: [...PLUGIN_EVENT_STATUS_VALUES],
		}).default("pending"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		processedAt: text("processed_at"),
	},
	(table) => [
		index("idx_plugin_events_org").on(table.orgId),
		index("idx_plugin_events_plugin").on(table.pluginId),
		index("idx_plugin_events_tedi").on(table.tediId),
		index("idx_plugin_events_status").on(table.status),
		index("idx_plugin_events_type").on(table.eventType),
	],
);

export type TediPluginEvent = typeof tediPluginEvents.$inferSelect;
export type NewTediPluginEvent = typeof tediPluginEvents.$inferInsert;
