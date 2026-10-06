/**
 * App Adapter Secret Bindings Schema
 *
 * Explicit bindings between adapter config paths and encrypted secrets.
 * Replaces magic name-based secret injection with explicit, queryable bindings.
 *
 * Design:
 * - One binding per config path (no multi-secret fields)
 * - Supports both app_secrets and organization_secrets via discriminated union
 * - Config paths use dot notation (e.g., "apiKey", "auth.token", "auth.oauth2.clientId")
 * - Required bindings are schema-driven per adapter type (validated via ADAPTER_TYPE_SPECS)
 *
 * Example bindings:
 * - adapterId: "klarna-de", configPath: "apiKey", secretId: "app-secret-123", secretScope: "app"
 * - adapterId: "shopify-1", configPath: "storefrontToken", secretId: "org-secret-456", secretScope: "organization"
 * - adapterId: "custom-api", configPath: "auth.oauth2.clientSecret", secretId: "app-secret-789", secretScope: "app"
 *
 * @module @tedix/db/schema/app-adapter-secret-bindings
 */

import { sql } from "drizzle-orm";
import { index, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { appAdapters } from "./adapters";
import { apps } from "./apps";

/**
 * Secret scope discriminator
 * Determines which secrets table the binding references
 */
export type SecretScope = "app" | "organization";

export const SECRET_SCOPES = ["app", "organization"] as const;

export const appAdapterSecretBindings = sqliteTable(
	"app_adapter_secret_bindings",
	{
		id: text("id").primaryKey(),

		// Adapter this binding belongs to
		adapterId: text("adapter_id")
			.notNull()
			.references(() => appAdapters.id, { onDelete: "cascade" }),

		// App ID (denormalized for efficient queries)
		// Also enables cascade delete when app is deleted
		appId: text("app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "cascade" }),

		// Config path in dot notation (e.g., "apiKey", "auth.token", "auth.oauth2.clientId")
		// Corresponds to a field in the adapter's config object
		configPath: text("config_path").notNull(),

		// Secret reference (discriminated union)
		secretId: text("secret_id").notNull(), // References app_secrets.id OR organization_secrets.id
		secretScope: text("secret_scope", {
			enum: ["app", "organization"],
		})
			.notNull()
			.$type<SecretScope>(),

		// Audit trail
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// One binding per config path per adapter
		unique("adapter_binding_unique").on(table.adapterId, table.configPath),
		// Fast lookups by adapter
		index("idx_adapter_bindings_adapter").on(table.adapterId),
		// Fast lookups by app (for cross-adapter queries)
		index("idx_adapter_bindings_app").on(table.appId),
		// Fast lookups by secret (for finding affected adapters when secret changes)
		index("idx_adapter_bindings_secret").on(table.secretId, table.secretScope),
	],
);

// =============================================================================
// TYPES
// =============================================================================

export type AppAdapterSecretBinding =
	typeof appAdapterSecretBindings.$inferSelect;
export type NewAppAdapterSecretBinding =
	typeof appAdapterSecretBindings.$inferInsert;

/**
 * Binding with hydrated secret value (for runtime use)
 * Returned by getBindingsWithSecrets()
 */
export interface HydratedBinding {
	id: string;
	adapterId: string;
	appId: string;
	configPath: string;
	secretId: string;
	secretScope: SecretScope;
	/** Decrypted secret value (only available in trusted contexts) */
	decryptedValue: string | null;
	/** Secret name for debugging/logging */
	secretName: string | null;
	createdAt: string;
	updatedAt: string;
}

/**
 * Safe binding metadata (for dashboard display)
 * Excludes decrypted values
 */
export interface SafeBindingMetadata {
	id: string;
	adapterId: string;
	appId: string;
	configPath: string;
	secretId: string;
	secretScope: SecretScope;
	secretName: string | null;
	secretHint: string | null;
	createdAt: string;
	updatedAt: string;
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard to check if binding references app secret
 */
export function isAppSecretBinding(
	binding: AppAdapterSecretBinding | HydratedBinding | SafeBindingMetadata,
): boolean {
	return binding.secretScope === "app";
}

/**
 * Type guard to check if binding references organization secret
 */
export function isOrgSecretBinding(
	binding: AppAdapterSecretBinding | HydratedBinding | SafeBindingMetadata,
): boolean {
	return binding.secretScope === "organization";
}
