import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

export const principalIdentities = pgTable(
	"principal_identities",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		principalType: text("principal_type").notNull(),
		principalId: text("principal_id").notNull(),
		provider: text("provider").notNull(),
		issuer: text("issuer").notNull(),
		subject: text("subject").notNull(),
		status: text("status").notNull().default("active"),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		lastVerifiedAt: text("last_verified_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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
			sql`${table.principalType} <> 'organization' OR ${table.organizationId} = ${table.principalId}`,
		),
	],
);

export type PgPrincipalIdentity = typeof principalIdentities.$inferSelect;
export type NewPgPrincipalIdentity = typeof principalIdentities.$inferInsert;
