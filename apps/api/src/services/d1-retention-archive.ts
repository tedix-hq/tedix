/**
 * Archive-then-delete retention for append-only ledgers in the core D1
 * database, driven by `d1_retention_policies` rows (no row = untouched).
 *
 * A pass reads the oldest rows 50 at a time, writes one gzip NDJSON object
 * per chunk to R2, confirms the object exists, and only then deletes exactly
 * those rows in one D1 batch of <=50-row statements. A run that stops midway
 * resumes on the next tick from the oldest remaining row. If it stops between
 * the R2 write and the delete, the next tick rewrites the same rows to the
 * same deterministic key before deleting them.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	type D1RetentionCutoff,
	type D1RetentionRow,
	type D1RetentionTableSpec,
	D1_RETENTION_ROWS_PER_STATEMENT,
	d1RetentionCutoff,
	d1RetentionPolicyProblem,
	deleteD1RetentionRows,
	estimateD1RetentionBacklog,
	getD1RetentionTableSpec,
	isD1RetentionExpired,
	listActiveD1RetentionPolicies,
	readD1RetentionPage,
	recordD1RetentionRun,
} from "@tedix/db/queries/d1-retention";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { D1RetentionPolicyRow } from "@tedix/db/schema/d1-retention";

export const D1_ARCHIVE_PREFIX = "d1-archive/v1/";
/** Rows per R2 object and per delete batch (10 statements of 50). */
export const D1_ARCHIVE_CHUNK_ROWS = 500;
const DEFAULT_TIME_BUDGET_MS = 20_000;

export interface D1RetentionTableResult {
	tableName: string;
	mode: D1RetentionPolicyRow["mode"];
	problem: string | null;
	eligibleRows: number;
	eligibleBytes: number;
	archivedRows: number;
	deletedRows: number;
	objects: number;
	stoppedBy: "done" | "row_cap" | "time_budget" | "error" | "skipped";
	error?: string;
}

export interface D1RetentionRunResult {
	tables: D1RetentionTableResult[];
	archivedRows: number;
	deletedRows: number;
	eligibleBytes: number;
}

function archiveDay(
	tableSpec: D1RetentionTableSpec,
	row: D1RetentionRow,
): string {
	const value = row[tableSpec.timestamp.name];
	if (tableSpec.format === "epoch_seconds" && typeof value === "number") {
		return new Date(value * 1000).toISOString().slice(0, 10);
	}
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)
		? value.slice(0, 10)
		: "unknown-day";
}

export function d1ArchiveObjectKey(
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
): string {
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (!first || !last) throw new Error("cannot key an empty archive chunk");
	return `${D1_ARCHIVE_PREFIX}${tableSpec.tableName}/${archiveDay(tableSpec, first)}/${first.__rowid}-${last.__rowid}.ndjson.gz`;
}

export async function gzipNdjson(
	rows: readonly D1RetentionRow[],
): Promise<Uint8Array> {
	const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	const stream = new Blob([text])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read up to `limit` of the oldest expired rows. Stops at the first row still
 * inside the keep window, so rows are only ever taken from the old end.
 */
async function readExpiredChunk(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	cutoff: D1RetentionCutoff,
	limit: number,
): Promise<{ rows: D1RetentionRow[]; reachedKeepWindow: boolean }> {
	const rows: D1RetentionRow[] = [];
	let afterRowid = -1;
	while (rows.length < limit) {
		const page = await readD1RetentionPage(
			db,
			tableSpec,
			afterRowid,
			Math.min(D1_RETENTION_ROWS_PER_STATEMENT, limit - rows.length),
		);
		if (page.length === 0) return { rows, reachedKeepWindow: true };
		for (const row of page) {
			if (
				!isD1RetentionExpired(tableSpec, row[tableSpec.timestamp.name], cutoff)
			) {
				return { rows, reachedKeepWindow: true };
			}
			rows.push(row);
		}
		afterRowid = page[page.length - 1]?.__rowid ?? afterRowid;
	}
	return { rows, reachedKeepWindow: false };
}

async function runPolicy(
	db: DbQueryClient,
	bucket: R2Bucket | undefined,
	policy: D1RetentionPolicyRow,
	now: Date,
	deadline: number,
): Promise<D1RetentionTableResult> {
	const result: D1RetentionTableResult = {
		tableName: policy.tableName,
		mode: policy.mode,
		problem: d1RetentionPolicyProblem(policy),
		eligibleRows: 0,
		eligibleBytes: 0,
		archivedRows: 0,
		deletedRows: 0,
		objects: 0,
		stoppedBy: "skipped",
	};
	const tableSpec = getD1RetentionTableSpec(policy.tableName);
	if (result.problem || !tableSpec) return result;
	if (policy.mode === "archive_then_delete" && !bucket) {
		result.problem = "archive_bucket_missing";
		return result;
	}
	const cutoff = d1RetentionCutoff(tableSpec, now, policy.keepDays);
	const estimate = await estimateD1RetentionBacklog(db, tableSpec, cutoff);
	result.eligibleRows = estimate.eligibleRows;
	result.eligibleBytes = estimate.eligibleBytes;
	if (policy.mode === "dry_run") {
		result.stoppedBy = "done";
		return result;
	}

	const rowCap = Math.max(0, policy.maxRowsPerRun);
	result.stoppedBy = "done";
	try {
		while (true) {
			const remaining = rowCap - result.deletedRows;
			if (remaining <= 0) {
				result.stoppedBy = "row_cap";
				break;
			}
			if (Date.now() >= deadline) {
				result.stoppedBy = "time_budget";
				break;
			}
			const { rows, reachedKeepWindow } = await readExpiredChunk(
				db,
				tableSpec,
				cutoff,
				Math.min(D1_ARCHIVE_CHUNK_ROWS, remaining),
			);
			if (rows.length === 0) break;
			if (policy.mode === "archive_then_delete" && bucket) {
				const key = d1ArchiveObjectKey(tableSpec, rows);
				const body = await gzipNdjson(rows);
				await bucket.put(key, body, {
					httpMetadata: {
						contentType: "application/x-ndjson",
						contentEncoding: "gzip",
					},
					customMetadata: {
						table: tableSpec.tableName,
						rows: String(rows.length),
						firstRowid: String(rows[0]?.__rowid),
						lastRowid: String(rows[rows.length - 1]?.__rowid),
						cutoff: String(cutoff),
					},
				});
				const stored = await bucket.head(key);
				if (!stored || stored.size !== body.byteLength) {
					throw new Error(`archive object not confirmed: ${key}`);
				}
				result.archivedRows += rows.length;
				result.objects += 1;
			}
			const deleted = await deleteD1RetentionRows(
				db,
				tableSpec,
				rows.map((row) => row.__rowid),
				cutoff,
			);
			result.deletedRows += deleted;
			// Fewer deletions than rows read means something else changed these
			// rows; stop instead of re-reading the same chunk forever.
			if (deleted < rows.length) {
				throw new Error(
					`deleted ${deleted} of ${rows.length} rows read; stopping`,
				);
			}
			if (reachedKeepWindow) break;
		}
	} catch (error) {
		result.stoppedBy = "error";
		result.error = error instanceof Error ? error.message : String(error);
	}
	return result;
}

function reportFor(
	result: D1RetentionTableResult,
	keepDays: number,
): Record<string, JsonValue> {
	return {
		mode: result.mode,
		keepDays,
		problem: result.problem,
		eligibleRows: result.eligibleRows,
		eligibleBytes: result.eligibleBytes,
		archivedRows: result.archivedRows,
		deletedRows: result.deletedRows,
		objects: result.objects,
		stoppedBy: result.stoppedBy,
		error: result.error ?? null,
	};
}

/**
 * Run every active policy once. Tables run one after another so the database
 * sees at most one retention statement at a time; one table's failure is
 * recorded on its row and never stops the next table.
 */
export async function runD1Retention(params: {
	db: DbQueryClient;
	bucket?: R2Bucket;
	now: Date;
	timeBudgetMs?: number;
}): Promise<D1RetentionRunResult> {
	const deadline = Date.now() + (params.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const policies = await listActiveD1RetentionPolicies(params.db);
	const tables: D1RetentionTableResult[] = [];
	for (const policy of policies) {
		let result: D1RetentionTableResult;
		try {
			result = await runPolicy(
				params.db,
				params.bucket,
				policy,
				params.now,
				deadline,
			);
		} catch (error) {
			result = {
				tableName: policy.tableName,
				mode: policy.mode,
				problem: null,
				eligibleRows: 0,
				eligibleBytes: 0,
				archivedRows: 0,
				deletedRows: 0,
				objects: 0,
				stoppedBy: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		tables.push(result);
		await recordD1RetentionRun(params.db, {
			tableName: policy.tableName,
			ranAt: params.now.toISOString(),
			report: reportFor(result, policy.keepDays),
			archivedRows: result.archivedRows,
			deletedRows: result.deletedRows,
		});
	}
	return {
		tables,
		archivedRows: tables.reduce((sum, t) => sum + t.archivedRows, 0),
		deletedRows: tables.reduce((sum, t) => sum + t.deletedRows, 0),
		eligibleBytes: tables.reduce((sum, t) => sum + t.eligibleBytes, 0),
	};
}
