/**
 * Index-friendly time predicates for credit admission.
 *
 * Writers persist UTC ISO milliseconds (`YYYY-MM-DDTHH:MM:SS.sssZ`), so plain
 * text comparison orders these columns correctly. Wrapping a column in
 * `datetime()` or `substr()` hides it from its index: on an organization with
 * hundreds of thousands of charges, every admission then read all of them
 * (D1 "too many resources consumed", 2026-11-04).
 */

import { type SQL, sql } from "drizzle-orm";
import { coreStore } from "../../core-store/dialect";
import type { DbClient } from "../../client";

/**
 * `column` is still live at `now`, as `datetime(column) > datetime(now)`
 * decided it. `datetime()` truncates both sides to whole seconds, so the text
 * threshold is the next whole second after `now`, in the stored format.
 */
export function liveAtSql(db: DbClient, column: string, now: string): SQL {
	return coreStore(db) === "postgres"
		? sql`${columnRef(column)} >= to_char(date_trunc('second', ${now}::timestamptz) + interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql`${columnRef(column)} >= strftime('%Y-%m-%dT%H:%M:%fZ', datetime(${now}, '+1 second'))`;
}

/** `column` or `alias.column` as quoted identifiers. */
function columnRef(column: string): SQL {
	return sql.join(
		column.split(".").map((part) => sql.identifier(part)),
		sql`.`,
	);
}
