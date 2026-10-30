import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { appTools } from "./tools";

/** Owner-attested rules are immutable; changing one creates a new revision. */
export const tenantToolPolicies = sqliteTable(
	"tenant_tool_policies",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		appId: text("app_id").notNull(),
		rootAppId: text("root_app_id"),
		mountedToolId: text("mounted_tool_id"),
		toolRowId: text("tool_row_id")
			.notNull()
			.references(() => appTools.id, { onDelete: "cascade" }),
		toolDigest: text("tool_digest").notNull(),
		ruleDigest: text("rule_digest").notNull(),
		mountDescriptor: text("mount_descriptor", {
			mode: "json",
		}).$type<JsonValue>(),
		mountDigest: text("mount_digest"),
		resourceGenerationDigest: text("resource_generation_digest"),
		predicate: text("predicate", { mode: "json" }).$type<JsonValue>().notNull(),
		effect: text("effect", { mode: "json" }).$type<JsonValue>().notNull(),
		policySet: text("policy_set", { mode: "json" }).$type<JsonValue>(),
		createdBy: text("created_by").notNull(),
		createdAt: text("created_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("tenant_tool_policies_tool_idx").on(
			table.organizationId,
			table.appId,
			table.toolRowId,
		),
		uniqueIndex("tenant_tool_policies_revision_order_idx").on(
			table.organizationId,
			table.appId,
			table.toolRowId,
			table.createdAt,
		),
	],
);

export type TenantToolPolicyRow = typeof tenantToolPolicies.$inferSelect;
export type NewTenantToolPolicyRow = typeof tenantToolPolicies.$inferInsert;

/** Immutable owner-reviewed provider identity probes; no caller metadata is authority. */
export const tenantProviderIdentityProfiles = sqliteTable(
	"tenant_provider_identity_profiles",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		mount: text("mount", { mode: "json" }).$type<JsonValue>().notNull(),
		probeMount: text("probe_mount", { mode: "json" })
			.$type<JsonValue>()
			.notNull(),
		profile: text("profile", { mode: "json" }).$type<JsonValue>().notNull(),
		safetyAttestation: text("safety_attestation").notNull(),
		profileDigest: text("profile_digest").notNull(),
		resourceGenerationDigest: text("resource_generation_digest").notNull(),
		createdBy: text("created_by").notNull(),
		createdAt: text("created_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("tenant_provider_identity_profiles_org_idx").on(table.organizationId),
	],
);

export const tenantProviderIdentityPreparations = sqliteTable(
	"tenant_provider_identity_preparations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		ownerId: text("owner_id").notNull(),
		mount: text("mount", { mode: "json" }).$type<JsonValue>().notNull(),
		probeMount: text("probe_mount", { mode: "json" })
			.$type<JsonValue>()
			.notNull(),
		profile: text("profile", { mode: "json" }).$type<JsonValue>().notNull(),
		profileDigest: text("profile_digest").notNull(),
		resourceGenerationDigest: text("resource_generation_digest").notNull(),
		expiresAt: text("expires_at").notNull(),
		consumedAt: text("consumed_at"),
	},
	(table) => [
		index("tenant_provider_identity_preparations_owner_idx").on(
			table.organizationId,
			table.ownerId,
		),
	],
);

/** Monotonic mount history deliberately survives deletion of a tool or rule. */
export const tenantToolPolicyMountRevisions = sqliteTable(
	"tenant_tool_policy_mount_revisions",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		rootAppId: text("root_app_id").notNull(),
		mountedToolId: text("mounted_tool_id").notNull(),
		policyId: text("policy_id").notNull(),
		sourceAppId: text("source_app_id"),
		sourceToolRowId: text("source_tool_row_id"),
		sourceToolId: text("source_tool_id"),
		subjectKey: text("subject_key"),
		retiredUnknownSequence: integer("retired_unknown_sequence"),
	},
	(table) => [
		index("tenant_tool_policy_mount_revision_lookup_idx").on(
			table.organizationId,
			table.rootAppId,
			table.mountedToolId,
			table.sequence,
		),
		index("tenant_tool_policy_subject_revision_lookup_idx").on(
			table.organizationId,
			table.rootAppId,
			table.mountedToolId,
			table.subjectKey,
			table.sequence,
		),
	],
);

/** Generations never decrease; configuration change/revert cannot revive a rule. */
export const tenantToolPolicyResourceGenerations = sqliteTable(
	"tenant_tool_policy_resource_generations",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		resourceKind: text("resource_kind").notNull(),
		resourceId: text("resource_id").notNull(),
		generation: integer("generation").notNull().default(0),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.resourceKind, table.resourceId],
		}),
	],
);

/** Short-lived owner-bound snapshot prepared by the trusted gateway. */
export const tenantToolPolicyPreparations = sqliteTable(
	"tenant_tool_policy_preparations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		ownerId: text("owner_id").notNull(),
		descriptor: text("descriptor", { mode: "json" })
			.$type<JsonValue>()
			.notNull(),
		descriptorDigest: text("descriptor_digest").notNull(),
		sourceToolDigest: text("source_tool_digest"),
		exampleArgsDigest: text("example_args_digest"),
		resourceGenerationDigest: text("resource_generation_digest"),
		expiresAt: text("expires_at").notNull(),
		consumedAt: text("consumed_at"),
	},
	(table) => [
		index("tenant_tool_policy_preparations_owner_idx").on(
			table.organizationId,
			table.ownerId,
		),
	],
);
