import type { DoQueryStatement } from "./emdash-db";

export const THEME_PREVIEW_DATABASE_NAME = /^__theme-preview:[0-9a-f-]{36}$/;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Copy in one synchronous turn: schema and rows must describe the same database.
 * Shadow tables are rebuilt by their virtual table, and triggers run only after import. */
export function themePreviewSnapshot(
	sql: DurableObjectStorage["sql"],
): DoQueryStatement[] {
	const statements: DoQueryStatement[] = [];
	let bytes = 0;
	const add = (statement: DoQueryStatement) => {
		bytes += new TextEncoder().encode(statement.sql).byteLength;
		for (const value of statement.params ?? [])
			bytes +=
				value instanceof ArrayBuffer
					? value.byteLength
					: new TextEncoder().encode(String(value)).byteLength;
		if (bytes > 16 * 1024 * 1024 || statements.length >= 20_000)
			throw new Error("Theme preview snapshot exceeds copy limit");
		statements.push(statement);
	};
	const schema = sql
		.exec<{ type: string; name: string; sql: string }>(
			"SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY rowid",
		)
		.toArray();
	const tableInfo = sql
		.exec<{ name: string; type: string; wr: number }>("PRAGMA table_list")
		.toArray();
	const shadows = new Set(
		tableInfo.filter((row) => row.type === "shadow").map((row) => row.name),
	);
	const tables = schema.filter(
		(row) => row.type === "table" && !shadows.has(row.name),
	);
	for (const table of tables) add({ sql: table.sql });
	// Referenced unique keys must exist before inserting child rows.
	for (const index of schema.filter(
		(row) => row.type === "index" && !shadows.has(row.name),
	))
		add({ sql: index.sql });
	for (const table of tables) {
		const columns = sql
			.exec<{ name: string; hidden: number }>(
				`PRAGMA table_xinfo(${quote(table.name)})`,
			)
			.toArray()
			.filter((column) => column.hidden === 0)
			.map((column) => quote(column.name));
		// FTS joins use SQLite rowids; deleted rows must not renumber the copy.
		if (!tableInfo.find((row) => row.name === table.name)?.wr) {
			const rowid = ["rowid", "_rowid_", "oid"].find(
				(name) => !columns.includes(quote(name)),
			);
			if (rowid) columns.unshift(quote(rowid));
		}
		for (const row of sql
			.exec(`SELECT ${columns.join(", ")} FROM ${quote(table.name)}`)
			.raw())
			add({
				sql: `INSERT INTO ${quote(table.name)} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
				params: row,
			});
	}
	for (const object of schema.filter(
		(row) =>
			(row.type === "view" || row.type === "trigger") && !shadows.has(row.name),
	))
		add({ sql: object.sql });
	return statements;
}
