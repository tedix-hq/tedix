/**
 * Artifact-neutral work-factory control plane.
 *
 * These records deliberately separate portfolio structure, human/agent
 * interaction, governance, admission, and execution capacity from the Work
 * Item business lifecycle. Immutable receipt tables are additionally fenced
 * by D1 triggers in the owning migration.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { projects } from "./projects";
import { workAttempts, workItems } from "./work-items";

export const WORK_CASE_STAGE_VALUES = [
	"investigating",
	"planning",
	"executing",
	"monitoring",
	"closed",
] as const;
export type WorkCaseStage = (typeof WORK_CASE_STAGE_VALUES)[number];

export const WORK_MILESTONE_STATUS_VALUES = [
	"proposed",
	"planned",
	"active",
	"done",
	"cancelled",
] as const;
export type WorkMilestoneStatus = (typeof WORK_MILESTONE_STATUS_VALUES)[number];

export const WORK_SPRINT_STATUS_VALUES = [
	"planned",
	"active",
	"completed",
	"cancelled",
] as const;
export type WorkSprintStatus = (typeof WORK_SPRINT_STATUS_VALUES)[number];

export const WORK_HEALTH_STATUS_VALUES = [
	"on_track",
	"at_risk",
	"off_track",
	"paused",
] as const;
export type WorkHealthStatus = (typeof WORK_HEALTH_STATUS_VALUES)[number];

export const WORK_APPROVAL_PROPOSAL_STATUS_VALUES = [
	"pending",
	"approved",
	"rejected",
	"cancelled",
	"expired",
] as const;
export type WorkApprovalProposalStatus =
	(typeof WORK_APPROVAL_PROPOSAL_STATUS_VALUES)[number];

export const WORK_INTERACTION_KIND_VALUES = [
	"question",
	"input",
	"handoff",
	"coordination",
] as const;
export type WorkInteractionKind = (typeof WORK_INTERACTION_KIND_VALUES)[number];

export const WORK_INTERACTION_STATUS_VALUES = [
	"open",
	"resolved",
	"cancelled",
	"expired",
] as const;
export type WorkInteractionStatus =
	(typeof WORK_INTERACTION_STATUS_VALUES)[number];

export const WORK_INTERACTION_TARGET_TYPE_VALUES = [
	"user",
	"tedi",
	"external_agent",
] as const;
export type WorkInteractionTargetType =
	(typeof WORK_INTERACTION_TARGET_TYPE_VALUES)[number];

export const WORK_INTERACTION_RESPONSE_KIND_VALUES = [
	"answer",
	"input_provided",
	"handoff_accepted",
	"handoff_declined",
	"coordination_update",
] as const;
export type WorkInteractionResponseKind =
	(typeof WORK_INTERACTION_RESPONSE_KIND_VALUES)[number];

export const WORK_ADMISSION_DECISION_VALUES = ["admitted", "rejected"] as const;
export type WorkAdmissionDecision =
	(typeof WORK_ADMISSION_DECISION_VALUES)[number];

export const WORK_RESERVATION_STATE_VALUES = [
	"active",
	"released",
	"consumed",
	"expired",
] as const;
export type WorkReservationState =
	(typeof WORK_RESERVATION_STATE_VALUES)[number];

export const WORK_BUDGET_SCOPE_VALUES = [
	"organization",
	"project",
	"case",
	"work_item",
] as const;
export type WorkBudgetScope = (typeof WORK_BUDGET_SCOPE_VALUES)[number];

export const workCases = sqliteTable(
	"work_cases",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: text("project_id"),
		objectiveId: text("objective_id"),
		title: text("title").notNull(),
		description: text("description"),
		kind: text("kind").notNull(),
		stage: text("stage", { enum: WORK_CASE_STAGE_VALUES })
			.notNull()
			.default("investigating"),
		accountableOwnerType: text("accountable_owner_type", {
			enum: ["user", "tedi", "system"] as const,
		}).notNull(),
		accountableOwnerId: text("accountable_owner_id").notNull(),
		openedAt: text("opened_at").notNull(),
		targetResolutionAt: text("target_resolution_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		closedAt: text("closed_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_cases_org_id").on(table.orgId, table.id),
		foreignKey({
			name: "fk_work_case_project",
			columns: [table.orgId, table.projectId],
			foreignColumns: [projects.orgId, projects.id],
		}).onDelete("restrict"),
		index("idx_work_cases_org_stage").on(
			table.orgId,
			table.stage,
			table.createdAt,
		),
		index("idx_work_cases_project").on(table.orgId, table.projectId),
		check("chk_work_case_owner", sql`length(${table.accountableOwnerId}) > 0`),
	],
);

export const workCaseDependencies = sqliteTable(
	"work_case_dependencies",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		prerequisiteCaseId: text("prerequisite_case_id").notNull(),
		dependentCaseId: text("dependent_case_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_case_dependency_from",
			columns: [table.orgId, table.prerequisiteCaseId],
			foreignColumns: [workCases.orgId, workCases.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_case_dependency_to",
			columns: [table.orgId, table.dependentCaseId],
			foreignColumns: [workCases.orgId, workCases.id],
		}).onDelete("cascade"),
		uniqueIndex("uniq_work_case_dependency").on(
			table.orgId,
			table.prerequisiteCaseId,
			table.dependentCaseId,
		),
		index("idx_work_case_dependency_to").on(table.orgId, table.dependentCaseId),
		check(
			"chk_work_case_dependency_not_self",
			sql`${table.prerequisiteCaseId} <> ${table.dependentCaseId}`,
		),
	],
);

export const workCaseItems = sqliteTable(
	"work_case_items",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		caseId: text("case_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		rationale: text("rationale"),
		discoveredAt: text("discovered_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_work_case_item").on(
			table.orgId,
			table.caseId,
			table.workItemId,
		),
		foreignKey({
			name: "fk_work_case_item_case",
			columns: [table.orgId, table.caseId],
			foreignColumns: [workCases.orgId, workCases.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_case_item_work",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		index("idx_work_case_items_work").on(table.orgId, table.workItemId),
	],
);

export const workMilestones = sqliteTable(
	"work_milestones",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		title: text("title").notNull(),
		description: text("description"),
		status: text("status", { enum: WORK_MILESTONE_STATUS_VALUES })
			.notNull()
			.default("proposed"),
		accountableOwnerType: text("accountable_owner_type", {
			enum: ["user", "tedi", "system"] as const,
		}).notNull(),
		accountableOwnerId: text("accountable_owner_id").notNull(),
		sortOrder: integer("sort_order").notNull().default(0),
		targetAt: text("target_at"),
		proofRef: text("proof_ref"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		doneAt: text("done_at"),
		cancelledAt: text("cancelled_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_milestones_org_id").on(table.orgId, table.id),
		foreignKey({
			name: "fk_work_milestone_project",
			columns: [table.orgId, table.projectId],
			foreignColumns: [projects.orgId, projects.id],
		}).onDelete("cascade"),
		index("idx_work_milestones_project_status").on(
			table.orgId,
			table.projectId,
			table.status,
		),
	],
);

export const workMilestoneDependencies = sqliteTable(
	"work_milestone_dependencies",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		prerequisiteMilestoneId: text("prerequisite_milestone_id").notNull(),
		dependentMilestoneId: text("dependent_milestone_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_milestone_dependency_from",
			columns: [table.orgId, table.prerequisiteMilestoneId],
			foreignColumns: [workMilestones.orgId, workMilestones.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_milestone_dependency_to",
			columns: [table.orgId, table.dependentMilestoneId],
			foreignColumns: [workMilestones.orgId, workMilestones.id],
		}).onDelete("cascade"),
		uniqueIndex("uniq_work_milestone_dependency").on(
			table.orgId,
			table.prerequisiteMilestoneId,
			table.dependentMilestoneId,
		),
		index("idx_work_milestone_dependency_to").on(
			table.orgId,
			table.dependentMilestoneId,
		),
		check(
			"chk_work_milestone_dependency_not_self",
			sql`${table.prerequisiteMilestoneId} <> ${table.dependentMilestoneId}`,
		),
	],
);

export const workMilestoneItems = sqliteTable(
	"work_milestone_items",
	{
		orgId: text("org_id").notNull(),
		milestoneId: text("milestone_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.milestoneId, table.workItemId] }),
		foreignKey({
			name: "fk_work_milestone_item_milestone",
			columns: [table.orgId, table.milestoneId],
			foreignColumns: [workMilestones.orgId, workMilestones.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_milestone_item_work",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		index("idx_work_milestone_items_work").on(table.orgId, table.workItemId),
	],
);

export const workSprints = sqliteTable(
	"work_sprints",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		name: text("name").notNull(),
		goal: text("goal"),
		status: text("status", { enum: WORK_SPRINT_STATUS_VALUES })
			.notNull()
			.default("planned"),
		startAt: text("start_at").notNull(),
		endAt: text("end_at").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_sprints_org_id").on(table.orgId, table.id),
		foreignKey({
			name: "fk_work_sprint_project",
			columns: [table.orgId, table.projectId],
			foreignColumns: [projects.orgId, projects.id],
		}).onDelete("cascade"),
		index("idx_work_sprints_project_start").on(
			table.orgId,
			table.projectId,
			table.startAt,
		),
		check("chk_work_sprint_dates", sql`${table.endAt} >= ${table.startAt}`),
	],
);

export const workSprintItems = sqliteTable(
	"work_sprint_items",
	{
		orgId: text("org_id").notNull(),
		sprintId: text("sprint_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.sprintId, table.workItemId] }),
		foreignKey({
			name: "fk_work_sprint_item_sprint",
			columns: [table.orgId, table.sprintId],
			foreignColumns: [workSprints.orgId, workSprints.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_sprint_item_work",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		index("idx_work_sprint_items_work").on(table.orgId, table.workItemId),
	],
);

export const workProjectHealthJudgments = sqliteTable(
	"work_project_health_judgments",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: text("project_id").notNull(),
		status: text("status", { enum: WORK_HEALTH_STATUS_VALUES }).notNull(),
		summary: text("summary").notNull(),
		targetAt: text("target_at"),
		actorType: text("actor_type", {
			enum: ["user", "tedi", "external_agent", "system"] as const,
		}).notNull(),
		actorId: text("actor_id").notNull(),
		actorSessionId: text("actor_session_id"),
		actorExternalSessionKey: text("actor_external_session_key"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		observedAt: text("observed_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_project_health_project",
			columns: [table.orgId, table.projectId],
			foreignColumns: [projects.orgId, projects.id],
		}).onDelete("restrict"),
		index("idx_work_project_health_observed").on(
			table.orgId,
			table.projectId,
			table.observedAt,
		),
	],
);

export const workApprovalProposals = sqliteTable(
	"work_approval_proposals",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		workItemVersion: integer("work_item_version").notNull(),
		authorityKey: text("authority_key").notNull(),
		action: text("action").notNull(),
		proposal: text("proposal", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		requesterType: text("requester_type", {
			enum: ["user", "tedi", "external_agent", "system"] as const,
		}).notNull(),
		requesterId: text("requester_id").notNull(),
		requesterSessionId: text("requester_session_id"),
		requesterExternalSessionKey: text("requester_external_session_key"),
		approverType: text("approver_type", {
			enum: ["user", "tedi"] as const,
		}).notNull(),
		approverId: text("approver_id").notNull(),
		status: text("status", { enum: WORK_APPROVAL_PROPOSAL_STATUS_VALUES })
			.notNull()
			.default("pending"),
		rationale: text("rationale").notNull(),
		expiresAt: text("expires_at").notNull(),
		resolutionFence: text("resolution_fence"),
		createdAt: text("created_at").notNull(),
		resolvedAt: text("resolved_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		foreignKey({
			name: "fk_work_approval_proposal_item",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		uniqueIndex("uniq_work_approval_pending_scope")
			.on(
				table.orgId,
				table.workItemId,
				table.workItemVersion,
				table.authorityKey,
				table.action,
				table.approverType,
				table.approverId,
			)
			.where(sql`${table.status} = 'pending'`),
		index("idx_work_approval_approver_status").on(
			table.orgId,
			table.approverType,
			table.approverId,
			table.status,
		),
	],
);

export const workApprovalDecisions = sqliteTable(
	"work_approval_decisions",
	{
		id: text("id").primaryKey(),
		proposalId: text("proposal_id")
			.notNull()
			.references(() => workApprovalProposals.id, { onDelete: "restrict" }),
		resolvedProposalVersion: integer("resolved_proposal_version").notNull(),
		decision: text("decision", {
			enum: ["approved", "rejected"] as const,
		}).notNull(),
		deciderType: text("decider_type", {
			enum: ["user", "tedi"] as const,
		}).notNull(),
		deciderId: text("decider_id").notNull(),
		rationale: text("rationale").notNull(),
		decidedAt: text("decided_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_work_approval_decision_proposal").on(table.proposalId),
		index("idx_work_approval_decisions_time").on(table.decidedAt),
	],
);

export const workInteractions = sqliteTable(
	"work_interactions",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id"),
		caseId: text("case_id"),
		projectId: text("project_id"),
		kind: text("kind", { enum: WORK_INTERACTION_KIND_VALUES }).notNull(),
		status: text("status", { enum: WORK_INTERACTION_STATUS_VALUES })
			.notNull()
			.default("open"),
		subject: text("subject").notNull(),
		prompt: text("prompt").notNull(),
		creatorType: text("creator_type", {
			enum: ["user", "tedi", "external_agent", "system"] as const,
		}).notNull(),
		creatorId: text("creator_id").notNull(),
		creatorSessionId: text("creator_session_id"),
		creatorExternalSessionKey: text("creator_external_session_key"),
		targetType: text("target_type", {
			enum: WORK_INTERACTION_TARGET_TYPE_VALUES,
		}),
		targetId: text("target_id"),
		dueAt: text("due_at"),
		expiresAt: text("expires_at"),
		resolutionFence: text("resolution_fence"),
		createdAt: text("created_at").notNull(),
		resolvedAt: text("resolved_at"),
		cancelledAt: text("cancelled_at"),
		expiredAt: text("expired_at"),
		version: integer("version").notNull().default(1),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
	},
	(table) => [
		uniqueIndex("uniq_work_interactions_org_id").on(table.orgId, table.id),
		foreignKey({
			name: "fk_work_interaction_item",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_interaction_case",
			columns: [table.orgId, table.caseId],
			foreignColumns: [workCases.orgId, workCases.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_interaction_project",
			columns: [table.orgId, table.projectId],
			foreignColumns: [projects.orgId, projects.id],
		}).onDelete("cascade"),
		index("idx_work_interactions_target_status").on(
			table.orgId,
			table.targetType,
			table.targetId,
			table.status,
			table.createdAt,
		),
		index("idx_work_interactions_work").on(
			table.orgId,
			table.workItemId,
			table.createdAt,
		),
		check(
			"chk_work_interaction_context",
			sql`${table.workItemId} IS NOT NULL OR ${table.caseId} IS NOT NULL OR ${table.projectId} IS NOT NULL`,
		),
	],
);

export const workInteractionResponses = sqliteTable(
	"work_interaction_responses",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		interactionId: text("interaction_id").notNull(),
		resolvedRequestVersion: integer("resolved_request_version").notNull(),
		resolutionFence: text("resolution_fence").notNull(),
		responderType: text("responder_type", {
			enum: WORK_INTERACTION_TARGET_TYPE_VALUES,
		}).notNull(),
		responderId: text("responder_id").notNull(),
		responderSessionId: text("responder_session_id"),
		responderExternalSessionKey: text("responder_external_session_key"),
		body: text("body").notNull(),
		responseKind: text("response_kind", {
			enum: WORK_INTERACTION_RESPONSE_KIND_VALUES,
		}).notNull(),
		artifactRef: text("artifact_ref"),
		artifactVersion: text("artifact_version"),
		artifactDigest: text("artifact_digest"),
		resolvesRequest: integer("resolves_request", { mode: "boolean" })
			.notNull()
			.default(false),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		respondedAt: text("responded_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_interaction_response_request",
			columns: [table.orgId, table.interactionId],
			foreignColumns: [workInteractions.orgId, workInteractions.id],
		}).onDelete("restrict"),
		index("idx_work_interaction_responses_cursor").on(
			table.orgId,
			table.interactionId,
			table.respondedAt,
			table.id,
		),
	],
);

export const workResourcePools = sqliteTable(
	"work_resource_pools",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		resourceKey: text("resource_key").notNull(),
		allocationMode: text("allocation_mode", {
			enum: ["exclusive", "capacity"] as const,
		}).notNull(),
		capacity: integer("capacity").notNull(),
		ownerRef: text("owner_ref"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_resource_pool_key").on(
			table.orgId,
			table.resourceKey,
		),
		uniqueIndex("uniq_work_resource_pool_org_id").on(table.orgId, table.id),
		check("chk_work_resource_pool_capacity", sql`${table.capacity} > 0`),
		check(
			"chk_work_resource_pool_mode",
			sql`${table.allocationMode} <> 'exclusive' OR ${table.capacity} = 1`,
		),
	],
);

export const workResourceRequirements = sqliteTable(
	"work_resource_requirements",
	{
		orgId: text("org_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		resourceKey: text("resource_key").notNull(),
		quantity: integer("quantity").notNull().default(1),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.orgId, table.workItemId, table.resourceKey] }),
		foreignKey({
			name: "fk_work_resource_requirement_item",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "fk_work_resource_requirement_pool",
			columns: [table.orgId, table.resourceKey],
			foreignColumns: [workResourcePools.orgId, workResourcePools.resourceKey],
		}).onDelete("restrict"),
		check("chk_work_resource_requirement_quantity", sql`${table.quantity} > 0`),
	],
);

export const workBudgetEnvelopes = sqliteTable(
	"work_budget_envelopes",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		scopeType: text("scope_type", { enum: WORK_BUDGET_SCOPE_VALUES }).notNull(),
		scopeId: text("scope_id").notNull(),
		limitMicros: integer("limit_micros").notNull(),
		reservationMicros: integer("reservation_micros").notNull(),
		currency: text("currency").notNull().default("USD"),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_budget_scope").on(
			table.orgId,
			table.scopeType,
			table.scopeId,
		),
		uniqueIndex("uniq_work_budget_org_id").on(table.orgId, table.id),
		index("idx_work_budget_org_enabled").on(table.orgId, table.enabled),
		check("chk_work_budget_limit", sql`${table.limitMicros} >= 0`),
		check(
			"chk_work_budget_reservation",
			sql`${table.reservationMicros} >= 0 AND ${table.reservationMicros} <= ${table.limitMicros}`,
		),
	],
);

export const workAdmissions = sqliteTable(
	"work_admissions",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		workItemVersion: integer("work_item_version").notNull(),
		admissionSpecRevision: text("admission_spec_revision").notNull(),
		executorType: text("executor_type", {
			enum: ["tedi", "external_agent"] as const,
		}).notNull(),
		executorId: text("executor_id").notNull(),
		executorSessionId: text("executor_session_id"),
		externalSessionKey: text("external_session_key"),
		decision: text("decision", {
			enum: WORK_ADMISSION_DECISION_VALUES,
		}).notNull(),
		rejectionCode: text("rejection_code"),
		rejectionReason: text("rejection_reason"),
		rejectionKey: text("rejection_key"),
		maxCostMicros: integer("max_cost_micros"),
		decidedAt: text("decided_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_work_admission_item",
			columns: [table.orgId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("restrict"),
		uniqueIndex("uniq_work_admission_org_item_id").on(
			table.orgId,
			table.workItemId,
			table.id,
		),
		uniqueIndex("uniq_work_admission_rejection_key").on(
			table.orgId,
			table.rejectionKey,
		),
		index("idx_work_admission_executor_time").on(
			table.orgId,
			table.executorType,
			table.executorId,
			table.createdAt,
		),
		index("idx_work_admission_item_time").on(
			table.orgId,
			table.workItemId,
			table.createdAt,
		),
		check(
			"chk_work_admission_identity",
			sql`(${table.executorType} = 'tedi' AND ${table.executorSessionId} IS NULL AND ${table.externalSessionKey} IS NULL) OR (${table.executorType} = 'external_agent' AND ${table.executorSessionId} IS NOT NULL AND ${table.externalSessionKey} IS NOT NULL)`,
		),
		check(
			"chk_work_admission_decision",
			sql`(${table.decision} = 'admitted' AND ${table.rejectionCode} IS NULL AND ${table.rejectionReason} IS NULL AND ${table.rejectionKey} IS NULL) OR (${table.decision} = 'rejected' AND ${table.rejectionCode} IS NOT NULL AND ${table.rejectionReason} IS NOT NULL AND ${table.rejectionKey} IS NOT NULL)`,
		),
	],
);

export const workResourceReservations = sqliteTable(
	"work_resource_reservations",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		admissionId: text("admission_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		poolId: text("pool_id").notNull(),
		poolVersion: integer("pool_version").notNull(),
		resourceKey: text("resource_key").notNull(),
		quantity: integer("quantity").notNull(),
		state: text("state", { enum: WORK_RESERVATION_STATE_VALUES })
			.notNull()
			.default("active"),
		reservedAt: text("reserved_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		settledAt: text("settled_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		foreignKey({
			name: "fk_work_resource_reservation_admission",
			columns: [table.orgId, table.workItemId, table.admissionId],
			foreignColumns: [
				workAdmissions.orgId,
				workAdmissions.workItemId,
				workAdmissions.id,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "fk_work_resource_reservation_pool",
			columns: [table.orgId, table.poolId],
			foreignColumns: [workResourcePools.orgId, workResourcePools.id],
		}).onDelete("restrict"),
		uniqueIndex("uniq_work_resource_reservation_admission_key").on(
			table.admissionId,
			table.resourceKey,
		),
		index("idx_work_resource_reservation_pool_active").on(
			table.orgId,
			table.poolId,
			table.state,
			table.expiresAt,
		),
		check("chk_work_resource_reservation_quantity", sql`${table.quantity} > 0`),
	],
);

export const workBudgetReservations = sqliteTable(
	"work_budget_reservations",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id").notNull(),
		admissionId: text("admission_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		envelopeId: text("envelope_id").notNull(),
		envelopeVersion: integer("envelope_version").notNull(),
		amountMicros: integer("amount_micros").notNull(),
		consumedMicros: integer("consumed_micros"),
		state: text("state", { enum: WORK_RESERVATION_STATE_VALUES })
			.notNull()
			.default("active"),
		reservedAt: text("reserved_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		settledAt: text("settled_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		foreignKey({
			name: "fk_work_budget_reservation_admission",
			columns: [table.orgId, table.workItemId, table.admissionId],
			foreignColumns: [
				workAdmissions.orgId,
				workAdmissions.workItemId,
				workAdmissions.id,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "fk_work_budget_reservation_envelope",
			columns: [table.orgId, table.envelopeId],
			foreignColumns: [workBudgetEnvelopes.orgId, workBudgetEnvelopes.id],
		}).onDelete("restrict"),
		uniqueIndex("uniq_work_budget_reservation_admission_envelope").on(
			table.admissionId,
			table.envelopeId,
		),
		index("idx_work_budget_reservation_envelope_active").on(
			table.orgId,
			table.envelopeId,
			table.state,
			table.expiresAt,
		),
		check(
			"chk_work_budget_reservation_amount",
			sql`${table.amountMicros} >= 0`,
		),
	],
);

export type WorkCase = typeof workCases.$inferSelect;
export type NewWorkCase = typeof workCases.$inferInsert;
export type WorkCaseDependency = typeof workCaseDependencies.$inferSelect;
export type WorkCaseItem = typeof workCaseItems.$inferSelect;
export type WorkMilestone = typeof workMilestones.$inferSelect;
export type NewWorkMilestone = typeof workMilestones.$inferInsert;
export type WorkMilestoneDependency =
	typeof workMilestoneDependencies.$inferSelect;
export type WorkMilestoneItem = typeof workMilestoneItems.$inferSelect;
export type WorkProjectHealthJudgment =
	typeof workProjectHealthJudgments.$inferSelect;
export type WorkApprovalProposal = typeof workApprovalProposals.$inferSelect;
export type WorkApprovalDecision = typeof workApprovalDecisions.$inferSelect;
export type WorkInteraction = typeof workInteractions.$inferSelect;
export type WorkInteractionResponse =
	typeof workInteractionResponses.$inferSelect;
export type WorkResourcePool = typeof workResourcePools.$inferSelect;
export type WorkResourceRequirement =
	typeof workResourceRequirements.$inferSelect;
export type WorkBudgetEnvelope = typeof workBudgetEnvelopes.$inferSelect;
export type WorkAdmission = typeof workAdmissions.$inferSelect;
export type WorkResourceReservation =
	typeof workResourceReservations.$inferSelect;
export type WorkBudgetReservation = typeof workBudgetReservations.$inferSelect;
