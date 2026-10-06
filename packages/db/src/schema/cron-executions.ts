/**
 * Tedi Cron Execution Ledger
 *
 * Durable, mechanical execution stamps for cognitive-loop cron fires. Every
 * scheduled cognitive cron (brain-reflection, objective-review, …) writes a
 * `running` row at dispatch and a terminal `success`/`failure` row when its
 * turn workflow settles — regardless of what the LLM inside the turn did.
 * This table is THE source `flywheel.crons_flywheel_health` reads; the old
 * behavior (keyword-matching rationale-record prose) depended on the model
 * voluntarily writing a "cycle completed" rationale and was not evidence.
 *
 * One row per fire, keyed by (tedi_id, fire_key) where fire_key is the
 * runtime's deterministic per-fire key (`cron:{scheduleId}:{scheduledTime}`),
 * so alarm re-fires upsert rather than duplicate.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const CRON_EXECUTION_STATUS_VALUES = [
	"running",
	"success",
	"failure",
] as const;

export type CronExecutionStatus = (typeof CRON_EXECUTION_STATUS_VALUES)[number];

export const tediCronExecutions = sqliteTable(
	"tedi_cron_executions",
	{
		id: text("id").primaryKey(),

		tediId: text("tedi_id")
			.notNull()
			.references(() => tedis.id, { onDelete: "cascade" }),

		orgId: text("org_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		/** Cron job name from the schedule payload (e.g. "brain-reflection"). */
		cronName: text("cron_name").notNull(),

		/** Deterministic per-fire key: `cron:{scheduleId}:{scheduledTime}`. */
		fireKey: text("fire_key").notNull(),

		/** Runtime run id the fire dispatched (`{tediId}:cron:{turnKey}`). */
		runId: text("run_id"),

		status: text("status", { enum: CRON_EXECUTION_STATUS_VALUES })
			.notNull()
			.default("running"),

		/** When the fire dispatched (ISO 8601). */
		startedAt: text("started_at").notNull(),

		/** When the turn workflow settled (ISO 8601); null while running. */
		finishedAt: text("finished_at"),

		/** JSON summary of the state transitions the execution performed. */
		transitions: text("transitions", { mode: "json" }).$type<
			Record<string, JsonValue>
		>(),

		/** Terminal error message for status=failure. */
		error: text("error"),

		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("idx_tedi_cron_executions_fire").on(
			table.tediId,
			table.fireKey,
		),
		index("idx_tedi_cron_executions_name_started").on(
			table.tediId,
			table.cronName,
			table.startedAt,
		),
		index("idx_tedi_cron_executions_org_started").on(
			table.orgId,
			table.startedAt,
		),
		// Standalone created_at for the retention sweep (WHERE created_at < cutoff).
		index("idx_tedi_cron_executions_created").on(table.createdAt),
	],
);

export type TediCronExecution = typeof tediCronExecutions.$inferSelect;
export type NewTediCronExecution = typeof tediCronExecutions.$inferInsert;
