/**
 * Shared monthly-partition contract for Postgres retention ledgers.
 *
 * Lane 10 owns `d1-retention` archive/drop execution; this module owns the
 * schema identity those partitions must preserve. A table is eligible only
 * when its existing guarantees still hold under `PARTITION BY RANGE (<time>)`:
 * the primary key becomes `(id, <partition column>)`, and every unique key
 * already contains the partition column. Tables whose global id, idempotency,
 * or inbound foreign-key guarantees cannot be expressed that way are listed in
 * `RETENTION_PARTITION_EXCLUSIONS` for their owning lane instead of silently
 * dropping the constraint.
 */

import type { PgTable } from "drizzle-orm/pg-core";
import {
	auditEvents,
	kernelRuntimeEvents,
	platformCronExecutions,
	tediRuntimeEvents,
	tediUsageEvents,
	widgetEvents,
	workflowRunLedger,
} from "./core";

export type RetentionPartitionTenantScope =
	| "organization"
	| "tedi"
	| "platform";

export interface RetentionPartitionSpec {
	/** Physical table name, matching `LOGS_DB_TABLE_NAMES` where movable. */
	tableName: string;
	table: PgTable;
	/** Physical column the monthly range partition is bound to. */
	partitionColumn: string;
	/** `timestamp` columns take timestamptz bounds; `text` columns take ISO dates. */
	boundType: "timestamp" | "text";
	/** Who owns archive rows for tenant-scoped reads. */
	tenantScope: RetentionPartitionTenantScope;
	/** Physical owner column when the row carries one directly. */
	ownerColumn?: string;
}

export interface RetentionPartitionExclusion {
	tableName: string;
	owner: string;
	reason: string;
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function spec(
	tableName: string,
	table: PgTable,
	partitionColumn: string,
	boundType: "timestamp" | "text",
	tenantScope: RetentionPartitionTenantScope,
	ownerColumn?: string,
): RetentionPartitionSpec {
	return {
		tableName,
		table,
		partitionColumn,
		boundType,
		tenantScope,
		ownerColumn,
	};
}

/**
 * Monthly-range candidates whose current constraints survive partitioning.
 * `id` stays the leading identity column; the partition column is appended so
 * PostgreSQL accepts the key. Readers keep deduping by `id` across Postgres
 * and archive sources.
 */
export const RETENTION_PARTITION_TABLES: readonly RetentionPartitionSpec[] = [
	spec(
		"audit_events",
		auditEvents,
		"timestamp",
		"timestamp",
		"organization",
		"organization_id",
	),
	spec(
		"tedi_runtime_events",
		tediRuntimeEvents,
		"created_at",
		"text",
		"organization",
		"organization_id",
	),
	spec(
		"kernel_runtime_events",
		kernelRuntimeEvents,
		"created_at",
		"text",
		"organization",
		"organization_id",
	),
	spec(
		"tedi_usage_events",
		tediUsageEvents,
		"created_at",
		"text",
		"tedi",
		"tedi_id",
	),
	spec(
		"widget_events",
		widgetEvents,
		"created_at",
		"text",
		"organization",
		"organization_id",
	),
	spec(
		"workflow_run_ledger",
		workflowRunLedger,
		"started_at",
		"text",
		"platform",
	),
	spec(
		"platform_cron_executions",
		platformCronExecutions,
		"scheduled_at",
		"text",
		"platform",
	),
];

/**
 * Retention tables that must not be monthly-partitioned until their owning
 * lane preserves the named guarantee. Keeping them out of the shared contract
 * is deliberate: a partitioned table cannot enforce a unique key or inbound FK
 * that omits the partition column.
 */
export const RETENTION_PARTITION_EXCLUSIONS: readonly RetentionPartitionExclusion[] =
	[
		{
			tableName: "skill_run_artifacts",
			owner: "cognitive/skill-runs",
			reason:
				"unique(run_id, path) idempotency omits created_at; partition key or identity registry required",
		},
		{
			tableName: "external_agent_attributions",
			owner: "external-agent-identity",
			reason:
				"global (organization_id, id) and attribution uniques omit occurred_at; review evidence FKs to (organization_id, id)",
		},
		{
			tableName: "tedi_call_costs",
			owner: "billing/usage-ledger",
			reason: "global gateway_log_id idempotency omits the partition column",
		},
		{
			tableName: "kernel_request_events",
			owner: "kernel-requests",
			reason:
				"unique(request_id, version) history idempotency omits created_at",
		},
		{
			tableName: "provider_execution_attempts",
			owner: "provider-executions/billing",
			reason:
				"unique(organization_id, idempotency_key) admission idempotency omits authorized_at",
		},
		{
			tableName: "billing_usage_quarantines",
			owner: "billing",
			reason: "global gateway_log_id quarantine uniqueness omits created_at",
		},
		{
			tableName: "site_reconciliation_runs",
			owner: "site-reconciliation",
			reason:
				"site_reconciliation_findings has an inbound FK to runs.id; partitioning runs requires a composite run identity",
		},
	];

export function getRetentionPartitionSpec(
	tableName: string,
): RetentionPartitionSpec | null {
	return (
		RETENTION_PARTITION_TABLES.find((entry) => entry.tableName === tableName) ??
		null
	);
}

export function getRetentionPartitionExclusion(
	tableName: string,
): RetentionPartitionExclusion | null {
	return (
		RETENTION_PARTITION_EXCLUSIONS.find(
			(entry) => entry.tableName === tableName,
		) ?? null
	);
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface RetentionPartitionMonth {
	/** Canonical `YYYY-MM` partition key. */
	month: string;
	/** Inclusive lower bound as a `YYYY-MM-DD` date. */
	from: string;
	/** Exclusive upper bound as a `YYYY-MM-DD` date. */
	to: string;
}

/** Validate and expand a monthly partition key into its half-open range. */
export function retentionPartitionMonth(
	month: string,
): RetentionPartitionMonth {
	const match = MONTH.exec(month);
	if (!match) throw new Error(`Invalid retention partition month: ${month}`);
	const year = Number(match[1]);
	const index = Number(match[2]) - 1;
	const from = `${match[1]}-${match[2]}-01`;
	const toDate = new Date(Date.UTC(year, index + 1, 1));
	const to = toDate.toISOString().slice(0, 10);
	return { month, from, to };
}

/** Quoted literal bound for `FOR VALUES FROM/TO` in the table's column type. */
export function retentionPartitionBoundLiteral(
	spec: RetentionPartitionSpec,
	month: string,
	edge: "from" | "to",
): string {
	const range = retentionPartitionMonth(month);
	const value = edge === "from" ? range.from : range.to;
	return literal(
		spec.boundType === "timestamp" ? `${value} 00:00:00+00` : value,
	);
}

/** Default monthly child name: `audit_events_2026_11`. */
export function retentionPartitionName(
	spec: RetentionPartitionSpec,
	month: string,
): string {
	return `${spec.tableName}_${month.replace("-", "_")}`;
}

/** `CREATE TABLE ... PARTITION OF ... FOR VALUES FROM (...) TO (...)`. */
export function retentionPartitionOfStatement(
	spec: RetentionPartitionSpec,
	month: string,
	name = retentionPartitionName(spec, month),
): string {
	return `CREATE TABLE ${quote(name)} PARTITION OF ${quote(spec.tableName)} FOR VALUES FROM (${retentionPartitionBoundLiteral(spec, month, "from")}) TO (${retentionPartitionBoundLiteral(spec, month, "to")})`;
}

/** Primary-key columns required by the monthly identity strategy. */
export function retentionPartitionPrimaryKeyColumns(
	spec: RetentionPartitionSpec,
): string[] {
	return ["id", spec.partitionColumn];
}

/** Drizzle `pgTableDdl` options implementing the shared partition identity. */
export function retentionPartitionDdlOptions(spec: RetentionPartitionSpec) {
	return {
		partitionBy: {
			strategy: "range" as const,
			columns: [spec.partitionColumn],
		},
		primaryKeyColumns: retentionPartitionPrimaryKeyColumns(spec),
		primaryKeyName: `${spec.tableName}_pkey`,
	};
}
