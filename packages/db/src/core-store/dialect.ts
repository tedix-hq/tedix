import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export type CoreStore = "d1" | "postgres";
const stores = new WeakMap<object, CoreStore>();
export function registerCoreStore(db: object, store: CoreStore): void {
	stores.set(db, store);
}
export function coreStore(db: object): CoreStore {
	return stores.get(db) ?? "d1";
}

/** Literal paths retain SQLite expression-index matching; only data values are bound. */
function sqliteJsonPath(path: readonly string[]): SQL {
	const value =
		"$" +
		path
			.map((segment) =>
				/^[A-Za-z_][A-Za-z_0-9]*$/.test(segment)
					? "." + segment
					: "." + JSON.stringify(segment),
			)
			.join("");
	return sql.raw("'" + value.replaceAll("'", "''") + "'");
}

/** Paths are segments, never caller-supplied SQL or a JSONPath expression. */
export function jsonRead(
	db: object,
	column: SQLWrapper,
	path: readonly string[],
	kind: "text" | "number" | "boolean" | "json" = "text",
): SQL {
	if (!path.length) throw new Error("A JSON path needs at least one segment");
	if (coreStore(db) === "d1")
		return sql`json_extract(${column}, ${sqliteJsonPath(path)})`;
	const value = sql`${column} ${kind === "json" ? sql`#>` : sql`#>>`} ${pgTextArray(path)}::text[]`;
	if (kind === "number" || kind === "boolean") {
		const jsonType = kind === "number" ? "number" : "boolean";
		return sql`CASE WHEN jsonb_typeof(${column} #> ${pgTextArray(path)}::text[]) = ${jsonType} THEN ${kind === "number" ? sql`(${value})::numeric` : sql`(${value})::boolean`} END`;
	}
	return value;
}
export function jsonWrite(
	db: object,
	column: SQLWrapper,
	path: readonly string[],
	value: unknown,
): SQL {
	if (!path.length) throw new Error("A JSON path needs at least one segment");
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("JSON values must be serializable");
	if (coreStore(db) === "d1")
		return sql`json_set(coalesce(${column}, '{}'), ${sqliteJsonPath(path)}, json(${json}))`;
	let document = sql`coalesce(${column}, '{}'::jsonb)`;
	for (let length = 1; length < path.length; length++) {
		const prefix = pgTextArray(path.slice(0, length));
		document = sql`jsonb_set(${document}, ${prefix}::text[], coalesce(${column} #> ${prefix}::text[], '{}'::jsonb), true)`;
	}
	return sql`jsonb_set(${document}, ${pgTextArray(path)}::text[], ${json}::jsonb, true)`;
}
/** One bound array on Postgres; one bound JSON set on D1 (including empty sets). */
export function anyIds(
	db: object,
	column: SQLWrapper,
	ids: readonly string[],
): SQL {
	return coreStore(db) === "postgres"
		? sql`${column} = ANY(${pgTextArray(ids)}::text[])`
		: sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}
export function pgTextArray(values: readonly string[]): string {
	return `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;
}
export function unixTime(db: object, value: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`floor(extract(epoch FROM ${value}::timestamptz))::bigint`
		: sql`unixepoch(${value})`;
}
export function dateTime(db: object, epoch: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`to_timestamp(${epoch})`
		: sql`datetime(${epoch}, 'unixepoch')`;
}
export function containsText(
	db: object,
	column: SQLWrapper,
	text: string,
): SQL {
	return coreStore(db) === "postgres"
		? sql`strpos(${column}, ${text}) > 0`
		: sql`instr(${column}, ${text}) > 0`;
}
/** SQLite LIKE folds ASCII only. Do the same on Postgres, without locale-specific ILIKE. */
export function likeText(db: object, column: SQLWrapper, pattern: string): SQL {
	return coreStore(db) === "postgres"
		? sql`translate(${column}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') LIKE translate(${pattern}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') ESCAPE ''`
		: sql`${column} LIKE ${pattern}`;
}
export function booleanValue(db: object, value: boolean): SQL {
	return coreStore(db) === "postgres"
		? sql`${value}::boolean`
		: sql`${value ? 1 : 0}`;
}
/** Both builders use .onConflictDoUpdate({ target, set }) and .returning(...).
 * Count RETURNING rows for conditional writes instead of connection-local changes(). */
export function changedRows(rows: readonly unknown[]): number {
	return rows.length;
}

/** JSON expressions in INSERT ... SELECT need an explicit Postgres type. */
export function jsonParameter(db: object, value: unknown): SQL {
	const text = JSON.stringify(value);
	if (text === undefined) throw new Error("JSON values must be serializable");
	return coreStore(db) === "postgres" ? sql`${text}::jsonb` : sql`${text}`;
}
