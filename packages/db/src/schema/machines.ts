import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
	MACHINE_TOOL_CALL_STATUS_VALUES,
	MACHINE_TOOL_NAMES,
} from "@tedix/api-contract/schemas/machines";
import { organizations } from "./organizations";

export const MACHINE_TOOL_CALL_REQUESTER_TYPE_VALUES = [
	"user",
	"tedi",
] as const;
export type MachineToolCallRequesterType =
	(typeof MACHINE_TOOL_CALL_REQUESTER_TYPE_VALUES)[number];

/**
 * One read-only tool call queued for a named machine. The machine's runner
 * claims it and stores a bounded result.
 */
export const machineToolCalls = sqliteTable(
	"machine_tool_calls",
	{
		id: text("id").primaryKey(),
		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		machineName: text("machine_name").notNull(),
		tool: text("tool", { enum: MACHINE_TOOL_NAMES }).notNull(),
		/** The tool's input as JSON text. */
		input: text("input").notNull(),
		requestedByType: text("requested_by_type", {
			enum: MACHINE_TOOL_CALL_REQUESTER_TYPE_VALUES,
		}).notNull(),
		requestedById: text("requested_by_id").notNull(),
		status: text("status", { enum: MACHINE_TOOL_CALL_STATUS_VALUES })
			.notNull()
			.default("pending"),
		result: text("result"),
		error: text("error"),
		/** The runner that claimed the call; only it may store the result. */
		claimedByReporterId: text("claimed_by_reporter_id"),
		createdAt: text("created_at").notNull(),
		claimedAt: text("claimed_at"),
		finishedAt: text("finished_at"),
		/** A call no runner claimed by this time expires. */
		expiresAt: text("expires_at").notNull(),
	},
	(table) => [
		index("idx_machine_tool_calls_machine_status").on(
			table.orgId,
			table.machineName,
			table.status,
			table.createdAt,
		),
		check(
			"chk_machine_tool_calls_bounds",
			sql`length(${table.input}) <= 4000
				AND (${table.result} IS NULL OR length(${table.result}) <= 20000)
				AND (${table.error} IS NULL OR length(${table.error}) <= 1000)`,
		),
	],
);

export type MachineToolCallRow = typeof machineToolCalls.$inferSelect;
export type NewMachineToolCallRow = typeof machineToolCalls.$inferInsert;
