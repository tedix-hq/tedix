/**
 * Database Client Factory
 * Creates Drizzle ORM instances for Cloudflare D1
 */

import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index";
import { relations } from "./schema/relations";

export function createDbClient(d1: D1Database) {
	return drizzle(d1, { relations });
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
	const session = d1.withSession(bookmark?.trim() || constraint);
	return {
		// Cast is confined to the `$client` escape hatch: a session-backed Drizzle
		// instance has an identical query surface, and `$client` narrows from
		// D1Database to D1DatabaseSession. The one caller that reaches for it
		// (queries/billing/settlement.ts) takes `D1Executor`, which both satisfy.
		db: drizzle(session, { relations }) as unknown as DbClient,
		getBookmark: () => session.getBookmark() ?? null,
	};
}

export { schema };
