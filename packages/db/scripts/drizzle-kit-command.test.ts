import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
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
	// Every installed-CLI invocation below is fixture setup, not the verdict:
	// the spawns run once at collection so subprocess wall-clock on a shared
	// machine cannot decide a timed test.
	const review = (() => {
		const dbRoot = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
		);
		const fixture = mkdtempSync(path.join(tmpdir(), "tedix-generator-review-"));
		const root = path.join(fixture, "packages/db");
		const out: {
			error?: unknown;
			initial?: { status: number | null; stdout: string; stderr: string };
			manifest?: string;
			generated?: { status: number | null; stdout: string; stderr: string };
			manifestAfterGenerate?: string;
			unchanged?: { status: number | null; stdout: string; stderr: string };
			manifestAfterUnchanged?: string;
			check?: { status: number | null; stdout: string; stderr: string };
			record?: { status: number | null; stdout: string; stderr: string };
			migrationsAfterRecord?: { name: string }[];
			final?: { status: number | null; stdout: string; stderr: string };
			custom?: { status: number | null; stdout: string; stderr: string };
			recordedBytes?: string;
			drizzleBeforeDenied?: string[];
			denied?: { status: number | null; stdout: string; stderr: string };
			drizzleAfterDenied?: string[];
			missing?: { status: number | null; stdout: string; stderr: string };
			drizzleAfterMissing?: string[];
		} = {};
		try {
			mkdirSync(path.join(root, "scripts"), { recursive: true });
			for (const name of [
				"oss/git-env.ts",
				"ci/push-range-selection.mjs",
				"lib/remote-d1.ts",
			]) {
				const destination = path.join(fixture, "scripts", name);
				mkdirSync(path.dirname(destination), { recursive: true });
				copyFileSync(path.resolve(dbRoot, "../../scripts", name), destination);
			}
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
			const run = (script: string, args: string[] = []) => {
				const result = spawnSync("bun", [script, ...args], {
					cwd: root,
					encoding: "utf8",
					env: process.env,
				});
				return {
					status: result.status,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
				};
			};
			out.initial = run("run", [
				"--silent",
				"drizzle-kit",
				"--",
				"generate",
				"--name",
				"initial",
				"--output",
				"json",
			]);
			const generatedBaseline = readdirSync(path.join(root, "drizzle")).filter(
				(name) => name !== "meta",
			)[0]!;
			// Distinct fixture-local names replace wall-clock sleeps without changing
			// the generated SQL or snapshot identity chain.
			const baseline = "20000101000000_initial";
			renameSync(
				path.join(root, "drizzle", generatedBaseline),
				path.join(root, "drizzle", baseline),
			);
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
			out.manifest = manifest;
			writeFileSync(path.join(root, "migration-integrity.json"), manifest);
			writeFileSync(
				path.join(root, "schema.ts"),
				`import {sqliteTable,text,integer} from "drizzle-orm/sqlite-core"; export const sample=sqliteTable("sample",{id:text().primaryKey(),count:integer()});`,
			);
			out.generated = run("scripts/generate-migration.ts", [
				"--name",
				"review",
			]);
			const generatedReview = readdirSync(path.join(root, "drizzle")).find(
				(name) => name !== "meta" && name !== baseline,
			);
			if (generatedReview) {
				renameSync(
					path.join(root, "drizzle", generatedReview),
					path.join(root, "drizzle", "20000101000001_review"),
				);
			}
			out.manifestAfterGenerate = readFileSync(
				path.join(root, "migration-integrity.json"),
				"utf8",
			);
			out.unchanged = run("scripts/generate-migration.ts");
			out.manifestAfterUnchanged = readFileSync(
				path.join(root, "migration-integrity.json"),
				"utf8",
			);
			out.check = run("scripts/generate-migration.ts", ["--check"]);
			out.record = run("scripts/migration-integrity.ts", ["--write"]);
			out.migrationsAfterRecord = JSON.parse(
				readFileSync(path.join(root, "migration-integrity.json"), "utf8"),
			).migrations;
			out.final = run("scripts/generate-migration.ts", ["--check"]);
			out.custom = run("scripts/generate-migration.ts", [
				"--custom",
				"--name",
				"custom_review",
			]);
			out.recordedBytes = readFileSync(
				path.join(root, "migration-integrity.json"),
				"utf8",
			);
			// Missing/corrupt history refuses before the installed generator can write.
			writeFileSync(path.join(root, "migration-integrity.json"), "invalid");
			out.drizzleBeforeDenied = readdirSync(path.join(root, "drizzle"));
			out.denied = run("scripts/generate-migration.ts", [
				"--custom",
				"--name",
				"denied",
			]);
			out.drizzleAfterDenied = readdirSync(path.join(root, "drizzle"));
			rmSync(path.join(root, "migration-integrity.json"));
			out.missing = run("scripts/generate-migration.ts", [
				"--custom",
				"--name",
				"missing",
			]);
			out.drizzleAfterMissing = readdirSync(path.join(root, "drizzle"));
		} catch (error) {
			out.error = error;
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
		return out;
	})();

	it("isolates actual generation, no_changes, explicit recording and strict check", () => {
		expect(
			review.initial?.status,
			(review.initial?.stderr ?? "") + (review.initial?.stdout ?? ""),
		).toBe(0);
		expect(
			review.generated?.status,
			(review.generated?.stderr ?? "") + (review.generated?.stdout ?? ""),
		).toBe(0);
		expect(review.generated?.stdout).toContain("unrecorded draft");
		expect(review.manifestAfterGenerate).toBe(review.manifest);
		expect(
			review.unchanged?.status,
			(review.unchanged?.stderr ?? "") + (review.unchanged?.stdout ?? ""),
		).toBe(0);
		expect(review.unchanged?.stdout).toContain(
			"Pending drafts remain unrecorded",
		);
		expect(review.manifestAfterUnchanged).toBe(review.manifest);
		expect(review.check?.status).not.toBe(0);
		expect(review.check?.stderr).toContain("unrecorded");
		expect(
			review.record?.status,
			(review.record?.stderr ?? "") + (review.record?.stdout ?? ""),
		).toBe(0);
		expect(review.migrationsAfterRecord).toHaveLength(2);
		expect(
			review.final?.status,
			(review.final?.stderr ?? "") + (review.final?.stdout ?? ""),
		).toBe(0);
		expect(
			review.custom?.status,
			(review.custom?.stderr ?? "") + (review.custom?.stdout ?? ""),
		).toBe(0);
		expect(review.custom?.stdout).toContain("unrecorded draft");
		expect(JSON.parse(review.recordedBytes ?? "null").migrations).toHaveLength(
			2,
		);
		expect(review.denied?.status).not.toBe(0);
		expect(review.drizzleAfterDenied).toEqual(review.drizzleBeforeDenied);
		expect(review.missing?.status).not.toBe(0);
		expect(review.drizzleAfterMissing).toEqual(review.drizzleBeforeDenied);
		if (review.error) throw review.error;
	}, 30000);
});
