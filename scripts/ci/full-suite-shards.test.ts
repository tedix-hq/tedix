import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
