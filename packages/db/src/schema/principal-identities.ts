/**
 * Provider-neutral mappings from Tedix principals to external identities.
 *
 * Tedix UUIDs remain canonical. Identity providers are adapters identified by
 * an exact `(provider, issuer, subject)` tuple; provider subjects never become
 * authority merely because they resemble an existing Tedix id.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export const PRINCIPAL_TYPE_VALUES = [
	"organization",
	"user",
	"tedi",
	"service",
	"external_agent",
] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPE_VALUES)[number];

export const PRINCIPAL_IDENTITY_STATUS_VALUES = ["active", "revoked"] as const;
export type PrincipalIdentityStatus =
	(typeof PRINCIPAL_IDENTITY_STATUS_VALUES)[number];

export const principalIdentities = sqliteTable(
	"principal_identities",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		principalType: text("principal_type", {
			enum: [...PRINCIPAL_TYPE_VALUES],
		}).notNull(),
		principalId: text("principal_id").notNull(),
		provider: text("provider").notNull(),
		issuer: text("issuer").notNull(),
		subject: text("subject").notNull(),
		status: text("status", {
			enum: [...PRINCIPAL_IDENTITY_STATUS_VALUES],
		})
			.notNull()
			.default("active"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		lastVerifiedAt: text("last_verified_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_principal_identity_external").on(
			table.provider,
			table.issuer,
			table.subject,
		),
		uniqueIndex("uniq_principal_identity_canonical").on(
			table.principalType,
			table.principalId,
			table.provider,
			table.issuer,
			table.subject,
		),
		index("idx_principal_identity_principal").on(
			table.principalType,
			table.principalId,
			table.status,
		),
		index("idx_principal_identity_org").on(
			table.organizationId,
			table.principalType,
			table.status,
		),
		check(
			"chk_principal_identity_provider",
			sql`length(${table.provider}) > 0`,
		),
		check("chk_principal_identity_issuer", sql`length(${table.issuer}) > 0`),
		check("chk_principal_identity_subject", sql`length(${table.subject}) > 0`),
		check(
			"chk_principal_identity_org_principal",
			sql`${table.principalType} != 'organization' OR ${table.organizationId} = ${table.principalId}`,
		),
	],
);

export type PrincipalIdentity = typeof principalIdentities.$inferSelect;
export type NewPrincipalIdentity = typeof principalIdentities.$inferInsert;
