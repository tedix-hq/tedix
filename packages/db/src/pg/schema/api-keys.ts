import type { ApiKeyMetadata, ApiKeyScope } from "../../schema/api-keys";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/** Hashed organization credentials and the rotation state revoked by retirement. */
export const apiKeys = pgTable(
	"api_keys",
	{
		id: text("id").primaryKey(),

		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		name: text("name").notNull(),
		description: text("description"),
		purpose: text("purpose", { enum: ["general", "external_agent_bootstrap"] })
			.notNull()
			.default("general"),

		keyHash: text("key_hash").notNull().unique(),
		keyPreview: text("key_preview").notNull(),

		scopes: jsonb("scopes").$type<ApiKeyScope[]>(),

		environment: text("environment", {
			enum: ["test", "live"],
		}).default("test"),

		lastUsedAt: text("last_used_at"),
		requestsThisMonth: integer("requests_this_month").default(0),
		totalRequests: integer("total_requests").default(0),

		ipAllowlist: jsonb("ip_allowlist").$type<string[]>(),
		expiresAt: text("expires_at"),

		rateLimit: integer("rate_limit"),

		status: text("status", {
			enum: ["active", "revoked", "expired"],
		}).default("active"),

		rotatedAt: text("rotated_at"),
		rotationScheduleDays: integer("rotation_schedule_days"),
		previousKeyHash: text("previous_key_hash"),
		previousKeyExpiresAt: text("previous_key_expires_at"),

		revokedAt: text("revoked_at"),
		revokedBy: text("revoked_by"),
		revokeReason: text("revoke_reason"),

		metadata: jsonb("metadata").$type<ApiKeyMetadata>(),

		createdBy: text("created_by"),
		createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		index("idx_api_key_org").on(table.organizationId),
		index("idx_api_key_status").on(table.status),
		index("idx_api_key_env").on(table.environment),
		index("idx_api_key_hash").on(table.keyHash),
	],
);
