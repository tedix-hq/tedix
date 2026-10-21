import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { LOGS_DB_TABLE_NAMES } from "../src/schema/logs-db";
import { renderLogsDbSchema } from "./logs-db-schema";

const MIGRATIONS_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"logs-db",
	"migrations",
);

/** Column and index shape of every logs table, as SQLite reports it. */
function shape(sqlite: DatabaseSync) {
	const result: Record<string, { columns: unknown[]; indexes: unknown[] }> = {};
	for (const table of [...LOGS_DB_TABLE_NAMES].sort()) {
		const columns = sqlite
			.prepare(`PRAGMA table_info("${table}")`)
			.all()
			.map((row) => {
				const column = row as Record<string, unknown>;
				return {
					name: column.name,
					type: column.type,
					notnull: column.notnull,
					pk: column.pk,
				};
			});
		const indexes = (
			sqlite.prepare(`PRAGMA index_list("${table}")`).all() as Array<
				Record<string, unknown>
			>
		)
			.filter((index) => index.origin === "c")
			.map((index) => ({
				name: index.name,
				unique: index.unique,
				columns: (
					sqlite.prepare(`PRAGMA index_info("${index.name}")`).all() as Array<
						Record<string, unknown>
					>
				).map((column) => column.name),
			}))
			.sort((a, b) => String(a.name).localeCompare(String(b.name)));
		result[table] = { columns, indexes };
	}
	return result;
}

describe("logs database migrations", () => {
	it("apply in order to the same shape the Drizzle tables render", () => {
		const files = readdirSync(MIGRATIONS_DIR)
			.filter((name) => name.endsWith(".sql"))
			.sort();
		expect(files[0]).toBe("0001_logs_schema.sql");
		const applied = new DatabaseSync(":memory:");
		for (const file of files)
			applied.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
		const rendered = new DatabaseSync(":memory:");
		rendered.exec(renderLogsDbSchema());
		expect(shape(applied)).toEqual(shape(rendered));
	});

	it("carries no foreign keys, because the parent tables stay in the main database", () => {
		const applied = new DatabaseSync(":memory:");
		for (const file of readdirSync(MIGRATIONS_DIR).sort())
			applied.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
		for (const table of LOGS_DB_TABLE_NAMES)
			expect(
				applied.prepare(`PRAGMA foreign_key_list("${table}")`).all(),
			).toEqual([]);
	});
});
