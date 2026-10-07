/**
 * Canonical identity for non-Tedix execution harnesses.
 *
 * A principal is the stable, credential-bound accountable actor. A session is
 * one immutable harness/model execution context. Neither is a tedi identity,
 * and an Agent-Session string is never authority on its own.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { workItems } from "./work-items";

export const externalAgentPrincipals = sqliteTable(
	"external_agent_principals",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		key: text("key").notNull(),
		displayName: text("display_name").notNull(),
		status: text("status", {
			enum: ["active", "suspended", "retired"],
		})
			.notNull()
			.default("active"),
		credentialBindingType: text("credential_binding_type", {
			enum: ["api_key", "github_actions_oidc", "owner_user"],
		}).notNull(),
		credentialBindingId: text("credential_binding_id").notNull(),
		createdByType: text("created_by_type", {
			enum: ["user", "api_key", "platform"],
		}).notNull(),
		createdById: text("created_by_id").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_external_agent_principal_org_id").on(
			table.organizationId,
			table.id,
		),
		uniqueIndex("uniq_external_agent_principal_key").on(
			table.organizationId,
			table.key,
		),
		uniqueIndex("uniq_external_agent_credential_binding").on(
			table.organizationId,
			table.credentialBindingType,
			table.credentialBindingId,
		),
		index("idx_external_agent_principal_status").on(
			table.organizationId,
			table.status,
		),
		check("chk_external_agent_principal_key", sql`length(${table.key}) > 0`),
		check(
			"chk_external_agent_principal_binding",
			sql`length(${table.credentialBindingId}) > 0`,
		),
	],
);

/**
 * Single-use workload assertions consumed before an external-agent session is
 * opened. The issuer+jti uniqueness constraint is the replay fence; the other
 * claims preserve the exact binding decision for audit without storing JWTs.
 */
export const externalAgentWorkloadTokenUses = sqliteTable(
	"external_agent_workload_token_uses",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		issuer: text("issuer").notNull(),
		subject: text("subject").notNull(),
		audience: text("audience").notNull(),
		jti: text("jti").notNull(),
		externalSessionKey: text("external_session_key").notNull(),
		tokenIssuedAt: text("token_issued_at").notNull(),
		tokenExpiresAt: text("token_expires_at").notNull(),
		consumedAt: text("consumed_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_external_agent_workload_use_principal_org",
			columns: [table.organizationId, table.principalId],
			foreignColumns: [
				externalAgentPrincipals.organizationId,
				externalAgentPrincipals.id,
			],
		}).onDelete("restrict"),
		uniqueIndex("uniq_external_agent_workload_issuer_jti").on(
			table.issuer,
			table.jti,
		),
		index("idx_external_agent_workload_principal").on(
			table.organizationId,
			table.principalId,
			table.consumedAt,
		),
		check(
			"chk_external_agent_workload_token_lifetime",
			sql`${table.tokenExpiresAt} > ${table.tokenIssuedAt}`,
		),
	],
);

export const externalAgentSessions = sqliteTable(
	"external_agent_sessions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		externalSessionKey: text("external_session_key").notNull(),
		harness: text("harness").notNull(),
		harnessVersion: text("harness_version").notNull(),
		modelProvider: text("model_provider").notNull(),
		modelId: text("model_id").notNull(),
		modelVersion: text("model_version").notNull(),
		identitySource: text("identity_source", {
			enum: ["native", "explicit", "derived"],
		}).notNull(),
		status: text("status", { enum: ["active", "ended"] })
			.notNull()
			.default("active"),
		creditEligible: integer("credit_eligible", { mode: "boolean" })
			.notNull()
			.default(true),
		startedAt: text("started_at").notNull(),
		lastSeenAt: text("last_seen_at").notNull(),
		endedAt: text("ended_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
	},
	(table) => [
		foreignKey({
			name: "fk_external_agent_session_principal_org",
			columns: [table.organizationId, table.principalId],
			foreignColumns: [
				externalAgentPrincipals.organizationId,
				externalAgentPrincipals.id,
			],
		}).onDelete("restrict"),
		uniqueIndex("uniq_external_agent_session_org_principal_id").on(
			table.organizationId,
			table.principalId,
			table.id,
		),
		uniqueIndex("uniq_external_agent_session_key").on(
			table.organizationId,
			table.harness,
			table.externalSessionKey,
		),
		index("idx_external_agent_session_principal").on(
			table.organizationId,
			table.principalId,
			table.status,
		),
		check(
			"chk_external_agent_session_key",
			sql`length(${table.externalSessionKey}) > 0`,
		),
		check(
			"chk_external_agent_session_derived_credit",
			sql`${table.identitySource} != 'derived' OR ${table.creditEligible} = 0`,
		),
		check(
			"chk_external_agent_session_end_state",
			sql`(${table.status} = 'active' AND ${table.endedAt} IS NULL) OR (${table.status} = 'ended' AND ${table.endedAt} IS NOT NULL)`,
		),
	],
);

export const externalAgentMcpCredentials = sqliteTable(
	"external_agent_mcp_credentials",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		sessionId: text("session_id").notNull(),
		clientRecordId: text("client_record_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		mcpServerUrl: text("mcp_server_url").notNull(),
		status: text("status", { enum: ["active", "revoked"] })
			.notNull()
			.default("active"),
		issuedAt: text("issued_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		foreignKey({
			name: "fk_external_agent_mcp_credential_session_org",
			columns: [table.organizationId, table.principalId, table.sessionId],
			foreignColumns: [
				externalAgentSessions.organizationId,
				externalAgentSessions.principalId,
				externalAgentSessions.id,
			],
		}).onDelete("restrict"),
		uniqueIndex("uniq_external_agent_mcp_client_record").on(
			table.clientRecordId,
		),
		index("idx_external_agent_mcp_credential_session").on(
			table.organizationId,
			table.principalId,
			table.sessionId,
			table.status,
		),
		check(
			"chk_external_agent_mcp_credential_state",
			sql`(${table.status} = 'active' AND ${table.revokedAt} IS NULL) OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
		),
	],
);

export const externalAgentMcpIssuanceLeases = sqliteTable(
	"external_agent_mcp_issuance_leases",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		sessionId: text("session_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		ownerToken: text("owner_token").notNull(),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_external_agent_mcp_issuance_lease_session_org",
			columns: [table.organizationId, table.principalId, table.sessionId],
			foreignColumns: [
				externalAgentSessions.organizationId,
				externalAgentSessions.principalId,
				externalAgentSessions.id,
			],
		}).onDelete("cascade"),
		uniqueIndex("uniq_external_agent_mcp_issuance_lease_target").on(
			table.organizationId,
			table.principalId,
			table.sessionId,
			table.mcpServerId,
		),
		check(
			"chk_external_agent_mcp_issuance_lease_expiry",
			sql`${table.expiresAt} > ${table.updatedAt}`,
		),
	],
);

export const externalAgentAttributions = sqliteTable(
	"external_agent_attributions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		sessionId: text("session_id").notNull(),
		targetType: text("target_type", {
			enum: [
				"work_item_attempt",
				"work_item_event",
				"mcp_execution",
				"review",
				"commit",
			],
		}).notNull(),
		targetId: text("target_id").notNull(),
		role: text("role", {
			enum: ["executor", "reviewer", "attester"],
		}).notNull(),
		workItemId: text("work_item_id"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		occurredAt: text("occurred_at").notNull(),
	},
	(table) => [
		foreignKey({
			name: "fk_external_agent_attribution_session_org",
			columns: [table.organizationId, table.principalId, table.sessionId],
			foreignColumns: [
				externalAgentSessions.organizationId,
				externalAgentSessions.principalId,
				externalAgentSessions.id,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "fk_external_agent_attribution_work_item_org",
			columns: [table.organizationId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("restrict"),
		uniqueIndex("uniq_external_agent_attribution").on(
			table.organizationId,
			table.targetType,
			table.targetId,
			table.role,
			table.principalId,
		),
		uniqueIndex("uniq_external_agent_attribution_org_id").on(
			table.organizationId,
			table.id,
		),
		index("idx_external_agent_attribution_session").on(
			table.organizationId,
			table.sessionId,
			table.occurredAt,
		),
		index("idx_external_agent_attribution_work_item").on(
			table.organizationId,
			table.workItemId,
		),
		check(
			"chk_external_agent_attribution_target",
			sql`length(${table.targetId}) > 0`,
		),
	],
);

/**
 * Independently reviewed outcome evidence for external execution. Execution
 * provenance stays in `external_agent_attributions`; this table names both the
 * subject and reviewer and carries a typed, exact reputation context.
 */
export const externalAgentReviewEvidence = sqliteTable(
	"external_agent_review_evidence",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		executionAttributionId: text("execution_attribution_id").notNull(),
		subjectPrincipalId: text("subject_principal_id").notNull(),
		subjectSessionId: text("subject_session_id").notNull(),
		reviewerPrincipalType: text("reviewer_principal_type", {
			enum: ["user", "certification_service", "external_agent"],
		}).notNull(),
		reviewerPrincipalId: text("reviewer_principal_id").notNull(),
		reviewerSessionId: text("reviewer_session_id"),
		targetType: text("target_type", {
			enum: ["work_item", "commit", "mcp_execution"],
		}).notNull(),
		targetId: text("target_id").notNull(),
		workItemId: text("work_item_id"),
		taskFamily: text("task_family").notNull(),
		repositoryKey: text("repository_key").notNull(),
		repositoryVersion: text("repository_version").notNull(),
		riskLevel: text("risk_level", {
			enum: ["low", "medium", "high", "critical"],
		}).notNull(),
		environment: text("environment").notNull(),
		outcome: text("outcome", {
			enum: ["success", "partial", "failure", "policy_violation"],
		}).notNull(),
		score: real("score").notNull(),
		policyViolationSeverity: integer("policy_violation_severity")
			.notNull()
			.default(0),
		reviewMethod: text("review_method").notNull(),
		evidenceRefs: text("evidence_refs", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		contextHash: text("context_hash").notNull(),
		resolutionStatus: text("resolution_status", {
			enum: ["open", "remediated"],
		})
			.notNull()
			.default("open"),
		resolutionEvidenceRef: text("resolution_evidence_ref"),
		resolvedByType: text("resolved_by_type", { enum: ["user", "api_key"] }),
		resolvedById: text("resolved_by_id"),
		resolvedAt: text("resolved_at"),
		occurredAt: text("occurred_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		foreignKey({
			name: "fk_external_agent_review_execution_org",
			columns: [table.organizationId, table.executionAttributionId],
			foreignColumns: [
				externalAgentAttributions.organizationId,
				externalAgentAttributions.id,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "fk_external_agent_review_subject_session",
			columns: [
				table.organizationId,
				table.subjectPrincipalId,
				table.subjectSessionId,
			],
			foreignColumns: [
				externalAgentSessions.organizationId,
				externalAgentSessions.principalId,
				externalAgentSessions.id,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "fk_external_agent_review_reviewer_session",
			columns: [
				table.organizationId,
				table.reviewerPrincipalId,
				table.reviewerSessionId,
			],
			foreignColumns: [
				externalAgentSessions.organizationId,
				externalAgentSessions.principalId,
				externalAgentSessions.id,
			],
		}).onDelete("restrict"),
		foreignKey({
			name: "fk_external_agent_review_work_item_org",
			columns: [table.organizationId, table.workItemId],
			foreignColumns: [workItems.orgId, workItems.id],
		}).onDelete("restrict"),
		uniqueIndex("uniq_external_agent_review_principal_execution").on(
			table.organizationId,
			table.executionAttributionId,
			table.reviewerPrincipalType,
			table.reviewerPrincipalId,
		),
		index("idx_external_agent_review_subject_context").on(
			table.organizationId,
			table.subjectPrincipalId,
			table.taskFamily,
			table.repositoryKey,
			table.riskLevel,
		),
		check(
			"chk_external_agent_review_principal_type",
			sql`${table.reviewerPrincipalType} IN ('user', 'certification_service', 'external_agent')`,
		),
		check(
			"chk_external_agent_review_no_self_review",
			sql`${table.reviewerPrincipalType} != 'external_agent' OR ${table.reviewerPrincipalId} != ${table.subjectPrincipalId}`,
		),
		check(
			"chk_external_agent_review_session_shape",
			sql`(${table.reviewerPrincipalType} = 'external_agent' AND ${table.reviewerSessionId} IS NOT NULL) OR (${table.reviewerPrincipalType} != 'external_agent' AND ${table.reviewerSessionId} IS NULL)`,
		),
		check(
			"chk_external_agent_review_score",
			sql`${table.score} >= 0 AND ${table.score} <= 1 AND ${table.policyViolationSeverity} >= 0 AND ${table.policyViolationSeverity} <= 10`,
		),
		check(
			"chk_external_agent_review_outcome_coherence",
			sql`(${table.outcome} = 'success' AND ${table.score} >= 0.5 AND ${table.policyViolationSeverity} = 0) OR (${table.outcome} = 'partial' AND ${table.policyViolationSeverity} = 0) OR (${table.outcome} = 'failure' AND ${table.score} <= 0.5 AND ${table.policyViolationSeverity} = 0) OR (${table.outcome} = 'policy_violation' AND ${table.score} <= 0.5 AND ${table.policyViolationSeverity} >= 1)`,
		),
		check(
			"chk_external_agent_review_context",
			sql`length(${table.taskFamily}) > 0 AND length(${table.repositoryKey}) > 0 AND length(${table.repositoryVersion}) > 0 AND length(${table.environment}) > 0 AND json_array_length(${table.evidenceRefs}) > 0`,
		),
		check(
			"chk_external_agent_review_resolution",
			sql`(${table.resolutionStatus} = 'open' AND ${table.resolutionEvidenceRef} IS NULL AND ${table.resolvedByType} IS NULL AND ${table.resolvedById} IS NULL AND ${table.resolvedAt} IS NULL) OR (${table.resolutionStatus} = 'remediated' AND ${table.resolutionEvidenceRef} IS NOT NULL AND ${table.resolvedByType} IS NOT NULL AND ${table.resolvedById} IS NOT NULL AND ${table.resolvedAt} IS NOT NULL)`,
		),
	],
);

export type ExternalAgentPrincipal =
	typeof externalAgentPrincipals.$inferSelect;
export type NewExternalAgentPrincipal =
	typeof externalAgentPrincipals.$inferInsert;
export type ExternalAgentSession = typeof externalAgentSessions.$inferSelect;
export type NewExternalAgentSession = typeof externalAgentSessions.$inferInsert;
export type ExternalAgentAttribution =
	typeof externalAgentAttributions.$inferSelect;
export type NewExternalAgentAttribution =
	typeof externalAgentAttributions.$inferInsert;
export type ExternalAgentMcpCredential =
	typeof externalAgentMcpCredentials.$inferSelect;
export type NewExternalAgentMcpCredential =
	typeof externalAgentMcpCredentials.$inferInsert;
export type ExternalAgentReviewEvidence =
	typeof externalAgentReviewEvidence.$inferSelect;
export type NewExternalAgentReviewEvidence =
	typeof externalAgentReviewEvidence.$inferInsert;
