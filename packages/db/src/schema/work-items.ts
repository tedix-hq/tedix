/**
 * Provider-neutral work coordination.
 *
 * Work Items are Tedix-owned issue threads. They persist accepted work across
 * conversations, TaskFlow runtime state, and external task/project providers.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { getColumns, sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { projects } from "./projects";
import { tediObjectives } from "./tedi-objectives";

export const WORK_ITEM_DISPOSITION_VALUES = [
	"proposed",
	"accepted",
	"completed",
	"cancelled",
] as const;
export type WorkItemDisposition = (typeof WORK_ITEM_DISPOSITION_VALUES)[number];

export const WORK_ITEM_READINESS_VALUES = [
	"ready",
	"not_accepted",
	"purpose_blocked",
	"dependencies_blocked",
	"capability_blocked",
	"approval_blocked",
	"evaluation_required",
	"budget_blocked",
	"resource_blocked",
	"already_running",
	"not_before",
	"terminal",
] as const;
export type WorkItemReadiness = (typeof WORK_ITEM_READINESS_VALUES)[number];

export const WORK_ITEM_KIND_VALUES = [
	"coding",
	"research",
	"document",
	"design",
	"browser",
	"operations",
	"communication",
	"outbound",
	"finance",
	"legal",
	"stewardship",
	"incident",
	"other",
] as const;
export type WorkItemKind = (typeof WORK_ITEM_KIND_VALUES)[number];

export const WORK_ITEM_RISK_LEVEL_VALUES = [
	"low",
	"medium",
	"high",
	"critical",
] as const;
export type WorkItemRiskLevel = (typeof WORK_ITEM_RISK_LEVEL_VALUES)[number];

export const WORK_ITEM_PRIORITY_VALUES = [
	"critical",
	"high",
	"medium",
	"low",
] as const;
export type WorkItemPriority = (typeof WORK_ITEM_PRIORITY_VALUES)[number];

/**
 * Why this work exists. `objective` is normal purpose-linked work. The other
 * values are explicitly time-bounded operational exceptions; they must never
 * become a permanent substitute for an objective.
 */
export const WORK_ITEM_CLASS_VALUES = [
	"objective",
	"maintenance",
	"incident",
	"hygiene",
] as const;
export type WorkItemClass = (typeof WORK_ITEM_CLASS_VALUES)[number];

export const WORK_ITEM_ACCOUNTABILITY_PRINCIPAL_TYPE_VALUES = [
	"user",
	"tedi",
	"team",
	"system",
] as const;
export type WorkItemAccountabilityPrincipalType =
	(typeof WORK_ITEM_ACCOUNTABILITY_PRINCIPAL_TYPE_VALUES)[number];

export interface WorkItemAcceptanceContract {
	version: 1;
	/** Plain-language statement of the accepted outcome; the current shape. */
	doneLooksLike?: string;
}

export const WORK_ACTOR_TYPE_VALUES = [
	...WORK_ITEM_ACCOUNTABILITY_PRINCIPAL_TYPE_VALUES,
	"external_agent",
] as const;
export type WorkActorType = (typeof WORK_ACTOR_TYPE_VALUES)[number];

export const WORK_ITEM_COMMENT_AUTHOR_TYPE_VALUES = [
	"user",
	"tedi",
	"external_agent",
	"system",
] as const;
export type WorkItemCommentAuthorType =
	(typeof WORK_ITEM_COMMENT_AUTHOR_TYPE_VALUES)[number];

/**
 * What a second principal is asserting about a Work Item.
 *
 * The ledger began as duplicate suppression — "I hit this too" — which is why
 * every row before this column meant `corroborates` and the default backfills
 * them correctly. But AGENTS.md delegates correctness after the fact to this
 * ledger ("a settled outcome that turns out to be false is fixed when someone
 * notices"), and a table that can only agree cannot carry that. The stance is
 * the difference between a ranking signal and a detection plane.
 */
export const WORK_ITEM_CORROBORATION_STANCE_VALUES = [
	"corroborates",
	"contradicts",
] as const;
export type WorkItemCorroborationStance =
	(typeof WORK_ITEM_CORROBORATION_STANCE_VALUES)[number];

export const WORK_ITEM_CORROBORATION_PRINCIPAL_TYPE_VALUES = [
	"user",
	"organization",
	"tedi",
	"external_agent",
] as const;
export type WorkItemCorroborationPrincipalType =
	(typeof WORK_ITEM_CORROBORATION_PRINCIPAL_TYPE_VALUES)[number];

export const WORK_ITEM_RELATION_TYPE_VALUES = [
	"blocks",
	"supersedes",
	"duplicates",
	"references",
] as const;
export type WorkItemRelationType =
	(typeof WORK_ITEM_RELATION_TYPE_VALUES)[number];

export const WORK_ATTEMPT_RUNTIME_STATE_VALUES = [
	"queued",
	"running",
	"waiting",
	"retrying",
	"failed",
	"expired",
	"finished",
	"cancelled",
] as const;
export type WorkAttemptRuntimeState =
	(typeof WORK_ATTEMPT_RUNTIME_STATE_VALUES)[number];

export const WORK_ATTEMPT_OUTCOME_VALUES = [
	"succeeded",
	"failed",
	"rejected",
	"cancelled",
	"expired",
] as const;
export type WorkAttemptOutcome = (typeof WORK_ATTEMPT_OUTCOME_VALUES)[number];

export const WORK_EVIDENCE_DISPOSITION_VALUES = [
	"pending",
	"accepted",
	"rejected",
	"superseded",
] as const;
export type WorkEvidenceDisposition =
	(typeof WORK_EVIDENCE_DISPOSITION_VALUES)[number];

/** A principal that may be assigned Work or recorded as its actual executor. */
export const WORK_EXECUTOR_TYPE_VALUES = [
	"human",
	"tedi",
	"external_agent",
	"team",
	"organization",
] as const;
export type WorkExecutorType = (typeof WORK_EXECUTOR_TYPE_VALUES)[number];
export const WORK_ITEM_EXECUTOR_TYPE_VALUES = [
	"tedi",
	"external_agent",
] as const;
export type WorkItemExecutorType =
	(typeof WORK_ITEM_EXECUTOR_TYPE_VALUES)[number];

export const WORK_ITEM_DISPATCH_STATE_VALUES = ["held", "ready"] as const;
export type WorkItemDispatchState =
	(typeof WORK_ITEM_DISPATCH_STATE_VALUES)[number];

export const WORK_ITEM_PROJECTION_DIRECTION_VALUES = [
	"source",
	"projection",
	"sync",
] as const;
export type WorkItemProjectionDirection =
	(typeof WORK_ITEM_PROJECTION_DIRECTION_VALUES)[number];

export const WORK_ITEM_PROJECTION_STATUS_VALUES = [
	"pending",
	"synced",
	"failed",
	"stale",
] as const;
export type WorkItemProjectionStatus =
	(typeof WORK_ITEM_PROJECTION_STATUS_VALUES)[number];

/**
 * A repository observation that is still open. This is the WHERE of
 * `idx_work_items_open_repository_observation_columns` and of the maintenance sweeps
 * that use it, word for word, because SQLite offers a partial index only to a
 * query that states the index's condition. Changing it needs a migration that
 * rebuilds the index.
 */
export const openRepositoryObservation = sql`repository_observer = 1 AND disposition NOT IN ('completed', 'cancelled')`;
/**
 * A repository observation waiting for a wake slot: deferred, never woken and
 * not reported. The WHERE of `idx_work_items_deferred_repository_wake_columns` and of
 * the read that uses it, word for word, for the same reason.
 */
export const deferredRepositoryWake = sql`repository_observer = 1 AND json_extract(metadata, '$.observerWakeDeferredAt') IS NOT NULL AND observer_woken_at IS NULL AND report IS NULL`;

/**
 * A repository observation that holds one of its project's wake slots while
 * its wake is recent: woken, not reported, and open or settled as an advisory
 * push. The WHERE of `idx_work_items_woken_repository_observation_columns` and of the
 * slot count that uses it, word for word, for the same reason. How recent the
 * wake is cannot be part of an index; the count tests it on these few rows.
 */
export const wokenRepositoryObservation = sql`repository_observer = 1 AND observer_woken_at IS NOT NULL AND report IS NULL AND (disposition IN ('proposed','accepted') OR (disposition = 'cancelled' AND json_extract(metadata, '$.settleReason') = 'advisory push observation'))`;

export const workItems = sqliteTable(
	"work_items",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		description: text("description"),
		disposition: text("disposition", { enum: WORK_ITEM_DISPOSITION_VALUES })
			.notNull()
			.default("proposed"),
		workKind: text("work_kind", { enum: WORK_ITEM_KIND_VALUES })
			.notNull()
			.default("other"),
		riskLevel: text("risk_level", { enum: WORK_ITEM_RISK_LEVEL_VALUES })
			.notNull()
			.default("medium"),
		acceptanceContract: text("acceptance_contract", {
			mode: "json",
		}).$type<WorkItemAcceptanceContract>(),
		requiredCapabilities: text("required_capabilities", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		requiredAuthorities: text("required_authorities", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		admissionSpecRevision: text("admission_spec_revision")
			.notNull()
			.default("legacy"),
		priority: text("priority", { enum: WORK_ITEM_PRIORITY_VALUES })
			.notNull()
			.default("medium"),
		accountableOwnerType: text("accountable_owner_type", {
			enum: WORK_ITEM_ACCOUNTABILITY_PRINCIPAL_TYPE_VALUES,
		}),
		accountableOwnerId: text("accountable_owner_id"),
		stewardType: text("steward_type", {
			enum: WORK_ITEM_ACCOUNTABILITY_PRINCIPAL_TYPE_VALUES,
		}),
		stewardId: text("steward_id"),
		reviewerType: text("reviewer_type", {
			enum: WORK_ITEM_ACCOUNTABILITY_PRINCIPAL_TYPE_VALUES,
		}),
		reviewerId: text("reviewer_id"),
		/** Retired reviewer lease; retained only for historical data review. */
		reviewerLeaseExpiresAt: text("reviewer_lease_expires_at"),
		objectiveId: text("objective_id").references(() => tediObjectives.id, {
			onDelete: "set null",
		}),
		workClass: text("work_class", { enum: WORK_ITEM_CLASS_VALUES }),
		purposeExceptionExpiresAt: text("purpose_exception_expires_at"),
		projectId: text("project_id").references(() => projects.id, {
			onDelete: "set null",
		}),
		/**
		 * Parent node in the work hierarchy. Deliberately TEXT with NO db FK:
		 * a db-level self-FK would force drizzle to recreate `work_items`, a
		 * destructive table rebuild. Parent integrity is enforced at the query layer
		 * (`queries/work-items/crud.ts` and `hierarchy.ts`: existence, same-org,
		 * containment, and cycle checks).
		 */
		parentWorkItemId: text("parent_work_item_id"),
		executorType: text("executor_type", { enum: WORK_EXECUTOR_TYPE_VALUES }),
		executorId: text("executor_id"),
		dispatchState: text("dispatch_state", {
			enum: WORK_ITEM_DISPATCH_STATE_VALUES,
		}),
		delegationDepth: integer("delegation_depth"),
		maxAttempts: integer("max_attempts"),
		rootWorkItemId: text("root_work_item_id"),
		rootGoal: text("root_goal"),
		/** Millionths of the parent contract's budget reserved for this Work. */
		budgetShareMicros: integer("budget_share_micros"),
		sourceSessionKey: text("source_session_key"),
		sourceIntentId: text("source_intent_id"),
		dueDate: text("due_date"),
		deadline: text("deadline"),
		startAt: text("start_at"),
		durationDays: integer("duration_days"),
		provenance: text("provenance", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),
		repositoryObserver: integer("repository_observer").generatedAlwaysAs(
			sql`CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.repositoryObserver') END`,
			{ mode: "virtual" },
		),
		report: text("report").generatedAlwaysAs(
			sql`CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.report') END`,
			{ mode: "virtual" },
		),
		observerWokenAt: text("observer_woken_at").generatedAlwaysAs(
			sql`CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.observerWokenAt') END`,
			{ mode: "virtual" },
		),
		metadataExecutor: text("metadata_executor").generatedAlwaysAs(
			sql`CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.executor') END`,
			{ mode: "virtual" },
		),
		metadataSource: text("metadata_source").generatedAlwaysAs(
			sql`CASE WHEN json_valid("metadata") THEN json_extract("metadata", '$.source') END`,
			{ mode: "virtual" },
		),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		acceptedAt: text("accepted_at"),
		completedAt: text("completed_at"),
		cancelledAt: text("cancelled_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_items_org_id").on(table.orgId, table.id),
		// Supersedes the bare `idx_work_items_org` (a strict prefix of this and of
		// several other org-leading indexes). The board list orders by created_at
		// DESC; org_id alone meant a temp B-tree over every item in the org.
		index("idx_work_items_metadata_executor").on(
			table.orgId,
			table.metadataExecutor,
			table.createdAt,
		),
		index("idx_work_items_metadata_source").on(
			table.orgId,
			table.metadataSource,
			table.createdAt,
		),
		index("idx_work_items_observer_report_woken").on(
			table.orgId,
			table.projectId,
			table.repositoryObserver,
			table.report,
			table.observerWokenAt,
		),
		index("idx_work_items_deadline").on(table.deadline),
		index("idx_work_items_due_date").on(table.dueDate),
		index("idx_work_items_org_created").on(table.orgId, table.createdAt),
		index("idx_work_items_org_disposition").on(table.orgId, table.disposition),
		index("idx_work_items_stale_delegation")
			.on(
				table.disposition,
				sql`COALESCE(${table.updatedAt}, ${table.createdAt})`,
				table.orgId,
				table.id,
			)
			.where(
				sql`json_extract(${table.provenance}, '$.source') = 'kernelRuntime.directDelegation'`,
			),
		index("idx_work_items_lane_executor").on(
			table.orgId,
			table.disposition,
			table.executorType,
			table.executorId,
			table.createdAt,
			table.id,
		),
		// Keep held lanes out of both dispatcher polling and health checks.
		index("idx_work_items_lane_ready")
			.on(
				table.orgId,
				table.disposition,
				table.executorType,
				table.executorId,
				table.createdAt,
				table.id,
			)
			.where(sql`${table.dispatchState} = 'ready'`),
		index("idx_work_items_org_kind_risk").on(
			table.orgId,
			table.workKind,
			table.riskLevel,
		),
		index("idx_work_items_project").on(table.projectId),
		index("idx_work_items_org_project_created").on(
			table.orgId,
			table.projectId,
			table.createdAt,
		),
		index("idx_work_items_org_project_disposition").on(
			table.orgId,
			table.projectId,
			table.disposition,
		),
		index("idx_work_items_parent").on(table.parentWorkItemId),
		index("idx_work_items_accountable_owner").on(
			table.orgId,
			table.accountableOwnerType,
			table.accountableOwnerId,
		),
		// One owner's Work in one disposition, newest first, for an owner of any
		// type. Partial on purpose: SQLite may use it only when a query names the
		// owner, so it is never an alternative for a lookup by organization and
		// id. The same columns without the WHERE were chosen for exactly such a
		// lookup and walked the organization (commitment-wakes.test.ts).
		index("idx_work_items_owner_list")
			.on(
				table.orgId,
				table.accountableOwnerId,
				table.disposition,
				table.createdAt,
				table.id,
			)
			.where(sql`${table.accountableOwnerId} IS NOT NULL`),
		// The repository observer's maintenance tick looks across every
		// organization for open observations (overdue red incidents, aged
		// pushes) and for pushes waiting for a wake slot. Almost every
		// observation is a settled commit watch, so without these two the tick
		// walked the whole table three times. No other read states their WHERE.
		index("idx_work_items_open_repository_observation_columns")
			.on(table.createdAt, table.id)
			.where(openRepositoryObservation),
		index("idx_work_items_deferred_repository_wake_columns")
			.on(table.createdAt, table.id)
			.where(deferredRepositoryWake),
		// Taking a wake slot counts the project's woken, unreported
		// observations. Without this the count read every Work Item of the
		// project. No other read states its WHERE.
		index("idx_work_items_woken_repository_observation_columns")
			.on(table.orgId, table.projectId, table.id)
			.where(wokenRepositoryObservation),
		index("idx_work_items_objective").on(table.objectiveId),
		index("idx_work_items_org_objective").on(table.orgId, table.objectiveId),
		index("idx_work_items_org_class").on(table.orgId, table.workClass),
		index("idx_work_items_source_intent").on(table.sourceIntentId),
		uniqueIndex("uniq_work_items_org_source_intent").on(
			table.orgId,
			table.sourceIntentId,
		),
	],
);

/**
 * How many Work Items an organization has. Database triggers
 * (`WORK_ITEM_ORG_COUNT_TRIGGERS`) keep `total` equal to the organization's
 * rows on every insert, delete and move between organizations, including
 * cascade deletes and writes that bypass the query helpers. The unfiltered
 * Work list reads its total here instead of counting every row.
 */
export const workItemOrgCounts = sqliteTable("work_item_org_counts", {
	orgId: text("org_id")
		.primaryKey()
		.references(() => organizations.id, { onDelete: "cascade" }),
	total: integer("total").notNull().default(0),
});

/**
 * The triggers behind `work_item_org_counts`, as their migration created
 * them. Drizzle does not model triggers: tests that build `work_items` from
 * the schema add these, and a test compares them with the migrated database.
 */
export const WORK_ITEM_ORG_COUNT_TRIGGERS = [
	`CREATE TRIGGER work_item_org_counts_insert AFTER INSERT ON work_items
BEGIN
  INSERT INTO work_item_org_counts (org_id, total) VALUES (NEW.org_id, 1)
  ON CONFLICT(org_id) DO UPDATE SET total = total + 1;
END;`,
	`CREATE TRIGGER work_item_org_counts_delete AFTER DELETE ON work_items
BEGIN
  UPDATE work_item_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
END;`,
	`CREATE TRIGGER work_item_org_counts_move AFTER UPDATE OF org_id ON work_items
WHEN OLD.org_id != NEW.org_id
BEGIN
  UPDATE work_item_org_counts SET total = total - 1 WHERE org_id = OLD.org_id;
  INSERT INTO work_item_org_counts (org_id, total) VALUES (NEW.org_id, 1)
  ON CONFLICT(org_id) DO UPDATE SET total = total + 1;
END;`,
] as const;

/**
 * The columns a Work Item row is read and returned with. Generated columns exist for
 * WHERE, ORDER BY and indexes only: select and `returning()` through this, never
 * the whole table, so they do not reach a caller or an API response.
 */
export const {
	repositoryObserver: _repositoryObserver,
	report: _report,
	observerWokenAt: _observerWokenAt,
	metadataExecutor: _metadataExecutor,
	metadataSource: _metadataSource,
	...workItemStoredColumns
} = getColumns(workItems);

export type WorkItem = Omit<
	typeof workItems.$inferSelect,
	| "reviewerLeaseExpiresAt"
	| "repositoryObserver"
	| "report"
	| "observerWokenAt"
	| "metadataExecutor"
	| "metadataSource"
>;
export type NewWorkItem = Omit<
	typeof workItems.$inferInsert,
	"reviewerLeaseExpiresAt"
>;

export const workItemComments = sqliteTable(
	"work_item_comments",
	{
		id: text("id").primaryKey(),
		workItemId: text("work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		authorType: text("author_type", {
			enum: WORK_ITEM_COMMENT_AUTHOR_TYPE_VALUES,
		}).notNull(),
		authorId: text("author_id"),
		body: text("body").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_work_item_comments_work_item").on(table.workItemId),
		index("idx_work_item_comments_org").on(table.orgId),
	],
);

export type WorkItemComment = typeof workItemComments.$inferSelect;
export type NewWorkItemComment = typeof workItemComments.$inferInsert;

/**
 * Principal-deduplicated evidence that an accountable actor independently
 * encountered and confirmed an existing Work Item. Comments remain the display
 * thread; only this credential-derived ledger affects ranking.
 */
export const workItemCorroborations = sqliteTable(
	"work_item_corroborations",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "cascade" }),
		principalType: text("principal_type", {
			enum: WORK_ITEM_CORROBORATION_PRINCIPAL_TYPE_VALUES,
		}).notNull(),
		principalId: text("principal_id").notNull(),
		/** Session is audit provenance only and never participates in dedup. */
		sessionId: text("session_id"),
		evidenceRef: text("evidence_ref").notNull(),
		/**
		 * Deliberately NOT part of the dedup target below: a principal counts
		 * once per Work Item, and may change its mind without counting twice.
		 */
		stance: text("stance", { enum: WORK_ITEM_CORROBORATION_STANCE_VALUES })
			.notNull()
			.default("corroborates"),
		body: text("body").notNull(),
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		foreignKey({
			name: "fk_work_item_corroboration_item_org",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		uniqueIndex("uniq_work_item_corroboration_principal").on(
			table.orgId,
			table.workItemId,
			table.principalType,
			table.principalId,
		),
		check(
			"chk_work_item_corroboration_principal_type",
			sql`${table.principalType} IN ('user', 'organization', 'tedi', 'external_agent')`,
		),
		check(
			"chk_work_item_corroboration_identity",
			sql`length(${table.principalId}) > 0 AND length(${table.evidenceRef}) > 0`,
		),
	],
);

export type WorkItemCorroboration = typeof workItemCorroborations.$inferSelect;
export type NewWorkItemCorroboration =
	typeof workItemCorroborations.$inferInsert;

export const workItemRelations = sqliteTable(
	"work_item_relations",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		fromWorkItemId: text("from_work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "cascade" }),
		toWorkItemId: text("to_work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "cascade" }),
		relationType: text("relation_type", {
			enum: WORK_ITEM_RELATION_TYPE_VALUES,
		}).notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_work_item_relations_org").on(table.orgId),
		index("idx_work_item_relations_to").on(table.toWorkItemId),
		uniqueIndex("uniq_work_item_relation").on(
			table.fromWorkItemId,
			table.toWorkItemId,
			table.relationType,
		),
	],
);

export type WorkItemRelation = typeof workItemRelations.$inferSelect;
export type NewWorkItemRelation = typeof workItemRelations.$inferInsert;

export const workAttempts = sqliteTable(
	"work_attempts",
	{
		id: text("id").primaryKey(),
		admissionId: text("admission_id"),
		workItemId: text("work_item_id").notNull(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		executorType: text("executor_type", {
			enum: WORK_EXECUTOR_TYPE_VALUES,
		}).notNull(),
		executorId: text("executor_id").notNull(),
		executorSessionId: text("executor_session_id"),
		externalSessionKey: text("external_session_key"),
		runId: text("run_id"),
		runtimeState: text("runtime_state", {
			enum: WORK_ATTEMPT_RUNTIME_STATE_VALUES,
		})
			.notNull()
			.default("running"),
		outcome: text("outcome", { enum: WORK_ATTEMPT_OUTCOME_VALUES }),
		attemptNumber: integer("attempt_number").notNull(),
		startedAt: text("started_at").notNull(),
		heartbeatAt: text("heartbeat_at").notNull(),
		expiresAt: text("expires_at"),
		finishedAt: text("finished_at"),
		summary: text("summary"),
		version: integer("version").notNull().default(1),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
	},
	(table) => [
		foreignKey({
			name: "fk_work_attempt_item_org",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		uniqueIndex("uniq_work_attempt_number").on(
			table.orgId,
			table.workItemId,
			table.attemptNumber,
		),
		uniqueIndex("uniq_work_attempt_admission").on(table.admissionId),
		uniqueIndex("uniq_work_attempt_active")
			.on(table.orgId, table.workItemId)
			.where(
				sql`${table.runtimeState} IN ('queued', 'running', 'waiting', 'retrying')`,
			),
		index("idx_work_attempt_executor_state").on(
			table.orgId,
			table.executorType,
			table.executorId,
			table.runtimeState,
		),
		index("idx_work_attempt_expiry").on(table.runtimeState, table.expiresAt),
		index("idx_work_attempt_org_started").on(table.orgId, table.startedAt),
		index("idx_work_attempt_org_item_started").on(
			table.orgId,
			table.workItemId,
			sql`started_at DESC`,
			sql`id DESC`,
		),
		// Live-Attempt lists filter by runtime state; through org_started they
		// walked every Attempt the organization ever made.
		index("idx_work_attempt_org_state_started").on(
			table.orgId,
			table.runtimeState,
			table.startedAt,
		),
		check(
			"chk_work_attempt_identity",
			sql`(${table.executorType} = 'tedi' AND ${table.executorSessionId} IS NULL AND ${table.externalSessionKey} IS NULL) OR (${table.executorType} = 'external_agent' AND ${table.executorSessionId} IS NOT NULL AND ${table.externalSessionKey} IS NOT NULL)`,
		),
		check(
			"chk_work_attempt_terminal_state",
			sql`(${table.runtimeState} IN ('failed', 'expired', 'finished', 'cancelled') AND ${table.finishedAt} IS NOT NULL AND ${table.outcome} IS NOT NULL) OR (${table.runtimeState} IN ('queued', 'running', 'waiting', 'retrying') AND ${table.finishedAt} IS NULL AND ${table.outcome} IS NULL)`,
		),
	],
);

export type WorkAttempt = typeof workAttempts.$inferSelect;
export type NewWorkAttempt = typeof workAttempts.$inferInsert;

export const workEvidence = sqliteTable(
	"work_evidence",
	{
		id: text("id").primaryKey(),
		workItemId: text("work_item_id").notNull(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		attemptId: text("attempt_id").references(() => workAttempts.id, {
			onDelete: "set null",
		}),
		claimKey: text("claim_key").notNull(),
		kind: text("kind").notNull(),
		uri: text("uri").notNull(),
		digest: text("digest"),
		mediaType: text("media_type"),
		label: text("label"),
		submittedByType: text("submitted_by_type", {
			enum: WORK_ACTOR_TYPE_VALUES,
		}).notNull(),
		submittedById: text("submitted_by_id").notNull(),
		submittedBySessionId: text("submitted_by_session_id"),
		disposition: text("disposition", {
			enum: WORK_EVIDENCE_DISPOSITION_VALUES,
		})
			.notNull()
			.default("pending"),
		reviewedByType: text("reviewed_by_type", {
			enum: WORK_ACTOR_TYPE_VALUES,
		}),
		reviewedById: text("reviewed_by_id"),
		reviewedBySessionId: text("reviewed_by_session_id"),
		reviewReason: text("review_reason"),
		submittedAt: text("submitted_at").notNull(),
		reviewedAt: text("reviewed_at"),
		version: integer("version").notNull().default(1),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
	},
	(table) => [
		foreignKey({
			name: "fk_work_evidence_item_org",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		index("idx_work_evidence_item_disposition").on(
			table.orgId,
			table.workItemId,
			table.disposition,
		),
		index("idx_work_evidence_attempt").on(table.attemptId),
		uniqueIndex("uniq_work_evidence_observation").on(
			table.orgId,
			table.workItemId,
			table.claimKey,
			table.uri,
			sql`coalesce(${table.digest}, '')`,
		),
		check(
			"chk_work_evidence_review_state",
			sql`(${table.disposition} = 'pending' AND ${table.reviewedAt} IS NULL AND ${table.reviewedByType} IS NULL AND ${table.reviewedById} IS NULL) OR (${table.disposition} != 'pending' AND ${table.reviewedAt} IS NOT NULL AND ${table.reviewedByType} IS NOT NULL AND ${table.reviewedById} IS NOT NULL)`,
		),
	],
);

export type WorkEvidence = typeof workEvidence.$inferSelect;
export type NewWorkEvidence = typeof workEvidence.$inferInsert;

export const workEvents = sqliteTable(
	"work_events",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		id: text("id").notNull().unique(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		// Maintained from the current item by migration-installed triggers.
		projectId: text("project_id"),
		objectiveId: text("objective_id"),
		attemptId: text("attempt_id").references(() => workAttempts.id, {
			onDelete: "set null",
		}),
		eventType: text("event_type").notNull(),
		actorType: text("actor_type", {
			enum: WORK_ACTOR_TYPE_VALUES,
		}).notNull(),
		actorId: text("actor_id").notNull(),
		actorSessionId: text("actor_session_id"),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		occurredAt: text("occurred_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_event_item_org",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		// Global commitment polling filters time before joining Work and tedis.
		index("idx_work_events_occurred").on(table.occurredAt),
		// History indexes include the tie breaker to avoid sorting a feed page.
		index("idx_work_events_org_occurred").on(
			table.orgId,
			table.occurredAt,
			table.id,
		),
		index("idx_work_events_project_occurred").on(
			table.orgId,
			table.projectId,
			table.occurredAt,
			table.id,
		),
		index("idx_work_events_objective_occurred").on(
			table.orgId,
			table.objectiveId,
			table.occurredAt,
			table.id,
		),
		index("idx_work_events_project_sequence").on(
			table.orgId,
			table.projectId,
			table.sequence,
		),
		index("idx_work_events_objective_sequence").on(
			table.orgId,
			table.objectiveId,
			table.sequence,
		),
		index("idx_work_events_item_sequence").on(
			table.orgId,
			table.workItemId,
			table.sequence,
		),
		index("idx_work_events_attempt_sequence").on(
			table.attemptId,
			table.sequence,
		),
		// Agent side-effect policy reads one event type per org on every call.
		index("idx_work_events_org_type_actor").on(
			table.orgId,
			table.eventType,
			table.actorType,
		),
		// The Office timeline reads a few event types inside a time window per org.
		index("idx_work_events_org_type_occurred").on(
			table.orgId,
			table.eventType,
			table.occurredAt,
		),
		// The lease sweep reads stopped lanes across tenants in sequence order.
		// The platform-wide personal-agent email sweep has no org; without this it
		// scanned every work event on each run (99k rows per call on 7 Nov).
		index("idx_work_events_personal_outcome_sequence")
			.on(table.sequence)
			.where(sql`event_type = 'personal_agent.outcome_recorded'`),
		index("idx_work_events_stopped_lane_sequence")
			.on(table.sequence)
			.where(sql`event_type IN ('lane.stale', 'attempt.expired')`),
	],
);

export type WorkEvent = typeof workEvents.$inferSelect;
export type NewWorkEvent = typeof workEvents.$inferInsert;

export const workItemProjections = sqliteTable(
	"work_item_projections",
	{
		id: text("id").primaryKey(),
		workItemId: text("work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		provider: text("provider").notNull(),
		direction: text("direction", {
			enum: WORK_ITEM_PROJECTION_DIRECTION_VALUES,
		})
			.notNull()
			.default("projection"),
		status: text("status", { enum: WORK_ITEM_PROJECTION_STATUS_VALUES })
			.notNull()
			.default("pending"),
		externalId: text("external_id"),
		externalUrl: text("external_url"),
		externalProjectId: text("external_project_id"),
		externalSectionId: text("external_section_id"),
		lastSyncedAt: text("last_synced_at"),
		lastError: text("last_error"),
		syncCursor: text("sync_cursor"),
		providerState: text("provider_state", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
	},
	(table) => [
		index("idx_work_item_projections_org_provider").on(
			table.orgId,
			table.provider,
		),
		uniqueIndex("uniq_work_item_projection_provider").on(
			table.workItemId,
			table.provider,
		),
	],
);

export type WorkItemProjection = typeof workItemProjections.$inferSelect;
export type NewWorkItemProjection = typeof workItemProjections.$inferInsert;

/**
 * RETIRED SYSTEM-AUTHORED CORROBORATION OF ONE EVIDENCE ROW.
 *
 * Nothing writes or reads this table any more. The independent evidence-review
 * plane it fed — the leased tedi reviewer, the readback verifiers, and the
 * corroboration projection on the inbox — was deleted under
 * `decisions/minimal-gates-over-pre-proof.md`, which found that the
 * mechanical gates caught 0 of 34 production rejections while carrying
 * essentially all of the friction.
 *
 * The DEFINITION stays because the rows do. Dropping a SQLite table means
 * rebuilding it and every table that references it, and the historical
 * observations remain readable, org-scoped history. Orphan rows are harmless;
 * a migration to remove them is not.
 *
 * A row means: "at `observed_at`, component `verifier_id`, acting as the
 * platform and never as the executor, went and looked, and this is what it
 * saw." `claimed` is what the evidence row asserted; `observed` is what the
 * verifier independently read; `matches_claim` is the comparison of the two.
 *
 * Do not repoint anything at this table without an incident that earns the
 * check back (see the ADR's revisit trigger).
 */
export const workEvidenceVerifications = sqliteTable(
	"work_evidence_verifications",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		/** The exact evidence row this observation corroborates or contradicts. */
		evidenceId: text("evidence_id")
			.notNull()
			.references(() => workEvidence.id, { onDelete: "cascade" }),
		/**
		 * The observing component, e.g. `deployment_readback`. It is part of the
		 * uniqueness key so one source cannot restate itself, while a genuinely
		 * second source may still corroborate the same row.
		 */
		source: text("source").notNull(),
		/**
		 * Always `system`. A verification authored by the principal that submitted
		 * the evidence would be the self-assertion this table exists to replace;
		 * the query owner rejects that case before the insert is built and this
		 * CHECK makes the storage layer say the same thing.
		 */
		verifierType: text("verifier_type", { enum: WORK_ACTOR_TYPE_VALUES })
			.notNull()
			.default("system"),
		verifierId: text("verifier_id").notNull(),
		/** What the evidence row asserted, as the verifier resolved it. */
		claimed: text("claimed", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		/** What the verifier independently read. */
		observed: text("observed", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		matchesClaim: integer("matches_claim", { mode: "boolean" }).notNull(),
		observedAt: text("observed_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_evidence_verification_item_org",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		uniqueIndex("uniq_work_evidence_verification_source").on(
			table.orgId,
			table.evidenceId,
			table.source,
		),
		index("idx_work_evidence_verifications_item").on(
			table.orgId,
			table.workItemId,
		),
		check(
			"chk_work_evidence_verification_system_authored",
			sql`${table.verifierType} = 'system'`,
		),
	],
);

export type WorkEvidenceVerification =
	typeof workEvidenceVerifications.$inferSelect;
export type NewWorkEvidenceVerification =
	typeof workEvidenceVerifications.$inferInsert;

export const WORK_ATTEMPT_STEP_KIND_VALUES = [
	"started",
	"message",
	"command",
	"tool",
	"file_change",
	"error",
	"follow_up",
	"question",
	"stopped",
	"finished",
] as const;
export type WorkAttemptStepKind =
	(typeof WORK_ATTEMPT_STEP_KIND_VALUES)[number];

/** One row per step a run reports while it works on a Work Item. */
export const workAttemptSteps = sqliteTable(
	"work_attempt_steps",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		attemptId: text("attempt_id").notNull(),
		seq: integer("seq").notNull(),
		/** When the step happened on the runner, in epoch milliseconds. */
		at: integer("at").notNull(),
		kind: text("kind", { enum: WORK_ATTEMPT_STEP_KIND_VALUES }).notNull(),
		text: text("text").notNull(),
		/** The short answers a `question` step offers; null for any other step. */
		choices: text("choices", { mode: "json" }).$type<string[]>(),
	},
	(table) => [
		uniqueIndex("uniq_work_attempt_step_seq").on(table.attemptId, table.seq),
		index("idx_work_attempt_steps_item_attempt_seq").on(
			table.workItemId,
			table.attemptId,
			table.seq,
		),
	],
);

export type WorkAttemptStepRow = typeof workAttemptSteps.$inferSelect;
export type NewWorkAttemptStepRow = typeof workAttemptSteps.$inferInsert;

export const WORK_ATTEMPT_MESSAGE_KIND_VALUES = ["follow_up", "stop"] as const;
export type WorkAttemptMessageKind =
	(typeof WORK_ATTEMPT_MESSAGE_KIND_VALUES)[number];

export const WORK_ATTEMPT_MESSAGE_SENDER_TYPE_VALUES = [
	"user",
	"tedi",
	"external_agent",
] as const;
export type WorkAttemptMessageSenderType =
	(typeof WORK_ATTEMPT_MESSAGE_SENDER_TYPE_VALUES)[number];

/** What a person or tedi sends to a run in progress: a follow-up or a stop. */
export const workAttemptMessages = sqliteTable(
	"work_attempt_messages",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		attemptId: text("attempt_id").notNull(),
		kind: text("kind", { enum: WORK_ATTEMPT_MESSAGE_KIND_VALUES }).notNull(),
		body: text("body").notNull().default(""),
		senderType: text("sender_type", {
			enum: WORK_ATTEMPT_MESSAGE_SENDER_TYPE_VALUES,
		}).notNull(),
		senderId: text("sender_id").notNull(),
		/**
		 * A follow-up that should not wait for the agent's current turn: the
		 * runner stops that turn and starts the next one with this message.
		 */
		interrupt: integer("interrupt", { mode: "boolean" })
			.notNull()
			.default(false),
		createdAt: text("created_at").notNull(),
		/** Set when the runner holding the Attempt has received the message. */
		deliveredAt: text("delivered_at"),
		/** Set when the runner reports that it acted on the message. */
		appliedAt: text("applied_at"),
	},
	(table) => [
		index("idx_work_attempt_messages_attempt_delivered").on(
			table.attemptId,
			table.deliveredAt,
		),
	],
);

export type WorkAttemptMessageRow = typeof workAttemptMessages.$inferSelect;
export type NewWorkAttemptMessageRow = typeof workAttemptMessages.$inferInsert;
