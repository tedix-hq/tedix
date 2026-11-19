import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createMigratedSqlite } from "./migrated-sqlite";

const root = new URL("../../drizzle/", import.meta.url);
const [base, next, last, beforeMigration] = readdirSync(root)
	.filter((name) => /^\d{14}_/.test(name))
	.sort() as [string, string, string, string, ...string[]];
const names = [base, next, last];
const schema = (sqlite: DatabaseSync) =>
	sqlite
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
		)
		.all();

const transformMigration = (sql: string, name: string) =>
	`${sql}\n${name === base ? "CREATE TABLE transform_order(name TEXT);" : ""}\nINSERT INTO transform_order(name) VALUES('${name}');`;

describe("migrated SQLite template", () => {
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
			createMigratedSqlite({ beforeMigration, transformMigration }),
			createMigratedSqlite({ beforeMigration, transformMigration }),
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
		const replay = new DatabaseSync(":memory:");
		try {
			replay.exec("PRAGMA foreign_keys=OFF");
			for (const name of names)
				replay.exec(
					readFileSync(new URL(`${name}/migration.sql`, root), "utf8"),
				);
			expect(schema(sqlite)).toEqual(schema(replay));
		} finally {
			replay.close();
		}
		expect(sqlite.prepare("PRAGMA foreign_keys").get()).toEqual({
			foreign_keys: 0,
		});
	});
	it("reuses an unchanged prefix and invalidates changed suffix SQL", () => {
		createMigratedSqlite({ beforeMigration: next }).close();
		const marker = `probe_${Date.now()}`;
		const exec = vi.spyOn(DatabaseSync.prototype, "exec");
		for (const value of [1, 2]) {
			const options = {
				beforeMigration,
				transformMigration: (sql: string, name: string) =>
					sql +
					(name === next
						? `CREATE TABLE ${marker}(value INTEGER); INSERT INTO ${marker} VALUES (${value});`
						: name === last
							? `UPDATE ${marker} SET value=value+10;`
							: ""),
			};
			for (let copy = 0; copy < 2; copy++) {
				const sqlite = createMigratedSqlite(options);
				expect(exec).not.toHaveBeenCalledWith(
					readFileSync(new URL(`${names[0]}/migration.sql`, root), "utf8"),
				);
				expect(sqlite.prepare(`SELECT value FROM ${marker}`).get()).toEqual({
					value: value + 10,
				});
			}
		}
		exec.mockRestore();
	});
});
