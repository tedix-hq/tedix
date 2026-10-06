/**
 * Organization Secrets Schema
 * Stores encrypted customer API keys and credentials with per-org isolation.
 *
 * Security model:
 * - Master key stored in Cloudflare Secrets Store (env.SECRETS_MASTER_KEY)
 * - Per-org encryption keys derived via HKDF from master key + org_id
 * - Values encrypted with AES-256-GCM before storage
 * - Only encrypted_value stored in DB, decrypted at runtime
 */

import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const organizationSecrets = sqliteTable(
	"organization_secrets",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// Secret identifier (e.g., "shopify_token", "firecrawl_api_key")
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
		// Unique constraint: one secret name per organization
		unique("org_secret_unique").on(t.organizationId, t.name),
		// Index for fast lookups by org
		index("org_secrets_org_idx").on(t.organizationId),
	],
);

// Types
export type OrganizationSecret = typeof organizationSecrets.$inferSelect;
export type NewOrganizationSecret = typeof organizationSecrets.$inferInsert;
