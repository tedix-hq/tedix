/**
 * Provider-neutral work coordination.
 *
 * Work Items are Tedix-owned issue threads. They persist accepted work across
 * conversations, TaskFlow runtime state, and external task/project providers.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
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

/** Credential-derived actor authorized by one fenced Work Item attempt. */
export const WORK_ITEM_EXECUTOR_TYPE_VALUES = [
	"tedi",
	"external_agent",
] as const;
export type WorkItemExecutorType =
	(typeof WORK_ITEM_EXECUTOR_TYPE_VALUES)[number];

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
		sourceSessionKey: text("source_session_key"),
		sourceIntentId: text("source_intent_id"),
		dueDate: text("due_date"),
		deadline: text("deadline"),
		startAt: text("start_at"),
		durationDays: integer("duration_days"),
		provenance: text("provenance", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),
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
		index("idx_work_items_org_created").on(table.orgId, table.createdAt),
		index("idx_work_items_org_disposition").on(table.orgId, table.disposition),
		index("idx_work_items_org_kind_risk").on(
			table.orgId,
			table.workKind,
			table.riskLevel,
		),
		index("idx_work_items_project").on(table.projectId),
		index("idx_work_items_parent").on(table.parentWorkItemId),
		index("idx_work_items_accountable_owner").on(
			table.orgId,
			table.accountableOwnerType,
			table.accountableOwnerId,
		),
		index("idx_work_items_objective").on(table.objectiveId),
		index("idx_work_items_org_class").on(table.orgId, table.workClass),
		index("idx_work_items_source_intent").on(table.sourceIntentId),
		uniqueIndex("uniq_work_items_org_source_intent").on(
			table.orgId,
			table.sourceIntentId,
		),
	],
);

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;

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

export const WORK_ITEM_INBOX_RECIPIENT_TYPE_VALUES = [
	"agent_session",
	"tedi",
	"user",
] as const;
export type WorkItemInboxRecipientType =
	(typeof WORK_ITEM_INBOX_RECIPIENT_TYPE_VALUES)[number];

/**
 * Durable board-write outbox. `sequence` is the stable keyset cursor exposed to
 * inbox consumers; payloads are notification hints and never replace the
 * canonical Work Item/comment read.
 */
export const workItemOutboxEvents = sqliteTable(
	"work_item_outbox_events",
	{
		sequence: integer("sequence").primaryKey({ autoIncrement: true }),
		id: text("id").notNull().unique(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "cascade" }),
		eventType: text("event_type").notNull(),
		sourceSessionKey: text("source_session_key"),
		sourceAuthorType: text("source_author_type"),
		sourceAuthorId: text("source_author_id"),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_work_item_outbox_org_sequence").on(table.orgId, table.sequence),
		index("idx_work_item_outbox_item").on(table.workItemId, table.sequence),
	],
);

export type WorkItemOutboxEvent = typeof workItemOutboxEvents.$inferSelect;

/** One idempotent recipient projection of an outbox event. */
export const workItemInboxDeliveries = sqliteTable(
	"work_item_inbox_deliveries",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		eventSequence: integer("event_sequence")
			.notNull()
			.references(() => workItemOutboxEvents.sequence, { onDelete: "cascade" }),
		recipientType: text("recipient_type", {
			enum: WORK_ITEM_INBOX_RECIPIENT_TYPE_VALUES,
		}).notNull(),
		recipientId: text("recipient_id").notNull(),
		acknowledgedAt: text("acknowledged_at"),
		acknowledgedBy: text("acknowledged_by"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_work_item_inbox_event_recipient").on(
			table.eventSequence,
			table.recipientType,
			table.recipientId,
		),
		index("idx_work_item_inbox_recipient_cursor").on(
			table.orgId,
			table.recipientType,
			table.recipientId,
			table.eventSequence,
		),
		index("idx_work_item_inbox_unread").on(
			table.orgId,
			table.recipientId,
			table.acknowledgedAt,
		),
	],
);

export type WorkItemInboxDelivery = typeof workItemInboxDeliveries.$inferSelect;

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
			enum: WORK_ITEM_EXECUTOR_TYPE_VALUES,
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
		index("idx_work_events_item_sequence").on(
			table.orgId,
			table.workItemId,
			table.sequence,
		),
		index("idx_work_events_attempt_sequence").on(
			table.attemptId,
			table.sequence,
		),
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
 * Write-once certification that a specific commit sha was accepted as a governed
 * Git shipment.
 *
 * WHY THIS IS A TABLE AND NOT A METADATA KEY. Certification used to live only as
 * `work_items.metadata.proofCertifiedAt`, which made it a re-derivable opinion
 * rather than a fact: the deploy gate re-ran its admission predicates over the
 * whole undeployed range on every push, so shipping a stricter policy
 * retroactively disqualified commits that had already passed. That is exactly
 * what happened when the posthumous-override gate (c993b0052) deployed mid-day
 * and preflight began throwing on 9c46a1dde — a commit whose identical inputs
 * had passed the same validator twenty minutes earlier. Metadata is also
 * mutable, sweepable and expirable; a row keyed on the sha is none of those.
 *
 * The contract is deliberately narrow: INSERT ... ON CONFLICT DO NOTHING, no
 * UPDATE path, no DELETE path. Once a sha is certified it stays certified, and
 * the gate's first question becomes "is this sha already certified?" instead of
 * "would this sha pass today's policy?".
 */
export const workItemCommitCertifications = sqliteTable(
	"work_item_commit_certifications",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		/** Lowercase 40-char git sha. Unique per org — the certification key. */
		commitSha: text("commit_sha").notNull(),
		workItemId: text("work_item_id").notNull(),
		/** Harness-prefixed external session key, e.g. `claude-code:<uuid>`. */
		agentSession: text("agent_session"),
		/** Set when the shipment was admitted via an operator override. */
		operatorOverrideCommentId: text("operator_override_comment_id"),
		/** How the shipment was admitted by the canonical certification policy. */
		mode: text("mode", {
			enum: ["external_agent", "operator_override", "tedi"],
		}).notNull(),
		certifiedAt: text("certified_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_item_commit_certification_item_org",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		// THE invariant: one certification per (org, sha, ITEM). The work item is
		// part of the key because a single commit may carry several `Work-Item:`
		// trailers and must settle each of them independently — keying on the sha
		// alone would let the first item's certification suppress settlement of
		// every other item on the same commit.
		uniqueIndex("uniq_work_item_commit_certification_sha").on(
			table.orgId,
			table.commitSha,
			table.workItemId,
		),
		index("idx_work_item_commit_certifications_item").on(table.workItemId),
		check(
			"chk_work_item_commit_certification_sha",
			sql`length(${table.commitSha}) = 40`,
		),
	],
);

export type WorkItemCommitCertification =
	typeof workItemCommitCertifications.$inferSelect;
export type NewWorkItemCommitCertification =
	typeof workItemCommitCertifications.$inferInsert;

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
