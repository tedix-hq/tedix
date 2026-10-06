import type { EmbeddedContactAttributes } from "@tedix/api-contract/schemas/embedded-contact";
import { sql } from "drizzle-orm";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { apiKeys } from "./api-keys";
import { apps } from "./apps";
import { organizations } from "./organizations";
import { osWorkspaces } from "./os-workspaces";
import { tedis } from "./tedis";

/**
 * Authoritative provider-to-customer installation boundary for embedded tedis.
 *
 * The browser never selects the target organization or tedi. A provider API
 * key plus its external tenant id resolves this row; the row owns the target,
 * allowed origin, and forced host-tenant tool constraint.
 */
export const providerInstallations = sqliteTable(
	"provider_installations",
	{
		id: text("id").primaryKey(),
		providerOrganizationId: text("provider_organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "restrict" }),
		providerAppId: text("provider_app_id")
			.notNull()
			.references(() => apps.id, { onDelete: "restrict" }),
		providerApiKeyId: text("provider_api_key_id")
			.notNull()
			.references(() => apiKeys.id, { onDelete: "restrict" }),
		externalTenantId: text("external_tenant_id").notNull(),
		customerOrganizationId: text("customer_organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "restrict" }),
		primaryWorkspaceId: text("primary_workspace_id")
			.notNull()
			.references(() => osWorkspaces.id, { onDelete: "restrict" }),
		primaryTediId: text("primary_tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "restrict" }),
		allowedOrigin: text("allowed_origin").notNull(),
		hostTenantArgument: text("host_tenant_argument").notNull(),
		hostTenantNamespace: text("host_tenant_namespace").notNull(),
		status: text("status", { enum: ["active", "paused"] })
			.notNull()
			.default("active"),
		provisionedBy: text("provisioned_by").notNull(),
		companyProfile: text("company_profile", { mode: "json" }).$type<{
			name: string | null;
			customAttributes: EmbeddedContactAttributes;
			firstSeenAt: string;
			lastSeenAt: string;
			revision: number;
		}>(),
		provenance: text("provenance", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`),
		pausedAt: text("paused_at"),
	},
	(table) => [
		uniqueIndex("uniq_provider_installation_tenant").on(
			table.providerOrganizationId,
			table.providerAppId,
			table.externalTenantId,
		),
		uniqueIndex("uniq_provider_installation_credential_tenant").on(
			table.providerApiKeyId,
			table.externalTenantId,
		),
		index("idx_provider_installation_customer").on(
			table.customerOrganizationId,
		),
		index("idx_provider_installation_tedi").on(table.primaryTediId),
		check(
			"provider_installation_status_check",
			sql`${table.status} IN ('active', 'paused')`,
		),
		check(
			"provider_installation_pause_check",
			sql`(${table.status} = 'active' AND ${table.pausedAt} IS NULL) OR (${table.status} = 'paused' AND ${table.pausedAt} IS NOT NULL)`,
		),
	],
);

export type ProviderInstallation = typeof providerInstallations.$inferSelect;
export type NewProviderInstallation = typeof providerInstallations.$inferInsert;

/** Host identities are scoped to installations; these are not Tedix login users. */
export const embeddedContactUsers = sqliteTable(
	"embedded_contact_users",
	{
		installationId: text("installation_id")
			.notNull()
			.references(() => providerInstallations.id, { onDelete: "cascade" }),
		hostUserId: text("host_user_id").notNull(),
		name: text("name"),
		email: text("email"),
		role: text("role"),
		customAttributes: text("custom_attributes", { mode: "json" })
			.$type<EmbeddedContactAttributes>()
			.notNull()
			.default({}),
		firstSeenAt: text("first_seen_at").notNull(),
		lastSeenAt: text("last_seen_at").notNull(),
		revision: integer("revision").notNull().default(1),
	},
	(table) => [
		primaryKey({ columns: [table.installationId, table.hostUserId] }),
		index("idx_embedded_contact_email").on(table.installationId, table.email),
	],
);
