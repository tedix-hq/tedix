/**
 * Archive-then-delete and move-to-logs retention for append-only ledgers in
 * the core D1 database, driven by `d1_retention_policies` rows (no row =
 * untouched).
 *
 * One indexed age probe skips tables without expired candidates before time
 * is shared among the remaining policies. A pass reads the oldest rows one
 * page (500 rows) per statement, writes one gzip NDJSON object per page to
 * R2, confirms the stored object, and only
 * then deletes exactly those rows with one statement. The next page is read
 * while the current one is copied, archived and deleted, so a page costs a
 * few round trips instead of one per 50 rows. Every tick starts at the oldest
 * row, where rows leave the keep window, and moves what expired there; the
 * first page with nothing to move ends that head pass. Every table's head pass
 * runs before any table sweeps, so a table with a real backlog is not left
 * waiting behind tables that only re-check retained rows. The rest of the
 * tick continues each long sweep through retained rows from the rowid saved
 * in `last_report` (`scanAfterRowid`), so out-of-order old rows are still
 * found and a completed sweep wraps to reconsider retained rows. A sweep does
 * not read its way through rows that are all inside the keep window: after a
 * page without one old row it asks the timestamp index where the next old row
 * is and continues there, or ends if there is none. If a run stops
 * between the R2 write and the delete, the next tick rewrites the same rows
 * to the same deterministic key before deleting them.
 *
 * `move_to_logs_db` adds a step in front of the archive: the page is copied
 * into the logs database with insert-or-ignore, read back in the same batch
 * and compared column by column with the rows read from the main database.
 * A row with no logs copy fails the run before anything is archived or
 * deleted. A row whose logs id already holds a different version is a
 * conflict: the logs copy is never rewritten, the source version still goes
 * to R2, and only then is the main row removed. A crash anywhere leaves the
 * main rows in place; the next tick repeats the copy (a no-op for rows
 * already there), the check, the archive and the delete. Reads, copies and
 * deletes back off on D1 `overloaded` errors before the run gives up.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	type D1LogsCopyVerification,
	type D1RetentionPolicyCutoff,
	type D1RetentionRow,
	type D1RetentionTableSpec,
	D1_RETENTION_PAGE_ROWS,
	D1RetentionEstimateDeadlineError,
	copyD1RetentionRowsToLogs,
	d1RetentionPolicyCutoff,
	MCP_TELEMETRY_KEEP_DAYS,
	d1RetentionEffectiveKeepDays,
	d1RetentionPolicyProblem,
	deleteD1RetentionRows,
	estimateD1RetentionBacklog,
	filterD1RetentionReferencedRows,
	getD1RetentionTableSpec,
	groupD1RetentionArchiveRows,
	hasD1RetentionExpiredRows,
	isD1RetentionExpired,
	listActiveD1RetentionPolicies,
	mayBeOlderThanD1RetentionCutoff,
	nextD1RetentionOldRowid,
	readD1RetentionPage,
	recordD1RetentionRun,
	verifyD1LogsCopy,
} from "@tedix/db/queries/d1-retention";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { D1RetentionPolicyRow } from "@tedix/db/schema/d1-retention";

export const D1_ARCHIVE_PREFIX = "d1-archive/v1/";
/** Rows per R2 object, per logs copy and per delete statement. */
export const D1_ARCHIVE_CHUNK_ROWS = D1_RETENTION_PAGE_ROWS;
/**
 * Shared by policies with expired candidates (leftovers flow to later
 * tables). Each 15-minute tick has to move a few 500-row artifact pages, each
 * costing a few seconds of reads, copies and R2 writes, or the main database
 * grows faster than retention drains it.
 *
 * Temporarily 5 minutes (normally 60 s) while the 1.4M-row MCP telemetry
 * audit backlog drains (Work 539ccae7). Each page still pauses for
 * `D1_RETENTION_PAGE_PAUSE_MS`, so main D1 sees the same load per second,
 * just for longer. Put back to 60_000 once the backlog is gone.
 */
const DEFAULT_TIME_BUDGET_MS = 300_000;
/** Conflicts kept in `last_report` for repair evidence. */
const D1_RETENTION_CONFLICT_SAMPLE = 20;
/** Waits before each retry of a statement D1 refused as overloaded. */
const OVERLOAD_BACKOFF_MS = [500, 1000, 2000] as const;
/**
 * Pause after each moved page (500 rows: logs copy, R2 write, one main
 * delete). Back-to-back pages overloaded main D1 for live reads (7429) on
 * 20 Nov 2026; 300 ms raised live "Database temporarily unavailable" 503s
 * to ~35 a minute during runs on 21 Nov 2026. Temporarily 500 ms while the
 * telemetry audit backlog drains (Work 539ccae7); back to 1000 after.
 */
export const D1_RETENTION_PAGE_PAUSE_MS = 500;

/**
 * The error's message followed by its causes. Drizzle reports "Failed query:
 * <sql>" and keeps D1's own reason (overloaded, timeout) in `cause`.
 */
function errorText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (let depth = 0; current !== undefined && depth < 4; depth++) {
		parts.push(current instanceof Error ? current.message : String(current));
		current = current instanceof Error ? current.cause : undefined;
	}
	return parts.join(" <- ");
}

function isD1Overloaded(error: unknown): boolean {
	return /overloaded|too many requests|temporarily unavailable/i.test(
		errorText(error),
	);
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
	/** Approximate backlog; null when no estimate completed this run. */
	eligibleRows: number | null;
	eligibleBytes: number | null;
	archivedRows: number;
	referencedRows: number;
	/** Rows copied into the logs database and verified there. */
	movedRows: number;
	/**
	 * Rows whose logs-database id already held a different version. The logs
	 * copy is never rewritten; the source version went to R2 before the main
	 * row was deleted, so both survive.
	 */
	conflictedRows: number;
	deletedRows: number;
	/** Rows read and copied but not deleted: changed or pinned since the read. */
	skippedRows: number;
	objects: number;
	/** Last successfully processed rowid; -1 restarts a completed sweep. */
	scanAfterRowid: number;
	stoppedBy: "done" | "row_cap" | "time_budget" | "error" | "skipped";
	error?: string;
	/** First few conflicts with their differing columns, for repair evidence. */
	conflicts: { id: string; columns: string[] }[];
	timings: D1RetentionTimings;
}

export interface D1RetentionRunResult {
	tables: D1RetentionTableResult[];
	archivedRows: number;
	movedRows: number;
	conflictedRows: number;
	deletedRows: number;
	eligibleBytes: number | null;
}

function emptyResult(policy: D1RetentionPolicyRow): D1RetentionTableResult {
	return {
		tableName: policy.tableName,
		mode: policy.mode,
		problem: null,
		eligibleRows: null,
		eligibleBytes: null,
		archivedRows: 0,
		referencedRows: 0,
		movedRows: 0,
		conflictedRows: 0,
		deletedRows: 0,
		skippedRows: 0,
		objects: 0,
		scanAfterRowid: -1,
		stoppedBy: "skipped",
		conflicts: [],
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
	organizationId: string,
	rows: readonly D1RetentionRow[],
): string {
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (!first || !last) throw new Error("cannot key an empty archive chunk");
	return `${D1_ARCHIVE_PREFIX}${tableSpec.tableName}/${encodeURIComponent(organizationId)}/${archiveDay(tableSpec, first)}/${first.__rowid}-${last.__rowid}.ndjson.gz`;
}

export async function gzipNdjson(
	rows: readonly D1RetentionRow[],
): Promise<Uint8Array> {
	// The fingerprint is the delete's guard, not part of the stored row.
	const text = `${rows.map(({ __fingerprint: _, ...row }) => JSON.stringify(row)).join("\n")}\n`;
	const stream = new Blob([text])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface ExpiredChunk {
	rows: D1RetentionRow[];
	referencedRows: number;
	afterRowid: number;
	reachedEnd: boolean;
	/** The page held a row the database would call older than the cutoff. */
	hasOldRow: boolean;
}

/**
 * How often one table's sweep may ask the index for the next old row in a
 * tick. Each question reads every index entry older than the cutoff, so a
 * table whose old rows lie scattered among newer ones falls back to reading
 * page after page, as every sweep used to.
 */
export const D1_RETENTION_SKIPS_PER_SWEEP = 8;

/** Read one page after the cursor; keep its expired rows, retain newer and invalid timestamps. */
async function readExpiredChunk(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	cutoff: D1RetentionPolicyCutoff,
	limit: number,
	afterRowid: number,
	deadline: number,
): Promise<ExpiredChunk> {
	const page = await withOverloadBackoff(
		() => readD1RetentionPage(db, tableSpec, afterRowid, limit),
		deadline,
	);
	const expired = page.filter((row) =>
		isD1RetentionExpired(
			tableSpec,
			row[tableSpec.timestamp.name],
			cutoff,
			row.action,
		),
	);
	const filtered = await withOverloadBackoff(
		() => filterD1RetentionReferencedRows(db, tableSpec, expired, cutoff),
		deadline,
	);
	return {
		...filtered,
		afterRowid: page[page.length - 1]?.__rowid ?? afterRowid,
		// A short page is the end of the table as of this read.
		reachedEnd: page.length < limit,
		hasOldRow: page.some((row) =>
			mayBeOlderThanD1RetentionCutoff(row[tableSpec.timestamp.name], cutoff),
		),
	};
}

/**
 * Copy one chunk into the logs database and classify the read-back. A source
 * row with no logs row at all is a real copy failure: throw, which stops the
 * run before anything is archived or deleted. A row that reads back
 * differently is a divergent earlier copy — insert-or-ignore already refused
 * to rewrite it, and the kernel/runtime event ledgers are not immutable
 * (`updateKernelRuntimeEventMetadata` rewrites `runtime_metadata`/`trace_id`,
 * and deterministic event ids can be re-inserted after the original moved).
 * Those rows are returned as conflicts: their current source version reaches
 * R2 before the main row is deleted, so nothing rewrites the logs copy and no
 * version is discarded.
 */
async function copyChunkToLogs(
	logsDb: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
	deadline: number,
): Promise<D1LogsCopyVerification> {
	const copied = await withOverloadBackoff(
		() => copyD1RetentionRowsToLogs(logsDb, tableSpec, rows),
		deadline,
	);
	const check = verifyD1LogsCopy(tableSpec, rows, copied);
	if (check.missing.length > 0) {
		throw new Error(
			`logs copy not verified for ${tableSpec.tableName}: ${check.missing.length} missing (first: ${check.missing[0]})`,
		);
	}
	return check;
}

/**
 * Write the chunk to R2 and confirm the stored object. R2 resolves a put only
 * once the object is durably stored (reads after it are strongly consistent),
 * and the object it returns must carry this key and the body's exact size.
 */
async function archiveChunk(
	bucket: R2Bucket,
	organizationId: string,
	tableSpec: D1RetentionTableSpec,
	rows: readonly D1RetentionRow[],
	cutoff: D1RetentionPolicyCutoff,
): Promise<void> {
	const key = d1ArchiveObjectKey(tableSpec, organizationId, rows);
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
			cutoff:
				typeof cutoff === "object" ? JSON.stringify(cutoff) : String(cutoff),
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

async function estimateBacklog(
	db: DbQueryClient,
	tableSpec: D1RetentionTableSpec,
	cutoff: D1RetentionPolicyCutoff,
	result: D1RetentionTableResult,
	deadline: number,
): Promise<void> {
	try {
		const estimate = await timed(result.timings, "estimateMs", () =>
			estimateD1RetentionBacklog(db, tableSpec, cutoff, deadline),
		);
		result.eligibleRows = estimate.eligibleRows;
		result.eligibleBytes = estimate.eligibleBytes;
	} catch (error) {
		if (error instanceof D1RetentionEstimateDeadlineError) {
			if (result.mode === "dry_run") result.stoppedBy = "time_budget";
			return;
		}
		if (result.mode === "dry_run") result.stoppedBy = "error";
		result.error ??= `estimate: ${errorText(error)}`;
	}
}

/**
 * One table's progress through a tick: its result and where its sweep starts,
 * or null when the head pass settled the table or the sweep must not run.
 */
interface PolicyTurn {
	policy: D1RetentionPolicyRow;
	result: D1RetentionTableResult;
	sweepFrom: number | null;
}

/** Check prerequisites and probe age before allocating processing time. */
async function preparePolicyTurn(
	db: DbQueryClient,
	logsDb: DbQueryClient | undefined,
	bucket: R2Bucket | undefined,
	policy: D1RetentionPolicyRow,
	now: Date,
	deadline: number,
): Promise<PolicyTurn> {
	const result = emptyResult(policy);
	const turn: PolicyTurn = { policy, result, sweepFrom: null };
	result.problem = d1RetentionPolicyProblem(policy);
	const tableSpec = getD1RetentionTableSpec(policy.tableName);
	if (result.problem || !tableSpec) return turn;
	const archives = policy.mode === "move_to_logs_db";
	if (archives && !bucket) {
		result.problem = "archive_bucket_missing";
		return turn;
	}
	if (policy.mode === "move_to_logs_db" && !logsDb) {
		result.problem = "logs_db_missing";
		return turn;
	}
	result.stoppedBy = "done";
	if (Date.now() >= deadline) {
		result.stoppedBy = "time_budget";
		return turn;
	}
	const cutoff = d1RetentionPolicyCutoff(tableSpec, now, policy);
	const hasExpired = await timed(result.timings, "readMs", () =>
		withOverloadBackoff(
			() => hasD1RetentionExpiredRows(db, tableSpec, cutoff),
			deadline,
		),
	);
	if (!hasExpired) {
		result.eligibleRows = 0;
		result.eligibleBytes = 0;
		return turn;
	}
	// Where the previous tick's walk through retained rows stopped; -1 when
	// that sweep completed or never ran. Persisted as `scanAfterRowid`.
	let sweepAfterRowid = -1;
	const previousCursor = policy.lastReport?.scanAfterRowid;
	if (
		typeof previousCursor === "number" &&
		Number.isSafeInteger(previousCursor) &&
		previousCursor >= -1
	)
		sweepAfterRowid = previousCursor;
	result.scanAfterRowid = sweepAfterRowid;
	return turn;
}

/**
 * Move expired pages in rowid order. `head` starts at the oldest row and ends
 * at the first page with nothing to move, recording where the sweep resumes;
 * a head page never moves the parked sweep cursor. `sweep` continues from
 * `turn.sweepFrom` and saves its position as `scanAfterRowid`.
 */
async function movePages(
	db: DbQueryClient,
	logsDb: DbQueryClient | undefined,
	bucket: R2Bucket | undefined,
	policy: D1RetentionPolicyRow,
	now: Date,
	deadline: number,
	turn: PolicyTurn,
	phase: "head" | "sweep",
	skipsPerSweep: number,
	pagePauseMs: number,
): Promise<void> {
	const { result } = turn;
	const tableSpec = getD1RetentionTableSpec(policy.tableName);
	if (!tableSpec) return;
	const archives = policy.mode === "move_to_logs_db";
	const cutoff = d1RetentionPolicyCutoff(tableSpec, now, policy);
	const { timings } = result;
	const sweepAfterRowid = result.scanAfterRowid;
	let readAfterRowid = phase === "head" ? -1 : (turn.sweepFrom ?? -1);
	turn.sweepFrom = null;
	result.stoppedBy = "done";
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
	let skips = 0;
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
				read(readAfterRowid, Math.min(D1_ARCHIVE_CHUNK_ROWS, remaining));
			next = null;
			const { rows, referencedRows, afterRowid, reachedEnd, hasOldRow } =
				await timed(timings, "readMs", () => pending);
			timings.pages += 1;
			result.referencedRows += referencedRows;
			if (phase === "head" && rows.length === 0) {
				// The head holds nothing more to move (retained, pinned or
				// invalid rows). The sweep continues where the previous tick
				// stopped, unless this page already reached past it.
				if (reachedEnd) result.scanAfterRowid = -1;
				else turn.sweepFrom = Math.max(sweepAfterRowid, afterRowid);
				break;
			}
			readAfterRowid = afterRowid;
			if (!hasOldRow && !reachedEnd && skips < skipsPerSweep) {
				// Every row of this page is inside the keep window, and so may
				// be the pages after it. Continue at the next old row instead of
				// reading up to it; none left ends the sweep, as reaching the
				// end of the table does.
				skips += 1;
				const nextOldRowid = await timed(timings, "readMs", () =>
					withOverloadBackoff(
						() => nextD1RetentionOldRowid(db, tableSpec, cutoff, afterRowid),
						deadline,
					),
				);
				if (nextOldRowid === null) {
					result.scanAfterRowid = -1;
					break;
				}
				readAfterRowid = nextOldRowid - 1;
				result.scanAfterRowid = readAfterRowid;
				continue;
			}
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
			let conflicted = 0;
			if (policy.mode === "move_to_logs_db" && logsDb) {
				const check = await timed(timings, "copyMs", () =>
					copyChunkToLogs(logsDb, tableSpec, rows, deadline),
				);
				conflicted = check.mismatched.length;
				result.conflictedRows += conflicted;
				for (const id of check.mismatched) {
					if (result.conflicts.length >= D1_RETENTION_CONFLICT_SAMPLE) break;
					result.conflicts.push({
						id,
						columns: check.divergentColumns[id] ?? [],
					});
				}
			}
			if (archives && bucket) {
				const groups = await groupD1RetentionArchiveRows(db, tableSpec, rows);
				// One object per organization; all must be confirmed before the delete.
				await timed(timings, "archiveMs", () =>
					Promise.all(
						[...groups].map(([organizationId, group]) =>
							archiveChunk(bucket, organizationId, tableSpec, group, cutoff),
						),
					),
				);
				for (const group of groups.values()) {
					result.archivedRows += group.length;
					result.objects += 1;
				}
			}
			// Only a chunk that is in the logs database (verified) and in R2
			// (confirmed) reaches this delete.
			const deleted = await timed(timings, "deleteMs", () =>
				withOverloadBackoff(
					() => deleteD1RetentionRows(db, tableSpec, rows, cutoff),
					deadline,
				),
			);
			if (policy.mode === "move_to_logs_db")
				result.movedRows += deleted - Math.min(deleted, conflicted);
			result.deletedRows += deleted;
			// A row changed or pinned since the read stays in main; a later run
			// copies and archives its current version before removing it.
			result.skippedRows += rows.length - deleted;
			// A head page never moves the parked sweep cursor; the head is
			// re-read every tick anyway.
			if (phase === "sweep" || reachedEnd)
				result.scanAfterRowid = reachedEnd ? -1 : afterRowid;
			if (reachedEnd) break;
			// Leave the main database room for live reads between deletes.
			if (pagePauseMs > 0 && Date.now() + pagePauseMs < deadline)
				await new Promise((resolve) => setTimeout(resolve, pagePauseMs));
		}
	} catch (error) {
		result.stoppedBy = "error";
		result.error = errorText(error);
		turn.sweepFrom = null;
	} finally {
		if (next) await next.then(noop, noop);
	}
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
		...(policy.tableName === "audit_events"
			? { telemetryKeepDays: MCP_TELEMETRY_KEEP_DAYS }
			: {}),
		...(keepDays !== policy.keepDays ? { keepDaysRow: policy.keepDays } : {}),
		problem: result.problem,
		eligibleRows: result.eligibleRows,
		eligibleBytes: result.eligibleBytes,
		archivedRows: result.archivedRows,
		referencedRows: result.referencedRows,
		movedRows: result.movedRows,
		conflictedRows: result.conflictedRows,
		...(result.conflicts.length > 0 ? { conflicts: result.conflicts } : {}),
		deletedRows: result.deletedRows,
		skippedRows: result.skippedRows,
		objects: result.objects,
		scanAfterRowid: result.scanAfterRowid,
		stoppedBy: result.stoppedBy,
		error: result.error ?? null,
		timings: { ...result.timings },
	};
}

/**
 * Probe every policy first; tables without expired candidates need no pages
 * or estimates. Run the others in two rounds: head passes (or dry-run
 * estimates) first, then sweeps through retained rows. Each round
 * reserves an equal share of the remaining processing time for each table it
 * runs, and leftovers flow to later tables.
 * In-flight pages finish their safety fences even when their share expires.
 * Dry runs estimate during their turn; optional estimates and report writes
 * follow all processing turns so diagnostics cannot consume another table's time.
 */
export async function runD1Retention(params: {
	db: DbQueryClient;
	/** The logs database; absent when the Worker has no `LOGS_DB` binding. */
	logsDb?: DbQueryClient;
	bucket?: R2Bucket;
	now: Date;
	timeBudgetMs?: number;
	/** Default `D1_RETENTION_SKIPS_PER_SWEEP`; 0 reads every page of a sweep. */
	skipsPerSweep?: number;
	/** Wait after each moved page; default `D1_RETENTION_PAGE_PAUSE_MS`. */
	pagePauseMs?: number;
}): Promise<D1RetentionRunResult> {
	const skipsPerSweep = params.skipsPerSweep ?? D1_RETENTION_SKIPS_PER_SWEEP;
	const pagePauseMs = params.pagePauseMs ?? D1_RETENTION_PAGE_PAUSE_MS;
	const deadline = Date.now() + (params.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
	const policies = await listActiveD1RetentionPolicies(params.db);
	const shareOf = (remainingTables: number) => {
		if (remainingTables <= 1) return deadline;
		const startedAt = Date.now();
		return startedAt + Math.max(0, deadline - startedAt) / remainingTables;
	};
	const turns: PolicyTurn[] = [];
	for (const policy of policies) {
		try {
			turns.push(
				await preparePolicyTurn(
					params.db,
					params.logsDb,
					params.bucket,
					policy,
					params.now,
					deadline,
				),
			);
		} catch (error) {
			turns.push({
				policy,
				sweepFrom: null,
				result: {
					...emptyResult(policy),
					stoppedBy: "error",
					error: errorText(error),
				},
			});
		}
	}
	const processing = turns.filter(
		({ result }) => result.stoppedBy === "done" && result.eligibleRows !== 0,
	);
	for (const [index, turn] of processing.entries()) {
		const tableDeadline = shareOf(processing.length - index);
		if (turn.policy.mode === "dry_run") {
			const tableSpec = getD1RetentionTableSpec(turn.policy.tableName)!;
			const cutoff = d1RetentionPolicyCutoff(
				tableSpec,
				params.now,
				turn.policy,
			);
			await estimateBacklog(
				params.db,
				tableSpec,
				cutoff,
				turn.result,
				tableDeadline,
			);
		} else {
			await movePages(
				params.db,
				params.logsDb,
				params.bucket,
				turn.policy,
				params.now,
				tableDeadline,
				turn,
				"head",
				skipsPerSweep,
				pagePauseMs,
			);
		}
	}
	const sweeping = turns.filter((turn) => turn.sweepFrom !== null);
	for (const [index, turn] of sweeping.entries()) {
		await movePages(
			params.db,
			params.logsDb,
			params.bucket,
			turn.policy,
			params.now,
			shareOf(sweeping.length - index),
			turn,
			"sweep",
			skipsPerSweep,
			pagePauseMs,
		);
	}
	const tables = turns.map((turn) => turn.result);
	for (const [index, policy] of policies.entries()) {
		const result = tables[index]!;
		const tableSpec = getD1RetentionTableSpec(policy.tableName);
		if (
			policy.mode !== "dry_run" &&
			result.eligibleRows !== 0 &&
			!result.problem &&
			tableSpec &&
			Date.now() < deadline
		) {
			const cutoff = d1RetentionPolicyCutoff(tableSpec, params.now, policy);
			await estimateBacklog(params.db, tableSpec, cutoff, result, deadline);
		}
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
		conflictedRows: tables.reduce((sum, t) => sum + t.conflictedRows, 0),
		deletedRows: tables.reduce((sum, t) => sum + t.deletedRows, 0),
		eligibleBytes: tables.some((t) => t.eligibleBytes === null)
			? null
			: tables.reduce((sum, t) => sum + (t.eligibleBytes ?? 0), 0),
	};
}
