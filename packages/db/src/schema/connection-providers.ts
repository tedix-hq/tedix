/**
 * Connection Providers Schema
 *
 * Pre-built OAuth/api_key connection provider templates (Google Gmail, GitHub,
 * Slack, ...) that decorate live Descope outbound apps with display metadata,
 * scope defaults, and credential templates. Descope is the source of truth for
 * what's actually registered/connected; this table only supplies defaults for
 * provider ids it recognizes (see apps/api/src/rpc/routers/connections/).
 *
 * Canonical provider registry for connection discovery and credential profiles.
 */

import type { AgentRequestProposal } from "@tedix/api-contract/schemas/agent-requests";
import type { ConnectionProviderDcrExceptionRecord } from "@tedix/api-contract/schemas/connections";
import type {
	ConnectionCredentialProfile,
	ConnectionProviderCategory,
	ConnectionProviderOAuthConfig,
	TokenScope,
} from "@tedix/api-contract/schemas/connection-provider-templates";
import { organizations } from "./organizations";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const connectionProviders = sqliteTable(
	"connection_providers",
	{
		id: text("id").primaryKey(),

		defaultDataSensitivity: text("default_data_sensitivity")
			.$type<AgentRequestProposal["dataSensitivity"]>()
			.notNull()
			.default("confidential"),
		name: text("name").notNull(),
		description: text("description").notNull(),
		icon: text("icon").notNull(),
		category: text("category").notNull().$type<ConnectionProviderCategory>(),
		type: text("type", { enum: ["oauth", "api_key"] }).notNull(),

		// Descope outbound app id this template decorates, once registered.
		// Nullable (unregistered template); unique when present.
		descopeAppId: text("descope_app_id"),
		// Additional Descope outbound app ids that reuse this provider definition.
		descopeAppAliases: text("descope_app_aliases", { mode: "json" }).$type<
			string[]
		>(),

		// Preserves the original array's ordering / "first match wins" semantics.
		sortOrder: integer("sort_order").notNull().default(0),

		recommendedScope: text("recommended_scope").notNull().$type<TokenScope>(),
		supportedScopes: text("supported_scopes", { mode: "json" })
			.notNull()
			.$type<TokenScope[]>(),
		requiredScopes: text("required_scopes", { mode: "json" })
			.notNull()
			.$type<string[]>(),

		credentialProfile: text("credential_profile", {
			mode: "json",
		}).$type<ConnectionCredentialProfile>(),
		oauthConfig: text("oauth_config", {
			mode: "json",
		}).$type<ConnectionProviderOAuthConfig>(),

		// --- Issuer pinning (ADR decisions/tedi-client-oauth-cimd.md, phase 1a) ---
		// The RFC 8414-validated authorization-server issuer recorded on first
		// successful MCP OAuth discovery. Later discovery producing a different
		// issuer refuses fail-closed instead of silently re-provisioning (the MCP
		// draft spec's authorization-server-binding rule). NULL = legacy row /
		// never discovered; behaves exactly as before pinning existed.
		pinnedIssuer: text("pinned_issuer"),
		// RFC 9207: whether that issuer's AS metadata advertised
		// `authorization_response_iss_parameter_supported: true` at pin time.
		// 1/0 boolean; NULL = unknown (legacy row). Consumed by
		// `assertAuthorizationResponseIss` call sites so the strict absent-iss
		// branch strengthens automatically once persisted.
		authorizationResponseIssSupported: integer(
			"authorization_response_iss_supported",
			{ mode: "boolean" },
		),

		// How Tedix obtained the upstream OAuth client for this provider. NULL =
		// legacy row, not recorded. A useDcr:false outbound app can still hold a
		// dynamically registered client ("dcr_direct"), so this, not the Descope
		// app shape, is the registration record.
		registrationProvenance: text("registration_provenance", {
			enum: ["cimd", "dcr_managed", "dcr_direct", "pre_registered"],
		}),
		// Why Dynamic Client Registration was allowed and when to review it.
		// Required whenever registrationProvenance is a DCR value.
		dcrException: text("dcr_exception", {
			mode: "json",
		}).$type<ConnectionProviderDcrExceptionRecord>(),

		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("connection_providers_descope_app_id_unique").on(
			table.descopeAppId,
		),
		index("connection_providers_category_idx").on(table.category),
		index("connection_providers_type_idx").on(table.type),
	],
);

export type ConnectionProviderRow = typeof connectionProviders.$inferSelect;
export type NewConnectionProviderRow = typeof connectionProviders.$inferInsert;

/** Ownership of live Descope outbound apps; absent legacy apps remain platform-only. */
export const connectionProviderOwnership = sqliteTable(
	"connection_provider_ownership",
	{
		appId: text("app_id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("connection_provider_ownership_org_idx").on(table.organizationId),
	],
);

/** Organization policy for how many accounts an owner may add for a provider. */
export const connectionProviderSettings = sqliteTable(
	"connection_provider_settings",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		providerId: text("provider_id").notNull(),
		accountMode: text("account_mode", {
			enum: ["single", "multiple"],
		}).notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.providerId] }),
	],
);

export type ConnectionProviderSettingRow =
	typeof connectionProviderSettings.$inferSelect;
