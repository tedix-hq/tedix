/**
 * Tedi Secrets Schema
 * Stores encrypted API keys and credentials at the tedi level.
 *
 * Security model:
 * - Master key stored in Cloudflare Secrets Store (env.SECRETS_MASTER_KEY)
 * - Per-tedi encryption keys derived via HKDF from master key + tedi_id
 * - Values encrypted with AES-256-GCM before storage
 * - Only encrypted_value stored in DB, decrypted at runtime
 *
 * Use cases:
 * - GEMINI_API_KEY / GOOGLE_API_KEY — Google Gemini provider key per tedi
 * - OPENAI_API_KEY — Alternative AI provider
 * - TEDI_RUNTIME_ACCESS_TOKEN — Runtime access token (auto-generated on create)
 * - TELEGRAM_BOT_TOKEN — Telegram bot token (if not in channels config)
 */

import {
	index,
	integer,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { tedis } from "./tedis";

export const TEDI_RUNTIME_ACCESS_TOKEN_SECRET_NAME =
	"TEDI_RUNTIME_ACCESS_TOKEN" as const;

export const tediSecrets = sqliteTable(
	"tedi_secrets",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		// Secret identifier (e.g., "GEMINI_API_KEY", "CDP_SECRET")
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
		unique("tedi_secret_unique").on(t.tediId, t.name),
		index("tedi_secrets_tedi_idx").on(t.tediId),
	],
);

export type TediSecret = typeof tediSecrets.$inferSelect;
export type NewTediSecret = typeof tediSecrets.$inferInsert;
