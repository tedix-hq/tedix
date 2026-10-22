/**
 * Tables the logs database (`LOGS_DB` binding) holds.
 *
 * The logs database is a second D1 that takes the append-only log classes out
 * of the main database. It holds the SAME table definitions as the main
 * database (the query modules run the same statements against either store),
 * minus foreign keys: its parent tables (organizations, tedis, skill_runs)
 * stay in the main database.
 *
 * What lands here and how:
 * - `audit_events`: new `mcp.tool.execute` rows are written here directly
 *   when the binding is present (`queries/audit.ts`); every other audit action
 *   stays in the main database.
 * - `tedi_runtime_events`, `kernel_runtime_events`, `skill_run_artifacts`:
 *   new rows stay in the main database, because the runtime joins, cause-bound
 *   inserts and compare-and-set reads need them there. The retention job's
 *   `move_to_logs_db` mode copies rows older than the keep window here,
 *   verifies the copy, and only then removes them from the main database.
 *
 * Readers merge both stores through `getLogStores()` in `client.ts`. The
 * checked-in DDL under `packages/db/logs-db/migrations` is derived from this
 * list; `scripts/logs-db-schema.test.ts` keeps the two in step.
 */

import { sqliteTable, text, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { auditEvents } from "./audit-events";
import { skillRunArtifacts } from "./cognitive";
import { kernelRuntimeEvents, tediRuntimeEvents } from "./cognitive-runtime";

/**
 * Logs-local directory, never part of the main migration chain. Apply the logs
 * migrations to every binding before attaching numbered historical partitions.
 * An empty directory reads all dates. Otherwise the operator supplies one row
 * whose bounds cover every stored event (including retention backfill). Keep
 * fromTs fixed; seal with an inclusive toTs after writes stop. Active ranges
 * have no upper bound, so a cached active row remains safe during rotation.
 */
export const logPartition = sqliteTable("log_partition", {
	id: text("id").primaryKey(),
	state: text("state", { enum: ["active", "sealed"] }).notNull(),
	fromTs: text("from_ts").notNull(),
	toTs: text("to_ts"),
	createdAt: text("created_at").notNull(),
});

export const LOGS_DB_TABLES: readonly SQLiteTable[] = [
	auditEvents,
	tediRuntimeEvents,
	kernelRuntimeEvents,
	skillRunArtifacts,
	logPartition,
];

/** Movable log tables for retention policy checks; excludes directory metadata. */
export const LOGS_DB_TABLE_NAMES: ReadonlySet<string> = new Set([
	"audit_events",
	"tedi_runtime_events",
	"kernel_runtime_events",
	"skill_run_artifacts",
]);
