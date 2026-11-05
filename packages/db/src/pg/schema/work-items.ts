import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	bigint,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type { WorkItemAcceptanceContract } from "../../schema/work-items";
import { organizations } from "./organizations";

export const workItems = pgTable(
	"work_items",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		description: text("description"),
		disposition: text("disposition").notNull().default("proposed"),
		workKind: text("work_kind").notNull().default("other"),
		riskLevel: text("risk_level").notNull().default("medium"),
		acceptanceContract: jsonb(
			"acceptance_contract",
		).$type<WorkItemAcceptanceContract>(),
		requiredCapabilities: jsonb("required_capabilities")
			.$type<string[]>()
			.notNull()
			.default([]),
		requiredAuthorities: jsonb("required_authorities")
			.$type<string[]>()
			.notNull()
			.default([]),
		admissionSpecRevision: text("admission_spec_revision")
			.notNull()
			.default("legacy"),
		priority: text("priority").notNull().default("medium"),
		accountableOwnerType: text("accountable_owner_type"),
		accountableOwnerId: text("accountable_owner_id"),
		stewardType: text("steward_type"),
		stewardId: text("steward_id"),
		reviewerType: text("reviewer_type"),
		reviewerId: text("reviewer_id"),
		reviewerLeaseExpiresAt: text("reviewer_lease_expires_at"),
		objectiveId: text("objective_id"),
		workClass: text("work_class"),
		purposeExceptionExpiresAt: text("purpose_exception_expires_at"),
		projectId: text("project_id"),
		parentWorkItemId: text("parent_work_item_id"),
		sourceSessionKey: text("source_session_key"),
		sourceIntentId: text("source_intent_id"),
		dueDate: text("due_date"),
		deadline: text("deadline"),
		startAt: text("start_at"),
		durationDays: integer("duration_days"),
		provenance: jsonb("provenance")
			.$type<Record<string, JsonValue>>()
			.default({}),
		metadata: jsonb("metadata").$type<Record<string, JsonValue>>().default({}),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		acceptedAt: text("accepted_at"),
		completedAt: text("completed_at"),
		cancelledAt: text("cancelled_at"),
		version: integer("version").notNull().default(1),
	},
	(table) => [
		uniqueIndex("uniq_work_items_org_id").on(table.orgId, table.id),
		index("idx_work_items_org_created").on(table.orgId, table.createdAt),
		index("idx_work_items_org_disposition").on(table.orgId, table.disposition),
		index("idx_work_items_lane_executor").on(
			table.orgId,
			table.disposition,
			sql`(${table.metadata} ->> 'executor')`,
			table.createdAt,
			table.id,
		),
		index("idx_work_items_project").on(table.projectId),
		index("idx_work_items_parent").on(table.parentWorkItemId),
		uniqueIndex("uniq_work_items_org_source_intent").on(
			table.orgId,
			table.sourceIntentId,
		),
	],
);

export const workAdmissions = pgTable(
	"work_admissions",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id").notNull(),
		workItemVersion: integer("work_item_version").notNull(),
		admissionSpecRevision: text("admission_spec_revision").notNull(),
		executorType: text("executor_type").notNull(),
		executorId: text("executor_id").notNull(),
		executorSessionId: text("executor_session_id"),
		externalSessionKey: text("external_session_key"),
		decision: text("decision").notNull(),
		rejectionCode: text("rejection_code"),
		rejectionReason: text("rejection_reason"),
		rejectionKey: text("rejection_key"),
		maxCostMicros: bigint("max_cost_micros", { mode: "number" }),
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
		check(
			"chk_work_admission_expiry",
			sql`${table.expiresAt} > ${table.decidedAt}`,
		),
	],
);

export const workAttempts = pgTable(
	"work_attempts",
	{
		id: text("id").primaryKey(),
		admissionId: text("admission_id").notNull(),
		workItemId: text("work_item_id").notNull(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		executorType: text("executor_type").notNull(),
		executorId: text("executor_id").notNull(),
		executorSessionId: text("executor_session_id"),
		externalSessionKey: text("external_session_key"),
		runId: text("run_id"),
		runtimeState: text("runtime_state").notNull().default("running"),
		outcome: text("outcome"),
		attemptNumber: integer("attempt_number").notNull(),
		startedAt: text("started_at").notNull(),
		heartbeatAt: text("heartbeat_at").notNull(),
		expiresAt: text("expires_at"),
		finishedAt: text("finished_at"),
		summary: text("summary"),
		version: integer("version").notNull().default(1),
		metadata: jsonb("metadata")
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
		foreignKey({
			name: "fk_work_attempt_admission",
			columns: [table.orgId, table.workItemId, table.admissionId],
			foreignColumns: [
				workAdmissions.orgId,
				workAdmissions.workItemId,
				workAdmissions.id,
			],
		}).onDelete("restrict"),
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

export type PgWorkItem = typeof workItems.$inferSelect;
export type PgWorkAdmission = typeof workAdmissions.$inferSelect;
export type PgWorkAttempt = typeof workAttempts.$inferSelect;
