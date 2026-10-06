/**
 * Tedi Approval Requests Schema
 * Human-in-the-loop approval queue for tedi governance
 *
 * When a tedi's governance policy requires human approval for an action,
 * the tedi creates an approval request. A human resolves it (approve/reject)
 * from Tedix OS. A Cloudflare Workflow polls for resolution.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

// =============================================================================
// ENUMS
// =============================================================================

export const APPROVAL_STATUS_VALUES = [
	"pending",
	"approved",
	"rejected",
	"cancelled",
	"expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUS_VALUES)[number];

export const APPROVAL_ACTION_TYPE_VALUES = [
	"cron_job",
	"config_change",
	"memory_append",
	"new_skill",
	"skill_update",
	"bash_exec",
	"deploy",
	"custom",
] as const;
export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPE_VALUES)[number];

// =============================================================================
// TABLE
// =============================================================================

export const tediApprovalRequests = sqliteTable(
	"tedi_approval_requests",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** Action type requiring approval */
		actionType: text("action_type").notNull(),

		/** Human-readable description of the action */
		description: text("description").notNull(),

		/** Deferred action payload */
		payload: text("payload", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),

		/** Current status: pending, approved, rejected, expired */
		status: text("status", { enum: APPROVAL_STATUS_VALUES })
			.notNull()
			.default("pending"),

		/** When the request was created (ISO 8601) */
		createdAt: text("created_at").notNull(),

		/** When the request expires (ISO 8601) */
		expiresAt: text("expires_at").notNull(),

		/** When a human resolved the request (ISO 8601) */
		resolvedAt: text("resolved_at"),

		/** User ID of the human who resolved the request */
		resolvedBy: text("resolved_by"),

		/** Optional reviewer note */
		resolution: text("resolution"),

		/** Cloudflare Workflow instance ID for polling */
		workflowId: text("workflow_id"),
	},
	(table) => [
		index("idx_approval_requests_status").on(table.orgId, table.status),
		index("idx_approval_requests_tedi_status").on(table.tediId, table.status),
	],
);

export type TediApprovalRequest = typeof tediApprovalRequests.$inferSelect;
export type NewTediApprovalRequest = typeof tediApprovalRequests.$inferInsert;

/**
 * A non-canonical result that may inform continued analysis but grants no
 * authority or executor linkage. Promotion records the separately approved
 * request that granted authority; it never executes the proposed side effect.
 */
export const tediProvisionalOutcomes = sqliteTable(
	"tedi_provisional_outcomes",
	{
		id: text("id").primaryKey(),
		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		conversationId: text("conversation_id"),
		runId: text("run_id"),
		kind: text("kind", { enum: ["draft", "configuration_proposal"] }).notNull(),
		title: text("title").notNull(),
		payload: text("payload", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		createdAt: text("created_at").notNull(),
		state: text("state", {
			enum: ["provisional", "promoted", "rolled_back"],
		})
			.notNull()
			.default("provisional"),
		promotionApprovalRequestId: text(
			"promotion_approval_request_id",
		).references(() => tediApprovalRequests.id),
		promotedAt: text("promoted_at"),
		promotedBy: text("promoted_by"),
		rolledBackAt: text("rolled_back_at"),
		rolledBackBy: text("rolled_back_by"),
		rollbackReason: text("rollback_reason"),
	},
	(table) => [
		index("idx_tedi_provisional_outcomes_org_created").on(
			table.orgId,
			table.createdAt,
		),
		index("idx_tedi_provisional_outcomes_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
	],
);

export type TediProvisionalOutcome =
	typeof tediProvisionalOutcomes.$inferSelect;
export type NewTediProvisionalOutcome =
	typeof tediProvisionalOutcomes.$inferInsert;
