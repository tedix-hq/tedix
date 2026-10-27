import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vite-plus/test";
import {
	assertLocalMigrationInspection,
	checkD1MigrationChain,
} from "./check-d1-migration-chain";
import { runWrangler } from "./wrangler-command";

describe("full D1 migration-chain inspection", () => {
	const names = ["a/migration.sql", "b/migration.sql"];
	const valid = [
		{ success: true, results: names.map((name) => ({ name })) },
		{ success: true, results: [] },
	];

	it("requires the exact ledger and no FK violations", () => {
		expect(() => assertLocalMigrationInspection(valid, names)).not.toThrow();
		expect(() =>
			assertLocalMigrationInspection(
				[valid[0], { success: true, results: [{ table: "x" }] }],
				names,
			),
		).toThrow("foreign_key_check");
	});
});

describe("real local D1 prefix snapshots", () => {
	let seedRoot: string;
	let extendedSeedRoot: string;
	let root: string;
	let cacheDirectory: string;
	let dbRoot: string;
	const names = [
		"20260101000000_base/migration.sql",
		"20260102000000_next/migration.sql",
	];
	function migration(name: string, sql: string): void {
		mkdirSync(path.dirname(path.join(dbRoot, "drizzle", name)), {
			recursive: true,
		});
		writeFileSync(path.join(dbRoot, "drizzle", name), sql);
	}
	function manifest(ordered = names): void {
		writeFileSync(
			path.join(dbRoot, "migration-integrity.json"),
			JSON.stringify({
				version: 1,
				migrations: ordered.map((name) => ({
					name,
					sha256: createHash("sha256")
						.update(readFileSync(path.join(dbRoot, "drizzle", name)))
						.digest("hex"),
				})),
			}),
		);
	}
	function check(env: NodeJS.ProcessEnv = {}) {
		return checkD1MigrationChain({ dbRoot, cacheDirectory, env });
	}
	beforeAll(() => {
		seedRoot = mkdtempSync(path.join(tmpdir(), "tedix-chain-seed-"));
		root = seedRoot;
		dbRoot = path.join(root, "db");
		cacheDirectory = path.join(root, "cache");
		mkdirSync(dbRoot);
		writeFileSync(
			path.join(dbRoot, "wrangler.jsonc"),
			JSON.stringify({
				name: "chain-fixture",
				send_metrics: false,
				d1_databases: [
					{
						binding: "DB",
						database_name: "fixture",
						database_id: "00000000-0000-0000-0000-000000000000",
						migrations_dir: "drizzle",
						migrations_pattern: "drizzle/*/migration.sql",
						migrations_table: "tedix_drizzle_migrations",
					},
				],
			}),
		);
		migration(names[0]!, "CREATE TABLE parent (id INTEGER PRIMARY KEY);");
		manifest([names[0]!]);
		expect(check()).toEqual({ cachedCount: 0, appliedCount: 1 });
	});
	beforeAll(() => {
		extendedSeedRoot = mkdtempSync(
			path.join(tmpdir(), "tedix-chain-extended-seed-"),
		);
		cpSync(seedRoot, extendedSeedRoot, { recursive: true });
		dbRoot = path.join(extendedSeedRoot, "db");
		cacheDirectory = path.join(extendedSeedRoot, "cache");
		migration(names[1]!, "CREATE TABLE child (id INTEGER PRIMARY KEY);");
		manifest();
		expect(check()).toEqual({ cachedCount: 1, appliedCount: 1 });
	});
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "tedix-chain-test-"));
		// Reuse the verified real D1 prefix, but isolate every mutation and cache.
		cpSync(seedRoot, root, { recursive: true });
		dbRoot = path.join(root, "db");
		cacheDirectory = path.join(root, "cache");
	});
	afterAll(() => {
		if (seedRoot) rmSync(seedRoot, { recursive: true, force: true });
		if (extendedSeedRoot)
			rmSync(extendedSeedRoot, { recursive: true, force: true });
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("restores a verified prefix, applies only new migrations, and inspects a complete hit", () => {
		migration(
			names[1]!,
			"CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));",
		);
		manifest();
		expect(check()).toEqual({ cachedCount: 1, appliedCount: 1 });
		expect(check()).toEqual({ cachedCount: 2, appliedCount: 0 });
	});

	it("rejects a broken new migration without publishing its snapshot", () => {
		migration(names[1]!, "INSERT INTO missing_table VALUES (1);");
		manifest();
		expect(() => check()).toThrow("missing_table");
		expect(readdirSync(cacheDirectory)).toHaveLength(1);
	});

	it("rejects a reordered ledger even when the SQL can replay", () => {
		cpSync(extendedSeedRoot, root, { recursive: true });
		manifest([...names].reverse());
		expect(() => check()).toThrow("diverged at position 0");
	});

	it("reads and rejects a reordered real D1 ledger on a complete hit", () => {
		cpSync(extendedSeedRoot, root, { recursive: true });
		expect(() =>
			checkD1MigrationChain({
				dbRoot,
				cacheDirectory,
				env: {},
				run: (args, options) => {
					expect(args.slice(0, 2)).toEqual(["d1", "execute"]);
					const altered = [...args];
					altered[altered.indexOf("--command") + 1] =
						"UPDATE tedix_drizzle_migrations SET id = -id;";
					runWrangler(altered, options);
					return runWrangler(args, options);
				},
			}),
		).toThrow("diverged at position 0");
	});

	it("hashes old SQL rather than trusting an unchanged integrity manifest", () => {
		migration(
			names[0]!,
			"CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE revised (id INTEGER PRIMARY KEY);",
		);
		expect(check()).toEqual({ cachedCount: 0, appliedCount: 1 });
	});

	it.each([{ CI: "true" }, { CI: "1" }, { TEDIX_D1_CHAIN_FULL_REPLAY: "1" }])(
		"forces an empty-store replay with %j",
		(env) => {
			expect(check(env)).toEqual({ cachedCount: 0, appliedCount: 1 });
		},
	);

	it("rejects unrecorded migrations on a complete cache hit", () => {
		migration(names[1]!, "CREATE TABLE unrecorded (id INTEGER PRIMARY KEY);");
		expect(() => check()).toThrow("diverged at position 1");
	});

	it("does not accept a damaged snapshot", () => {
		const snapshot = path.join(cacheDirectory, readdirSync(cacheDirectory)[0]!);
		writeFileSync(path.join(snapshot, "state", "unexpected"), "damage");
		expect(check()).toEqual({ cachedCount: 0, appliedCount: 1 });
	});
});
