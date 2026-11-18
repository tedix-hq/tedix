import { type SQL, sql } from "drizzle-orm";

/** Preserve SQLite's whole-second expiry cutoff for stored UTC timestamps. */
export function liveAtSql(column: string, now: string): SQL {
	return sql`${columnRef(column)}::timestamptz >= date_trunc('second', ${now}::timestamptz) + interval '1 second'`;
}
export function sameUtcDaySql(column: string, now: string): SQL {
	const day = `${now.slice(0, 10)}`;
	return sql`${columnRef(column)} >= ${day} AND ${columnRef(column)} < ((${day}::date + 1)::text)`;
}
function columnRef(column: string): SQL {
	return sql.join(
		column.split(".").map((part) => sql.identifier(part)),
		sql`.`,
	);
}
