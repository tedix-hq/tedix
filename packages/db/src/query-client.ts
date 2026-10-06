/**
 * Relation-free Drizzle client for small Workers that only use typed SQL
 * builders.
 *
 * Importing `client.ts` initializes the complete platform schema and Relations
 * v2 graph. That is appropriate for consumers of `db.query.*`, but needlessly
 * expands Workers whose direct query leaves only use Core API builders. Keep
 * this factory schema-agnostic so those Workers pay only for the tables their
 * imported query leaves reference.
 */

import { drizzle } from "drizzle-orm/d1";

export function createDbQueryClient(d1: D1Database) {
	return drizzle(d1);
}

export type DbQueryClient = ReturnType<typeof createDbQueryClient>;
