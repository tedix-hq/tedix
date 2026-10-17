import {
	integer,
	sqliteTable,
	text,
	uniqueIndex,
	check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { ResidencyProvider } from "@tedix/api-contract/schemas/data-residency";
import { organizations } from "./organizations";

export const organizationResidencyPolicies = sqliteTable(
	"organization_residency_policies",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		mode: text("mode", { enum: ["unrestricted", "eu"] }).notNull(),
		revision: integer("revision").notNull(),
		updatedAt: text("updated_at").notNull(),
		updatedBy: text("updated_by").notNull(),
	},
	(t) => [
		check("residency_policy_mode", sql`${t.mode} IN ('unrestricted', 'eu')`),
		check("residency_policy_revision", sql`${t.revision} > 0`),
	],
);

export const residencyProviderVersions = sqliteTable(
	"residency_provider_versions",
	{
		id: text("id").primaryKey(),
		memberKey: text("member_key").notNull(),
		revision: integer("revision").notNull(),
		config: text("config", { mode: "json" })
			.$type<ResidencyProvider>()
			.notNull(),
		publishedAt: text("published_at").notNull(),
		publishedBy: text("published_by").notNull(),
	},
	(t) => [
		uniqueIndex("residency_provider_version").on(t.memberKey, t.revision),
	],
);

export const residencyExecutionReceipts = sqliteTable(
	"residency_execution_receipts",
	{
		executionId: text("execution_id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		policyRevision: integer("policy_revision").notNull(),
		memberKey: text("member_key").notNull(),
		poolRevision: integer("pool_revision").notNull(),
		providerOrigin: text("provider_origin").notNull(),
		evidenceRef: text("evidence_ref").notNull(),
		credentialRef: text("credential_ref").notNull(),
		createdAt: text("created_at").notNull(),
	},
);
