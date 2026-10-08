import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const DB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(DB_ROOT, "drizzle");
const MIGRATION_PREFIX = "20261008210408_";
const migrationNames = readdirSync(MIGRATIONS_DIR)
	.filter((name) => /^\d{14}_/.test(name))
	.sort();

function applyMigration(sqlite: DatabaseSync, name: string): void {
	sqlite.exec(
		readFileSync(
			join(MIGRATIONS_DIR, name, "migration.sql"),
			"utf8",
		).replaceAll("--> statement-breakpoint", ""),
	);
}

function migrationName(): string {
	const name = migrationNames.find((n) => n.startsWith(MIGRATION_PREFIX));
	if (!name) throw new Error(`Migration ${MIGRATION_PREFIX} not found`);
	return name;
}

function databaseBeforeRepair(): DatabaseSync {
	const sqlite = new DatabaseSync(":memory:");
	const target = migrationName();
	for (const name of migrationNames) {
		if (name === target) break;
		applyMigration(sqlite, name);
	}
	// Rows are inserted without their parents; only the column rewrite matters.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	return sqlite;
}

function insertTool(
	sqlite: DatabaseSync,
	table: "app_catalog_mcp_tools" | "app_tools",
	id: string,
	annotations: string | null,
	meta: string | null,
): void {
	const required = sqlite
		.prepare(
			`SELECT name FROM pragma_table_info('${table}')
			 WHERE "notnull" = 1 AND dflt_value IS NULL`,
		)
		.all()
		.map((row) => String(row.name))
		.filter((name) => !["id", "annotations", "meta"].includes(name));
	const columns = ["id", "annotations", "meta", ...required];
	const values = [id, annotations, meta, ...required.map(() => `${id}-x`)];
	sqlite
		.prepare(
			`INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")})
			 VALUES (${columns.map(() => "?").join(", ")})`,
		)
		.run(...values);
}

function readTool(
	sqlite: DatabaseSync,
	table: string,
	id: string,
): { annotations: unknown; meta: unknown } {
	const row = sqlite
		.prepare(`SELECT annotations, meta FROM ${table} WHERE id = ?`)
		.get(id) as { annotations: string | null; meta: string | null };
	return {
		annotations: row.annotations === null ? null : JSON.parse(row.annotations),
		meta: row.meta === null ? null : JSON.parse(row.meta),
	};
}

describe("sanitize tool annotations migration", () => {
	for (const table of ["app_catalog_mcp_tools", "app_tools"] as const) {
		it(`keeps only ToolAnnotations keys in ${table} and is idempotent`, () => {
			const sqlite = databaseBeforeRepair();
			insertTool(
				sqlite,
				table,
				"slides",
				JSON.stringify({
					title: "Render slides",
					readOnlyHint: false,
					destructiveHint: "yes",
					cost: { usd: 0.02, unit: "call", note: "per render" },
					"x-openai-isConsequential": true,
					returnDirect: false,
				}),
				JSON.stringify({ audience: ["user"] }),
			);
			insertTool(
				sqlite,
				table,
				"only-extras",
				JSON.stringify({ progressHint: 3, tags: ["a"], nothing: null }),
				null,
			);
			insertTool(
				sqlite,
				table,
				"clean",
				JSON.stringify({ readOnlyHint: true }),
				null,
			);
			insertTool(sqlite, table, "array", JSON.stringify(["x"]), null);
			insertTool(sqlite, table, "absent", null, null);

			applyMigration(sqlite, migrationName());

			expect(readTool(sqlite, table, "slides")).toEqual({
				annotations: { title: "Render slides", readOnlyHint: false },
				meta: {
					audience: ["user"],
					"tedix/upstreamAnnotations": {
						destructiveHint: "yes",
						cost: { usd: 0.02, unit: "call", note: "per render" },
						"x-openai-isConsequential": true,
						returnDirect: false,
					},
				},
			});
			expect(readTool(sqlite, table, "only-extras")).toEqual({
				annotations: null,
				meta: {
					"tedix/upstreamAnnotations": {
						progressHint: 3,
						tags: ["a"],
						nothing: null,
					},
				},
			});
			expect(readTool(sqlite, table, "clean")).toEqual({
				annotations: { readOnlyHint: true },
				meta: null,
			});
			expect(readTool(sqlite, table, "array")).toEqual({
				annotations: null,
				meta: null,
			});
			expect(readTool(sqlite, table, "absent")).toEqual({
				annotations: null,
				meta: null,
			});

			const snapshot = sqlite
				.prepare(`SELECT id, annotations, meta FROM ${table} ORDER BY id`)
				.all();
			applyMigration(sqlite, migrationName());
			expect(
				sqlite
					.prepare(`SELECT id, annotations, meta FROM ${table} ORDER BY id`)
					.all(),
			).toEqual(snapshot);
		});
	}
});
