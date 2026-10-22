/**
 * Retention engine statements for append-only ledgers in the core D1 database.
 *
 * The policy (mode, keep days, per-run cap) lives in `d1_retention_policies`
 * rows. This module owns the engine side: which tables are supported, how
 * each one is timestamped, the minimum window it may never go below, and the
 * bounded statements a run uses.
 *
 * Every read walks the table's own rowid b-tree from the oldest end, so no
 * statement depends on a timestamp index. The engine advances through bounded
 * pages, skipping newer or invalid timestamps instead of assuming rowid order
 * matches timestamp order. Each delete names at most one page of rowids and
 * repeats the cutoff test, so it only removes rows read and judged expired.
 *
 * Row lists travel as one JSON bound parameter expanded with `json_each`, so a
 * page costs one statement instead of one per 50 rows while every statement
 * stays far under D1's 100 bound-parameter cap.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { eq, getColumns, type SQL, sql } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../query-client";
import { auditEvents } from "../schema/audit-events";
import { skillRunArtifacts } from "../schema/cognitive";
import {
	kernelRuntimeEvents,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import {
	type D1RetentionPolicyRow,
	d1RetentionPolicies,
} from "../schema/d1-retention";
import { LOGS_DB_TABLE_NAMES } from "../schema/logs-db";
import { tediCallCosts } from "../schema/tedis";

/** Rows the backlog estimate samples for the average row size. */
export const D1_RETENTION_SAMPLE_ROWS = 50;

/** Rows one page reads and one delete statement names; a run moves one page per step. */
export const D1_RETENTION_PAGE_ROWS = 500;

/**
 * How a supported table stores its age.
 * - `epoch_seconds`: integer Unix seconds (Drizzle `mode: "timestamp"`).
 * - `text`: ISO-8601 or SQLite `CURRENT_TIMESTAMP` text. Both sort by date
 *   prefix, so the cutoff is compared as a `YYYY-MM-DD` day boundary.
 */
export type D1RetentionTimestampFormat = "epoch_seconds" | "text";

export interface D1RetentionTableSpec {
	tableName: string;
	table: SQLiteTable;
	timestamp: AnySQLiteColumn;
	format: D1RetentionTimestampFormat;
	/** A policy window below this is raised to it. */
	minKeepDays: number;
	/** Financial or legal evidence: may be archived and removed, never dropped. */
	archiveRequired: boolean;
	/** The logs database holds this table, so `move_to_logs_db` may run. */
	logsDb: boolean;
}

function spec(
	tableName: string,
	table: SQLiteTable,
	timestamp: AnySQLiteColumn,
	format: D1RetentionTimestampFormat,
	minKeepDays: number,
	archiveRequired = false,
): D1RetentionTableSpec {
	return {
		tableName,
		table,
		timestamp,
		format,
		minKeepDays,
		archiveRequired,
		logsDb: LOGS_DB_TABLE_NAMES.has(tableName),
	};
}

/**
 * Tables the engine may touch. A table belongs here only when nothing
 * references its rows with a foreign key (a delete could otherwise fail or
 * cascade) and readers tolerate old rows disappearing.
 */
export const D1_RETENTION_TABLES: Readonly<
	Record<string, D1RetentionTableSpec>
> = Object.freeze({
	audit_events: spec(
		"audit_events",
		auditEvents,
		auditEvents.timestamp,
		"epoch_seconds",
		30,
		true,
	),
	tedi_runtime_events: spec(
		"tedi_runtime_events",
		tediRuntimeEvents,
		tediRuntimeEvents.createdAt,
		"text",
		14,
	),
	kernel_runtime_events: spec(
		"kernel_runtime_events",
		kernelRuntimeEvents,
		kernelRuntimeEvents.createdAt,
		"text",
		14,
	),
	skill_run_artifacts: spec(
		"skill_run_artifacts",
		skillRunArtifacts,
		skillRunArtifacts.createdAt,
		"text",
		14,
		true,
	),
	tedi_call_costs: spec(
		"tedi_call_costs",
		tediCallCosts,
		tediCallCosts.createdAt,
		"text",
		400,
		true,
	),
});

export function getD1RetentionTableSpec(
	tableName: string,
): D1RetentionTableSpec | null {
	return Object.hasOwn(D1_RETENTION_TABLES, tableName)
		? (D1_RETENTION_TABLES[tableName] ?? null)
		: null;
}

export type D1RetentionCutoff = number | string;

/** The exclusive cutoff value in the table's own timestamp representation. */
export function d1RetentionCutoff(
	tableSpec: D1RetentionTableSpec,
	now: Date,
	keepDays: number,
): D1RetentionCutoff {
	const cutoffMs = now.getTime() - keepDays * 86_400_000;
	if (tableSpec.format === "epoch_seconds") return Math.floor(cutoffMs / 1000);
	return new Date(cutoffMs).toISOString().slice(0, 10);
}

export function isD1RetentionExpired(
	tableSpec: D1RetentionTableSpec,
	value: unknown,
	cutoff: D1RetentionCutoff,
): boolean {
	if (value === null || value === undefined) return false;
	if (tableSpec.format === "epoch_seconds") {
		return (
			typeof value === "number" &&
			Number.isFinite(new Date(value * 1000).getTime()) &&
			value < (cutoff as number)
		);
	}
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/.test(value)
	)
		return false;
	const parsed = new Date(
		value.length === 10
			? `${value}T00:00:00Z`
			: `${value.replace(" ", "T").replace(/Z$/, "")}Z`,
	);
	return (
		Number.isFinite(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value.slice(0, 10) &&
		value < (cutoff as string)
	);
}

/**
 * The keep window a run uses: the row's `keep_days`, raised to the table's
 * floor. A row below the floor (the shipped audit seed says 14 days against
 * a 30-day floor) runs with the floor and reports both values, instead of
 * being refused on every tick and never even dry-running.
 */
export function d1RetentionEffectiveKeepDays(
	tableSpec: Pick<D1RetentionTableSpec, "minKeepDays">,
	policy: Pick<D1RetentionPolicyRow, "keepDays">,
): number {
	return Math.max(policy.keepDays, tableSpec.minKeepDays);
}

/** Why a policy row cannot run; null when it can. */
export function d1RetentionPolicyProblem(
	policy: Pick<D1RetentionPolicyRow, "tableName" | "mode" | "keepDays">,
): string | null {
	const tableSpec = getD1RetentionTableSpec(policy.tableName);
	if (!tableSpec) return "unsupported_table";
	if (!Number.isInteger(policy.keepDays)) return "keep_days_not_integer";
	// Artifact views need a queryable pointer to their separately stored R2 body.
	if (
		policy.tableName === "skill_run_artifacts" &&
		policy.mode === "archive_then_delete"
	)
		return "logs_copy_required";
	if (policy.mode === "delete" && tableSpec.archiveRequired) {
		return "archive_required";
	}
	if (policy.mode === "move_to_logs_db" && !tableSpec.logsDb) {
		return "logs_db_unsupported";
	}
	return null;
}

export async function listActiveD1RetentionPolicies(
	db: DbQueryClient,
): Promise<D1RetentionPolicyRow[]> {
	const rows = await db
		.select()
		.from(d1RetentionPolicies)
		.orderBy(d1RetentionPolicies.tableName);
	return rows.filter((row) => row.mode !== "off");
}

/** One raw row as stored, plus its rowid, for archiving. */
export type D1RetentionRow = Record<string, JsonValue> & { __rowid: number };

/**
 * Up to one page of the oldest rows after `afterRowid`, in rowid order. Walks
 * the table b-tree only; never filters on the timestamp in SQL, which without
 * an index would scan every newer row.
 */
export async function readD1RetentionPage(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	afterRowid: number,
	limit = D1_RETENTION_PAGE_ROWS,
): Promise<D1RetentionRow[]> {
	const bounded = Math.max(
		1,
		Math.min(D1_RETENTION_PAGE_ROWS, Math.floor(limit)),
	);
	return (await db.all(
		sql`SELECT rowid AS __rowid, * FROM ${tableSpec.table} WHERE rowid > ${afterRowid} ORDER BY rowid LIMIT ${bounded}`,
	)) as D1RetentionRow[];
}

/**
 * Delete statements for rows the run already read and judged expired: one
 * statement per page of rowids (passed as one JSON parameter, looked up by
 * rowid), and the cutoff is tested again so a row can never be removed while
 * it is still inside the keep window.
 */
export function buildD1RetentionDeleteStatements(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	rowids: readonly number[],
	cutoff: D1RetentionCutoff,
) {
	const statements = [];
	for (let start = 0; start < rowids.length; start += D1_RETENTION_PAGE_ROWS) {
		const chunk = rowids.slice(start, start + D1_RETENTION_PAGE_ROWS);
		statements.push(
			db
				.delete(tableSpec.table)
				.where(
					sql`rowid IN (SELECT value FROM json_each(${JSON.stringify(chunk)})) AND ${tableSpec.timestamp} < ${cutoff}`,
				)
				.returning({ rowid: sql<number>`rowid` }),
		);
	}
	return statements;
}

/**
 * Run delete statements in one D1 batch; returns rows removed, counted from
 * the rowids each statement returns.
 */
export async function deleteD1RetentionRows(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	rowids: readonly number[],
	cutoff: D1RetentionCutoff,
): Promise<number> {
	const statements = buildD1RetentionDeleteStatements(
		db,
		tableSpec,
		rowids,
		cutoff,
	);
	const [first, ...rest] = statements;
	if (!first) return 0;
	const results = await db.batch([first, ...rest]);
	return results.reduce((sum, rows) => sum + rows.length, 0);
}

export interface D1RetentionBacklogEstimate {
	/** Oldest row's stored timestamp, if any rows exist. */
	oldest: JsonValue;
	/** Estimated rows older than the cutoff (rowid span x sampled density). */
	eligibleRows: number;
	/** Mean stored bytes of the 50 oldest rows (column data, no index overhead). */
	avgRowBytes: number;
	/** eligibleRows x avgRowBytes. Index entries free roughly 20-40 % more. */
	eligibleBytes: number;
}

async function rowAt(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	atOrAfterRowid: number,
): Promise<{ rowid: number; ts: JsonValue } | null> {
	const [row] = (await db.all(
		sql`SELECT rowid AS rowid_value, ${tableSpec.timestamp} AS ts FROM ${tableSpec.table} WHERE rowid >= ${atOrAfterRowid} ORDER BY rowid LIMIT 1`,
	)) as Array<{ rowid_value: number; ts: JsonValue }>;
	return row ? { rowid: Number(row.rowid_value), ts: row.ts } : null;
}

/**
 * Estimate the expired backlog with a few dozen indexed point reads: binary
 * search the rowid where rows enter the keep window, sample density at the
 * old end, and average the stored bytes of the oldest rows. Never counts or
 * scans the table.
 */
export async function estimateD1RetentionBacklog(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	cutoff: D1RetentionCutoff,
): Promise<D1RetentionBacklogEstimate> {
	const [bounds] = (await db.all(
		sql`SELECT (SELECT min(rowid) FROM ${tableSpec.table}) AS lo, (SELECT max(rowid) FROM ${tableSpec.table}) AS hi`,
	)) as Array<{ lo: number | null; hi: number | null }>;
	const lo = bounds?.lo ?? null;
	const hi = bounds?.hi ?? null;
	if (lo === null || hi === null) {
		return { oldest: null, eligibleRows: 0, avgRowBytes: 0, eligibleBytes: 0 };
	}
	const first = await rowAt(db, tableSpec, lo);
	if (!first || !isD1RetentionExpired(tableSpec, first.ts, cutoff)) {
		return {
			oldest: first?.ts ?? null,
			eligibleRows: 0,
			avgRowBytes: 0,
			eligibleBytes: 0,
		};
	}
	// Smallest rowid whose row is inside the keep window (hi + 1 if none).
	// Invariant: every row below `left` is expired; no row at or after `right`
	// is expired.
	let left = first.rowid + 1;
	let right = hi + 1;
	for (let probe = 0; probe < 64 && left < right; probe++) {
		const mid = Math.floor((left + right) / 2);
		const row = await rowAt(db, tableSpec, mid);
		if (!row || row.rowid >= right) {
			right = mid;
		} else if (isD1RetentionExpired(tableSpec, row.ts, cutoff)) {
			left = row.rowid + 1;
		} else {
			right = row.rowid;
		}
	}
	const boundary = left;
	const span = Math.max(0, boundary - lo);
	const window = Math.min(span, 1000);
	const [density] = (await db.all(
		sql`SELECT count(*) AS n FROM ${tableSpec.table} WHERE rowid >= ${lo} AND rowid < ${lo + window}`,
	)) as Array<{ n: number }>;
	const live = window > 0 ? Number(density?.n ?? 0) / window : 0;
	const columnNames = Object.values(getColumns(tableSpec.table)).map(
		(column) => (column as AnySQLiteColumn).name,
	);
	const lengthExpression = sql.join(
		columnNames.map(
			(name) => sql`coalesce(length(CAST(${sql.identifier(name)} AS BLOB)), 0)`,
		),
		sql` + `,
	);
	const [sample] = (await db.all(
		sql`SELECT avg(row_bytes) AS avg_bytes FROM (SELECT ${lengthExpression} AS row_bytes FROM ${tableSpec.table} ORDER BY rowid LIMIT ${D1_RETENTION_SAMPLE_ROWS})`,
	)) as Array<{ avg_bytes: number | null }>;
	const avgRowBytes = Math.round(Number(sample?.avg_bytes ?? 0));
	const eligibleRows = Math.round(span * live);
	return {
		oldest: first.ts,
		eligibleRows,
		avgRowBytes,
		eligibleBytes: eligibleRows * avgRowBytes,
	};
}

export interface D1RetentionRunRecord {
	tableName: string;
	ranAt: string;
	report: Record<string, JsonValue>;
	archivedRows: number;
	deletedRows: number;
}

export async function recordD1RetentionRun(
	db: DbQueryClient,
	record: D1RetentionRunRecord,
): Promise<void> {
	await db
		.update(d1RetentionPolicies)
		.set({
			lastRunAt: record.ranAt,
			lastReport: record.report,
			archivedRowsTotal: sql`${d1RetentionPolicies.archivedRowsTotal} + ${record.archivedRows}`,
			deletedRowsTotal: sql`${d1RetentionPolicies.deletedRowsTotal} + ${record.deletedRows}`,
			updatedAt: record.ranAt,
		})
		.where(eq(d1RetentionPolicies.tableName, record.tableName));
}

// ============================================================================
// Copy to the logs database (`move_to_logs_db`)
// ============================================================================

/** The text primary key every logs-database table carries. */
const LOGS_ID_COLUMN = "id";

/**
 * JSON characters one copy statement carries in its single bound parameter. A row
 * larger than this is copied alone with one bound parameter per column.
 */
export const D1_LOGS_COPY_STATEMENT_BYTES = 256 * 1024;
/** JSON characters one logs-database batch carries; a larger page takes more batches. */
const D1_LOGS_COPY_BATCH_BYTES = 1024 * 1024;

function tableColumnNames(tableSpec: D1RetentionTableSpec): string[] {
	return Object.values(getColumns(tableSpec.table)).map(
		(column) => (column as AnySQLiteColumn).name,
	);
}

function rowValue(row: D1RetentionRow, column: string): JsonValue {
	const value = row[column];
	return value === undefined ? null : value;
}

export interface D1LogsCopyStatement {
	query: SQL;
	/** JSON characters the statement binds, for batch sizing. */
	bytes: number;
}

/**
 * `INSERT OR IGNORE` statements that copy raw rows (as `readD1RetentionPage`
 * returned them, JSON columns still text) into the logs database. Rows travel
 * as one JSON array parameter per statement, each row a positional array of
 * column values, expanded with `json_each`. Insert-or-ignore makes a resumed
 * run idempotent: a row copied before a crash is left as it is, and the
 * read-back check still compares it with the source.
 */
export function buildD1LogsCopyStatements(
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
): D1LogsCopyStatement[] {
	const columns = tableColumnNames(tableSpec);
	const columnList = sql.join(
		columns.map((name) => sql.identifier(name)),
		sql`, `,
	);
	const extract = sql.join(
		columns.map((_, index) => sql.raw(`json_extract(value, '$[${index}]')`)),
		sql`, `,
	);
	const statements: D1LogsCopyStatement[] = [];
	let group: string[] = [];
	let groupBytes = 0;
	const flush = () => {
		if (group.length === 0) return;
		const json = `[${group.join(",")}]`;
		statements.push({
			query: sql`INSERT OR IGNORE INTO ${tableSpec.table} (${columnList}) SELECT ${extract} FROM json_each(${json})`,
			bytes: json.length,
		});
		group = [];
		groupBytes = 0;
	};
	for (const row of rows) {
		const values = columns.map((name) => rowValue(row, name));
		const json = JSON.stringify(values);
		if (json.length > D1_LOGS_COPY_STATEMENT_BYTES) {
			// Bound column by column: no single parameter grows past the value itself.
			statements.push({
				query: sql`INSERT OR IGNORE INTO ${tableSpec.table} (${columnList}) VALUES (${sql.join(
					values.map((value) => sql`${value}`),
					sql`, `,
				)})`,
				bytes: json.length,
			});
			continue;
		}
		if (groupBytes + json.length > D1_LOGS_COPY_STATEMENT_BYTES) flush();
		group.push(json);
		groupBytes += json.length + 1;
	}
	flush();
	return statements;
}

/**
 * Copy rows into the logs database and read them back by id. The read-back
 * rides the last copy batch (one round trip for a typical page), so it sees
 * exactly what the committed batch wrote. Returns the logs rows keyed by id
 * for `verifyD1LogsCopy`.
 */
export async function copyD1RetentionRowsToLogs(
	logsDb: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
): Promise<Map<string, Record<string, JsonValue>>> {
	const ids = JSON.stringify(rows.map(d1RetentionRowId));
	const batches: D1LogsCopyStatement[][] = [[]];
	let batchBytes = 0;
	for (const statement of buildD1LogsCopyStatements(tableSpec, rows)) {
		const current = batches[batches.length - 1] ?? [];
		if (
			current.length > 0 &&
			batchBytes + statement.bytes > D1_LOGS_COPY_BATCH_BYTES
		) {
			batches.push([statement]);
			batchBytes = statement.bytes;
		} else {
			current.push(statement);
			batchBytes += statement.bytes;
		}
	}
	let copied: Array<Record<string, JsonValue>> = [];
	for (const [index, batch] of batches.entries()) {
		const queries = batch.map((statement) => logsDb.run(statement.query));
		if (index < batches.length - 1) {
			const [first, ...rest] = queries;
			if (first) await logsDb.batch([first, ...rest]);
			continue;
		}
		const readBack = logsDb.all<Record<string, JsonValue>>(
			sql`SELECT * FROM ${tableSpec.table} WHERE ${sql.identifier(LOGS_ID_COLUMN)} IN (SELECT value FROM json_each(${ids}))`,
		);
		// The read-back runs after every insert of the batch.
		const [first, ...rest] = [...queries, readBack];
		if (!first) continue;
		const results = await logsDb.batch([first, ...rest]);
		copied = results[results.length - 1] as Array<Record<string, JsonValue>>;
	}
	return new Map(copied.map((row) => [String(row[LOGS_ID_COLUMN]), row]));
}

export interface D1LogsCopyVerification {
	/** Source ids with no row in the logs database. */
	missing: string[];
	/** Source ids whose logs-database row differs in at least one column. */
	mismatched: string[];
}

/** Every source column must read back identical from the logs database. */
export function verifyD1LogsCopy(
	tableSpec: D1RetentionTableSpec,
	source: readonly D1RetentionRow[],
	copied: ReadonlyMap<string, Record<string, JsonValue>>,
): D1LogsCopyVerification {
	const columns = tableColumnNames(tableSpec);
	const result: D1LogsCopyVerification = { missing: [], mismatched: [] };
	for (const row of source) {
		const id = String(rowValue(row, LOGS_ID_COLUMN));
		const copy = copied.get(id);
		if (!copy) {
			result.missing.push(id);
			continue;
		}
		const same = columns.every(
			(column) => rowValue(row, column) === (copy[column] ?? null),
		);
		if (!same) result.mismatched.push(id);
	}
	return result;
}

/** The source id of a raw retention row. */
export function d1RetentionRowId(row: D1RetentionRow): string {
	return String(rowValue(row, LOGS_ID_COLUMN));
}
