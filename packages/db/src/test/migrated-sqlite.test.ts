import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "./migrated-sqlite";

const root = new URL("../../drizzle/", import.meta.url);
const names = readdirSync(root).sort();
const schema = (sqlite: DatabaseSync) =>
	sqlite
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
		)
		.all();

// Fresh replays are the baseline these tests compare against; build them once
// at collection, not inside a timed test on a shared machine.
const freshReplay = (() => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=ON");
	for (const name of names)
		sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), "utf8"));
	return sqlite;
})();

const beforeMigration = "20260920072429_provider_execution_cost_provenance";
const freshPrefixReplay = (() => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	for (const name of names.filter((name) => name < beforeMigration))
		sqlite.exec(readFileSync(new URL(`${name}/migration.sql`, root), "utf8"));
	return sqlite;
})();

const transformMigration = (sql: string, name: string) =>
	`${sql}\n${name === names[0] ? "CREATE TABLE transform_order(name TEXT);" : ""}\nINSERT INTO transform_order(name) VALUES('${name}');`;

// The transformed and prefix variants build at collection too.
createMigratedSqlite({ transformMigration }).close();
createMigratedSqlite({ beforeMigration, foreignKeys: false }).close();

describe("migrated SQLite template", () => {
	it("preserves every table, index and trigger from a fresh ordered replay", () => {
		const copy = createMigratedSqlite();
		expect(schema(copy)).toEqual(schema(freshReplay));
		for (const type of ["table", "index", "trigger"])
			expect(schema(copy).some((row) => row.type === type)).toBe(true);
	});

	it("enables and enforces foreign keys on each copy", () => {
		for (const sqlite of [createMigratedSqlite(), createMigratedSqlite()]) {
			expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({
				foreign_keys: 1,
			});
			expect(() =>
				sqlite.exec(
					"INSERT INTO apps(id, organization_id, name, slug) VALUES('orphan','missing','App','app')",
				),
			).toThrow(/FOREIGN KEY/);
		}
	});

	it("isolates row, schema and pragma mutations from other copies and the template", () => {
		const first = createMigratedSqlite();
		const second = createMigratedSqlite();
		first.exec(
			"INSERT INTO organizations(id,name,slug) VALUES('fixture','Fixture','fixture')",
		);
		first.exec("CREATE TABLE copy_only(id TEXT)");
		first.exec("PRAGMA foreign_keys=OFF");
		for (const sqlite of [second, createMigratedSqlite()]) {
			expect(sqlite.location()).toBeNull();
			expect(
				sqlite.prepare("SELECT id FROM organizations WHERE id='fixture'").all(),
			).toEqual([]);
			expect(
				sqlite
					.prepare("SELECT name FROM sqlite_master WHERE name='copy_only'")
					.all(),
			).toEqual([]);
			expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({
				foreign_keys: 1,
			});
		}
	});

	it("keeps transformed ledgers separate while preserving migration order", () => {
		for (const sqlite of [
			createMigratedSqlite({ transformMigration }),
			createMigratedSqlite({ transformMigration }),
		])
			expect(
				sqlite.prepare("SELECT name FROM transform_order ORDER BY rowid").all(),
			).toEqual(names.map((name) => ({ name })));
		expect(() =>
			createMigratedSqlite().prepare("SELECT * FROM transform_order"),
		).toThrow(/no such table/);
	});

	it("supports a historical prefix and explicit foreign key opt-out", () => {
		const sqlite = createMigratedSqlite({
			beforeMigration,
			foreignKeys: false,
		});
		expect(schema(sqlite)).toEqual(schema(freshPrefixReplay));
		expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({
			foreign_keys: 0,
		});
		expect(() =>
			sqlite.prepare("SELECT * FROM provider_execution_attempts"),
		).toThrow(/no such table/);
	});
});
