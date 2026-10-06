/**
 * Tedi Objectives & Tasks Schema
 * Mission directives (objectives) and execution log (tasks)
 *
 * Objectives are human-set mission directives and standing orders.
 * Tasks are a thin execution log showing what the tedi is doing right now.
 * This is NOT a project manager — real PM stays in Jira/Linear/Notion.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

// =============================================================================
// ENUMS
// =============================================================================

export const OBJECTIVE_TYPE_VALUES = [
	"one_time",
	"standing",
	"reactive",
] as const;
export type ObjectiveType = (typeof OBJECTIVE_TYPE_VALUES)[number];

export const OBJECTIVE_STATUS_VALUES = [
	"active",
	"paused",
	"completed",
	"failed",
] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUS_VALUES)[number];

export const OBJECTIVE_RISK_LEVEL_VALUES = [
	"low",
	"medium",
	"high",
	"critical",
] as const;
export type ObjectiveRiskLevel = (typeof OBJECTIVE_RISK_LEVEL_VALUES)[number];

export const TASK_STATUS_VALUES = [
	"pending",
	"in_progress",
	"completed",
	"failed",
	"blocked",
	"abandoned",
] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

export const TASK_KIND_VALUES = [
	"general",
	"inspect",
	"change",
	"validate",
	"deploy",
	"verify",
	"cleanup",
	"research",
	"communicate",
] as const;
export type TaskKind = (typeof TASK_KIND_VALUES)[number];

// =============================================================================
// TABLES
// =============================================================================

export const tediObjectives = sqliteTable(
	"tedi_objectives",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** Purpose revision this objective interprets. Query-layer integrity keeps this additive in D1. */
		purposeCharterId: text("purpose_charter_id"),

		/** Short name — "Keep MCP app healthy" */
		title: text("title").notNull(),

		/** Detailed with success criteria */
		description: text("description"),

		/** HOW to do it, constraints, forbidden actions */
		approach: text("approach"),

		/** What counts as done */
		successCriteria: text("success_criteria"),

		/** Explicit operational constraints */
		constraints: text("constraints"),

		/** one_time, standing, reactive */
		type: text("type", { enum: OBJECTIVE_TYPE_VALUES })
			.notNull()
			.default("standing"),

		/** active, paused, completed, failed */
		status: text("status", { enum: OBJECTIVE_STATUS_VALUES })
			.notNull()
			.default("active"),

		/** low, medium, high, critical */
		riskLevel: text("risk_level", { enum: OBJECTIVE_RISK_LEVEL_VALUES })
			.notNull()
			.default("medium"),

		/** Lower = higher priority */
		priority: integer("priority").notNull().default(0),

		/** JSON array: ["auth", "mcp", "memory"] */
		linkedDomains: text("linked_domains", { mode: "json" })
			.$type<string[]>()
			.default([]),

		/** JSON: { gateType, threshold, firstN } */
		gateConfig: text("gate_config", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		/** JSON: { maxTokens, maxTimeMs, maxCostCents, maxActions } */
		budgetConfig: text("budget_config", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		/** JSON: free-form progress markers */
		progress: text("progress", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		completedAt: text("completed_at"),
	},
	(table) => [
		index("idx_objectives_org").on(table.orgId),
		index("idx_objectives_purpose_charter").on(table.purposeCharterId),
		index("idx_objectives_tedi_status").on(table.tediId, table.status),
		index("idx_objectives_tedi_type").on(table.tediId, table.type),
	],
);

export type TediObjective = typeof tediObjectives.$inferSelect;
export type NewTediObjective = typeof tediObjectives.$inferInsert;

export const tediTasks = sqliteTable(
	"tedi_tasks",
	{
		id: text("id").primaryKey(),

		/** Nullable — ad-hoc tasks have no objective */
		objectiveId: text("objective_id").references(() => tediObjectives.id, {
			onDelete: "cascade",
		}),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** What the tedi is doing */
		title: text("title").notNull(),

		/** general, inspect, change, validate, deploy, verify, cleanup, research, communicate */
		kind: text("kind", { enum: TASK_KIND_VALUES }).notNull().default("general"),

		/** pending, in_progress, completed, failed, blocked, abandoned */
		status: text("status", { enum: TASK_STATUS_VALUES })
			.notNull()
			.default("pending"),

		/** Why progress is blocked */
		blocker: text("blocker"),

		/** JSON array of evidence references */
		evidence: text("evidence", { mode: "json" }).$type<string[]>().default([]),

		/** JSON array of tool names / resources touched */
		toolingUsed: text("tooling_used", { mode: "json" })
			.$type<string[]>()
			.default([]),

		/** JSON: expected tokens / time / cost */
		estimatedCost: text("estimated_cost", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		/** What happened (filled on completion) */
		result: text("result"),

		/** JSON: actual tokens / time / cost */
		actualCost: text("actual_cost", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		/** JSON: { tokens, timeMs, costCents, actions } */
		budgetUsed: text("budget_used", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.default({}),

		/** Consecutive failures (dead-end detection) */
		failCount: integer("fail_count").notNull().default(0),

		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at"),
		completedAt: text("completed_at"),
	},
	(table) => [
		index("idx_tasks_objective").on(table.objectiveId),
		index("idx_tasks_tedi_status").on(table.tediId, table.status),
	],
);

export type TediTask = typeof tediTasks.$inferSelect;
export type NewTediTask = typeof tediTasks.$inferInsert;
