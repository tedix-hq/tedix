/**
 * Generic MCP Tasks schema (`io.modelcontextprotocol/tasks`).
 *
 * Durable store for config-driven, long-running MCP tool calls that do NOT
 * already have a first-class run ledger. Home runs project
 * `kernel_runtime_runs` and per-tedi runs project `tedi_runtime_events`; this
 * table only backs generic provider/workflow tools that opt into async
 * execution (`config._asyncTask === true`) when the client opted into the
 * Tasks extension.
 *
 * This is a clean schema — the
 * historical SDK v1 experimental `mcp_tasks` table is intentionally not carried
 * forward.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type {
	McpTaskInputRequests,
	McpTaskInputResponses,
	McpTaskJsonRpcError,
} from "@tedix/api-contract/schemas/mcp-tasks";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const MCP_TASK_STATUS_VALUES = [
	"working",
	"input_required",
	"completed",
	"failed",
	"cancelled",
] as const;

export type McpTaskStatusValue = (typeof MCP_TASK_STATUS_VALUES)[number];

export const mcpTasks = sqliteTable(
	"mcp_tasks",
	{
		/** Internal UUID primary key. */
		id: text("id").primaryKey(),
		/** Public MCP task identifier returned to clients (`generic-<uuid>`). */
		taskId: text("task_id").notNull().unique(),
		/** Organization boundary. No FK — keeps the workflow writer hot path
		 * single-statement and survives org pruning races, mirroring
		 * chat_dispatch_idempotency. */
		orgId: text("org_id").notNull(),
		/** Canonical user that created a human-owned task. Null for machine and
		 * pre-migration tasks; public task handlers require an exact match when set. */
		subjectUserId: text("subject_user_id"),
		/** MCP app that created the task. */
		appId: text("app_id").notNull(),
		/** Optional `app_tools.id` reference when created from `tools/call`. */
		toolId: text("tool_id"),
		/** MCP tool name as seen by the client. */
		toolName: text("tool_name").notNull(),
		/** Original JSON-RPC request id, when available. */
		requestId: text("request_id"),
		/** Original request method, usually `tools/call`. */
		method: text("method").notNull().default("tools/call"),
		status: text("status", { enum: MCP_TASK_STATUS_VALUES })
			.notNull()
			.default("working"),
		/** Protocol-visible time to live (ms). */
		ttlMs: integer("ttl_ms"),
		/** Suggested client polling interval (ms). */
		pollIntervalMs: integer("poll_interval_ms"),
		/** Tool input snapshot + protocol input requests keyed by id. */
		inputRequests: text("input_requests", {
			mode: "json",
		}).$type<McpTaskInputRequests>(),
		/** Client-provided input responses keyed by input request id. */
		inputResponses: text("input_responses", {
			mode: "json",
		}).$type<McpTaskInputResponses>(),
		/** Final successful result in the original request's result shape. */
		result: text("result", { mode: "json" }).$type<Record<string, JsonValue>>(),
		/** Final JSON-RPC error object for failed tasks. */
		error: text("error", { mode: "json" }).$type<McpTaskJsonRpcError>(),
		/** Cloudflare Workflow instance id, when backed by Workflows. */
		workflowId: text("workflow_id"),
		/** Cooperative cancellation marker. */
		cancelRequestedAt: text("cancel_requested_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		/** Cleanup boundary. */
		expiresAt: text("expires_at"),
	},
	(table) => [
		index("idx_mcp_tasks_task_id").on(table.taskId),
		index("idx_mcp_tasks_org_app_status").on(
			table.orgId,
			table.appId,
			table.status,
		),
		index("idx_mcp_tasks_org_subject_user").on(
			table.orgId,
			table.subjectUserId,
		),
		index("idx_mcp_tasks_expires_at").on(table.expiresAt),
		index("idx_mcp_tasks_workflow_id").on(table.workflowId),
	],
);

export type McpTask = typeof mcpTasks.$inferSelect;
export type NewMcpTask = typeof mcpTasks.$inferInsert;
