import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { uuid4Default } from "./_sql-helpers";
import { apps } from "./apps";

export const APP_CONFIG_VERSION_STATUS_VALUES = [
	"draft",
	"published",
	"archived",
] as const;

export type AppConfigVersionStatus =
	(typeof APP_CONFIG_VERSION_STATUS_VALUES)[number];

export const appConfigVersions = sqliteTable(
	"app_config_versions",
	{
		id: text("id").primaryKey().default(uuid4Default()),

		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),

		version: integer("version").notNull(),
		status: text("status", { enum: APP_CONFIG_VERSION_STATUS_VALUES })
			.notNull()
			.default("draft"),

		config: text("config", { mode: "json" }).$type<JsonValue>().notNull(),
		changeSummary: text("change_summary"),

		publishedAt: text("published_at"),
		publishedBy: text("published_by"),
		activatedAt: text("activated_at"),
		activatedBy: text("activated_by"),

		createdBy: text("created_by"),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_app_config_versions_app_version").on(
			table.appId,
			table.version,
		),
		index("idx_app_config_versions_app").on(table.appId),
		index("idx_app_config_versions_status").on(table.status),
	],
);

export type AppConfigVersion = typeof appConfigVersions.$inferSelect;
export type NewAppConfigVersion = typeof appConfigVersions.$inferInsert;
