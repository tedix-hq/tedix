/**
 * Workspace-owned output tables as they exist inside one TenantStore object.
 *
 * Same table and column names as `../schema/os-workspaces.ts`, so the
 * `durable-sqlite/os-outputs.ts` queries (which import that module's table
 * objects) and the migration copy pipeline (`importRows`) both work unchanged.
 * Cross-domain foreign keys are dropped: organizations and users stay in the
 * core database, so a per-workspace SQLite file cannot reference them.
 */
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdByKinds = ["user", "tedi", "external_agent", "service"] as const;

export const tenantOsWorkspaces = sqliteTable(
	"os_workspaces",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		sourceBlueprintId: text("source_blueprint_id"),
		sourceBlueprintRevisionId: text("source_blueprint_revision_id"),
		sourceBlueprintRevisionNumber: integer("source_blueprint_revision_number"),
		instantiationPreflight: text("instantiation_preflight"),
		previousBlueprintRevisionId: text("previous_blueprint_revision_id"),
		previousBlueprintRevisionNumber: integer(
			"previous_blueprint_revision_number",
		),
		previousInstantiationPreflight: text("previous_instantiation_preflight"),
		blueprintDecision: text("blueprint_decision"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		visibility: text("visibility", { enum: ["org", "private"] })
			.notNull()
			.default("org"),
		ownerUserId: text("owner_user_id"),
		iconUrl: text("icon_url"),
	},
	(table) => [
		uniqueIndex("os_workspaces_org_id_unique").on(
			table.organizationId,
			table.id,
		),
		uniqueIndex("os_workspaces_org_name_unique").on(
			table.organizationId,
			table.name,
		),
	],
);

export const tenantOsOutputs = sqliteTable(
	"os_outputs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		workspaceId: text("workspace_id"),
		kind: text("kind", {
			enum: ["document", "sheet", "presentation", "video"],
		}).notNull(),
		title: text("title").notNull(),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		currentRevisionId: text("current_revision_id"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		index("os_outputs_org_idx").on(table.organizationId, table.updatedAt),
		index("os_outputs_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
			table.updatedAt,
		),
	],
);

export const tenantOsOutputRevisions = sqliteTable(
	"os_output_revisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		outputId: text("output_id")
			.notNull()
			.references(() => tenantOsOutputs.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		/** Always the empty string on this plane; the body lives at `bodyR2Key`. */
		content: text("content").notNull(),
		note: text("note"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		skillRunId: text("skill_run_id"),
		skillId: text("skill_id"),
		accessEnvelope: text("access_envelope"),
		contentSha256: text("content_sha256"),
		contentBytes: integer("content_bytes"),
		bodyR2Key: text("body_r2_key"),
	},
	(table) => [
		uniqueIndex("os_output_revisions_output_revision_unique").on(
			table.outputId,
			table.revision,
		),
		index("os_output_revisions_org_idx").on(table.organizationId),
		index("os_output_revisions_skill_run_idx").on(
			table.skillRunId,
			table.createdAt,
		),
	],
);

/**
 * Provider resources attached to the workspace, mirroring
 * `osWorkspaceResources`. Only the organization reference is dropped; the
 * workspace reference points at this store's own `os_workspaces` row.
 */
export const tenantOsWorkspaceResources = sqliteTable(
	"os_workspace_resources",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => tenantOsWorkspaces.id, { onDelete: "cascade" }),
		slot: text("slot"),
		providerId: text("provider_id").notNull(),
		connectionScope: text("connection_scope", {
			enum: ["tenant", "user"],
		}).notNull(),
		personalOwnerUserId: text("personal_owner_user_id"),
		connectionInstanceId: text("connection_instance_id"),
		providerAccess: text("provider_access", { mode: "json" }).$type<{
			canRead: boolean;
			canWrite: boolean;
		}>(),
		requiredScopes: text("required_scopes").notNull().default("[]"),
		resourceType: text("resource_type").notNull(),
		providerResourceId: text("provider_resource_id").notNull(),
		name: text("name").notNull(),
		metadata: text("metadata").notNull().default("{}"),
		status: text("status", { enum: ["active", "removed"] })
			.notNull()
			.default("active"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		removedAt: text("removed_at"),
	},
	(table) => [
		uniqueIndex("os_workspace_resources_workspace_slot_unique").on(
			table.workspaceId,
			table.slot,
		),
		uniqueIndex("os_workspace_resources_provider_object_unique").on(
			table.workspaceId,
			table.providerId,
			table.connectionScope,
			sql`coalesce(${table.personalOwnerUserId}, '')`,
			sql`coalesce(${table.connectionInstanceId}, '')`,
			table.resourceType,
			table.providerResourceId,
		),
		index("os_workspace_resources_org_workspace_idx").on(
			table.organizationId,
			table.workspaceId,
			table.status,
		),
	],
);
