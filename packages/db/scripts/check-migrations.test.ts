import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { readMigrationManifest } from "./check-live-migration-ledger";
import { splitMigrationStatements } from "./expected-schema";
import {
	APPLIED_BASELINE,
	assertNoLegacyMigrationFiles,
	assertSnapshotPerMigration,
	checkMigrations,
	inspectMigration,
	isAppliedHistory,
} from "./check-migrations";

const snapshotDirectories: string[] = [];

function snapshotFixture(...withSnapshot: readonly string[]): {
	directory: string;
	files: string[];
} {
	const directory = mkdtempSync(path.join(tmpdir(), "tedix-snapshot-gate-"));
	snapshotDirectories.push(directory);
	const names = ["20260101000000_a", "20260102000000_b", "20260103000000_c"];
	for (const name of names) {
		mkdirSync(path.join(directory, name));
		writeFileSync(path.join(directory, name, "migration.sql"), "SELECT 1;");
		if (withSnapshot.includes(name)) {
			writeFileSync(path.join(directory, name, "snapshot.json"), "{}");
		}
	}
	return { directory, files: names.map((name) => `${name}/migration.sql`) };
}

afterAll(() => {
	for (const directory of snapshotDirectories) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("snapshot-per-migration gate", () => {
	it("accepts a snapshot beside every migration", () => {
		const { directory, files } = snapshotFixture(
			"20260101000000_a",
			"20260102000000_b",
			"20260103000000_c",
		);
		expect(() => assertSnapshotPerMigration(directory, files)).not.toThrow();
	});

	it("rejects a hole in the chain and names it", () => {
		const { directory, files } = snapshotFixture(
			"20260101000000_a",
			"20260103000000_c",
		);
		expect(() => assertSnapshotPerMigration(directory, files)).toThrow(
			/missing: 20260102000000_b\/snapshot\.json/,
		);
	});

	it("rejects a migration tree with no snapshots", () => {
		const { directory, files } = snapshotFixture();
		expect(() => assertSnapshotPerMigration(directory, files)).toThrow(
			/missing: 20260101000000_a\/snapshot\.json/,
		);
	});
});

describe("reconstructed behavioral-evaluation snapshots", () => {
	it("matches the SQL state at both missing boundaries and preserves the FK successor", () => {
		const dbRoot = path.resolve(import.meta.dirname, "..");
		const migrationNames = [
			"20260922185847_tenant-behavioral-evals",
			"20260922190904_tenant-behavioral-evals-cas",
			"20260922192237_tenant-behavioral-evals-fks",
		];
		const tables = [
			"tenant_behavioral_eval_assertion_results",
			"tenant_behavioral_eval_case_runs",
			"tenant_behavioral_eval_definitions",
			"tenant_behavioral_eval_revisions",
			"tenant_behavioral_eval_runs",
		];
		const database = new DatabaseSync(":memory:");
		let previousId = "26a5499c-cbea-43c4-beb6-02894bc89f93";
		try {
			database.exec("PRAGMA foreign_keys = OFF");
			for (const migration of readMigrationManifest().migrations) {
				const sql = readFileSync(
					path.join(dbRoot, "drizzle", migration.name),
					"utf8",
				);
				for (const statement of splitMigrationStatements(sql)) {
					database.exec(statement);
				}
				const folder = migration.name.replace(/\/migration\.sql$/, "");
				if (!migrationNames.includes(folder)) continue;
				const snapshot = JSON.parse(
					readFileSync(
						path.join(dbRoot, "drizzle", folder, "snapshot.json"),
						"utf8",
					),
				) as {
					id: string;
					prevIds: string[];
					ddl: Array<{
						entityType: string;
						table?: string;
						name: string;
						type?: string;
						notNull?: boolean;
						columns?: string[];
						columnsTo?: string[];
						tableTo?: string;
						onDelete?: string;
					}>;
				};
				expect(snapshot.prevIds).toEqual([previousId]);
				previousId = snapshot.id;
				for (const table of tables) {
					const columns = database
						.prepare(`PRAGMA table_info("${table}")`)
						.all() as Array<{ name: string; type: string; notnull: number }>;
					const expectedColumns = snapshot.ddl
						.filter(
							(entry) =>
								entry.entityType === "columns" && entry.table === table,
						)
						.map((entry) => ({
							name: entry.name,
							type: entry.type?.toLowerCase(),
							notNull: entry.notNull,
						}))
						.sort((left, right) => left.name.localeCompare(right.name));
					expect(
						columns
							.map((column) => ({
								name: column.name,
								type: column.type.toLowerCase(),
								notNull: column.notnull === 1,
							}))
							.sort((left, right) => left.name.localeCompare(right.name)),
					).toEqual(expectedColumns);
					const indexes = database
						.prepare(`PRAGMA index_list("${table}")`)
						.all() as Array<{ name: string }>;
					expect(
						indexes
							.map((index) => index.name)
							.filter((name) => !name.startsWith("sqlite_autoindex"))
							.sort(),
					).toEqual(
						snapshot.ddl
							.filter(
								(entry) =>
									entry.entityType === "indexes" && entry.table === table,
							)
							.map((entry) => entry.name)
							.sort(),
					);
					const foreignKeys = database
						.prepare(`PRAGMA foreign_key_list("${table}")`)
						.all() as Array<{ id: number }>;
					expect(new Set(foreignKeys.map((key) => key.id)).size).toBe(
						snapshot.ddl.filter(
							(entry) => entry.entityType === "fks" && entry.table === table,
						).length,
					);
				}
				if (folder === migrationNames[2]) break;
			}
		} finally {
			database.close();
		}
	});
});

describe("D1 migration safety review", () => {
	it("rejects the retired flat Wrangler projection", () => {
		expect(() =>
			assertNoLegacyMigrationFiles([
				"0029_20260802180112_soft_scalphunter.sql",
			]),
		).toThrow(/Legacy flat D1 migration projection is forbidden/);
		expect(() => assertNoLegacyMigrationFiles([])).not.toThrow();
	});

	it("accepts additive migrations without an override", () => {
		expect(
			inspectMigration(
				"0001_add_column.sql",
				"ALTER TABLE skill_runs ADD COLUMN attempt_count INTEGER;",
			),
		).toEqual({
			destructive: [],
			remoteIncompatible: [],
			reviewed: false,
		});
	});

	it("detects table recreation and row deletion", () => {
		const result = inspectMigration(
			"0002_rebuild.sql",
			"CREATE TABLE __new_skill_runs (id TEXT); DELETE FROM skill_runs; DROP TABLE skill_runs;",
		);
		expect(result.destructive).toEqual([
			"DROP TABLE",
			"table recreation",
			"row deletion",
		]);
		expect(result.remoteIncompatible).toEqual([]);
		expect(result.reviewed).toBe(false);
	});

	it("recognizes an explicit Work Item review directive", () => {
		const result = inspectMigration(
			"0003_reviewed.sql",
			"-- tedix: destructive-reviewed Work-Item: 00000000-0000-4000-8000-000000000000\nDROP TABLE old_table;",
		);
		expect(result.destructive).toEqual(["DROP TABLE"]);
		expect(result.remoteIncompatible).toEqual([]);
		expect(result.reviewed).toBe(true);
	});

	it("rejects nested CASE expressions inside D1 trigger programs", () => {
		const result = inspectMigration(
			"0004_trigger.sql",
			[
				"CREATE TRIGGER advance_revision",
				"AFTER INSERT ON benchmark_cases",
				"BEGIN",
				"\tSELECT CASE WHEN changes() != 1",
				"\t\tTHEN RAISE(ABORT, 'revision CAS failed')",
				"\tEND;",
				"END;--> statement-breakpoint",
			].join("\n"),
		);

		expect(result.remoteIncompatible).toEqual([
			"nested CASE inside CREATE TRIGGER",
		]);
	});

	it("accepts the D1-compatible trigger CAS form", () => {
		const result = inspectMigration(
			"0005_trigger.sql",
			[
				"CREATE TRIGGER advance_revision",
				"AFTER INSERT ON benchmark_cases",
				"BEGIN",
				"\tSELECT RAISE(ABORT, 'revision CAS failed')",
				"\tWHERE changes() != 1;",
				"END;--> statement-breakpoint",
			].join("\n"),
		);

		expect(result.remoteIncompatible).toEqual([]);
	});

	it("rejects simple CASE expressions but ignores quoted CASE text", () => {
		const result = inspectMigration(
			"0006_trigger.sql",
			[
				"CREATE TRIGGER classify_revision",
				"AFTER INSERT ON benchmark_cases",
				"BEGIN",
				"\tSELECT CASE changes() WHEN 1 THEN 'CASE is fine in text' ELSE 'bad' END;",
				"END;--> statement-breakpoint",
			].join("\n"),
		);

		expect(result.remoteIncompatible).toEqual([
			"nested CASE inside CREATE TRIGGER",
		]);
	});

	it("does not confuse CASE text in a trigger error message with SQL", () => {
		const result = inspectMigration(
			"0007_trigger.sql",
			[
				"CREATE TRIGGER guard_revision",
				"AFTER INSERT ON benchmark_cases",
				"BEGIN",
				"\tSELECT RAISE(ABORT, 'CASE expressions are unsupported here');",
				"END;--> statement-breakpoint",
			].join("\n"),
		);

		expect(result.remoteIncompatible).toEqual([]);
	});
});

describe("applied baseline", () => {
	const REVIEWED =
		"-- tedix: destructive-reviewed Work-Item: 00000000-0000-4000-8000-000000000000";
	const CASCADE_REVIEWED =
		"-- tedix: cascade-reviewed Work-Item: 00000000-0000-4000-8000-000000000000 Table: parent";
	const PARENT_AND_CHILD = [
		"CREATE TABLE `parent` (`id` text PRIMARY KEY);--> statement-breakpoint",
		"CREATE TABLE `child` (`id` text PRIMARY KEY, `parent_id` text REFERENCES `parent`(`id`) ON DELETE CASCADE);",
	].join("\n");

	function chain(dropSql: string): string {
		const directory = mkdtempSync(path.join(tmpdir(), "tedix-baseline-gate-"));
		snapshotDirectories.push(directory);
		for (const [name, sql] of [
			["20260101000000_tables", PARENT_AND_CHILD],
			["20260102000000_drop_parent", dropSql],
		] as const) {
			mkdirSync(path.join(directory, name));
			writeFileSync(path.join(directory, name, "migration.sql"), sql);
		}
		return directory;
	}

	const DROP = "DROP TABLE `parent`;";
	const PRAGMA = "PRAGMA foreign_keys=OFF;--> statement-breakpoint\nSELECT 1;";

	it("judges a destructive migration after the baseline", () => {
		const options = { appliedBaseline: "20260101000000_tables" };
		expect(() => checkMigrations(chain(DROP), options)).toThrow(
			/destructive DDL \(DROP TABLE\) requires/,
		);
		expect(() =>
			checkMigrations(chain(`${REVIEWED}\n${DROP}`), options),
		).toThrow(/cascade-reviewed Work-Item: <uuid> Table: parent/);
		expect(() =>
			checkMigrations(chain(`${REVIEWED}\n${PRAGMA}`), options),
		).toThrow(/remove `PRAGMA foreign_keys=OFF`/);
	});

	it("accepts review directives after the baseline", () => {
		expect(() =>
			checkMigrations(chain(`${REVIEWED}\n${CASCADE_REVIEWED}\n${DROP}`), {
				appliedBaseline: "20260101000000_tables",
			}),
		).not.toThrow();
	});

	it("does not re-review migrations at or before the baseline", () => {
		const options = { appliedBaseline: "20260102000000_drop_parent" };
		expect(() => checkMigrations(chain(DROP), options)).not.toThrow();
		expect(() => checkMigrations(chain(PRAGMA), options)).not.toThrow();
	});

	it("still rejects D1-incompatible SQL at or before the baseline", () => {
		const trigger = [
			"CREATE TRIGGER t AFTER INSERT ON parent BEGIN",
			"\tSELECT CASE WHEN 1 THEN 1 END;",
			"END;",
		].join("\n");
		expect(() =>
			checkMigrations(chain(trigger), {
				appliedBaseline: "20260102000000_drop_parent",
			}),
		).toThrow(/D1 remote migration parser incompatibility/);
	});

	it("compares by timestamp and names a migration present in the chain", () => {
		expect(isAppliedHistory(`${APPLIED_BASELINE}/migration.sql`)).toBe(true);
		expect(isAppliedHistory("20990101000000_future/migration.sql")).toBe(false);
		expect(isAppliedHistory("20260101000000_old/migration.sql", null)).toBe(
			false,
		);
		expect(
			existsSync(
				path.resolve(import.meta.dirname, "../drizzle", APPLIED_BASELINE),
			),
		).toBe(true);
	});
});
