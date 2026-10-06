/**
 * Durable receipts for API Worker Cron Trigger maintenance paths.
 *
 * One row represents one logical maintenance path for one Cloudflare scheduled
 * fire. `schedule_id + scheduled_at` is deterministic, so at-least-once Cron
 * Trigger delivery cannot duplicate evidence.
 */

import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const PLATFORM_CRON_EXECUTION_STATUS_VALUES = [
	"running",
	"success",
	"failure",
] as const;

export type PlatformCronExecutionStatus =
	(typeof PLATFORM_CRON_EXECUTION_STATUS_VALUES)[number];

export const platformCronExecutions = sqliteTable(
	"platform_cron_executions",
	{
		id: text("id").primaryKey(),
		/** Stable logical path name, for example `work-item-lease-expiry`. */
		scheduleId: text("schedule_id").notNull(),
		/** Cloudflare Cron Trigger expression that delivered the fire. */
		cron: text("cron").notNull(),
		/** Cloudflare's scheduled time, not Worker wall-clock arrival time. */
		scheduledAt: text("scheduled_at").notNull(),
		startedAt: text("started_at").notNull(),
		finishedAt: text("finished_at"),
		status: text("status", { enum: PLATFORM_CRON_EXECUTION_STATUS_VALUES })
			.notNull()
			.default("running"),
		durationMs: integer("duration_ms"),
		/** Bounded database-row effects reported by the owning maintenance path. */
		affectedRowCounts: text("affected_row_counts", { mode: "json" })
			.$type<Record<string, number>>()
			.notNull()
			.default(sql`'{}'`),
		/** Normalized, bounded terminal error for status=failure. */
		error: text("error"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("idx_platform_cron_executions_fire").on(
			table.scheduleId,
			table.scheduledAt,
		),
		index("idx_platform_cron_executions_schedule_started").on(
			table.scheduleId,
			table.startedAt,
		),
		index("idx_platform_cron_executions_status_started").on(
			table.status,
			table.startedAt,
		),
		index("idx_platform_cron_executions_created").on(table.createdAt),
	],
);

export type PlatformCronExecution = typeof platformCronExecutions.$inferSelect;
export type NewPlatformCronExecution =
	typeof platformCronExecutions.$inferInsert;
