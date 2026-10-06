import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	DrizzleKitCommandError,
	assertMatchingExitCode,
	expectedExitCode,
	parseDrizzleKitResponse,
	requireOk,
	requireNoChanges,
} from "./drizzle-kit-command";
import { finishMigrationGeneration } from "./generate-migration";

describe("Drizzle Kit machine-readable commands", () => {
	it("parses all RC4 response statuses and exit codes", () => {
		const responses = [
			'{"status":"ok","dialect":"sqlite","migration_path":"drizzle/0001_add/migration.sql"}',
			'{"status":"no_changes","dialect":"sqlite"}',
			'{"status":"missing_hints","unresolved":[]}',
			'{"status":"error","error":{"code":"check_error","kind":"conflicts"}}',
		];

		expect(
			responses.map((payload) => {
				const response = parseDrizzleKitResponse(payload);
				return [response.status, expectedExitCode(response)];
			}),
		).toEqual([
			["ok", 0],
			["no_changes", 0],
			["missing_hints", 2],
			["error", 1],
		]);
	});

	it.each(["", "not-json", "{}", '{"status":"future"}'])(
		"fails closed for malformed output %j",
		(payload) => {
			expect(() => parseDrizzleKitResponse(payload)).toThrow(
				DrizzleKitCommandError,
			);
		},
	);

	it("treats explain ok as drift even though Drizzle exits zero", () => {
		const response = parseDrizzleKitResponse(
			'{"status":"ok","dialect":"sqlite","statements":["ALTER TABLE users ADD COLUMN handle text;"],"hints":[]}',
		);

		expect(() => requireNoChanges(response, "Schema check")).toThrow(
			"Schema check detected 1 pending SQL statement(s)",
		);
	});

	// Drizzle Kit returns statement OBJECTS, not strings. `String(statement)`
	// rendered a live drift report as N lines of `[object Object]` — the report
	// fired, and named nothing an operator could act on.
	it("names the SQL when a drift statement is an object", () => {
		const response = parseDrizzleKitResponse(
			'{"status":"ok","dialect":"sqlite","statements":[{"sql":"DROP TABLE work_item_sources;"}],"hints":[]}',
		);

		expect(() =>
			requireNoChanges(response, "Live D1 schema drift check"),
		).toThrow("DROP TABLE work_item_sources;");
	});

	it("falls back to the whole object when no sql field is recognisable", () => {
		const response = parseDrizzleKitResponse(
			'{"status":"ok","dialect":"sqlite","statements":[{"kind":"recreate_table"}],"hints":[]}',
		);

		expect(() => requireNoChanges(response, "Schema check")).toThrow(
			'{"kind":"recreate_table"}',
		);
	});

	it("fails closed when the process exit contradicts the envelope", () => {
		const response = parseDrizzleKitResponse(
			'{"status":"no_changes","dialect":"sqlite"}',
		);

		expect(() => assertMatchingExitCode(response, 1)).toThrow(
			"status no_changes requires exit 0, received 1",
		);
	});

	it("accepts only the explicit no_changes drift result", () => {
		const response = parseDrizzleKitResponse(
			'{"status":"no_changes","dialect":"sqlite"}',
		);
		expect(() => requireNoChanges(response, "Schema check")).not.toThrow();
	});

	it("accepts only the explicit ok migration-history result", () => {
		const ok = parseDrizzleKitResponse('{"status":"ok","dialect":"sqlite"}');
		const noChanges = parseDrizzleKitResponse(
			'{"status":"no_changes","dialect":"sqlite"}',
		);
		expect(() => requireOk(ok, "History check")).not.toThrow();
		expect(() => requireOk(noChanges, "History check")).toThrow(
			"required ok status",
		);
	});

	it("applies the same no_changes-only policy to a schema-snapshot check", () => {
		const noChanges = parseDrizzleKitResponse(
			'{"status":"no_changes","dialect":"sqlite"}',
		);
		const drift = parseDrizzleKitResponse(
			'{"status":"ok","dialect":"sqlite","statements":["CREATE TABLE drifted (id text);"],"hints":[]}',
		);

		expect(() =>
			requireNoChanges(noChanges, "Drizzle schema snapshot check"),
		).not.toThrow();
		expect(() =>
			requireNoChanges(drift, "Drizzle schema snapshot check"),
		).toThrow(
			"Drizzle schema snapshot check detected 1 pending SQL statement(s)",
		);
	});

	it("leaves successful generation and no_changes outcomes unrecorded", () => {
		const sync = vi.fn(() => ({
			version: 1 as const,
			migrations: [{ name: "0000/migration.sql", sha256: "a".repeat(64) }],
		}));
		const ok = parseDrizzleKitResponse(
			'{"status":"ok","dialect":"sqlite","migration_path":"drizzle/0001_add/migration.sql"}',
		);
		const noChanges = parseDrizzleKitResponse(
			'{"status":"no_changes","dialect":"sqlite"}',
		);

		expect(finishMigrationGeneration(ok, "generate", sync)).toEqual([
			"0000/migration.sql",
		]);
		expect(finishMigrationGeneration(noChanges, "generate", sync)).toEqual([
			"0000/migration.sql",
		]);
		expect(sync).toHaveBeenNthCalledWith(1, "draft");
		expect(sync).toHaveBeenNthCalledWith(2, "draft");
	});

	it("never records migrations after missing hints or errors", () => {
		const sync = vi.fn(() => ({ version: 1 as const, migrations: [] }));
		const missing = parseDrizzleKitResponse(
			'{"status":"missing_hints","unresolved":[{"type":"rename_or_create"}]}',
		);
		const error = parseDrizzleKitResponse(
			'{"status":"error","error":{"code":"internal_error","message":"boom"}}',
		);

		expect(() => finishMigrationGeneration(missing, "generate", sync)).toThrow(
			"needs hints",
		);
		expect(() => finishMigrationGeneration(error, "generate", sync)).toThrow(
			"internal_error",
		);
		expect(sync).not.toHaveBeenCalled();
	});

	it("defers integrity recording while a custom migration is edited", () => {
		const sync = vi.fn(() => ({ version: 1 as const, migrations: [] }));
		const ok = parseDrizzleKitResponse(
			'{"status":"ok","dialect":"sqlite","migration_path":"drizzle/0001_custom/migration.sql"}',
		);

		expect(finishMigrationGeneration(ok, "generate", sync)).toEqual([]);
		expect(sync).toHaveBeenCalledWith("draft");
	});

	it("refuses ok without a migration path before draft validation", () => {
		const sync = vi.fn(() => ({ version: 1 as const, migrations: [] }));
		expect(() =>
			finishMigrationGeneration(
				parseDrizzleKitResponse('{"status":"ok","dialect":"sqlite"}'),
				"generate",
				sync,
			),
		).toThrow("without a migration_path");
		expect(sync).not.toHaveBeenCalled();
	});

	it("checks migration integrity after a zero-diff explain", () => {
		const sync = vi.fn(() => ({
			version: 1 as const,
			migrations: [{ name: "0000/migration.sql", sha256: "a".repeat(64) }],
		}));
		const response = parseDrizzleKitResponse(
			'{"status":"no_changes","dialect":"sqlite"}',
		);

		expect(finishMigrationGeneration(response, "check", sync)).toEqual([
			"0000/migration.sql",
		]);
		expect(sync).toHaveBeenCalledWith("check");
	});
});

describe("installed generator CLI review before recording", () => {
	it("isolates actual generation, no_changes, explicit recording and strict check", async () => {
		const dbRoot = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
		);
		const root = mkdtempSync(path.join(tmpdir(), "tedix-generator-review-"));
		try {
			mkdirSync(path.join(root, "scripts"));
			// Relocate byte-exact owning scripts: their DB_ROOT must point at this fixture,
			// not the product manifest. Dependencies remain the installed pinned packages.
			for (const name of readdirSync(path.join(dbRoot, "scripts")))
				if (name.endsWith(".ts") && !name.endsWith(".test.ts"))
					copyFileSync(
						path.join(dbRoot, "scripts", name),
						path.join(root, "scripts", name),
					);
			symlinkSync(
				path.join(dbRoot, "node_modules"),
				path.join(root, "node_modules"),
				"dir",
			);
			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ type: "module" }),
			);
			writeFileSync(
				path.join(root, "drizzle.config.ts"),
				`import {defineConfig} from "drizzle-kit"; export default defineConfig({dialect:"sqlite",schema:"./schema.ts",out:"./drizzle"});`,
			);
			writeFileSync(
				path.join(root, "schema.ts"),
				`import {sqliteTable,text} from "drizzle-orm/sqlite-core"; export const sample=sqliteTable("sample",{id:text().primaryKey()});`,
			);
			// Seed an actual generated and reviewed prefix before exercising the wrapper.
			const run = (script: string, args: string[] = []) =>
				spawnSync("bun", [script, ...args], {
					cwd: root,
					encoding: "utf8",
					env: process.env,
				});
			const initial = run("run", [
				"--silent",
				"drizzle-kit",
				"--",
				"generate",
				"--name",
				"initial",
				"--output",
				"json",
			]);
			expect(initial.status, initial.stderr + initial.stdout).toBe(0);
			const baseline = readdirSync(path.join(root, "drizzle")).filter(
				(name) => name !== "meta",
			)[0]!;
			const manifest = JSON.stringify({
				version: 1,
				migrations: [
					{
						name: baseline + "/migration.sql",
						sha256: createHash("sha256")
							.update(
								readFileSync(
									path.join(root, "drizzle", baseline, "migration.sql"),
								),
							)
							.digest("hex"),
					},
				],
			});
			writeFileSync(path.join(root, "migration-integrity.json"), manifest);
			writeFileSync(
				path.join(root, "schema.ts"),
				`import {sqliteTable,text,integer} from "drizzle-orm/sqlite-core"; export const sample=sqliteTable("sample",{id:text().primaryKey(),count:integer()});`,
			);
			// Migration directory timestamps have second precision. Keep genuine CLI
			// generations distinct without mocking the clock or editing generated names.
			await new Promise((resolve) => setTimeout(resolve, 1100));
			const generated = run("scripts/generate-migration.ts", [
				"--name",
				"review",
			]);
			expect(generated.status, generated.stderr + generated.stdout).toBe(0);
			expect(generated.stdout).toContain("unrecorded draft");
			expect(
				readFileSync(path.join(root, "migration-integrity.json"), "utf8"),
			).toBe(manifest);
			const unchanged = run("scripts/generate-migration.ts");
			expect(unchanged.status, unchanged.stderr + unchanged.stdout).toBe(0);
			expect(unchanged.stdout).toContain("Pending drafts remain unrecorded");
			expect(
				readFileSync(path.join(root, "migration-integrity.json"), "utf8"),
			).toBe(manifest);
			const check = run("scripts/generate-migration.ts", ["--check"]);
			expect(check.status).not.toBe(0);
			expect(check.stderr).toContain("unrecorded");
			const record = run("scripts/migration-integrity.ts", ["--write"]);
			expect(record.status, record.stderr + record.stdout).toBe(0);
			expect(
				JSON.parse(
					readFileSync(path.join(root, "migration-integrity.json"), "utf8"),
				).migrations,
			).toHaveLength(2);
			const final = run("scripts/generate-migration.ts", ["--check"]);
			expect(final.status, final.stderr + final.stdout).toBe(0);
			await new Promise((resolve) => setTimeout(resolve, 1100));
			const custom = run("scripts/generate-migration.ts", [
				"--custom",
				"--name",
				"custom_review",
			]);
			expect(custom.status, custom.stderr + custom.stdout).toBe(0);
			expect(custom.stdout).toContain("unrecorded draft");
			const recordedBytes = readFileSync(
				path.join(root, "migration-integrity.json"),
				"utf8",
			);
			expect(JSON.parse(recordedBytes).migrations).toHaveLength(2);
			// Missing/corrupt history refuses before the installed generator can write.
			writeFileSync(path.join(root, "migration-integrity.json"), "invalid");
			const before = readdirSync(path.join(root, "drizzle"));
			const denied = run("scripts/generate-migration.ts", [
				"--custom",
				"--name",
				"denied",
			]);
			expect(denied.status).not.toBe(0);
			expect(readdirSync(path.join(root, "drizzle"))).toEqual(before);
			rmSync(path.join(root, "migration-integrity.json"));
			expect(
				run("scripts/generate-migration.ts", ["--custom", "--name", "missing"])
					.status,
			).not.toBe(0);
			expect(readdirSync(path.join(root, "drizzle"))).toEqual(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 30000);
});
