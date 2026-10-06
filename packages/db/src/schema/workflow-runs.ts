import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workflowRunStatusEnum = [
	"queued",
	"running",
	"completed",
	"failed",
] as const;
export type WorkflowRunStatus = (typeof workflowRunStatusEnum)[number];

export const workflowRunLedger = sqliteTable(
	"workflow_run_ledger",
	{
		id: text("id").primaryKey(),
		workflowType: text("workflow_type").notNull(),
		workflowId: text("workflow_id").notNull(),
		trigger: text("trigger").notNull(),
		target: text("target"),
		status: text("status").$type<WorkflowRunStatus>().notNull(),
		startedAt: text("started_at").notNull(),
		completedAt: text("completed_at"),
		totalCount: integer("total_count").default(0),
		successCount: integer("success_count").default(0),
		errorCount: integer("error_count").default(0),
		output: text("output", { mode: "json" }).$type<Record<string, JsonValue>>(),
		error: text("error"),
	},
	(table) => [
		index("workflow_run_ledger_type_started_idx").on(
			table.workflowType,
			table.startedAt,
		),
		index("workflow_run_ledger_status_started_idx").on(
			table.status,
			table.startedAt,
		),
		index("workflow_run_ledger_workflow_id_idx").on(table.workflowId),
	],
);

export type WorkflowRunLedger = typeof workflowRunLedger.$inferSelect;
export type NewWorkflowRunLedger = typeof workflowRunLedger.$inferInsert;
