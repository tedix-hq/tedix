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
 * - `tedi_call_costs`: settled or quarantined organization rows and platform
 *   rows (no organization) past the keep window. Pending settlement and reviewed source rows
 *   stay beside authority in main. The organization ledger merges archives.
 *
 * - `kernel_request_events`: request history past the keep window. New
 *   events stay in main, where they are inserted from their request row.
 * - `platform_cron_executions`: finished cron runs past the keep window;
 *   running rows stay in main.
 * - `tedi_usage_events`, `widget_events`, `workflow_run_ledger`: rows the
 *   nightly cleanup used to delete (30, 30 and 90 days); unfinished workflow
 *   runs stay in main.
 *
 * Readers merge both stores through `getLogStores()` in `client.ts`. The
 * checked-in DDL under `packages/db/logs-db/migrations` is derived from this
 * list; `scripts/logs-db-schema.test.ts` keeps the two in step.
 */

import { sqliteTable, text, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { auditEvents } from "./audit-events";
import { auditMetadataRefs } from "./audit-metadata-refs";
import { skillRunArtifacts } from "./cognitive";
import { kernelRuntimeEvents, tediRuntimeEvents } from "./cognitive-runtime";
import { externalAgentAttributions } from "./external-agent-identity";
import { kernelRequestEvents } from "./kernel-requests";
import { platformCronExecutions } from "./platform-cron-executions";
import { tediCallCosts, tediUsageEvents } from "./tedis";
import { widgetEvents } from "./analytics";
import { workflowRunLedger } from "./workflow-runs";

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
	auditMetadataRefs,
	tediRuntimeEvents,
	kernelRuntimeEvents,
	skillRunArtifacts,
	externalAgentAttributions,
	tediCallCosts,
	kernelRequestEvents,
	platformCronExecutions,
	tediUsageEvents,
	workflowRunLedger,
	widgetEvents,
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
		ddl: `CREATE INDEX "idx_audit_events_org_app_ref_timestamp" ON "audit_events" ("organization_id", json_extract("metadata", '$._r.a'), "timestamp");`,
	},
	{
		table: "audit_events",
		ddl: `CREATE INDEX "idx_audit_events_org_actor_timestamp" ON "audit_events" ("organization_id", "actor_id", "timestamp");`,
	},
	{
		table: "kernel_runtime_events",
		ddl: `CREATE INDEX "idx_kernel_runtime_events_child_created" ON "kernel_runtime_events" ("organization_id", "child_run_id", "created_at", "id");`,
	},
	{
		table: "kernel_runtime_events",
		ddl: `CREATE INDEX "idx_kernel_runtime_events_trace" ON "kernel_runtime_events" ("organization_id", "trace_id", "created_at") WHERE trace_id is not null;`,
	},
	// Dropped from main on 20 Nov 2026 to free space; the logs databases
	// keep them, so their applied migrations stay unchanged.
	{
		table: "tedi_runtime_events",
		ddl: `CREATE INDEX "idx_tedi_runtime_events_artifact" ON "tedi_runtime_events" ("artifact_id");`,
	},
	{
		table: "tedi_call_costs",
		ddl: `CREATE INDEX "idx_call_costs_source" ON "tedi_call_costs" ("tedi_id", "source", "snapshot_at");`,
	},
	{
		table: "external_agent_attributions",
		ddl: `CREATE INDEX "idx_external_agent_attribution_session" ON "external_agent_attributions" ("organization_id", "session_id", "occurred_at");`,
	},
	// Dropped from main on 21 Nov 2026 as a prefix of
	// idx_tedi_runtime_events_org_unfinished; the logs databases keep it.
	{
		table: "tedi_runtime_events",
		ddl: `CREATE INDEX "idx_tedi_runtime_events_org" ON "tedi_runtime_events" ("organization_id");`,
	},
];

/** Movable log tables for retention policy checks; excludes directory metadata. */
export const LOGS_DB_TABLE_NAMES: ReadonlySet<string> = new Set([
	"audit_events",
	"tedi_runtime_events",
	"kernel_runtime_events",
	"skill_run_artifacts",
	"external_agent_attributions",
	"tedi_call_costs",
	"kernel_request_events",
	"platform_cron_executions",
	"tedi_usage_events",
	"workflow_run_ledger",
	"widget_events",
]);
