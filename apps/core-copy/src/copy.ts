import postgres from "postgres";
import {
	copyPages,
	keysetSource,
	verifyCopy,
	type CopyReceipt,
	type CopyState,
	type CopyTable,
	type PgQuery,
} from "../../../scripts/db/core-copy.ts";
import { CORE_COPY_MIGRATIONS } from "./migrations.generated.ts";
import {
	coreCopyPlan,
	planTable,
	CORE_COPY_SKIPPED,
	type CoreCopyTable,
} from "./plan.ts";
import {
	type ProgressStore,
	type CheckpointStore,
	type TableProgress,
} from "./store.ts";

type Row = Record<string, unknown>;
type Scalar = string | number | null;

export const PAGE_SIZE = 500;
/**
 * Smaller pages for tables whose rows run to tens or hundreds of KB, so one
 * page stays far below the Worker's memory and D1's response size.
 */
export const LARGE_ROW_PAGE_SIZES: Record<string, number> = {
	os_output_revisions: 5,
	agent_session_events: 50,
	skill_runs: 50,
	skill_run_artifacts: 100,
};
export const PAUSE_MS = 1000;
/** Pages one cron tick may copy before yielding to the next schedule. */
/**
 * Pages per 5-minute tick. A page takes about 4 s end to end (1 s pause, the
 * D1 read, the Postgres upsert, the checkpoint), so 60 pages fit one tick.
 */
export const CRON_PAGE_BUDGET = 60;
/** Longer than any tick; a tick that dies leaves this lease to expire. */
export const CRON_LEASE_MS = 12 * 60_000;

export interface CopyPorts {
	/** Read-only D1 access; every call is a SELECT the copy engine issues. */
	readD1(sql: string, params: Scalar[]): Promise<Row[]>;
	/** Postgres target through Hyperdrive (or a test double). */
	query: PgQuery;
	store: ProgressStore;
	/** Test hook: replaces the real timer. */
	wait?: (ms: number) => Promise<unknown>;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function isD1Overloaded(error: unknown): boolean {
	// D1 refuses or resets for a moment under platform stalls; the same read
	// succeeds later, so these pause the table instead of failing it.
	return /overloaded|was reset|temporarily unavailable/i.test(
		error instanceof Error ? error.message : String(error),
	);
}

/**
 * Applies packages/db/drizzle-pg migrations in order and records each applied
 * name in core_copy_migrations. Already-applied names are skipped, so repeat
 * calls are idempotent. Statements run in file order; a failure mid-migration
 * leaves the ledger untouched and the next call retries that migration.
 */
export async function applySchema(query: PgQuery) {
	await query(
		`CREATE TABLE IF NOT EXISTS core_copy_migrations (
			name text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`,
		[],
	);
	const applied = await query(`SELECT name FROM core_copy_migrations`, []);
	const done = new Set(applied.rows.map((row) => String(row.name)));
	const ran: string[] = [];
	for (const migration of CORE_COPY_MIGRATIONS) {
		if (done.has(migration.name)) continue;
		for (const statement of migration.sql
			.split(/-->\s*statement-breakpoint/)
			.map((part) => part.trim())
			.filter(Boolean)) {
			try {
				await query(statement, []);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Migration ${migration.name} failed: ${message}\n${statement.slice(0, 200)}`,
				);
			}
		}
		await query(
			`INSERT INTO core_copy_migrations (name) VALUES ($1)
			ON CONFLICT (name) DO NOTHING`,
			[migration.name],
		);
		ran.push(migration.name);
	}
	return {
		applied: ran,
		alreadyApplied: CORE_COPY_MIGRATIONS.length - ran.length,
		total: CORE_COPY_MIGRATIONS.length,
	};
}

function blankedRead(ports: CopyPorts, table: CoreCopyTable) {
	const blank = table.blank;
	return async (sql: string, params: Scalar[]): Promise<Row[]> => {
		const rows = await ports.readD1(sql, params);
		if (!blank) return rows;
		return rows.map((row) => {
			const copy = { ...row };
			for (const [column, fill] of Object.entries(blank)) copy[column] = fill;
			return copy;
		});
	};
}

async function highWater(ports: CopyPorts, table: string): Promise<number> {
	// Pace the window probe like every other D1 read.
	await (ports.wait ?? wait)(PAUSE_MS);
	const rows = await ports.readD1(
		`SELECT rowid AS r FROM ${quoteIdent(table)} ORDER BY rowid DESC LIMIT 1`,
		[],
	);
	const value = Number(rows[0]?.r ?? 0);
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function quoteIdent(name: string): string {
	if (!/^[a-z_][a-z0-9_]*$/.test(name))
		throw new Error(`Invalid identifier: ${name}`);
	return `"${name}"`;
}

function asCopyTable(table: CoreCopyTable): CopyTable {
	return {
		table: table.table,
		keys: table.keys,
		columns: table.columns,
		...(table.sourceRowid ? { sourceRowid: table.sourceRowid } : {}),
	};
}

export interface CopyResult {
	table: string;
	done: boolean;
	pages: number;
	status: TableProgress["status"];
	lastError?: string;
}

/**
 * Runs one table until done, a page budget is hit, or D1 reports overloaded.
 * The checkpoint in KV is the resume point; a repeat call continues where the
 * last accepted page left off.
 */
export async function copyTable(
	ports: CopyPorts,
	tableName: string,
	options: { maxPages?: number; pageSize?: number } = {},
): Promise<CopyResult> {
	const entry = planTable(tableName);
	if (!entry) throw new Error(`Unknown copy table: ${tableName}`);
	const table = asCopyTable(entry);
	const { store } = ports;
	const existing = await store.tableProgress(tableName);
	let latest = existing?.state;
	// Receipts kept inline by an earlier version stay in the state; new ones
	// go to their own keys after them.
	let count = existing?.pages ?? 0;
	const pageSize =
		existing?.pageSize ??
		(existing?.state ? PAGE_SIZE : undefined) ??
		options.pageSize ??
		LARGE_ROW_PAGE_SIZES[tableName] ??
		PAGE_SIZE;
	const water =
		latest !== undefined && existing?.highWater !== undefined
			? existing.highWater
			: await highWater(ports, tableName);
	const source = keysetSource({
		id: `core-copy/${tableName}`,
		table: tableName,
		read: blankedRead(ports, entry),
		highWater: water,
	});
	const now = () => new Date().toISOString();
	let pending = false;
	const onReceipt = async (receipt: CopyReceipt) => {
		// Written at the next index; it only counts once the state is saved,
		// so a failed save rewrites the same index on resume.
		await store.putReceipt(tableName, count, receipt);
		pending = true;
	};
	const progress = (
		status: TableProgress["status"],
		state: CopyState | undefined,
		lastError?: string,
	): TableProgress => ({
		table: tableName,
		status,
		highWater: water,
		pages: count,
		pageSize,
		state,
		...(lastError ? { lastError } : {}),
		updatedAt: now(),
	});
	const save = async (next: CopyState) => {
		if (pending) {
			count += 1;
			pending = false;
		}
		latest = next;
		await store.putTableProgress(progress("running", next));
	};
	try {
		const result = await copyPages({
			table,
			source,
			query: ports.query,
			state: latest,
			save,
			onReceipt,
			pageSize,
			pauseMs: PAUSE_MS,
			maxPages: options.maxPages,
			wait: ports.wait ?? wait,
		});
		const status = result.done ? "done" : "running";
		await store.putTableProgress(progress(status, result));
		return { table: tableName, done: result.done, pages: count, status };
	} catch (error) {
		const overloaded = isD1Overloaded(error);
		const message = error instanceof Error ? error.message : String(error);
		await store.putTableProgress(
			progress(overloaded ? "paused" : "error", latest, message),
		);
		if (overloaded) {
			// The run keeps going: the next cron tick, five minutes later,
			// resumes this table from its checkpoint.
			await store.setRunState({
				mode: "running",
				note: `D1 refused a read during ${tableName} at ${now()}; resuming next tick`,
				updatedAt: now(),
			});
		}
		return {
			table: tableName,
			done: false,
			pages: count,
			status: overloaded ? "paused" : "error",
			lastError: message,
		};
	}
}

/** POST /verify: checks the Postgres rows against the page receipts only. */
export async function verifyTable(
	ports: CopyPorts,
	tableName: string,
	options: { fromPage?: number } = {},
): Promise<{ table: string; verified: boolean; pages: number }> {
	const entry = planTable(tableName);
	if (!entry) throw new Error(`Unknown copy table: ${tableName}`);
	const progress = await ports.store.tableProgress(tableName);
	if (!progress?.state)
		throw new Error(`No checkpoint for ${tableName}; copy it first`);
	const table = asCopyTable(entry);
	const inline = progress.state.pages;
	if (inline.length) await verifyCopy(table, ports.query, progress.state);
	for (
		let index = options.fromPage ?? inline.length;
		index < progress.pages;
		index += 1
	) {
		const receipt = await ports.store.receipt(tableName, index);
		if (!receipt) throw new Error(`Missing receipt ${index} for ${tableName}`);
		await verifyCopy(table, ports.query, {
			...progress.state,
			pages: [receipt],
		});
	}
	// Only a finished table is "verified"; the cron skips verified tables,
	// so checking a partial copy must not end it.
	if (progress.state.done)
		await ports.store.putTableProgress({
			...progress,
			status: "verified",
			updatedAt: new Date().toISOString(),
		});
	return { table: tableName, verified: true, pages: progress.pages };
}

export interface StatusReport {
	mode: string;
	note?: string;
	tables: {
		table: string;
		status: string;
		pages?: number;
		done?: boolean;
		lastError?: string;
	}[];
	skipped: { table: string; reason: string }[];
}

export async function copyStatus(ports: CopyPorts): Promise<StatusReport> {
	const run = await ports.store.runState();
	const tables = [];
	for (const entry of coreCopyPlan()) {
		const progress = await ports.store.tableProgress(entry.table);
		tables.push({
			table: entry.table,
			status: progress?.status ?? "pending",
			pages: progress?.pages ?? 0,
			done: progress?.state?.done ?? false,
			lastError: progress?.lastError,
		});
	}
	return {
		mode: run.mode,
		note: run.note,
		tables,
		skipped: CORE_COPY_SKIPPED,
	};
}

/**
 * One cron tick: while the run says "running", copy unfinished tables in plan
 * order until the page budget is spent. A lease keeps a slow tick and the
 * next one from writing the same table; a crashed tick's lease expires.
 * A table D1 refused stays paused and is resumed by a later tick.
 */
export async function cronTick(ports: CopyPorts): Promise<CopyResult | null> {
	const { store } = ports;
	const run = await store.runState();
	if (run.mode !== "running") return null;
	const lease = await store.leaseUntil();
	if (lease && Date.parse(lease) > Date.now()) return null;
	await store.setLease(new Date(Date.now() + CRON_LEASE_MS).toISOString());
	try {
		let budget = CRON_PAGE_BUDGET;
		let last: CopyResult | null = null;
		for (const entry of coreCopyPlan()) {
			if (budget <= 0) return last;
			const progress = await store.tableProgress(entry.table);
			if (
				progress?.status === "done" ||
				progress?.status === "verified" ||
				progress?.status === "error"
			)
				continue;
			const before = progress?.pages ?? 0;
			last = await copyTable(ports, entry.table, { maxPages: budget });
			if (last.status !== "done") return last;
			budget -= Math.max(1, last.pages - before);
		}
		await store.setRunState({
			mode: "idle",
			note: "all planned tables copied",
			updatedAt: new Date().toISOString(),
		});
		return last;
	} finally {
		await store.setLease(undefined);
	}
}

/** postgres.js query port over a Hyperdrive connection string. */
export function hyperdriveQuery(connectionString: string): {
	query: PgQuery;
	end(): Promise<void>;
} {
	const sql = postgres(connectionString, {
		prepare: true,
		fetch_types: false,
		max: 5,
	});
	// One reserved connection keeps BEGIN…COMMIT migration files on a single
	// session instead of hopping pooled connections between chunks.
	let reserved: ReturnType<typeof sql.reserve> | undefined;
	const connection = () => (reserved ??= sql.reserve());
	return {
		query: async (text, params) => {
			const conn = await connection();
			// No parameters means postgres.js uses the simple protocol, which
			// accepts the occasional migration chunk holding several statements.
			const rows =
				params.length === 0
					? await conn.unsafe(text)
					: await conn.unsafe(text, params as never[]);
			return { rows: rows as unknown as Row[] };
		},
		end: async () => {
			const conn = await reserved?.catch(() => undefined);
			conn?.release();
			await sql.end();
		},
	};
}
