import { sql } from "drizzle-orm";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { coreStore } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";

/** CMS admission predicates depend on serialized writes across its tables.
 * Acquire the Postgres lock before the next statement's READ COMMITTED snapshot.
 * Keeping it in the same batch preserves the single round trip and transaction.
 */
export async function runCmsWriteBatch<
	T extends readonly [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]],
>(db: DbQueryClient, statements: T): Promise<BatchResponse<T>> {
	if (coreStore(db) === "d1") return db.batch(statements);
	const lock = db
		.select({
			lock: sql`pg_advisory_xact_lock(hashtextextended('cms-write', 0))`,
		})
		.from(sql`(select 1) as cms_lock`);
	const results = await db.batch([lock, ...statements]);
	return results.slice(1) as BatchResponse<T>;
}

export async function runCmsWrite<T extends BatchItem<"sqlite">>(
	db: DbQueryClient,
	statement: T,
): Promise<T["_"]["result"]> {
	return (await runCmsWriteBatch(db, [statement]))[0];
}

export function cmsDateTime(db: DbQueryClient, now = "now", offsetSeconds = 0) {
	return coreStore(db) === "postgres"
		? sql`to_char(((CASE WHEN ${now}::text = 'now' THEN statement_timestamp() ELSE ${now}::timestamptz END) + ${offsetSeconds}::integer * interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`
		: sql`datetime(${now}, ${`${offsetSeconds} seconds`})`;
}

export function cmsEpochNow(db: DbQueryClient) {
	return coreStore(db) === "postgres"
		? sql`floor(extract(epoch FROM statement_timestamp()))::bigint`
		: sql`unixepoch()`;
}
