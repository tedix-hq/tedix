/// <reference types="node" />
import { AsyncLocalStorage } from "node:async_hooks";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import { createLogger } from "@tedix/worker-kit/logger";

const requestLogger = createLogger<{
	label: string;
	statements: number;
	d1WallMs: number;
	rowsRead: number;
	rowsWritten: number;
	rowsReturned: number;
	maxInFlight: number;
	overloaded: number;
	topShapes: string;
	topReadShapes: string;
}>({ component: "db.request" });

type Ledger = {
	reads?: Map<string, Map<object, Promise<unknown>>>;
	label: string;
	statements: number;
	d1WallMs: number;
	rowsRead: number;
	rowsWritten: number;
	rowsReturned: number;
	inFlight: number;
	maxInFlight: number;
	overloaded: number;
	shapes: Map<
		string,
		{ n: number; wallMs: number; rowsReturned: number; rowsRead: number }
	>;
};
const ledgers = new AsyncLocalStorage<Ledger>();

/**
 * One summary line per scheduled or queue invocation that used D1 heavily.
 * oRPC calls already report their D1 counters in `tedix.api.procedure`; jobs
 * had no equivalent. Workers Logs adds the trigger and requestId, so overload
 * bursts can be traced to the job. Rows returned are not rows scanned.
 */
export async function withD1Ledger<T>(
	label: string,
	run: () => Promise<T>,
): Promise<T> {
	const ledger: Ledger = {
		label,
		statements: 0,
		d1WallMs: 0,
		rowsRead: 0,
		rowsWritten: 0,
		rowsReturned: 0,
		inFlight: 0,
		maxInFlight: 0,
		overloaded: 0,
		shapes: new Map(),
		reads: new Map(),
	};
	try {
		return await ledgers.run(ledger, run);
	} finally {
		// Detached work must not retain or refill an invocation's memo.
		ledger.reads?.clear();
		ledger.reads = undefined;
		if (
			ledger.statements >= 25 ||
			ledger.d1WallMs >= 500 ||
			ledger.rowsRead >= 5_000 ||
			ledger.rowsReturned >= 2_000 ||
			ledger.overloaded > 0
		)
			requestLogger.info("D1 use by one request", {
				event: "db.request",
				label,
				statements: ledger.statements,
				d1WallMs: Math.round(ledger.d1WallMs),
				rowsRead: ledger.rowsRead,
				rowsWritten: ledger.rowsWritten,
				rowsReturned: ledger.rowsReturned,
				maxInFlight: ledger.maxInFlight,
				overloaded: ledger.overloaded,
				topReadShapes: [...ledger.shapes]
					.sort((a, b) => b[1].rowsRead - a[1].rowsRead)
					.slice(0, 3)
					.map(
						([shape, s]) =>
							`${s.n}x ${s.rowsRead}read ${s.rowsReturned}returned ${shape}`,
					)
					.join(" | "),
				topShapes: [...ledger.shapes]
					.sort((a, b) => b[1].wallMs - a[1].wallMs)
					.slice(0, 3)
					.map(
						([shape, s]) =>
							`${s.n}x ${Math.round(s.wallMs)}ms ${s.rowsReturned}rows ${shape}`,
					)
					.join(" | "),
			});
	}
}

/** Share a read only until the enclosing request, scheduled run or queue batch ends. */
export function memoizeD1InvocationRead<T>(
	name: string,
	client: object,
	read: () => Promise<T>,
): Promise<T> {
	const reads = ledgers.getStore()?.reads;
	if (!reads) return read();
	let bindings = reads.get(name);
	if (!bindings) {
		bindings = new Map();
		reads.set(name, bindings);
	}
	const key = getD1BindingKey(client);
	const existing = bindings.get(key);
	if (existing) return existing as Promise<T>;
	const result = read();
	bindings.set(key, result);
	return result;
}

export function invalidateD1InvocationRead(name: string, client: object): void {
	ledgers.getStore()?.reads?.get(name)?.delete(getD1BindingKey(client));
}

function begin(): Ledger | undefined {
	const ledger = ledgers.getStore();
	if (ledger) {
		ledger.inFlight += 1;
		ledger.maxInFlight = Math.max(ledger.maxInFlight, ledger.inFlight);
	}
	return ledger;
}

function tally(
	ledger: Ledger | undefined,
	sql: string,
	wallMs: number,
	result: D1Result | undefined,
	returned: number,
	error: unknown,
): void {
	if (!ledger) return;
	ledger.inFlight -= 1;
	ledger.statements += 1;
	ledger.d1WallMs += wallMs;
	ledger.rowsRead += result?.meta?.rows_read ?? 0;
	ledger.rowsWritten += result?.meta?.rows_written ?? 0;
	ledger.rowsReturned += returned;
	if (error instanceof Error && /overloaded/i.test(error.message))
		ledger.overloaded += 1;
	const shape = sql.replace(SQL_TOKENS, (token) =>
		/^["`\[]/.test(token) ? token : "?",
	);
	const key = shape.slice(0, 160);
	const entry = ledger.shapes.get(key) ?? {
		n: 0,
		wallMs: 0,
		rowsReturned: 0,
		rowsRead: 0,
	};
	entry.n += 1;
	entry.wallMs += wallMs;
	entry.rowsReturned += returned;
	entry.rowsRead += result?.meta?.rows_read ?? 0;
	ledger.shapes.set(key, entry);
}

function returnedRows(value: unknown): number {
	if (Array.isArray(value)) return value.length;
	const rows = (value as { results?: unknown } | null)?.results;
	if (Array.isArray(rows)) return rows.length;
	return value == null ? 0 : 1;
}

const logger = createLogger<{
	sqlShape: string;
	caller: string;
	durationMs: number | undefined;
	durationSource: string;
	operation: string;
	rowsRead: number;
	statementCount: number;
	sampleRate: number;
}>({ component: "db.slow_query" });

// Keep quoted identifiers, but remove literals and comments even in raw SQL.
const SQL_TOKENS =
	/"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:[^\]])*\]|(?:x)?'(?:''|[^'])*'|--[^\r\n]*|\/\*[\s\S]*?\*\/|\b(?:0x[\da-f]+|\d+(?:\.\d*)?(?:e[+-]?\d+)?)\b/gi;
const observed = new WeakMap<object, object>();
const bindingKeys = new WeakMap<object, object>();

/** Cache identity survives observation and per-request session wrappers. */
export function getD1BindingKey(client: object): object {
	return bindingKeys.get(client) ?? client;
}

export function registerD1BindingKey(client: object, binding: object): void {
	bindingKeys.set(client, getD1BindingKey(binding));
}
const statements = new WeakMap<
	D1PreparedStatement,
	{ native: D1PreparedStatement; sql: string }
>();

function caller(): string {
	return (new Error().stack ?? "")
		.split("\n")
		.slice(1)
		.filter(
			(line) =>
				!/\/slow-query\.(?:ts|js):|node_modules\/.*drizzle-orm/.test(line),
		)
		.slice(0, 6)
		.join("\n");
}

function report(
	sql: string,
	origin: string,
	operation: string,
	durationMs: number | undefined,
	durationSource: string,
	result?: D1Result,
	statementCount?: number,
): void {
	const slow = durationMs !== undefined && durationMs > 1_000;
	if (!slow && (result?.meta?.rows_read ?? 0) <= 100_000) return;
	logger.warn(
		slow ? "D1 operation exceeded 1 s" : "D1 operation read over 100k rows",
		{
			event: slow ? "db.query.slow" : "db.query.large_read",
			sqlShape: sql.replace(SQL_TOKENS, (token) =>
				/^["`\[]/.test(token) ? token : "?",
			),
			caller: origin,
			durationMs,
			durationSource,
			operation,
			rowsRead: result?.meta?.rows_read,
			statementCount,
			sampleRate: 1,
		},
	);
}

/** Observe native execution without changing SQL, bindings, results or errors. */
export function observeD1<T extends Pick<D1Database, "prepare" | "batch">>(
	database: T,
	binding: object = database,
): T {
	// A missing binding keeps failing on first use, inside the caller's error handling.
	if (typeof database !== "object" || database === null) return database;
	const existing = observed.get(database);
	if (existing) return existing as T;
	const wrap = (
		native: D1PreparedStatement,
		sql: string,
	): D1PreparedStatement => {
		const proxy = new Proxy(native, {
			get(target, key) {
				if (key === "bind")
					return (...values: unknown[]) => wrap(target.bind(...values), sql);
				const value = Reflect.get(target, key);
				if (["all", "run", "raw", "first"].includes(String(key)))
					return async (...args: unknown[]) => {
						const origin = caller();
						const ledger = begin();
						const start = performance.now();
						let result: D1Result | undefined;
						let returned = 0;
						let failure: unknown;
						try {
							const valueResult = await Reflect.apply(value, target, args);
							if (key === "all" || key === "run")
								result = valueResult as D1Result;
							if (key !== "run") returned = returnedRows(valueResult);
							return valueResult;
						} catch (error) {
							failure = error;
							throw error;
						} finally {
							tally(
								ledger,
								sql,
								performance.now() - start,
								result,
								returned,
								failure,
							);
							report(
								sql,
								origin,
								String(key),
								performance.now() - start,
								"wall",
								result,
							);
						}
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		statements.set(proxy, { native, sql });
		return proxy;
	};
	const proxy = new Proxy(database, {
		get(target, key) {
			if (key === "prepare")
				return (sql: string) => wrap(target.prepare(sql), sql);
			if (key === "withSession")
				return (...args: unknown[]) =>
					observeD1(
						Reflect.apply(
							Reflect.get(target, key) as D1Database["withSession"],
							target,
							args,
						),
						database,
					);
			if (key === "batch")
				return async (batch: D1PreparedStatement[]) => {
					const origin = caller();
					const ledger = begin();
					const start = performance.now();
					let results: D1Result[] | undefined;
					let failure: unknown;
					try {
						results = await target.batch(
							batch.map((s) => statements.get(s)?.native ?? s),
						);
						return results;
					} catch (error) {
						failure = error;
						throw error;
					} finally {
						const elapsed = performance.now() - start;
						const sqlOf = (statement: D1PreparedStatement) =>
							statements.get(statement)?.sql ?? "<unobserved statement>";
						let untimed = 0;
						batch.forEach((statement, index) => {
							const result = results?.[index];
							if (ledger) {
								// One in-flight slot covers the whole batch.
								if (index > 0) ledger.inFlight += 1;
								tally(
									ledger,
									sqlOf(statement),
									elapsed / batch.length,
									result,
									returnedRows(result),
									index === 0 ? failure : undefined,
								);
							}
							const duration = result?.meta?.duration;
							if (duration === undefined) untimed += 1;
							report(
								sqlOf(statement),
								origin,
								"batch",
								duration,
								duration === undefined ? "unavailable" : "d1",
								result,
							);
						});
						// A batch's wall time cannot be attributed to one statement.
						if (untimed > 0)
							report(
								sqlOf(batch[0]!),
								origin,
								"batch",
								elapsed,
								"batch_wall",
								undefined,
								batch.length,
							);
					}
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	registerD1BindingKey(database, binding);
	registerD1BindingKey(proxy, binding);
	observed.set(database, proxy);
	observed.set(proxy, proxy);
	return proxy;
}
