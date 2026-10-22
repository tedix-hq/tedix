import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testScriptShards, workspaceMatrix } from "./full-suite-hourly.mjs";

test("expands complete script chains, preserving order and repeated checks", () => {
	expect(
		testScriptShards(
			{
				ci: "bun run all && bun run browser",
				all: "bun run unit && bun run workers",
				unit: "vp test run",
				workers: "bun run unit",
				browser: "bun browser/a.ts && bun browser/b.ts",
			},
			"ci",
		),
	).toEqual(["unit", "unit", "browser"]);
});

test("retains complex and unknown command chains intact and rejects cycles", () => {
	for (const command of [
		"bun run unit && echo done",
		"bun run missing",
		"CI=1 bun run unit",
		"bun run unit --coverage",
	])
		expect(
			testScriptShards({ ci: command, unit: "vp test run" }, "ci"),
		).toEqual(["ci"]);
	expect(() =>
		testScriptShards({ a: "bun run b", b: "bun run a" }, "a"),
	).toThrow("Cyclic");
});

test("opt-in matrix covers every leaf and runs owner types once", () => {
	const root = mkdtempSync(join(tmpdir(), "suite-shards-"));
	try {
		mkdirSync(join(root, "apps/os"), { recursive: true });
		mkdirSync(join(root, "packages"));
		writeFileSync(
			join(root, "apps/os/package.json"),
			JSON.stringify({
				tedixCi: { splitTestScripts: true, testScriptShards: { unit: 2 } },
				scripts: {
					"test:ci": "bun run unit && bun run browser",
					unit: "vp test run",
					browser: "bun spec.ts",
					"type-check": "tsc",
				},
			}),
		);
		writeFileSync(
			join(root, "apps/os/spec.ts"),
			'import { chromium } from "playwright";',
		);
		expect(workspaceMatrix(root).include).toEqual([
			{
				workspace: "apps/os",
				test: true,
				testScript: "unit",
				shard: "1/2",
				types: true,
			},
			{
				workspace: "apps/os",
				test: true,
				testScript: "unit",
				shard: "2/2",
				types: false,
			},
			{
				workspace: "apps/os",
				test: true,
				testScript: "browser",
				browsers: "chromium",
				types: false,
			},
		]);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("slow workspaces publish complete non-overlapping shard sets on the real manifests", () => {
	const root = join(import.meta.dir, "../..");
	const jobsOf = (workspace, testScript) =>
		workspaceMatrix(root).include.filter(
			(job) => job.workspace === workspace && job.testScript === testScript,
		);
	expect(jobsOf("apps/api", "test:unit")).toEqual(
		[1, 2, 3, 4].map((shard) => ({
			workspace: "apps/api",
			test: true,
			testScript: "test:unit",
			shard: `${shard}/4`,
			types: shard === 1,
		})),
	);
	expect(jobsOf("packages/db", "test:run")).toEqual(
		[1, 2].map((shard) => ({
			workspace: "packages/db",
			test: true,
			testScript: "test:run",
			shard: `${shard}/2`,
			types: shard === 1,
		})),
	);
	for (const [, entries] of Map.groupBy(
		workspaceMatrix(root).include,
		(job) => `${job.workspace}:${job.testScript ?? ""}`,
	)) {
		const shards = entries
			.filter((job) => job.shard)
			.map((job) => job.shard.split("/").map(Number));
		if (!shards.length) continue;
		const count = shards[0]![1]!;
		expect(shards.map(([index]) => index).sort((a, b) => a - b)).toEqual(
			[...Array(count).keys()].map((index) => index + 1),
		);
	}
	const api = JSON.parse(
		readFileSync(join(root, "apps/api/package.json"), "utf8"),
	);
	expect(api.scripts["test:run"]).toBe("bun run test:unit");
	expect(api.scripts["test:unit"]).toContain("test-unit.ts");
});
