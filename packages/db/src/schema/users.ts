/**
 * Users Schema
 * Canonical Tedix users with provider profile data cached through mappings.
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

// ============================================================================
// Users Table
// ============================================================================

export const users = sqliteTable(
	"users",
	{
		// Stable Tedix id. Never assign a new provider subject here.
		id: text("id").primaryKey(),

		// Core profile fields
		email: text("email").notNull(),
		name: text("name"),
		avatarUrl: text("avatar_url"),
		profileRevision: integer("profile_revision").notNull().default(1),

		// Raw Descope metadata (optional)
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		// Activity tracking
		lastLoginAt: text("last_login_at"),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		unique("uniq_users_email").on(table.email),
		index("idx_users_email").on(table.email),
		index("idx_users_last_login").on(table.lastLoginAt),
	],
);

// ============================================================================
// Inferred Types
// ============================================================================

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
