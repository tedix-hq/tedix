/**
 * Archive-then-delete and move-to-logs retention for append-only ledgers in
 * the core D1 database, driven by `d1_retention_policies` rows (no row =
 * untouched).
 *
 * A pass reads the oldest rows one page (500 rows) per statement, writes one
 * gzip NDJSON object per page to R2, confirms the stored object, and only
 * then deletes exactly those rows with one statement. The next page is read
 * while the current one is copied, archived and deleted, so a page costs a
 * few round trips instead of one per 50 rows. A run that stops midway resumes
 * on the next tick from its last processed rowid in `last_report`. A
 * completed sweep wraps to reconsider retained rows. If it stops between the
 * R2 write and the delete, the next tick rewrites the same rows to the same
 * deterministic key before deleting them.
 *
 * `move_to_logs_db` adds a step in front of the archive: the page is copied
 * into the logs database with insert-or-ignore, read back in the same batch
 * and compared column by column with the rows read from the main database,
 * and only a page that reads back identical is archived and then removed
 * from the main database. A crash anywhere leaves the main rows in place;
 * the next tick repeats the copy (a no-op for rows already there), the
 * check, the archive and the delete. Reads, copies and deletes back off on
 * D1 `overloaded` errors before the run gives up.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	type D1RetentionCutoff,
	type D1RetentionRow,
	type D1RetentionTableSpec,
	D1_RETENTION_PAGE_ROWS,
	copyD1RetentionRowsToLogs,
	d1RetentionCutoff,
	d1RetentionEffectiveKeepDays,
	d1RetentionPolicyProblem,
	deleteD1RetentionRows,
	estimateD1RetentionBacklog,
	getD1RetentionTableSpec,
	isD1RetentionExpired,
	listActiveD1RetentionPolicies,
	readD1RetentionPage,
	recordD1RetentionRun,
	verifyD1LogsCopy,
} from "@tedix/db/queries/d1-retention";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { D1RetentionPolicyRow } from "@tedix/db/schema/d1-retention";

export const D1_ARCHIVE_PREFIX = "d1-archive/v1/";
/** Rows per R2 object, per logs copy and per delete statement. */
export const D1_ARCHIVE_CHUNK_ROWS = D1_RETENTION_PAGE_ROWS;
const DEFAULT_TIME_BUDGET_MS = 20_000;
/** Waits before each retry of a statement D1 refused as overloaded. */
const OVERLOAD_BACKOFF_MS = [500, 1000, 2000] as const;

function isD1Overloaded(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /overloaded|too many requests|temporarily unavailable/i.test(message);
}

/** Retry `run` with increasing waits while D1 reports itself overloaded. */
export async function withOverloadBackoff<T>(
	run: () => Promise<T>,
	deadline: number,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			const wait = OVERLOAD_BACKOFF_MS[attempt];
			if (
				wait === undefined ||
				!isD1Overloaded(error) ||
				Date.now() + wait >= deadline
			)
				throw error;
			await sleep(wait);
		}
	}
}

/** Wall time per step, summed over a run's pages. */
export interface D1RetentionTimings {
	/** Waiting for a page; most reads overlap the previous page's work. */
	readMs: number;
	/** Logs copy and its read-back. */
	copyMs: number;
	archiveMs: number;
	deleteMs: number;
	estimateMs: number;
	pages: number;
}

export interface D1RetentionTableResult {
	tableName: string;
	mode: D1RetentionPolicyRow["mode"];
	problem: string | null;
	eligibleRows: number;
	eligibleBytes: number;
	archivedRows: number;
	/** Rows copied into the logs database and verified there. */
	movedRows: number;
	deletedRows: number;
	objects: number;
	/** Last successfully processed rowid; -1 restarts a completed sweep. */
	scanAfterRowid: number;
	stoppedBy: "done" | "row_cap" | "time_budget" | "error" | "skipped";
	error?: string;
	timings: D1RetentionTimings;
}

export interface D1RetentionRunResult {
	tables: D1RetentionTableResult[];
	archivedRows: number;
	movedRows: number;
	deletedRows: number;
	eligibleBytes: number;
}

function emptyResult(policy: D1RetentionPolicyRow): D1RetentionTableResult {
	return {
		tableName: policy.tableName,
		mode: policy.mode,
		problem: null,
		eligibleRows: 0,
		eligibleBytes: 0,
		archivedRows: 0,
		movedRows: 0,
		deletedRows: 0,
		objects: 0,
		scanAfterRowid: -1,
		stoppedBy: "skipped",
		timings: {
			readMs: 0,
			copyMs: 0,
			archiveMs: 0,
			deleteMs: 0,
			estimateMs: 0,
			pages: 0,
		},
	};
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

interface ExpiredChunk {
	rows: D1RetentionRow[];
	afterRowid: number;
	reachedEnd: boolean;
}

/** Read one page after the cursor; keep its expired rows, retain newer and invalid timestamps. */
async function readExpiredChunk(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	cutoff: D1RetentionCutoff,
	limit: number,
	afterRowid: number,
	deadline: number,
): Promise<ExpiredChunk> {
	const page = await withOverloadBackoff(
		() => readD1RetentionPage(db, tableSpec, afterRowid, limit),
		deadline,
	);
	return {
		rows: page.filter((row) =>
			isD1RetentionExpired(tableSpec, row[tableSpec.timestamp.name], cutoff),
		),
		afterRowid: page[page.length - 1]?.__rowid ?? afterRowid,
		// A short page is the end of the table as of this read.
		reachedEnd: page.length < limit,
	};
}

/**
 * Copy one chunk into the logs database and prove the copy: every source row
 * must read back with every column identical. Throws otherwise, which stops
 * the run before anything is archived or deleted.
 */
async function copyChunkToLogs(
	logsDb: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
	deadline: number,
): Promise<void> {
	const copied = await withOverloadBackoff(
		() => copyD1RetentionRowsToLogs(logsDb, tableSpec, rows),
		deadline,
	);
	const check = verifyD1LogsCopy(tableSpec, rows, copied);
	if (check.missing.length > 0 || check.mismatched.length > 0) {
		throw new Error(
			`logs copy not verified for ${tableSpec.tableName}: ${check.missing.length} missing, ${check.mismatched.length} mismatched (first: ${check.missing[0] ?? check.mismatched[0]})`,
		);
	}
}

/**
 * Write the chunk to R2 and confirm the stored object. R2 resolves a put only
 * once the object is durably stored (reads after it are strongly consistent),
 * and the object it returns must carry this key and the body's exact size.
 */
async function archiveChunk(
	bucket: R2Bucket,
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
	cutoff: D1RetentionCutoff,
): Promise<void> {
	const key = d1ArchiveObjectKey(tableSpec, rows);
	const body = await gzipNdjson(rows);
	const stored = await bucket.put(key, body, {
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
	if (!stored || stored.key !== key || stored.size !== body.byteLength) {
		throw new Error(`archive object not confirmed: ${key}`);
	}
}

async function timed<T>(
	timings: D1RetentionTimings,
	step: Exclude<keyof D1RetentionTimings, "pages">,
	run: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	try {
		return await run();
	} finally {
		timings[step] += Date.now() - started;
	}
}

async function runPolicy(
	db: DbQueryClient,
	logsDb: DbQueryClient | undefined,
	bucket: R2Bucket | undefined,
	policy: D1RetentionPolicyRow,
	now: Date,
	deadline: number,
): Promise<D1RetentionTableResult> {
	const result = emptyResult(policy);
	result.problem = d1RetentionPolicyProblem(policy);
	const tableSpec = getD1RetentionTableSpec(policy.tableName);
	if (result.problem || !tableSpec) return result;
	const archives =
		policy.mode === "archive_then_delete" || policy.mode === "move_to_logs_db";
	if (archives && !bucket) {
		result.problem = "archive_bucket_missing";
		return result;
	}
	if (policy.mode === "move_to_logs_db" && !logsDb) {
		result.problem = "logs_db_missing";
		return result;
	}
	const keepDays = d1RetentionEffectiveKeepDays(tableSpec, policy);
	const cutoff = d1RetentionCutoff(tableSpec, now, keepDays);
	const { timings } = result;
	result.stoppedBy = "done";

	if (policy.mode !== "dry_run") {
		const previousCursor = policy.lastReport?.scanAfterRowid;
		if (
			typeof previousCursor === "number" &&
			Number.isSafeInteger(previousCursor) &&
			previousCursor >= -1
		)
			result.scanAfterRowid = previousCursor;
		const rowCap = Math.max(0, policy.maxRowsPerRun);
		const read = (afterRowid: number, limit: number) => {
			const pending = readExpiredChunk(
				db,
				tableSpec,
				cutoff,
				limit,
				afterRowid,
				deadline,
			);
			// Awaited later or abandoned when the run stops; never unhandled.
			pending.catch(() => {});
			return pending;
		};
		let next: Promise<ExpiredChunk> | null = null;
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
				const pending: Promise<ExpiredChunk> =
					next ??
					read(
						result.scanAfterRowid,
						Math.min(D1_ARCHIVE_CHUNK_ROWS, remaining),
					);
				next = null;
				const { rows, afterRowid, reachedEnd } = await timed(
					timings,
					"readMs",
					() => pending,
				);
				timings.pages += 1;
				// The next page has higher rowids than every row this one may
				// delete, so it is read while this page is copied and deleted.
				const nextLimit = Math.min(
					D1_ARCHIVE_CHUNK_ROWS,
					remaining - rows.length,
				);
				if (!reachedEnd && nextLimit > 0) next = read(afterRowid, nextLimit);
				if (rows.length === 0) {
					result.scanAfterRowid = reachedEnd ? -1 : afterRowid;
					if (reachedEnd) break;
					continue;
				}
				if (policy.mode === "move_to_logs_db" && logsDb) {
					await timed(timings, "copyMs", () =>
						copyChunkToLogs(logsDb, tableSpec, rows, deadline),
					);
				}
				if (archives && bucket) {
					await timed(timings, "archiveMs", () =>
						archiveChunk(bucket, tableSpec, rows, cutoff),
					);
					result.archivedRows += rows.length;
					result.objects += 1;
				}
				// Only a chunk that is in the logs database (verified) and in R2
				// (confirmed) reaches this delete.
				const deleted = await timed(timings, "deleteMs", () =>
					withOverloadBackoff(
						() =>
							deleteD1RetentionRows(
								db,
								tableSpec,
								rows.map((row) => row.__rowid),
								cutoff,
							),
						deadline,
					),
				);
				if (policy.mode === "move_to_logs_db") result.movedRows += deleted;
				result.deletedRows += deleted;
				// Fewer deletions than rows read means something else changed these
				// rows; stop instead of re-reading the same chunk forever.
				if (deleted < rows.length) {
					throw new Error(
						`deleted ${deleted} of ${rows.length} rows read; stopping`,
					);
				}
				result.scanAfterRowid = reachedEnd ? -1 : afterRowid;
				if (reachedEnd) break;
			}
		} catch (error) {
			result.stoppedBy = "error";
			result.error = error instanceof Error ? error.message : String(error);
		} finally {
			if (next) await next.then(noop, noop);
		}
	}

	// Estimated after the moves, so the moves get the time budget first and
	// the report shows what is still left.
	try {
		const estimate = await timed(timings, "estimateMs", () =>
			estimateD1RetentionBacklog(db, tableSpec, cutoff),
		);
		result.eligibleRows = estimate.eligibleRows;
		result.eligibleBytes = estimate.eligibleBytes;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (policy.mode === "dry_run") result.stoppedBy = "error";
		result.error ??= `estimate: ${message}`;
	}
	return result;
}

function noop(): void {}

function reportFor(
	result: D1RetentionTableResult,
	policy: D1RetentionPolicyRow,
): Record<string, JsonValue> {
	const tableSpec = getD1RetentionTableSpec(policy.tableName);
	const keepDays = tableSpec
		? d1RetentionEffectiveKeepDays(tableSpec, policy)
		: policy.keepDays;
	return {
		mode: result.mode,
		/** The window the run used; `keepDaysRow` when the row sat below the floor. */
		keepDays,
		...(keepDays !== policy.keepDays ? { keepDaysRow: policy.keepDays } : {}),
		problem: result.problem,
		eligibleRows: result.eligibleRows,
		eligibleBytes: result.eligibleBytes,
		archivedRows: result.archivedRows,
		movedRows: result.movedRows,
		deletedRows: result.deletedRows,
		objects: result.objects,
		scanAfterRowid: result.scanAfterRowid,
		stoppedBy: result.stoppedBy,
		error: result.error ?? null,
		timings: { ...result.timings },
	};
}

/**
 * Run every active policy once. Tables run one after another so the database
 * sees at most one retention statement at a time per store; one table's
 * failure is recorded on its row and never stops the next table.
 */
export async function runD1Retention(params: {
	db: DbQueryClient;
	/** The logs database; absent when the Worker has no `LOGS_DB` binding. */
	logsDb?: DbQueryClient;
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
				params.logsDb,
				params.bucket,
				policy,
				params.now,
				deadline,
			);
		} catch (error) {
			result = {
				...emptyResult(policy),
				stoppedBy: "error",
				error: error instanceof Error ? error.message : String(error),
			};
		}
		tables.push(result);
		await recordD1RetentionRun(params.db, {
			tableName: policy.tableName,
			ranAt: params.now.toISOString(),
			report: reportFor(result, policy),
			archivedRows: result.archivedRows,
			deletedRows: result.deletedRows,
		});
	}
	return {
		tables,
		archivedRows: tables.reduce((sum, t) => sum + t.archivedRows, 0),
		movedRows: tables.reduce((sum, t) => sum + t.movedRows, 0),
		deletedRows: tables.reduce((sum, t) => sum + t.deletedRows, 0),
		eligibleBytes: tables.reduce((sum, t) => sum + t.eligibleBytes, 0),
	};
}
