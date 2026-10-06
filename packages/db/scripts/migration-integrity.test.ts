import { createHash } from "node:crypto";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
	parseMigrationIntegrityManifest,
	syncMigrationIntegrity,
	reconcileMigrationIntegrity,
	type MigrationIntegrityEntry,
} from "./migration-integrity";

function entry(name: string, sql: string): MigrationIntegrityEntry {
	return {
		name,
		sha256: createHash("sha256").update(sql).digest("hex"),
	};
}

describe("migration integrity", () => {
	const first = entry("20260801000000_first/migration.sql", "SELECT 1;");
	const second = entry("20260802000000_second/migration.sql", "SELECT 2;");

	it("bootstraps and appends history only in write mode", () => {
		expect(
			reconcileMigrationIntegrity([first], undefined, "write", true),
		).toEqual({
			version: 1,
			migrations: [first],
		});
		expect(() =>
			reconcileMigrationIntegrity([first], undefined, "write"),
		).toThrow("cannot be reconstructed");
		expect(
			reconcileMigrationIntegrity(
				[first, second],
				{ version: 1, migrations: [first] },
				"write",
			),
		).toEqual({ version: 1, migrations: [first, second] });
	});

	it("rejects changed or reordered applied SQL", () => {
		expect(() =>
			reconcileMigrationIntegrity(
				[entry(first.name, "SELECT 9;")],
				{ version: 1, migrations: [first] },
				"check",
			),
		).toThrow("applied migration SQL changed");
		expect(() =>
			reconcileMigrationIntegrity(
				[second, first],
				{ version: 1, migrations: [first, second] },
				"check",
			),
		).toThrow("not append-only");
	});

	it("fails check mode when a migration is unrecorded", () => {
		expect(() =>
			reconcileMigrationIntegrity(
				[first, second],
				{ version: 1, migrations: [first] },
				"check",
			),
		).toThrow("unrecorded migration");
	});

	it("draft mode permits only an unrecorded append tail and never bootstraps", () => {
		const manifest = { version: 1 as const, migrations: [first] };
		expect(
			reconcileMigrationIntegrity([first, second], manifest, "draft"),
		).toEqual(manifest);
		expect(() => reconcileMigrationIntegrity([], manifest, "draft")).toThrow(
			"removed",
		);
		expect(() =>
			reconcileMigrationIntegrity([second, first], manifest, "draft"),
		).toThrow("not append-only");
		expect(() =>
			reconcileMigrationIntegrity(
				[entry(first.name, "changed")],
				manifest,
				"draft",
			),
		).toThrow("SQL changed");
		expect(() =>
			reconcileMigrationIntegrity([first], undefined, "draft", true),
		).toThrow("missing");
	});

	it("parses only the strict versioned shape", () => {
		expect(
			parseMigrationIntegrityManifest(
				JSON.stringify({ version: 1, migrations: [first] }),
			),
		).toEqual({ version: 1, migrations: [first] });
		expect(() =>
			parseMigrationIntegrityManifest(
				JSON.stringify({ version: 2, migrations: [] }),
			),
		).toThrow("version 1");
	});
});

describe("first recording on disk", () => {
	function fixture(
		run: (dir: string, manifestPath: string, migration: string) => void,
	) {
		const root = mkdtempSync(path.join(tmpdir(), "tedix-integrity-"));
		const dir = path.join(root, "drizzle");
		const migration = path.join(dir, "20261006000000_review");
		mkdirSync(migration, { recursive: true });
		writeFileSync(
			path.join(migration, "migration.sql"),
			"CREATE TABLE sample (id text);",
		);
		writeFileSync(path.join(migration, "snapshot.json"), "{}");
		const manifestPath = path.join(root, "migration-integrity.json");
		writeFileSync(manifestPath, JSON.stringify({ version: 1, migrations: [] }));
		try {
			run(dir, manifestPath, migration);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
	it("keeps pending drafts unrecorded, rejects missing/corrupt history and changed recorded bytes", () =>
		fixture((drizzleDir, manifestPath, migration) => {
			const options = { drizzleDir, manifestPath };
			const original = readFileSync(manifestPath, "utf8");
			expect(syncMigrationIntegrity("draft", options).migrations).toEqual([]);
			expect(readFileSync(manifestPath, "utf8")).toBe(original);
			expect(() => syncMigrationIntegrity("check", options)).toThrow(
				"unrecorded",
			);
			writeFileSync(manifestPath, "bad");
			expect(() => syncMigrationIntegrity("draft", options)).toThrow(
				"malformed",
			);
			rmSync(manifestPath);
			expect(() =>
				syncMigrationIntegrity("draft", { ...options, allowBootstrap: true }),
			).toThrow("missing");
			expect(existsSync(manifestPath)).toBe(false);
			writeFileSync(manifestPath, original);
			const recorded = syncMigrationIntegrity("write", options);
			expect(recorded.migrations).toEqual([
				entry(
					"20261006000000_review/migration.sql",
					"CREATE TABLE sample (id text);",
				),
			]);
			writeFileSync(
				path.join(migration, "migration.sql"),
				"CREATE TABLE changed (id text);",
			);
			for (const mode of ["draft", "check", "write"] as const)
				expect(() => syncMigrationIntegrity(mode, options)).toThrow(
					"SQL changed",
				);
		}));
	it("runs destructive review and unconditional FK checks before the first hash", () =>
		fixture((drizzleDir, manifestPath, migration) => {
			const options = { drizzleDir, manifestPath };
			const original = readFileSync(manifestPath, "utf8");
			const sql =
				"PRAGMA foreign_keys=OFF; CREATE TABLE sample(id text); DROP TABLE sample;";
			writeFileSync(path.join(migration, "migration.sql"), sql);
			expect(() => syncMigrationIntegrity("write", options)).toThrow(
				"destructive DDL",
			);
			expect(readFileSync(manifestPath, "utf8")).toBe(original);
			const directive =
				"-- tedix: destructive-reviewed Work-Item: 00000000-0000-4000-8000-000000000001\n";
			writeFileSync(path.join(migration, "migration.sql"), directive + sql);
			expect(() => syncMigrationIntegrity("write", options)).toThrow(
				"remove `PRAGMA foreign_keys=OFF`",
			);
			expect(readFileSync(manifestPath, "utf8")).toBe(original);
			const reviewed =
				directive + "CREATE TABLE sample(id text); DROP TABLE sample;";
			writeFileSync(path.join(migration, "migration.sql"), reviewed);
			expect(
				syncMigrationIntegrity("write", options).migrations[0]?.sha256,
			).toBe(entry("unused", reviewed).sha256);
		}));
	it("requires snapshots even for redirected SQL-only fixtures and explicit bootstrap", () =>
		fixture((drizzleDir, manifestPath, migration) => {
			rmSync(path.join(migration, "snapshot.json"));
			const original = readFileSync(manifestPath, "utf8");
			expect(() =>
				syncMigrationIntegrity("write", { drizzleDir, manifestPath }),
			).toThrow("missing");
			expect(readFileSync(manifestPath, "utf8")).toBe(original);
			rmSync(manifestPath);
			expect(() =>
				syncMigrationIntegrity("write", {
					drizzleDir,
					manifestPath,
					allowBootstrap: true,
				}),
			).toThrow("missing");
			expect(existsSync(manifestPath)).toBe(false);
		}));
	it("rejects parser and cascade hazards without adopting a pending tail", () =>
		fixture((drizzleDir, manifestPath, migration) => {
			const original = readFileSync(manifestPath, "utf8");
			writeFileSync(
				path.join(migration, "migration.sql"),
				"CREATE TABLE parent(id text PRIMARY KEY); CREATE TABLE child(id text, parent_id text REFERENCES parent(id) ON DELETE CASCADE);",
			);
			const drop = path.join(drizzleDir, "20261006000001_drop");
			mkdirSync(drop);
			writeFileSync(
				path.join(drop, "migration.sql"),
				"-- tedix: destructive-reviewed Work-Item: 00000000-0000-4000-8000-000000000001\nDROP TABLE parent;",
			);
			writeFileSync(path.join(drop, "snapshot.json"), "{}");
			expect(() =>
				syncMigrationIntegrity("write", { drizzleDir, manifestPath }),
			).toThrow("CASCADE");
			expect(readFileSync(manifestPath, "utf8")).toBe(original);
			rmSync(drop, { recursive: true });
			writeFileSync(
				path.join(migration, "migration.sql"),
				"CREATE TABLE sample(id text); CREATE TRIGGER bad AFTER INSERT ON sample BEGIN SELECT CASE WHEN NEW.id IS NULL THEN 1 ELSE 0 END; END;",
			);
			expect(() =>
				syncMigrationIntegrity("write", { drizzleDir, manifestPath }),
			).toThrow("parser incompatibility");
			expect(readFileSync(manifestPath, "utf8")).toBe(original);
		}));
});
