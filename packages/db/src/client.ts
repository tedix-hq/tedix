/**
 * Database Client Factory
 * Creates Drizzle ORM instances for Cloudflare D1
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index";
import { relations } from "./schema/relations";
import { observeD1 } from "./slow-query";

export function createDbClient(d1: D1Database) {
	return drizzle(observeD1(d1), { relations });
}

/**
 * Log-store routing. The logs database (`LOGS_DB`) is a second D1 that takes
 * the append-only log tables (see `schema/logs-db.ts`). A request-scoped
 * client registered here reads both stores and writes `mcp.tool.execute`
 * audit rows to the logs store; a client with no registration behaves exactly
 * as before, so a Worker without the binding is unchanged. The binding's
 * presence is the only switch.
 */
export interface LogStores {
	/** The main database, as a plain client (not itself registered). */
	main: DbClient;
	/** The logs database. */
	logs: DbClient;
}

const logStores = new WeakMap<object, LogStores>();

/** Register the logs database for `db` when the Worker binds `LOGS_DB`. */
export function configureLogStore(db: DbClient, bindings: object): void {
	const logs = (bindings as { LOGS_DB?: D1Database }).LOGS_DB;
	if (!logs) return;
	logStores.set(db, {
		main: createDbClient(db.$client),
		logs: createDbClient(logs),
	});
}

/** The registered stores for `db`, or undefined when there is no logs binding. */
export function getLogStores(db: object): LogStores | undefined {
	return logStores.get(db);
}

export type DbClient = ReturnType<typeof createDbClient>;

/**
 * The D1 surface a query module may reach for through `db.$client`.
 *
 * Deliberately narrower than `D1Database`: a `D1DatabaseSession` provides
 * `prepare` and `batch` but not `exec`, `dump`, or `withSession`. Typing the
 * escape hatch as only what callers actually need is what lets the same query
 * modules run against either a database or a session.
 */
export type D1Executor = Pick<D1Database, "prepare" | "batch">;

/**
 * The bookmark header a client uses to chain sequential consistency across
 * requests. Read it off the request, hand it to `createDbSession`, and write
 * `getBookmark()` back onto the response.
 */
export const D1_BOOKMARK_HEADER = "x-d1-bookmark";

/**
 * How the session's *first* query is routed. Later queries in the same session
 * follow from it, which is what makes the session sequentially consistent.
 *
 * - `first-unconstrained` — any instance, including a replica. Lowest latency.
 * - `first-primary` — the primary. Always current, no latency win.
 */
export type D1SessionConstraint = "first-unconstrained" | "first-primary";

export interface DbSession {
	metrics: {
		queries: number;
		rowsRead: number;
		rowsWritten: number;
		withoutMeta: number;
	};
	/** Drizzle client bound to the session. Use this for every query in the request. */
	db: DbClient;
	/**
	 * The bookmark to return to the caller, or null before any query has run.
	 * Echo it on the response so the caller's next request can resume from here.
	 */
	getBookmark(): string | null;
}

/**
 * Open one D1 session per request and bind Drizzle to it.
 *
 * D1 read replication routes reads to the nearest replica while writes always go
 * to the primary. The workload here is heavily read-skewed — ~532k reads against
 * ~47k writes per day, 1.25B rows read — and the primary sits in a single region,
 * so a Worker in another continent currently pays a cross-region round trip for
 * every read.
 *
 * A *session* is what makes that safe. Within one session D1 guarantees
 * sequential consistency: read-your-own-writes and monotonic reads. So a request
 * that writes and then reads sees its own write even though reads may be served
 * by a replica, with no per-query reasoning required. Correctness comes from
 * using ONE session for the whole request, not from classifying each query.
 *
 * Across requests, pass the previous response's bookmark back in
 * `D1_BOOKMARK_HEADER` to extend that guarantee; a caller that sends no bookmark
 * gets `constraint` (default `first-unconstrained`) and may observe data up to
 * the replication lag stale — sub-second, but not zero.
 *
 * Safe to adopt before replication is enabled: with `read_replication.mode`
 * disabled, sessions still work and every query goes to the primary, so this is
 * a behavioural no-op until the database setting is flipped.
 *
 * @example
 * const session = createDbSession(env.DB, request.headers.get(D1_BOOKMARK_HEADER));
 * // ... use session.db for every query in this request ...
 * response.headers.set(D1_BOOKMARK_HEADER, session.getBookmark() ?? "");
 */
export function createDbSession(
	d1: D1Database,
	bookmark?: string | null,
	constraint: D1SessionConstraint = "first-unconstrained",
): DbSession {
	// A bookmark is strictly more specific than a constraint — prefer it when the
	// caller supplied one, so the session resumes rather than restarting.
	const session = observeD1(d1.withSession(bookmark?.trim() || constraint));
	const metrics = { queries: 0, rowsRead: 0, rowsWritten: 0, withoutMeta: 0 };
	const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
	const record = (result: D1Result) => {
		if (
			typeof result.meta.rows_read !== "number" ||
			typeof result.meta.rows_written !== "number"
		)
			metrics.withoutMeta++;
		metrics.rowsRead += result.meta.rows_read ?? 0;
		metrics.rowsWritten += result.meta.rows_written ?? 0;
	};
	const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
		const proxy = new Proxy(statement, {
			get(target, key) {
				if (key === "bind")
					return (...values: unknown[]) => wrap(target.bind(...values));
				if (["raw", "first", "all", "run"].includes(String(key)))
					return async (...args: unknown[]) => {
						metrics.queries++;
						// D1 raw/first omit meta. Never report their unknown row cost as zero.
						const hasMeta = key === "all" || key === "run";
						if (!hasMeta) metrics.withoutMeta++;
						try {
							const result = await Reflect.apply(
								Reflect.get(target, key),
								target,
								args,
							);
							if (hasMeta) record(result as D1Result);
							return result;
						} catch (error) {
							if (hasMeta) metrics.withoutMeta++;
							throw error;
						}
					};
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		statements.set(proxy, statement);
		return proxy;
	};
	const measured = new Proxy(session, {
		get(target, key) {
			if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
			if (key === "batch")
				return async (batch: D1PreparedStatement[]) => {
					metrics.queries += batch.length;
					try {
						const results = await target.batch(
							batch.map((statement) => statements.get(statement) ?? statement),
						);
						results.forEach(record);
						return results;
					} catch (error) {
						metrics.withoutMeta += batch.length;
						throw error;
					}
				};
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return {
		metrics,
		// Cast is confined to the `$client` escape hatch: a session-backed Drizzle
		// instance has an identical query surface, and `$client` narrows from
		// D1Database to D1DatabaseSession. The one caller that reaches for it
		// (queries/billing/settlement.ts) takes `D1Executor`, which both satisfy.
		db: drizzle(measured, { relations }) as unknown as DbClient,
		getBookmark: () => session.getBookmark() ?? null,
	};
}

export { schema };
