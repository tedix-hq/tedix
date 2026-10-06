/**
 * App Secrets Schema
 * Stores encrypted API keys and credentials at the app level.
 *
 * Security model:
 * - Master key stored in Cloudflare Secrets Store (env.SECRETS_MASTER_KEY)
 * - Per-app encryption keys derived via HKDF from master key + app_id
 * - Values encrypted with AES-256-GCM before storage
 * - Only encrypted_value stored in DB, decrypted at runtime
 *
 * Use cases:
 * - Shopify Storefront API tokens per app
 * - Any third-party API credentials specific to an app
 */

import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { apps } from "./apps";

export const appSecrets = sqliteTable(
	"app_secrets",
	{
		id: text("id").primaryKey(),
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),

		// Secret identifier (e.g., "SHOPIFY_TOKEN", "FIRECRAWL_API_KEY")
		name: text("name").notNull(),

		// Encrypted value: base64(iv[12] + ciphertext + authTag[16])
		encryptedValue: text("encrypted_value").notNull(),

		// Last 4 chars of plaintext for UI display (e.g., "...4bfb")
		hint: text("hint"),

		// Value revision counter — NOT a key version, despite the historic name.
		// `deriveOrgKey`/`deriveAppKey`/`deriveTediKey` in
		// `packages/db/src/utils/secrets-encryption.ts` derive from the row id as
		// HKDF salt plus a STATIC info constant; this column never enters the KDF.
		// It is bumped on every value update. There is no SECRETS_MASTER_KEY
		// rotation path, so do not plan a key rotation around this field.
		keyVersion: integer("key_version").notNull().default(1),

		// Audit trail
		createdBy: text("created_by"), // User ID who created
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(t) => [
		// Unique constraint: one secret name per app
		unique("app_secret_unique").on(t.appId, t.name),
		// Index for fast lookups by app
		index("app_secrets_app_idx").on(t.appId),
	],
);

// Types
export type AppSecret = typeof appSecrets.$inferSelect;
export type NewAppSecret = typeof appSecrets.$inferInsert;
