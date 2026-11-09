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
 * - `audit_events`: known MCP execution telemetry is written here directly
 *   when the binding is present (`queries/audit.ts`). Access denials, payments,
 *   unknown actions and main-database batch audit stay in the main database.
 * - `tedi_runtime_events`, `kernel_runtime_events`, `skill_run_artifacts`:
 *   new rows stay in the main database, because the runtime joins, cause-bound
 *   inserts and compare-and-set reads need them there. The retention job's
 *   `move_to_logs_db` mode copies rows older than the keep window here,
 *   verifies the copy, and only then removes them from the main database.
 * - `external_agent_attributions`: new rows stay in the main database, where
 *   the insert checks the issuing credential and the unique key. The retention
 *   move takes only `mcp_execution` rows past the keep window that no review
 *   evidence cites; the writers check the logs database before inserting an
 *   attribution that old, so a replay never creates a second copy.
 *
 * Readers merge both stores through `getLogStores()` in `client.ts`. The
 * checked-in DDL under `packages/db/logs-db/migrations` is derived from this
 * list; `scripts/logs-db-schema.test.ts` keeps the two in step.
 */

import { sqliteTable, text, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { auditEvents } from "./audit-events";
import { skillRunArtifacts } from "./cognitive";
import { kernelRuntimeEvents, tediRuntimeEvents } from "./cognitive-runtime";
import { externalAgentAttributions } from "./external-agent-identity";

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
	externalAgentAttributions,
	logPartition,
];

/** Indexes that belong only to the logs database, not the shared main schema. */
export const LOGS_DB_INDEXES: readonly {
	table: string;
	ddl: string;
}[] = [
	{
		table: "audit_events",
		ddl: `CREATE INDEX "idx_audit_events_trace_timestamp" ON "audit_events" (json_extract("metadata", '$.traceId'), "timestamp");`,
	},
	{
		table: "audit_events",
		ddl: `CREATE INDEX "idx_audit_events_execution_timestamp" ON "audit_events" (json_extract("metadata", '$.executionId'), "timestamp");`,
	},
	{
		table: "audit_events",
		ddl: `CREATE INDEX "idx_audit_events_org_app_timestamp" ON "audit_events" ("organization_id", json_extract("metadata", '$.appId'), "timestamp");`,
	},
	{
		table: "audit_events",
		ddl: `CREATE INDEX "idx_audit_events_org_actor_timestamp" ON "audit_events" ("organization_id", "actor_id", "timestamp");`,
	},
];

/** Movable log tables for retention policy checks; excludes directory metadata. */
export const LOGS_DB_TABLE_NAMES: ReadonlySet<string> = new Set([
	"audit_events",
	"tedi_runtime_events",
	"kernel_runtime_events",
	"skill_run_artifacts",
	"external_agent_attributions",
]);
