import postgres from "postgres";
import {
	copyPages,
	keysetSource,
	verifyCopy,
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
export const PAUSE_MS = 1000;
/** Pages one cron tick may copy before yielding to the next schedule. */
export const CRON_PAGE_BUDGET = 10;

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
	return /overloaded/i.test(
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
	options: { maxPages?: number } = {},
): Promise<CopyResult> {
	const entry = planTable(tableName);
	if (!entry) throw new Error(`Unknown copy table: ${tableName}`);
	const table = asCopyTable(entry);
	const { store } = ports;
	const existing = await store.tableProgress(tableName);
	let latest = existing?.state;
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
	const save = async (next: CopyState) => {
		latest = next;
		await store.putTableProgress({
			table: tableName,
			status: "running",
			highWater: water,
			pages: next.pages.length,
			state: next,
			updatedAt: now(),
		});
	};
	try {
		const result = await copyPages({
			table,
			source,
			query: ports.query,
			state: latest,
			save,
			pageSize: PAGE_SIZE,
			pauseMs: PAUSE_MS,
			maxPages: options.maxPages,
			wait: ports.wait ?? wait,
		});
		const status = result.done ? "done" : "running";
		await store.putTableProgress({
			table: tableName,
			status,
			highWater: water,
			pages: result.pages.length,
			state: result,
			updatedAt: now(),
		});
		return {
			table: tableName,
			done: result.done,
			pages: result.pages.length,
			status,
		};
	} catch (error) {
		const overloaded = isD1Overloaded(error);
		const message = error instanceof Error ? error.message : String(error);
		const pages = latest?.pages.length ?? 0;
		await store.putTableProgress({
			table: tableName,
			status: overloaded ? "paused" : "error",
			highWater: water,
			pages,
			state: latest,
			lastError: message,
			updatedAt: now(),
		});
		if (overloaded) {
			await store.setRunState({
				mode: "paused",
				note: `D1 overloaded during ${tableName}; resume with POST /run`,
				updatedAt: now(),
			});
			return {
				table: tableName,
				done: false,
				pages,
				status: "paused",
				lastError: message,
			};
		}
		return {
			table: tableName,
			done: false,
			pages,
			status: "error",
			lastError: message,
		};
	}
}

/** POST /verify: checks the Postgres rows against the page receipts only. */
export async function verifyTable(
	ports: CopyPorts,
	tableName: string,
): Promise<{ table: string; verified: boolean; pages: number }> {
	const entry = planTable(tableName);
	if (!entry) throw new Error(`Unknown copy table: ${tableName}`);
	const progress = await ports.store.tableProgress(tableName);
	if (!progress?.state)
		throw new Error(`No checkpoint for ${tableName}; copy it first`);
	await verifyCopy(asCopyTable(entry), ports.query, progress.state);
	await ports.store.putTableProgress({
		...progress,
		status: "verified",
		updatedAt: new Date().toISOString(),
	});
	return {
		table: tableName,
		verified: true,
		pages: progress.state.pages.length,
	};
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
 * One cron tick: while the run says "running", copy the first unfinished
 * table for a bounded number of pages. An overloaded D1 pauses the run; the
 * next tick after POST /run resumes from the checkpoint.
 */
export async function cronTick(ports: CopyPorts): Promise<CopyResult | null> {
	const run = await ports.store.runState();
	if (run.mode !== "running") return null;
	for (const entry of coreCopyPlan()) {
		const progress = await ports.store.tableProgress(entry.table);
		if (progress?.status === "done" || progress?.status === "verified")
			continue;
		if (progress?.status === "error") continue;
		return copyTable(ports, entry.table, { maxPages: CRON_PAGE_BUDGET });
	}
	await ports.store.setRunState({
		mode: "idle",
		note: "all planned tables copied",
		updatedAt: new Date().toISOString(),
	});
	return null;
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
