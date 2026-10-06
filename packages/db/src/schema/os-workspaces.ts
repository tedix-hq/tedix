import { sql } from "drizzle-orm";
import {
	index,
	foreignKey,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { projects } from "./projects";

/**
 * Tedix OS workspace domain (v1). D1 is canonical.
 *
 * A workspace is the tenant-scoped container users and tedis work inside; a
 * gadget is an installable surface within one workspace; a blueprint is a
 * reusable, versioned workspace definition. Gadgets and blueprints are
 * versioned through append-only revision tables — `current_revision_id` is a
 * plain text pointer (no FK: the reference is circular) that the query layer
 * maintains inside the same `db.batch()` that writes the revision row. Durable
 * collaboration proposals are non-canonical review branches pinned to one of
 * those immutable revisions; only their explicit merge batch may advance the
 * pointer.
 *
 * This domain is separate from the provisioned-instance bridge tables in
 * `os-instances.ts`; those tables own deployment state rather than product
 * workspace state.
 */

const createdByKinds = ["user", "tedi", "external_agent", "service"] as const;

export const osWorkspaces = sqliteTable(
	"os_workspaces",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		/** Instantiation provenance: the blueprint this workspace came from. Plain text, no FK — the record must survive blueprint deletion. Null for hand-created workspaces. */
		sourceBlueprintId: text("source_blueprint_id"),
		/** The exact blueprint revision the instantiation pinned. */
		sourceBlueprintRevisionId: text("source_blueprint_revision_id"),
		/** The pinned revision's per-blueprint counter, denormalized so provenance reads without a second query. */
		sourceBlueprintRevisionNumber: integer("source_blueprint_revision_number"),
		/**
		 * JSON: the `OsBlueprintPreflight` envelope resolved at instantiation —
		 * the per-dependency verdicts, the pins declared, and the pins that
		 * actually resolved. Skills and policy packs version in place with no
		 * history table, so this evidence cannot be reconstructed later.
		 */
		instantiationPreflight: text("instantiation_preflight"),
		/**
		 * Rollback reference: the blueprint revision this workspace was pinned to
		 * BEFORE the most recent applied upgrade, so the workspace can name what it
		 * would return to. Null until an upgrade is applied.
		 */
		previousBlueprintRevisionId: text("previous_blueprint_revision_id"),
		/** The previous pin's per-blueprint counter, denormalized beside its id. */
		previousBlueprintRevisionNumber: integer(
			"previous_blueprint_revision_number",
		),
		/**
		 * JSON: the `OsBlueprintPreflight` envelope that was recorded while the
		 * workspace was pinned to `previous_blueprint_revision_id`. Retained rather
		 * than overwritten — the envelope is audit evidence that cannot be
		 * reconstructed later.
		 */
		previousInstantiationPreflight: text("previous_instantiation_preflight"),
		/**
		 * JSON: the `OsWorkspaceBlueprintDecision` recorded the last time an
		 * operator reviewed an upgrade — `applied` or `stay_pinned`. Its presence is
		 * what separates "we looked and chose not to move" from "nobody looked".
		 */
		blueprintDecision: text("blueprint_decision"),
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

/** Tenant-safe association between a Workspace and canonical Work project. */
export const osWorkspaceProjects = sqliteTable(
	"os_workspace_projects",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		projectId: text("project_id").notNull(),
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
		foreignKey({
			columns: [table.organizationId, table.workspaceId],
			foreignColumns: [osWorkspaces.organizationId, osWorkspaces.id],
			name: "os_workspace_projects_workspace_fk",
		}).onDelete("cascade"),
		foreignKey({
			columns: [table.organizationId, table.projectId],
			foreignColumns: [projects.orgId, projects.id],
			name: "os_workspace_projects_project_fk",
		}).onDelete("cascade"),
		uniqueIndex("os_workspace_projects_workspace_project_unique").on(
			table.workspaceId,
			table.projectId,
		),
		index("os_workspace_projects_org_workspace_status_idx").on(
			table.organizationId,
			table.workspaceId,
			table.status,
		),
	],
);

export const osWorkspaceResources = sqliteTable(
	"os_workspace_resources",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => osWorkspaces.id, { onDelete: "cascade" }),
		slot: text("slot"),
		providerId: text("provider_id").notNull(),
		connectionScope: text("connection_scope", {
			enum: ["tenant", "user"],
		}).notNull(),
		/** JSON string: scopes the canonical connection must grant at use time. */
		requiredScopes: text("required_scopes").notNull().default("[]"),
		resourceType: text("resource_type").notNull(),
		providerResourceId: text("provider_resource_id").notNull(),
		name: text("name").notNull(),
		/** JSON string: bounded non-secret discovery/display metadata. */
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

export const osGadgets = sqliteTable(
	"os_gadgets",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => osWorkspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		/** Pointer to the serving `os_gadget_revisions.id`; no FK (circular), queries maintain it. */
		currentRevisionId: text("current_revision_id"),
		/** Per-gadget instantiation lineage: the blueprint revision that declared it. Plain text, no FK — must survive blueprint deletion. */
		sourceBlueprintRevisionId: text("source_blueprint_revision_id"),
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
		uniqueIndex("os_gadgets_workspace_name_unique").on(
			table.workspaceId,
			table.name,
		),
		index("os_gadgets_org_idx").on(table.organizationId),
	],
);

export const osGadgetRevisions = sqliteTable(
	"os_gadget_revisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		gadgetId: text("gadget_id")
			.notNull()
			.references(() => osGadgets.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		/** JSON string: declared capabilities, entry, notes. */
		manifest: text("manifest").notNull(),
		sourceArtifactRef: text("source_artifact_ref"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("os_gadget_revisions_gadget_revision_unique").on(
			table.gadgetId,
			table.revision,
		),
		index("os_gadget_revisions_org_idx").on(table.organizationId),
	],
);

export const osBlueprints = sqliteTable(
	"os_blueprints",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status", { enum: ["draft", "published", "archived"] })
			.notNull()
			.default("draft"),
		/**
		 * Catalog visibility: `org` keeps the blueprint private to its
		 * organization; `catalog` lists a published blueprint in the
		 * cross-organization gallery (name, description, gadget count, and the
		 * owning organization's display name are the only fields that cross the
		 * tenant boundary).
		 */
		visibility: text("visibility", { enum: ["org", "catalog"] })
			.notNull()
			.default("org"),
		/** Pointer to the serving `os_blueprint_revisions.id`; no FK (circular), queries maintain it. */
		currentRevisionId: text("current_revision_id"),
		/**
		 * JSON: the `OsBlueprintLineage` fork chain — nearest ancestor first —
		 * recorded by the platform when this blueprint was forked from another one
		 * (a gallery import or an export/import round trip). Null for hand-authored
		 * blueprints.
		 *
		 * Deliberately NOT part of `os_blueprint_revisions.definition`: a definition
		 * is caller-supplied on every `blueprints.revise`, so lineage living there
		 * would be forgeable. This column is only ever written by the fork paths.
		 */
		lineage: text("lineage"),
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
		uniqueIndex("os_blueprints_org_name_unique").on(
			table.organizationId,
			table.name,
		),
	],
);

export const osBlueprintRevisions = sqliteTable(
	"os_blueprint_revisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		blueprintId: text("blueprint_id")
			.notNull()
			.references(() => osBlueprints.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		/** JSON string (`OsBlueprintDefinition`): declared gadgets plus the version-pinned `requirements` declaration. */
		definition: text("definition").notNull(),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		publishedAt: text("published_at"),
	},
	(table) => [
		uniqueIndex("os_blueprint_revisions_blueprint_revision_unique").on(
			table.blueprintId,
			table.revision,
		),
		index("os_blueprint_revisions_org_idx").on(table.organizationId),
	],
);

/**
 * Governed Gadget execution receipts. Every run — admitted or denied — records
 * the accountable actor, the pinned revision, the explicit capability set, the
 * policy decision, and (on completion) outputs, costs, and evidence refs.
 *
 * A governed run (caller supplied a tedi) DISPATCHES the skill the gadget's
 * manifest names through skill-runtime `/run`; the lineage columns pin the
 * dispatched run so the runtime — not the caller — settles the receipt.
 * Admission-only receipts (no `run_id`) keep the legacy caller-executor
 * contract and settle through the public complete verb.
 *
 * These rows are audit evidence, so `workspace_id` / `gadget_id` /
 * `revision_id` (and every lineage id) are deliberately plain text with no FK:
 * a receipt must survive the deletion of the gadget it ran against. Only the
 * organization cascade applies.
 */
export const osGadgetExecutions = sqliteTable(
	"os_gadget_executions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		gadgetId: text("gadget_id").notNull(),
		/** Pinned `os_gadget_revisions.id`; null when admission was denied before any revision existed. */
		revisionId: text("revision_id"),
		/** Pinned per-gadget revision number matching `revision_id`. */
		revision: integer("revision"),
		status: text("status", {
			enum: [
				"denied",
				"queued",
				"awaiting_approval",
				"running",
				"paused",
				"completed",
				"failed",
				"canceled",
			],
		}).notNull(),
		/** JSON array: the explicit capability set granted at admission. */
		grantedCapabilities: text("granted_capabilities").notNull(),
		/** JSON: the admission decision — `{ allowed, reasons, decisions? }`. */
		policyDecision: text("policy_decision").notNull(),
		/** JSON: caller-supplied execution input; null when none was given. */
		input: text("input"),
		/** JSON: runtime-reported output recorded at settlement. */
		output: text("output"),
		error: text("error"),
		/** JSON: runtime-reported cost summary recorded at settlement. */
		costs: text("costs"),
		/** JSON array: artifact/evidence references recorded from runtime evidence. */
		evidenceRefs: text("evidence_refs"),
		/** Dispatched `skill_runs.id`; null while approval is still pending or on historical receipts. */
		runId: text("run_id"),
		/** Engine workflow instance backing the dispatched run. */
		workflowInstanceId: text("workflow_instance_id"),
		/** The tedi the governed run executes as; null only on historical receipts. */
		tediId: text("tedi_id"),
		/** Work Item admitted with the run, when the caller linked one. */
		workItemId: text("work_item_id"),
		/** Evidence/trace bundle reference recorded by runtime settlement. */
		traceBundleId: text("trace_bundle_id"),
		/** Billing reservation taken at dispatch admission. */
		billingReservationId: text("billing_reservation_id"),
		/** `tedi_approval_requests.id` parked on an awaiting_approval receipt. */
		approvalRequestId: text("approval_request_id"),
		/** Deploy environment that admitted the dispatch (dev rows share prod D1). */
		runtimeEnvironment: text("runtime_environment"),
		/** External-agent session that started the run, when one was attested. */
		agentSessionId: text("agent_session_id"),
		/** JSON OsDerivedAccessEnvelope captured from the admitted resource grants. */
		resourceAccessEnvelope: text("resource_access_envelope"),
		/** Mirror of the dispatched run's execution epoch at admission. */
		executionEpoch: integer("execution_epoch").notNull().default(0),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		completedAt: text("completed_at"),
	},
	(table) => [
		index("os_gadget_executions_org_idx").on(table.organizationId),
		index("os_gadget_executions_gadget_idx").on(
			table.gadgetId,
			table.createdAt,
		),
	],
);

/**
 * Tedix OS outputs: durable, revisioned deliverables (documents, sheets,
 * presentations). `workspace_id` is optional grouping context, deliberately
 * plain text with no FK — an output is a durable deliverable that outlives
 * workspace lifecycle. Revisions are append-only; `current_revision_id` is the
 * usual circular plain-text pointer maintained by the revision write batch.
 */
export const osOutputs = sqliteTable(
	"os_outputs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id"),
		kind: text("kind", {
			enum: ["document", "sheet", "presentation", "video"],
		}).notNull(),
		title: text("title").notNull(),
		status: text("status", { enum: ["active", "archived"] })
			.notNull()
			.default("active"),
		/** Pointer to the serving `os_output_revisions.id`; no FK (circular), queries maintain it. */
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
	],
);

export const osOutputRevisions = sqliteTable(
	"os_output_revisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		outputId: text("output_id")
			.notNull()
			.references(() => osOutputs.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull(),
		/** JSON string: the semantic content body, discriminated by the output's kind. */
		content: text("content").notNull(),
		/** Optional revision message describing the edit. */
		note: text("note"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		/**
		 * Producer lineage: the skill run that authored these bytes. The workflow
		 * bridge already forwards `X-Tedix-Skill-Run-Id` / `X-Tedix-Skill-Id`
		 * through the MCP edge; before this column the API dropped them. Both are
		 * null for a human-authored revision and for every revision written before
		 * this column existed — there is no backfill source.
		 *
		 * Declared LAST on purpose: `ALTER TABLE ADD COLUMN` appends, and the
		 * revision writers use `insert().select()`, which emits no column list and
		 * binds positionally. Schema order must equal physical order or values
		 * land in the wrong columns.
		 *
		 * Deliberately plain text with no FK, matching `osGadgetExecutions`: a
		 * deliverable outlives the skill that produced it, so pruning a skill or
		 * its runs must never cascade away the receipt. Orphaned ids are expected
		 * and readers must degrade gracefully.
		 */
		skillRunId: text("skill_run_id"),
		skillId: text("skill_id"),
		/** JSON OsDerivedAccessEnvelope inherited from the producing governed run. */
		accessEnvelope: text("access_envelope"),
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
 * Agent-authored collaboration proposals are durable review records, not live
 * collaborative room state and not canonical artifact revisions. A proposal is pinned to one
 * immutable gadget/output revision. Streaming replaces only its preview body
 * and advances `sequence`; an explicit merge appends the next canonical
 * revision and records the resulting revision here in one D1 batch.
 */
export const osCollaborationProposals = sqliteTable(
	"os_collaboration_proposals",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => osWorkspaces.id, { onDelete: "cascade" }),
		documentType: text("document_type", {
			enum: ["gadget", "output"],
		}).notNull(),
		/** Gadget/output id. Plain text because the target table depends on document_type. */
		documentId: text("document_id").notNull(),
		baseRevisionId: text("base_revision_id").notNull(),
		baseRevision: integer("base_revision").notNull(),
		status: text("status", {
			enum: ["open", "accepted", "rejected", "merged"],
		})
			.notNull()
			.default("open"),
		sourceKind: text("source_kind", {
			enum: ["chat", "run", "agent_session"],
		}).notNull(),
		sourceId: text("source_id").notNull(),
		/** Null on legacy caller-asserted rows; 1 on server-attested producers. */
		sourceAttestationVersion: integer("source_attestation_version"),
		/** Latest full JSON preview. Never read as canonical artifact content. */
		content: text("content").notNull(),
		sequence: integer("sequence").notNull().default(0),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		decisionRationale: text("decision_rationale"),
		decisionEvidenceRefs: text("decision_evidence_refs")
			.notNull()
			.default("[]"),
		decidedByKind: text("decided_by_kind", { enum: createdByKinds }),
		decidedById: text("decided_by_id"),
		decidedAt: text("decided_at"),
		mergeRationale: text("merge_rationale"),
		mergeEvidenceRefs: text("merge_evidence_refs").notNull().default("[]"),
		mergedByKind: text("merged_by_kind", { enum: createdByKinds }),
		mergedById: text("merged_by_id"),
		mergedAt: text("merged_at"),
		resultRevisionId: text("result_revision_id"),
		resultRevision: integer("result_revision"),
	},
	(table) => [
		index("os_collaboration_proposals_document_idx").on(
			table.organizationId,
			table.workspaceId,
			table.documentType,
			table.documentId,
			table.updatedAt,
		),
		index("os_collaboration_proposals_source_idx").on(
			table.organizationId,
			table.sourceKind,
			table.sourceId,
		),
	],
);

export type OsWorkspaceRow = typeof osWorkspaces.$inferSelect;
export type NewOsWorkspaceRow = typeof osWorkspaces.$inferInsert;
export type OsWorkspaceProjectRow = typeof osWorkspaceProjects.$inferSelect;
export type NewOsWorkspaceProjectRow = typeof osWorkspaceProjects.$inferInsert;
export type OsWorkspaceResourceRow = typeof osWorkspaceResources.$inferSelect;
export type NewOsWorkspaceResourceRow =
	typeof osWorkspaceResources.$inferInsert;
export type OsGadgetRow = typeof osGadgets.$inferSelect;
export type NewOsGadgetRow = typeof osGadgets.$inferInsert;
export type OsGadgetRevisionRow = typeof osGadgetRevisions.$inferSelect;
export type NewOsGadgetRevisionRow = typeof osGadgetRevisions.$inferInsert;
export type OsBlueprintRow = typeof osBlueprints.$inferSelect;
export type NewOsBlueprintRow = typeof osBlueprints.$inferInsert;
export type OsBlueprintRevisionRow = typeof osBlueprintRevisions.$inferSelect;
export type NewOsBlueprintRevisionRow =
	typeof osBlueprintRevisions.$inferInsert;
export type OsGadgetExecutionRow = typeof osGadgetExecutions.$inferSelect;
export type NewOsGadgetExecutionRow = typeof osGadgetExecutions.$inferInsert;
export type OsOutputRow = typeof osOutputs.$inferSelect;
export type NewOsOutputRow = typeof osOutputs.$inferInsert;
export type OsOutputRevisionRow = typeof osOutputRevisions.$inferSelect;
export type NewOsOutputRevisionRow = typeof osOutputRevisions.$inferInsert;
export type OsCollaborationProposalRow =
	typeof osCollaborationProposals.$inferSelect;
export type NewOsCollaborationProposalRow =
	typeof osCollaborationProposals.$inferInsert;
