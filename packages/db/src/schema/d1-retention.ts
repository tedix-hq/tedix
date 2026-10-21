/**
 * Retention policy for append-only platform ledgers in the core D1 database.
 *
 * One row per supported table. A table without a row is never touched. The
 * engine (`queries/d1-retention.ts`) knows how to read and delete each
 * supported table safely; this row only says whether and how far it may go:
 *
 * - `off`: do nothing.
 * - `dry_run`: estimate what a real run would archive and free, write the
 *   estimate to `last_report`, change no rows.
 * - `archive_then_delete`: copy expired rows to R2 as gzip NDJSON, verify the
 *   object, then delete exactly those rows.
 * - `delete`: delete expired rows without an archive copy.
 *
 * Progress needs no cursor: every pass starts from the oldest remaining row,
 * so an interrupted run resumes where it stopped.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const D1_RETENTION_MODES = [
	"off",
	"dry_run",
	"archive_then_delete",
	"delete",
] as const;

export type D1RetentionMode = (typeof D1_RETENTION_MODES)[number];

export const d1RetentionPolicies = sqliteTable("d1_retention_policies", {
	/** Physical table name; must be a table the engine supports. */
	tableName: text("table_name").primaryKey(),
	mode: text("mode", { enum: D1_RETENTION_MODES }).notNull().default("off"),
	/** Rows older than this many days are eligible. */
	keepDays: integer("keep_days").notNull(),
	/** Upper bound on rows archived or deleted per table per run. */
	maxRowsPerRun: integer("max_rows_per_run").notNull().default(2000),
	lastRunAt: text("last_run_at"),
	/** Last run's report: mode, eligible estimate, bytes, archived/deleted counts. */
	lastReport: text("last_report", { mode: "json" }).$type<
		Record<string, JsonValue>
	>(),
	archivedRowsTotal: integer("archived_rows_total").notNull().default(0),
	deletedRowsTotal: integer("deleted_rows_total").notNull().default(0),
	updatedAt: text("updated_at")
		.notNull()
		.default(sql`(CURRENT_TIMESTAMP)`),
});

export type D1RetentionPolicyRow = typeof d1RetentionPolicies.$inferSelect;
