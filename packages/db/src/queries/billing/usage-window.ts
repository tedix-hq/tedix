/**
 * Index-friendly time predicates for the inference capacity gates.
 *
 * Writers persist UTC ISO milliseconds (`YYYY-MM-DDTHH:MM:SS.sssZ`), so plain
 * text comparison orders these columns correctly. Wrapping a column in
 * `datetime()` or `substr()` hides it from its index: on an organization with
 * hundreds of thousands of charges, every admission then read all of them
 * (D1 "too many resources consumed", 2026-11-04).
 */

import { type SQL, sql } from "drizzle-orm";

/**
 * `column` is still live at `now`, as `datetime(column) > datetime(now)`
 * decided it. `datetime()` truncates both sides to whole seconds, so the text
 * threshold is the next whole second after `now`, in the stored format.
 */
export function liveAtSql(column: string, now: string): SQL {
	return sql`${sql.raw(column)} >= strftime('%Y-%m-%dT%H:%M:%fZ', datetime(${now}, '+1 second'))`;
}

/**
 * `column` falls on the same UTC calendar day as `now`: the half-open range
 * `[day, next day)` that `substr(column, 1, 10) = substr(now, 1, 10)` used to
 * compute per row.
 */
export function sameUtcDaySql(column: string, now: string): SQL {
	const day = sql`substr(${now}, 1, 10)`;
	return sql`${sql.raw(column)} >= ${day} AND ${sql.raw(column)} < date(${day}, '+1 day')`;
}
