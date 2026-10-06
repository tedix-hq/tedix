/**
 * Tedi Rationale Records Schema
 * Decision journal — the "why" behind every tedi action that touches a gate
 *
 * Each record captures: what was done, why, confidence level,
 * evidence references, and outcome. This is the core data structure
 * for the Tedix OS rationale timeline.
 */

import {
	RATIONALE_OUTCOME_STATUSES,
	type RationaleOutcomeStatus,
	type RationaleProofRefKind,
} from "@tedix/api-contract/constants/enums";
import type { RationaleRecord } from "@tedix/api-contract/schemas/rationale-records";
import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export type OutcomeStatus = RationaleOutcomeStatus;

// =============================================================================
// TABLE
// =============================================================================

export const tediRationaleRecords = sqliteTable(
	"tedi_rationale_records",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** What action was taken */
		action: text("action").notNull(),

		/** Why — the qualitative explanation */
		rationale: text("rationale").notNull(),

		/** Category of action */
		category: text("category").notNull().default("custom"),

		/** How confident the tedi was (0-1) */
		confidence: real("confidence").notNull().default(0.5),

		/** JSON — references to facts, skills, apps that informed the decision */
		evidence: text("evidence", { mode: "json" })
			.$type<RationaleRecord["evidence"]>()
			.notNull()
			.default({}),

		/** What happened after the action (filled post-execution) */
		outcome: text("outcome"),

		/** Result status: success, failure, partial, pending */
		outcomeStatus: text("outcome_status", { enum: RATIONALE_OUTCOME_STATUSES })
			.notNull()
			.default("pending"),

		/** Link to approval request if this action was gated */
		approvalRequestId: text("approval_request_id"),

		/** Link to objective (future — when objectives system is built) */
		objectiveId: text("objective_id"),

		/**
		 * Execution link (WS1): the runtime run this decision belongs to.
		 * Every new record MUST carry at least one of runId / workItemId /
		 * toolCallRefs — unlinked writes are rejected at the write path.
		 */
		runId: text("run_id"),

		/** Execution link (WS1): the Work Item this decision serves. */
		workItemId: text("work_item_id"),

		/**
		 * Execution link (WS1): tool-call identifiers/spans from the runtime
		 * event ledger (`tedi_runtime_events`), e.g.
		 * `{runId}:step:{stepNumber}:{toolName}`. JSON array of strings.
		 */
		toolCallRefs: text("tool_call_refs", { mode: "json" }).$type<string[]>(),

		/**
		 * Span-checkable proof for a `success` outcome claim (WS1). A success
		 * completion without a proof ref is stored as `unverified`.
		 */
		proofRef: text("proof_ref", { mode: "json" }).$type<{
			kind: RationaleProofRefKind;
			ref: string;
		}>(),

		/** When the rationale was created (ISO 8601) */
		createdAt: text("created_at").notNull(),

		/** When the action completed (ISO 8601) */
		completedAt: text("completed_at"),

		/**
		 * Symbolic blame attribution — traces which component was most responsible
		 * when a rationale record completes with failure. Array of blame entries,
		 * each identifying a component (brain_fact, directive, skill, graph_edge,
		 * missing_skill), its contribution level, and a reason.
		 */
		blameChain: text("blame_chain", { mode: "json" }).$type<
			Array<{
				component:
					| "brain_fact"
					| "directive"
					| "skill"
					| "graph_edge"
					| "missing_skill";
				id?: string;
				contribution: "high" | "medium" | "low";
				reason: string;
			}>
		>(),
	},
	(table) => [
		// Supersedes the bare `idx_rationale_org`: the org-scoped list orders by
		// created_at DESC, and org_id alone left SQLite sorting all 30k rows in a
		// temp B-tree for a LIMIT 20 (measured 58,503 rows / 3,082ms).
		index("idx_rationale_org_created").on(table.orgId, table.createdAt),
		index("idx_rationale_tedi_created").on(table.tediId, table.createdAt),
		index("idx_rationale_flywheel_window").on(
			table.tediId,
			table.orgId,
			table.createdAt,
		),
		index("idx_rationale_replay").on(
			table.tediId,
			table.orgId,
			table.category,
			table.outcomeStatus,
			table.createdAt,
		),
		index("idx_rationale_category").on(table.tediId, table.category),
		index("idx_rationale_outcome").on(table.tediId, table.outcomeStatus),
		index("idx_rationale_run").on(table.runId),
		index("idx_rationale_work_item").on(table.workItemId),
	],
);

export type TediRationaleRecord = typeof tediRationaleRecords.$inferSelect;
export type NewTediRationaleRecord = typeof tediRationaleRecords.$inferInsert;
