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

/**
 * `column` is still live at `now`, as `datetime(column) > datetime(now)`
 * decided it. `datetime()` truncates both sides to whole seconds, so the text
 * threshold is the next whole second after `now`, in the stored format.
 */
export function liveAtSql(column: string, now: string): SQL {
	return sql`${columnRef(column)} >= strftime('%Y-%m-%dT%H:%M:%fZ', datetime(${now}, '+1 second'))`;
}

/** `column` or `alias.column` as quoted identifiers. */
function columnRef(column: string): SQL {
	return sql.join(
		column.split(".").map((part) => sql.identifier(part)),
		sql`.`,
	);
}
