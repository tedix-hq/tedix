/**
 * Projection helpers for joins on D1.
 *
 * Drizzle emits a select list with NO SQL aliases even when TS keys are
 * distinct. Direct D1 selects use array-mode decoding in Drizzle v1 rc.4 and
 * preserve duplicate names, but the same statement composed into `db.batch()`
 * is decoded from D1 object rows. Duplicate output names have already collapsed
 * by then, and Drizzle applies the TS selection positionally. So this idiom —
 * which looks safe because the tables are namespaced under distinct keys —
 *
 *   db.select({ principal: principals, session: sessions })
 *      .from(sessions).innerJoin(principals, ...)
 *
 * emits `"principals"."id", ..., "sessions"."id", ...` with both output columns
 * literally named `id`. In a batch result, the later duplicate replaces the
 * earlier one, every later selected field shifts left during mapping, and the
 * row decodes incorrectly. A later refactor must therefore be free to compose a
 * query into a batch without changing its output safety.
 *
 * `prefixedColumns` keeps the exact nested shape while forcing a unique output
 * name per column.
 */

import { type Column, getColumns, type SQL, sql } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

type PrefixedSelection<TTable extends SQLiteTable> = {
	[K in keyof TTable["_"]["columns"]]: SQL<
		TTable["_"]["columns"][K]["_"]["data"]
	>;
};

/**
 * Every column of `table`, aliased `<prefix>_<key>` so it cannot collide with a
 * column of the same name on another table in the same select.
 *
 * `mapWith(column)` is load-bearing and must not be dropped: a bare
 * `` sql`${column}` `` discards the column's `mapFromDriverValue`, so
 * `integer({ mode: "boolean" })` comes back as `1` instead of `true` and
 * `text({ mode: "json" })` comes back as an unparsed string. With it, values
 * decode exactly as they do through a plain column reference.
 *
 * @example
 * db.select({
 *   account: prefixedColumns(billingAccounts, "account"),
 *   plan: prefixedColumns(billingPlanVersions, "plan"),
 * })
 *   .from(billingAccounts)
 *   .innerJoin(billingPlanVersions, eq(...))
 */
export function prefixedColumns<TTable extends SQLiteTable>(
	table: TTable,
	prefix: string,
): PrefixedSelection<TTable> {
	const selection: Record<string, SQL<unknown>> = {};
	for (const [key, column] of Object.entries(
		getColumns(table) as Record<string, Column>,
	)) {
		selection[key] = sql`${column}`
			.mapWith(column)
			.as(`${prefix}_${key}`) as unknown as SQL<unknown>;
	}
	return selection as PrefixedSelection<TTable>;
}
