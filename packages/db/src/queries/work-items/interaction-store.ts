import { getColumns, sql, type SQLWrapper } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead, pgTextArray } from "../../core-store/dialect";
import { workInteractions } from "../../schema/work-factory";

export function interactionColumns(db: DbQueryClient) {
	const {
		source: _source,
		delegatedOwnerId: _delegatedOwnerId,
		...columns
	} = getColumns(coreTable(db, workInteractions));
	return columns;
}

/** Preserve SQLite JSON type names where the interaction guards distinguish scalar kinds. */
export function interactionJsonType(
	db: object,
	column: SQLWrapper,
	path: readonly string[],
) {
	if (coreStore(db) === "d1")
		return sql`json_type(${column}, ${"$." + path.join(".")})`;
	const value = jsonRead(db, column, path, "json");
	return sql`CASE jsonb_typeof(${value}) WHEN 'string' THEN 'text' WHEN 'boolean' THEN (${value})::text WHEN 'number' THEN CASE WHEN (${value})::text ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END ELSE jsonb_typeof(${value}) END`;
}

export function removeInteractionPaths(
	db: object,
	column: SQLWrapper,
	paths: readonly (readonly string[])[],
) {
	let expression = sql`${column}`;
	for (const path of paths)
		expression =
			coreStore(db) === "postgres"
				? sql`(${expression} #- ${pgTextArray(path)}::text[])`
				: sql`json_remove(${expression}, ${"$." + path.join(".")})`;
	return expression;
}

export function interactionDay(db: object, value: SQLWrapper) {
	return coreStore(db) === "postgres"
		? sql`(extract(epoch FROM ${value}::timestamptz) / 86400.0)`
		: sql`julianday(${value})`;
}

export function interactionAuditTime(db: object, at: string) {
	const epoch = Math.floor(Date.parse(at) / 1000);
	return coreStore(db) === "postgres"
		? sql`to_timestamp(${epoch})`
		: sql`${epoch}`;
}
