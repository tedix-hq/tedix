/**
 * Earned Delegation canonical state.
 *
 * Role identity, career stage, validated experience, and task-scoped authority
 * are separate. These tables start inert: no row grants authority until a
 * trusted disposer applies an evidence-backed decision.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	COMPETENCY_OUTCOMES,
	DECISION_AUTHORITY_ACTOR_TYPES,
	DELEGATION_ACTOR_TYPES,
	ENTRUSTMENT_LEVELS,
	ENTRUSTMENT_STATUSES,
	type EntrustmentScope,
	type EvidencePolicy,
	PROMOTION_DECISION_KINDS,
	PROMOTION_DECISION_STATUSES,
	TEDI_CAREER_STAGES,
} from "@tedix/api-contract/schemas/earned-delegation";
import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	check,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { roleTemplates } from "./role-templates";
import { tedis } from "./tedis";
import { workItems } from "./work-items";

export const tediRoleAssignments = sqliteTable(
	"tedi_role_assignments",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		roleTemplateId: text("role_template_id").references(
			() => roleTemplates.id,
			{ onDelete: "set null" },
		),
		roleKey: text("role_key").notNull(),
		roleName: text("role_name").notNull(),
		status: text("status", { enum: ["active", "ended"] })
			.notNull()
			.default("active"),
		careerStage: text("career_stage", { enum: TEDI_CAREER_STAGES })
			.notNull()
			.default("shadow"),
		assignedAt: text("assigned_at").notNull(),
		stageChangedAt: text("stage_changed_at").notNull(),
		endedAt: text("ended_at"),
		revision: integer("revision").notNull().default(1),
		/** Canonical decision points back to this row; query application verifies it. */
		lastDecisionId: text("last_decision_id"),
		evidenceSnapshotHash: text("evidence_snapshot_hash"),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_tedi_role_assignment_instance").on(
			table.tediId,
			table.roleKey,
			table.assignedAt,
		),
		uniqueIndex("uniq_tedi_role_assignment_active")
			.on(table.tediId)
			.where(sql`${table.status} = 'active'`),
		index("idx_tedi_role_assignment_org_stage").on(
			table.organizationId,
			table.careerStage,
		),
		check(
			"chk_tedi_role_assignment_status",
			sql`${table.status} IN ('active', 'ended')`,
		),
		check(
			"chk_tedi_role_assignment_stage",
			sql`${table.careerStage} IN ('shadow', 'apprentice', 'operator', 'specialist', 'lead', 'executive')`,
		),
		check("chk_tedi_role_assignment_revision", sql`${table.revision} > 0`),
		check(
			"chk_tedi_role_assignment_end",
			sql`(${table.status} = 'active' AND ${table.endedAt} IS NULL) OR (${table.status} = 'ended' AND ${table.endedAt} IS NOT NULL)`,
		),
		check(
			"chk_tedi_role_assignment_earned_stage",
			sql`${table.careerStage} = 'shadow' OR (${table.lastDecisionId} IS NOT NULL AND ${table.evidenceSnapshotHash} IS NOT NULL)`,
		),
	],
);

export const entrustableActivities = sqliteTable(
	"entrustable_activities",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id").references(() => organizations.id, {
			onDelete: "cascade",
		}),
		key: text("key").notNull(),
		version: integer("version").notNull().default(1),
		supersedesId: text("supersedes_id").references(
			(): AnySQLiteColumn => entrustableActivities.id,
			{ onDelete: "restrict" },
		),
		roleTemplateId: text("role_template_id").references(
			() => roleTemplates.id,
			{ onDelete: "set null" },
		),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status", { enum: ["active", "retired"] })
			.notNull()
			.default("active"),
		taskFamily: text("task_family").notNull(),
		riskLevel: text("risk_level", {
			enum: ["low", "medium", "high", "critical"],
		}).notNull(),
		maximumLevel: text("maximum_level", { enum: ENTRUSTMENT_LEVELS }).notNull(),
		actionPatterns: text("action_patterns", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		toolIds: text("tool_ids", { mode: "json" }).$type<string[]>().notNull(),
		rubric: text("rubric", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		rubricHash: text("rubric_hash").notNull(),
		evidencePolicy: text("evidence_policy", { mode: "json" })
			.$type<EvidencePolicy>()
			.notNull(),
		evidencePolicyHash: text("evidence_policy_hash").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_entrustable_activity_platform_version")
			.on(table.key, table.version)
			.where(sql`${table.organizationId} IS NULL`),
		uniqueIndex("uniq_entrustable_activity_org_version")
			.on(table.organizationId, table.key, table.version)
			.where(sql`${table.organizationId} IS NOT NULL`),
		uniqueIndex("uniq_entrustable_activity_platform_head")
			.on(table.key)
			.where(
				sql`${table.organizationId} IS NULL AND ${table.status} = 'active'`,
			),
		uniqueIndex("uniq_entrustable_activity_org_head")
			.on(table.organizationId, table.key)
			.where(
				sql`${table.organizationId} IS NOT NULL AND ${table.status} = 'active'`,
			),
		index("idx_entrustable_activity_risk").on(table.riskLevel),
		check("chk_entrustable_activity_version", sql`${table.version} > 0`),
		check(
			"chk_entrustable_activity_status",
			sql`${table.status} IN ('active', 'retired')`,
		),
		check(
			"chk_entrustable_activity_risk",
			sql`${table.riskLevel} IN ('low', 'medium', 'high', 'critical')`,
		),
		check(
			"chk_entrustable_activity_max_level",
			sql`${table.maximumLevel} IN ('observe', 'recommend', 'execute_preapproved', 'execute_reviewed', 'autonomous', 'delegate')`,
		),
	],
);

export const competencyObservations = sqliteTable(
	"competency_observations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		executorType: text("executor_type", {
			enum: ["tedi", "external_agent", "service"],
		}).notNull(),
		executorId: text("executor_id").notNull(),
		activityId: text("activity_id")
			.notNull()
			.references(() => entrustableActivities.id, { onDelete: "restrict" }),
		clientObservationId: text("client_observation_id").notNull(),
		inputHash: text("input_hash").notNull(),
		executionOpportunityId: text("execution_opportunity_id").notNull(),
		workItemId: text("work_item_id").references(() => workItems.id, {
			onDelete: "set null",
		}),
		sourceKind: text("source_kind").notNull(),
		sourceId: text("source_id").notNull(),
		traceBundleId: text("trace_bundle_id"),
		rationaleId: text("rationale_id"),
		taskFamily: text("task_family").notNull(),
		riskLevel: text("risk_level", {
			enum: ["low", "medium", "high", "critical"],
		}).notNull(),
		environment: text("environment").notNull(),
		rubricVersion: integer("rubric_version").notNull(),
		harness: text("harness").notNull(),
		harnessVersion: text("harness_version").notNull(),
		modelProvider: text("model_provider").notNull(),
		modelId: text("model_id").notNull(),
		modelVersion: text("model_version").notNull(),
		outcome: text("outcome", { enum: COMPETENCY_OUTCOMES }).notNull(),
		complexity: real("complexity").notNull(),
		nonTrivial: integer("non_trivial", { mode: "boolean" }).notNull(),
		heldOut: integer("held_out", { mode: "boolean" }).notNull(),
		calibrationScore: real("calibration_score").notNull(),
		escalationQuality: real("escalation_quality").notNull(),
		learningTransfer: integer("learning_transfer", {
			mode: "boolean",
		}).notNull(),
		evidenceRefs: text("evidence_refs", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		eligibilityStatus: text("eligibility_status", {
			enum: ["pending", "eligible", "ineligible"],
		})
			.notNull()
			.default("pending"),
		/** Null only for pre-provenance legacy rows, which cannot earn experience. */
		evaluatorType: text("evaluator_type", {
			enum: ["user", "api_key", "certification_service"],
		}),
		evaluatorId: text("evaluator_id"),
		classificationMethod: text("classification_method").notNull(),
		evaluationRunId: text("evaluation_run_id"),
		proofVerifiedAt: text("proof_verified_at"),
		costMinorUnits: integer("cost_minor_units"),
		costCurrency: text("cost_currency"),
		durationMs: integer("duration_ms"),
		ownerReviewMinutes: real("owner_review_minutes"),
		policyViolationSeverity: integer("policy_violation_severity")
			.notNull()
			.default(0),
		confidence: real("confidence").notNull(),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_competency_observation_org_client").on(
			table.organizationId,
			table.clientObservationId,
		),
		uniqueIndex("uniq_competency_observation_episode_activity").on(
			table.organizationId,
			table.tediId,
			table.executionOpportunityId,
			table.activityId,
			table.rubricVersion,
			table.harnessVersion,
		),
		index("idx_competency_observation_subject").on(
			table.tediId,
			table.activityId,
			table.occurredAt,
		),
		check("chk_competency_observation_rubric", sql`${table.rubricVersion} > 0`),
		check(
			"chk_competency_observation_outcome",
			sql`${table.outcome} IN ('success', 'partial', 'failure', 'unverified')`,
		),
		check(
			"chk_competency_observation_executor",
			sql`${table.executorType} IN ('tedi', 'external_agent', 'service')`,
		),
		check(
			"chk_competency_observation_risk",
			sql`${table.riskLevel} IN ('low', 'medium', 'high', 'critical')`,
		),
		check(
			"chk_competency_observation_eligibility",
			sql`${table.eligibilityStatus} IN ('pending', 'eligible', 'ineligible')`,
		),
		check(
			"chk_competency_observation_scores",
			sql`${table.complexity} >= 0 AND ${table.complexity} <= 1 AND ${table.confidence} >= 0 AND ${table.confidence} <= 1 AND ${table.calibrationScore} >= 0 AND ${table.calibrationScore} <= 1 AND ${table.escalationQuality} >= 0 AND ${table.escalationQuality} <= 1`,
		),
		check(
			"chk_competency_observation_booleans",
			sql`${table.nonTrivial} IN (0, 1) AND ${table.heldOut} IN (0, 1) AND ${table.learningTransfer} IN (0, 1)`,
		),
		check(
			"chk_competency_observation_nonnegative",
			sql`(${table.costMinorUnits} IS NULL OR ${table.costMinorUnits} >= 0) AND (${table.durationMs} IS NULL OR ${table.durationMs} >= 0) AND (${table.ownerReviewMinutes} IS NULL OR ${table.ownerReviewMinutes} >= 0) AND ${table.policyViolationSeverity} >= 0`,
		),
		check(
			"chk_competency_observation_currency",
			sql`(${table.costMinorUnits} IS NULL AND ${table.costCurrency} IS NULL) OR (${table.costMinorUnits} IS NOT NULL AND ${table.costCurrency} IS NOT NULL AND length(${table.costCurrency}) = 3)`,
		),
		check(
			"chk_competency_observation_eligible_proof",
			sql`${table.eligibilityStatus} != 'eligible' OR (json_array_length(${table.evidenceRefs}) > 0 AND ${table.proofVerifiedAt} IS NOT NULL)`,
		),
	],
);

/**
 * Organization-wide economic identity ledger for delegation-yield claims.
 * A business outcome and its accounting evidence may be attributed once,
 * to one proof-certified Work Item and its accountable tedi executor.
 */
export const delegationValueClaims = sqliteTable(
	"delegation_value_claims",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		observationId: text("observation_id")
			.notNull()
			.references(() => competencyObservations.id, { onDelete: "cascade" }),
		workItemId: text("work_item_id")
			.notNull()
			.references(() => workItems.id, { onDelete: "restrict" }),
		evaluationRunId: text("evaluation_run_id").notNull(),
		executorType: text("executor_type", { enum: ["tedi"] })
			.notNull()
			.default("tedi"),
		executorId: text("executor_id").notNull(),
		valueEventId: text("value_event_id").notNull(),
		valueEvidenceRef: text("value_evidence_ref").notNull(),
		valueMinorUnits: integer("value_minor_units").notNull(),
		currency: text("currency").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_delegation_value_claim_observation").on(
			table.organizationId,
			table.observationId,
		),
		uniqueIndex("uniq_delegation_value_claim_event").on(
			table.organizationId,
			table.valueEventId,
		),
		uniqueIndex("uniq_delegation_value_claim_evidence").on(
			table.organizationId,
			table.valueEvidenceRef,
		),
		index("idx_delegation_value_claim_tedi").on(
			table.organizationId,
			table.tediId,
			table.createdAt,
		),
		check(
			"chk_delegation_value_claim_executor",
			sql`${table.executorType} = 'tedi' AND ${table.executorId} = ${table.tediId}`,
		),
		check(
			"chk_delegation_value_claim_value",
			sql`${table.valueMinorUnits} >= 0 AND ${table.valueMinorUnits} <= 9000000000`,
		),
		check(
			"chk_delegation_value_claim_currency",
			sql`length(${table.currency}) = 3 AND ${table.currency} = upper(${table.currency})`,
		),
		check(
			"chk_delegation_value_claim_identity",
			sql`length(${table.valueEventId}) > 0 AND length(${table.valueEventId}) <= 200 AND length(${table.valueEvidenceRef}) > 0 AND length(${table.valueEvidenceRef}) <= 500`,
		),
	],
);

export const competencyObservationAttestations = sqliteTable(
	"competency_observation_attestations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		observationId: text("observation_id")
			.notNull()
			.references(() => competencyObservations.id, { onDelete: "cascade" }),
		principalType: text("principal_type", {
			enum: ["user", "api_key", "certification_service", "external_agent"],
		}).notNull(),
		principalId: text("principal_id").notNull(),
		verdict: text("verdict", { enum: ["supports", "rejects"] }).notNull(),
		verificationMethod: text("verification_method").notNull(),
		independenceVerified: integer("independence_verified", {
			mode: "boolean",
		}).notNull(),
		authenticatedAt: text("authenticated_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_competency_attestation_principal").on(
			table.observationId,
			table.principalType,
			table.principalId,
		),
		index("idx_competency_attestation_org_principal").on(
			table.organizationId,
			table.principalType,
			table.principalId,
		),
		check(
			"chk_competency_attestation_principal",
			sql`${table.principalType} IN ('user', 'api_key', 'certification_service', 'external_agent')`,
		),
		check(
			"chk_competency_attestation_verdict",
			sql`${table.verdict} IN ('supports', 'rejects')`,
		),
		check(
			"chk_competency_attestation_independence",
			sql`${table.independenceVerified} IN (0, 1)`,
		),
	],
);

/**
 * Monotonic fence for every certification fact that can change readiness.
 * Proposals and settlements capture this revision and authority mutations CAS
 * against it, preventing observations or attestations appended after a read
 * from slipping through the final D1 batch.
 */
export const earnedDelegationEvidenceRevisions = sqliteTable(
	"earned_delegation_evidence_revisions",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		revision: integer("revision").notNull().default(1),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({ columns: [table.organizationId, table.tediId] }),
		check(
			"chk_earned_delegation_evidence_revision",
			sql`${table.revision} > 0`,
		),
	],
);

export const promotionDecisions = sqliteTable(
	"promotion_decisions",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientProposalId: text("client_proposal_id").notNull(),
		inputHash: text("input_hash").notNull(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		roleAssignmentId: text("role_assignment_id").references(
			() => tediRoleAssignments.id,
			{ onDelete: "restrict" },
		),
		activityId: text("activity_id").references(() => entrustableActivities.id, {
			onDelete: "restrict",
		}),
		kind: text("kind", { enum: PROMOTION_DECISION_KINDS }).notNull(),
		status: text("status", { enum: PROMOTION_DECISION_STATUSES })
			.notNull()
			.default("proposed"),
		fromCareerStage: text("from_career_stage", { enum: TEDI_CAREER_STAGES }),
		toCareerStage: text("to_career_stage", { enum: TEDI_CAREER_STAGES }),
		fromEntrustmentLevel: text("from_entrustment_level", {
			enum: ENTRUSTMENT_LEVELS,
		}),
		fromEntrustmentStatus: text("from_entrustment_status", {
			enum: ENTRUSTMENT_STATUSES,
		}),
		toEntrustmentLevel: text("to_entrustment_level", {
			enum: ENTRUSTMENT_LEVELS,
		}),
		targetRoleTemplateId: text("target_role_template_id"),
		targetRoleKey: text("target_role_key"),
		targetRoleName: text("target_role_name"),
		targetScope: text("target_scope", {
			mode: "json",
		}).$type<EntrustmentScope>(),
		targetExpiresAt: text("target_expires_at"),
		targetNextReviewAt: text("target_next_review_at"),
		expectedRoleRevision: integer("expected_role_revision"),
		expectedEntrustmentRevision: integer("expected_entrustment_revision"),
		evidenceObservationIds: text("evidence_observation_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		evidenceRefs: text("evidence_refs", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		evidenceSnapshot: text("evidence_snapshot", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		proposedByType: text("proposed_by_type", {
			enum: DELEGATION_ACTOR_TYPES,
		}).notNull(),
		proposedById: text("proposed_by_id").notNull(),
		decidedByType: text("decided_by_type", {
			enum: DECISION_AUTHORITY_ACTOR_TYPES,
		}),
		decidedById: text("decided_by_id"),
		reason: text("reason"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		proposalExpiresAt: text("proposal_expires_at").notNull(),
		decidedAt: text("decided_at"),
		appliedAt: text("applied_at"),
	},
	(table) => [
		uniqueIndex("uniq_promotion_decision_org_client").on(
			table.organizationId,
			table.clientProposalId,
		),
		index("idx_promotion_decision_subject_status").on(
			table.tediId,
			table.status,
			table.createdAt,
		),
		index("idx_promotion_decision_org_kind").on(
			table.organizationId,
			table.kind,
			table.createdAt,
		),
		check(
			"chk_promotion_decision_kind",
			sql`${table.kind} IN ('promote', 'demote', 'grant', 'raise', 'restrict', 'revoke', 'recertify', 'reinstate', 'role_change')`,
		),
		check(
			"chk_promotion_decision_status",
			sql`${table.status} IN ('proposed', 'approved', 'rejected', 'applied', 'cancelled')`,
		),
		check(
			"chk_promotion_decision_from_entrustment_status",
			sql`(${table.kind} IN ('promote', 'demote', 'grant', 'role_change') AND ${table.fromEntrustmentStatus} IS NULL) OR (${table.kind} = 'raise' AND ${table.fromEntrustmentStatus} = 'active') OR (${table.kind} = 'recertify' AND ${table.fromEntrustmentStatus} = 'active') OR (${table.kind} = 'reinstate' AND ${table.fromEntrustmentStatus} IN ('restricted', 'expired')) OR (${table.kind} = 'restrict' AND ${table.fromEntrustmentStatus} = 'active') OR (${table.kind} = 'revoke' AND ${table.fromEntrustmentStatus} IN ('active', 'restricted', 'expired'))`,
		),
		check(
			"chk_promotion_decision_proposer",
			sql`${table.proposedByType} IN ('user', 'tedi', 'service', 'api_key', 'external_agent')`,
		),
		check(
			"chk_promotion_decision_disposer",
			sql`${table.decidedByType} IS NULL OR ${table.decidedByType} IN ('user', 'api_key', 'certification_service')`,
		),
		check(
			"chk_promotion_decision_evidence",
			sql`json_array_length(${table.evidenceRefs}) > 0`,
		),
		check(
			"chk_promotion_decision_promote_shape",
			sql`${table.kind} != 'promote' OR (${table.roleAssignmentId} IS NOT NULL AND ${table.activityId} IS NULL AND ${table.fromCareerStage} IS NOT NULL AND ${table.toCareerStage} IS NOT NULL AND ${table.fromEntrustmentLevel} IS NULL AND ${table.toEntrustmentLevel} IS NULL AND json_array_length(${table.evidenceObservationIds}) > 0 AND (CASE ${table.toCareerStage} WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END) = (CASE ${table.fromCareerStage} WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END) + 1)`,
		),
		check(
			"chk_promotion_decision_demote_shape",
			sql`${table.kind} != 'demote' OR (${table.roleAssignmentId} IS NOT NULL AND ${table.activityId} IS NULL AND ${table.fromCareerStage} IS NOT NULL AND ${table.toCareerStage} IS NOT NULL AND ${table.fromEntrustmentLevel} IS NULL AND ${table.toEntrustmentLevel} IS NULL AND (CASE ${table.toCareerStage} WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END) < (CASE ${table.fromCareerStage} WHEN 'shadow' THEN 0 WHEN 'apprentice' THEN 1 WHEN 'operator' THEN 2 WHEN 'specialist' THEN 3 WHEN 'lead' THEN 4 WHEN 'executive' THEN 5 END))`,
		),
		check(
			"chk_promotion_decision_grant_shape",
			sql`${table.kind} != 'grant' OR (${table.activityId} IS NOT NULL AND ${table.fromEntrustmentLevel} IS NULL AND ${table.toEntrustmentLevel} IS NOT NULL AND ${table.targetScope} IS NOT NULL AND ${table.targetExpiresAt} IS NOT NULL AND ${table.targetNextReviewAt} IS NOT NULL AND ${table.fromCareerStage} IS NULL AND ${table.toCareerStage} IS NULL AND json_array_length(${table.evidenceObservationIds}) > 0)`,
		),
		check(
			"chk_promotion_decision_raise_shape",
			sql`${table.kind} != 'raise' OR (${table.activityId} IS NOT NULL AND ${table.fromEntrustmentLevel} IS NOT NULL AND ${table.toEntrustmentLevel} IS NOT NULL AND ${table.targetScope} IS NOT NULL AND ${table.targetExpiresAt} IS NOT NULL AND ${table.targetNextReviewAt} IS NOT NULL AND ${table.fromCareerStage} IS NULL AND ${table.toCareerStage} IS NULL AND json_array_length(${table.evidenceObservationIds}) > 0 AND (CASE ${table.toEntrustmentLevel} WHEN 'observe' THEN 0 WHEN 'recommend' THEN 1 WHEN 'execute_preapproved' THEN 2 WHEN 'execute_reviewed' THEN 3 WHEN 'autonomous' THEN 4 WHEN 'delegate' THEN 5 END) > (CASE ${table.fromEntrustmentLevel} WHEN 'observe' THEN 0 WHEN 'recommend' THEN 1 WHEN 'execute_preapproved' THEN 2 WHEN 'execute_reviewed' THEN 3 WHEN 'autonomous' THEN 4 WHEN 'delegate' THEN 5 END))`,
		),
		check(
			"chk_promotion_decision_recertify_shape",
			sql`${table.kind} NOT IN ('recertify', 'reinstate') OR (${table.activityId} IS NOT NULL AND ${table.fromEntrustmentLevel} IS NOT NULL AND ${table.toEntrustmentLevel} = ${table.fromEntrustmentLevel} AND ${table.targetScope} IS NOT NULL AND ${table.targetExpiresAt} IS NOT NULL AND ${table.targetNextReviewAt} IS NOT NULL AND ${table.fromCareerStage} IS NULL AND ${table.toCareerStage} IS NULL AND json_array_length(${table.evidenceObservationIds}) > 0)`,
		),
		check(
			"chk_promotion_decision_incident_shape",
			sql`${table.kind} NOT IN ('restrict', 'revoke') OR (${table.activityId} IS NOT NULL AND ${table.fromEntrustmentLevel} IS NOT NULL AND ${table.toEntrustmentLevel} IS NULL AND ${table.targetScope} IS NULL AND ${table.targetExpiresAt} IS NULL AND ${table.targetNextReviewAt} IS NULL AND ${table.fromCareerStage} IS NULL AND ${table.toCareerStage} IS NULL)`,
		),
		check(
			"chk_promotion_decision_role_change_shape",
			sql`${table.kind} != 'role_change' OR (${table.roleAssignmentId} IS NOT NULL AND ${table.activityId} IS NULL AND ${table.targetRoleKey} IS NOT NULL AND ${table.targetRoleName} IS NOT NULL AND ${table.fromCareerStage} IS NULL AND ${table.toCareerStage} IS NULL AND ${table.fromEntrustmentLevel} IS NULL AND ${table.toEntrustmentLevel} IS NULL)`,
		),
		check(
			"chk_promotion_decision_target_role_fields",
			sql`${table.kind} = 'role_change' OR (${table.targetRoleTemplateId} IS NULL AND ${table.targetRoleKey} IS NULL AND ${table.targetRoleName} IS NULL)`,
		),
		check(
			"chk_promotion_decision_target_scope_fields",
			sql`${table.kind} IN ('grant', 'raise', 'recertify', 'reinstate') OR (${table.targetScope} IS NULL AND ${table.targetExpiresAt} IS NULL AND ${table.targetNextReviewAt} IS NULL)`,
		),
		check(
			"chk_promotion_decision_settlement",
			sql`${table.status} IN ('proposed', 'cancelled') OR (${table.decidedByType} IS NOT NULL AND ${table.decidedById} IS NOT NULL AND ${table.decidedAt} IS NOT NULL)`,
		),
		check(
			"chk_promotion_decision_application",
			sql`${table.status} != 'applied' OR ${table.appliedAt} IS NOT NULL`,
		),
		check(
			"chk_promotion_decision_independence",
			sql`${table.decidedById} IS NULL OR ${table.decidedByType} != ${table.proposedByType} OR ${table.decidedById} != ${table.proposedById}`,
		),
	],
);

export const promotionDecisionObservations = sqliteTable(
	"promotion_decision_observations",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		decisionId: text("decision_id")
			.notNull()
			.references(() => promotionDecisions.id, { onDelete: "cascade" }),
		observationId: text("observation_id")
			.notNull()
			.references(() => competencyObservations.id, { onDelete: "cascade" }),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_promotion_decision_observation").on(
			table.decisionId,
			table.observationId,
		),
		index("idx_promotion_decision_observation_org").on(table.organizationId),
	],
);

export const tediEntrustmentGrants = sqliteTable(
	"tedi_entrustment_grants",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		roleAssignmentId: text("role_assignment_id").references(
			() => tediRoleAssignments.id,
			{ onDelete: "restrict" },
		),
		activityId: text("activity_id")
			.notNull()
			.references(() => entrustableActivities.id, { onDelete: "restrict" }),
		level: text("level", { enum: ENTRUSTMENT_LEVELS })
			.notNull()
			.default("observe"),
		status: text("status", { enum: ENTRUSTMENT_STATUSES })
			.notNull()
			.default("active"),
		scope: text("scope", { mode: "json" }).$type<EntrustmentScope>().notNull(),
		revision: integer("revision").notNull().default(1),
		lastCertifiedAt: text("last_certified_at"),
		expiresAt: text("expires_at"),
		nextReviewAt: text("next_review_at").notNull(),
		restrictedAt: text("restricted_at"),
		reason: text("reason"),
		lastDecisionId: text("last_decision_id")
			.notNull()
			.references(() => promotionDecisions.id, { onDelete: "restrict" }),
		activityVersion: integer("activity_version").notNull(),
		rubricHash: text("rubric_hash").notNull(),
		evidencePolicyHash: text("evidence_policy_hash").notNull(),
		evidenceSnapshotHash: text("evidence_snapshot_hash").notNull(),
		grantedByType: text("granted_by_type", {
			enum: DECISION_AUTHORITY_ACTOR_TYPES,
		}).notNull(),
		grantedById: text("granted_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_tedi_entrustment_grant_activity").on(
			table.tediId,
			table.activityId,
		),
		index("idx_tedi_entrustment_grant_org_status").on(
			table.organizationId,
			table.status,
		),
		index("idx_tedi_entrustment_grant_expiry").on(
			table.status,
			table.expiresAt,
		),
		check(
			"chk_tedi_entrustment_grant_level",
			sql`${table.level} IN ('observe', 'recommend', 'execute_preapproved', 'execute_reviewed', 'autonomous', 'delegate')`,
		),
		check(
			"chk_tedi_entrustment_grant_status",
			sql`${table.status} IN ('active', 'restricted', 'expired', 'revoked')`,
		),
		check(
			"chk_tedi_entrustment_grant_revision",
			sql`${table.revision} > 0 AND ${table.activityVersion} > 0`,
		),
		check(
			"chk_tedi_entrustment_grant_authority",
			sql`${table.grantedByType} IN ('user', 'api_key', 'certification_service')`,
		),
	],
);

export type TediRoleAssignmentRow = typeof tediRoleAssignments.$inferSelect;
export type EntrustableActivityRow = typeof entrustableActivities.$inferSelect;
export type TediEntrustmentRow = typeof tediEntrustmentGrants.$inferSelect;
export type CompetencyObservationRow =
	typeof competencyObservations.$inferSelect;
export type CompetencyObservationAttestationRow =
	typeof competencyObservationAttestations.$inferSelect;
export type PromotionDecisionRow = typeof promotionDecisions.$inferSelect;
export type PromotionDecisionObservationRow =
	typeof promotionDecisionObservations.$inferSelect;
