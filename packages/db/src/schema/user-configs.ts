/**
 * User Configs Schema
 * Generic per-user configuration store for UI and operator personalizations.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { uuid4Default } from "./_sql-helpers";

export const userConfigs = sqliteTable(
	"user_configs",
	{
		id: text("id").primaryKey().default(uuid4Default()),
		userId: text("user_id").notNull(),
		namespace: text("namespace").notNull(),
		key: text("key").notNull(),
		value: text("value", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		/**
		 * Monotonic write counter for optimistic concurrency. `updated_at` is a
		 * timestamp, not a counter, so it cannot carry the repo's
		 * `expectedRevision` compare-and-swap idiom (two writes in the same
		 * second are indistinguishable). Every successful write bumps this by 1;
		 * the first write lands at 1, so `0` unambiguously means "no stored row"
		 * to a compare-and-swap caller.
		 */
		revision: integer("revision").notNull().default(0),
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_user_configs_user_namespace_key").on(
			table.userId,
			table.namespace,
			table.key,
		),
		index("idx_user_configs_user").on(table.userId),
		index("idx_user_configs_namespace").on(table.namespace),
	],
);

export type UserConfig = typeof userConfigs.$inferSelect;
export type NewUserConfig = typeof userConfigs.$inferInsert;
