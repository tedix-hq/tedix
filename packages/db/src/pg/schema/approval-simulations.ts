/**
 * Append-only records for approval-gated counterfactual simulation.
 *
 * These tables do not grant authority or execute effects. The canonical
 * decision remains `tedi_approval_requests`; predictions, dependency history,
 * and observed execution receipts stay separate and immutable.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	real,
	text,
	type AnyPgColumn,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { tediApprovalRequests } from "./approvals";
import { organizations } from "./organizations";

export interface ApprovalSimulationBaselineRef {
	ref: string;
	revision: string | null;
}

export interface ApprovalSimulationAssumption {
	name: string;
	value: JsonValue;
}

export interface ApprovalExecutionProviderReceiptRef {
	provider: string;
	ref: string;
}

export interface ApprovalExecutionError {
	code: string;
	message: string;
	retryable?: boolean;
}

export const APPROVAL_DEPENDENCY_EVENT_TYPE_VALUES = [
	"declared",
	"invalidated",
] as const;
export const APPROVAL_DEPENDENCY_KIND_VALUES = [
	"hard",
	"informational",
] as const;
export const APPROVAL_EXECUTION_OUTCOME_VALUES = [
	"succeeded",
	"failed",
] as const;
export const APPROVAL_BASELINE_FENCE_OUTCOME_VALUES = [
	"matched",
	"stale",
	"not_checked",
] as const;

export const tediApprovalSimulations = pgTable(
	"tedi_approval_simulations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		approvalRequestId: text("approval_request_id")
			.notNull()
			.references(() => tediApprovalRequests.id, { onDelete: "cascade" }),
		simulatorId: text("simulator_id").notNull(),
		simulatorVersion: text("simulator_version").notNull(),
		canonicalInputHash: text("canonical_input_hash").notNull(),
		recordHash: text("record_hash").notNull(),
		baselineEvidenceRefs: jsonb("baseline_evidence_refs")
			.$type<ApprovalSimulationBaselineRef[]>()
			.notNull(),
		predictedResult: jsonb("predicted_result")
			.$type<Record<string, JsonValue>>()
			.notNull(),
		assumptions: jsonb("assumptions")
			.$type<ApprovalSimulationAssumption[]>()
			.notNull(),
		confidence: real("confidence").notNull(),
		evidenceKind: text("evidence_kind", { enum: ["simulation"] })
			.notNull()
			.default("simulation"),
		notProof: boolean("not_proof").notNull().default(true),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_approval_simulations_request_created").on(
			table.organizationId,
			table.approvalRequestId,
			table.createdAt,
		),
	],
);

/**
 * Append-only dependency event stream. Invalidation appends a second event
 * referencing the original declaration; it never updates or deletes the edge.
 */
export const tediApprovalDependencyEvents = pgTable(
	"tedi_approval_dependency_events",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		dependentApprovalRequestId: text("dependent_approval_request_id")
			.notNull()
			.references(() => tediApprovalRequests.id, { onDelete: "cascade" }),
		prerequisiteApprovalRequestId: text("prerequisite_approval_request_id")
			.notNull()
			.references(() => tediApprovalRequests.id, { onDelete: "cascade" }),
		simulationId: text("simulation_id")
			.notNull()
			.references(() => tediApprovalSimulations.id, { onDelete: "cascade" }),
		eventType: text("event_type", {
			enum: APPROVAL_DEPENDENCY_EVENT_TYPE_VALUES,
		}).notNull(),
		dependencyKind: text("dependency_kind", {
			enum: APPROVAL_DEPENDENCY_KIND_VALUES,
		}).notNull(),
		invalidatesEventId: text("invalidates_event_id").references(
			(): AnyPgColumn => tediApprovalDependencyEvents.id,
			{ onDelete: "cascade" },
		),
		reason: text("reason"),
		recordHash: text("record_hash").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("idx_approval_dependency_dependent_created").on(
			table.organizationId,
			table.dependentApprovalRequestId,
			table.createdAt,
		),
		index("idx_approval_dependency_prerequisite").on(
			table.organizationId,
			table.prerequisiteApprovalRequestId,
		),
		uniqueIndex("uniq_approval_dependency_invalidation").on(
			table.invalidatesEventId,
		),
	],
);

export const tediApprovalExecutionReceipts = pgTable(
	"tedi_approval_execution_receipts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		approvalRequestId: text("approval_request_id")
			.notNull()
			.references(() => tediApprovalRequests.id, { onDelete: "cascade" }),
		simulationId: text("simulation_id").references(
			() => tediApprovalSimulations.id,
			{ onDelete: "set null" },
		),
		idempotencyKey: text("idempotency_key").notNull(),
		canonicalInputHash: text("canonical_input_hash").notNull(),
		recordHash: text("record_hash").notNull(),
		baselineFenceOutcome: text("baseline_fence_outcome", {
			enum: APPROVAL_BASELINE_FENCE_OUTCOME_VALUES,
		}).notNull(),
		outcome: text("outcome", {
			enum: APPROVAL_EXECUTION_OUTCOME_VALUES,
		}).notNull(),
		observedResult: jsonb("observed_result").$type<Record<string, JsonValue>>(),
		observedError: jsonb("observed_error").$type<ApprovalExecutionError>(),
		providerReceiptRefs: jsonb("provider_receipt_refs")
			.$type<ApprovalExecutionProviderReceiptRef[]>()
			.notNull(),
		executedAt: text("executed_at").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_approval_execution_receipt_idempotency").on(
			table.organizationId,
			table.approvalRequestId,
			table.idempotencyKey,
		),
		index("idx_approval_execution_receipts_request_executed").on(
			table.organizationId,
			table.approvalRequestId,
			table.executedAt,
		),
	],
);

export type TediApprovalSimulation =
	typeof tediApprovalSimulations.$inferSelect;
export type NewTediApprovalSimulation =
	typeof tediApprovalSimulations.$inferInsert;
export type TediApprovalDependencyEvent =
	typeof tediApprovalDependencyEvents.$inferSelect;
export type NewTediApprovalDependencyEvent =
	typeof tediApprovalDependencyEvents.$inferInsert;
export type TediApprovalExecutionReceipt =
	typeof tediApprovalExecutionReceipts.$inferSelect;
export type NewTediApprovalExecutionReceipt =
	typeof tediApprovalExecutionReceipts.$inferInsert;
