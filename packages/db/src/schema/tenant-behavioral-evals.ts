import type {
	TenantBehavioralEvalExecutionReceipt,
	TenantBehavioralEvalRevisionSpec,
	TenantBehavioralEvalRunManifest,
} from "@tedix/api-contract/schemas/tenant-behavioral-evals";
import { sql } from "drizzle-orm";
import {
	foreignKey,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

const createdAt = () =>
	text("created_at")
		.notNull()
		.default(sql`(CURRENT_TIMESTAMP)`);
const updatedAt = () =>
	text("updated_at")
		.notNull()
		.default(sql`(CURRENT_TIMESTAMP)`);
export const tenantBehavioralEvalDefinitions = sqliteTable(
	"tenant_behavioral_eval_definitions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "restrict" }),
		name: text("name").notNull(),
		latestRevision: integer("latest_revision").notNull().default(1),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("uq_tbe_definitions_id_org").on(t.id, t.organizationId),
		index("idx_tbe_definitions_org").on(t.organizationId, t.createdAt),
	],
);
export const tenantBehavioralEvalRevisions = sqliteTable(
	"tenant_behavioral_eval_revisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		definitionId: text("definition_id")
			.notNull()
			.references(() => tenantBehavioralEvalDefinitions.id, {
				onDelete: "cascade",
			}),
		revision: integer("revision").notNull(),
		spec: text("spec", { mode: "json" })
			.$type<TenantBehavioralEvalRevisionSpec>()
			.notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		foreignKey({
			columns: [t.definitionId, t.organizationId],
			foreignColumns: [
				tenantBehavioralEvalDefinitions.id,
				tenantBehavioralEvalDefinitions.organizationId,
			],
			name: "fk_tbe_revision_definition_org",
		}).onDelete("cascade"),
		uniqueIndex("uq_tbe_revisions_id_org").on(t.id, t.organizationId),
		uniqueIndex("uq_tbe_revision_number").on(t.definitionId, t.revision),
		index("idx_tbe_revisions_org_definition").on(
			t.organizationId,
			t.definitionId,
		),
	],
);
export const tenantBehavioralEvalRuns = sqliteTable(
	"tenant_behavioral_eval_runs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		definitionId: text("definition_id")
			.notNull()
			.references(() => tenantBehavioralEvalDefinitions.id, {
				onDelete: "cascade",
			}),
		revisionId: text("revision_id")
			.notNull()
			.references(() => tenantBehavioralEvalRevisions.id, {
				onDelete: "restrict",
			}),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "restrict" }),
		status: text("status", {
			enum: ["pending", "running", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		version: integer("version").notNull().default(0),
		idempotencyKey: text("idempotency_key").notNull(),
		payloadDigest: text("payload_digest").notNull(),
		manifest: text("manifest", {
			mode: "json",
		}).$type<TenantBehavioralEvalRunManifest>(),
		manifestDigest: text("manifest_digest"),
		leaseToken: text("lease_token"),
		leaseUntil: text("lease_until"),
		passed: integer("passed", { mode: "boolean" }),
		lastAdvanceError: text("last_advance_error"),
		lastAdvanceErrorPhase: text("last_advance_error_phase", {
			enum: ["dispatch", "evidence", "assertion"],
		}),
		lastAdvanceErrorRetryable: integer("last_advance_error_retryable", {
			mode: "boolean",
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		foreignKey({
			columns: [t.definitionId, t.organizationId],
			foreignColumns: [
				tenantBehavioralEvalDefinitions.id,
				tenantBehavioralEvalDefinitions.organizationId,
			],
			name: "fk_tbe_run_definition_org",
		}).onDelete("cascade"),
		foreignKey({
			columns: [t.revisionId, t.organizationId],
			foreignColumns: [
				tenantBehavioralEvalRevisions.id,
				tenantBehavioralEvalRevisions.organizationId,
			],
			name: "fk_tbe_run_revision_org",
		}).onDelete("restrict"),
		uniqueIndex("uq_tbe_run_idempotency").on(
			t.organizationId,
			t.idempotencyKey,
		),
		index("idx_tbe_runs_org").on(t.organizationId, t.createdAt),
	],
);
export const tenantBehavioralEvalCaseRuns = sqliteTable(
	"tenant_behavioral_eval_case_runs",
	{
		id: text("id").primaryKey(),
		runId: text("run_id")
			.notNull()
			.references(() => tenantBehavioralEvalRuns.id, { onDelete: "cascade" }),
		caseId: text("case_id").notNull(),
		homeRunId: text("home_run_id").notNull(),
		attemptNumber: integer("attempt_number").notNull().default(1),
		status: text("status", {
			enum: ["pending", "enqueued", "streaming", "completed", "failed"],
		})
			.notNull()
			.default("pending"),
		eventCursor: integer("event_cursor").notNull().default(0),
		sawClosed: integer("saw_closed", { mode: "boolean" })
			.notNull()
			.default(false),
		drained: integer("drained", { mode: "boolean" }).notNull().default(false),
		terminalStatus: text("terminal_status"),
		selectedRoute: text("selected_route"),
		effectsSuppressed: integer("effects_suppressed", { mode: "boolean" }),
		error: text("error"),
		executionReceipt: text("execution_receipt", {
			mode: "json",
		}).$type<TenantBehavioralEvalExecutionReceipt>(),
		disposition: text("disposition", {
			enum: ["passed", "failed", "unresolved", "void"],
		}),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		uniqueIndex("uq_tbe_case_run").on(t.runId, t.caseId),
		uniqueIndex("uq_tbe_home_run").on(t.homeRunId),
	],
);
export const tenantBehavioralEvalCaseAttempts = sqliteTable(
	"tenant_behavioral_eval_case_attempts",
	{
		id: text("id").primaryKey(),
		caseRunId: text("case_run_id")
			.notNull()
			.references(() => tenantBehavioralEvalCaseRuns.id, {
				onDelete: "cascade",
			}),
		attemptNumber: integer("attempt_number").notNull(),
		homeRunId: text("home_run_id").notNull(),
		status: text("status", { enum: ["completed", "failed"] }).notNull(),
		disposition: text("disposition", {
			enum: ["passed", "failed", "unresolved", "void"],
		}).notNull(),
		error: text("error"),
		eventCursor: integer("event_cursor").notNull(),
		terminalStatus: text("terminal_status"),
		selectedRoute: text("selected_route"),
		effectsSuppressed: integer("effects_suppressed", { mode: "boolean" }),
		executionReceipt: text("execution_receipt", {
			mode: "json",
		}).$type<TenantBehavioralEvalExecutionReceipt>(),
		recordedAt: createdAt(),
	},
	(t) => [
		uniqueIndex("uq_tbe_case_attempt_number").on(t.caseRunId, t.attemptNumber),
		uniqueIndex("uq_tbe_case_attempt_home").on(t.homeRunId),
	],
);
export const tenantBehavioralEvalAssertionResults = sqliteTable(
	"tenant_behavioral_eval_assertion_results",
	{
		id: text("id").primaryKey(),
		caseRunId: text("case_run_id")
			.notNull()
			.references(() => tenantBehavioralEvalCaseRuns.id, {
				onDelete: "cascade",
			}),
		assertionIndex: integer("assertion_index").notNull(),
		type: text("type", {
			enum: ["route_is", "terminal_status_is", "no_effects"],
		}).notNull(),
		passed: integer("passed", { mode: "boolean" }).notNull(),
		severity: text("severity", { enum: ["gate", "soft"] })
			.notNull()
			.default("gate"),
		disposition: text("disposition", {
			enum: ["passed", "failed", "unresolved", "void"],
		}),
		detail: text("detail").notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		uniqueIndex("uq_tbe_assertion_result").on(t.caseRunId, t.assertionIndex),
	],
);
