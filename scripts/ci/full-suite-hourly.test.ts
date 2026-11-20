import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ciObservation,
	laneSelection,
	scriptBrowsers,
	sourceBrowsers,
	testScriptShards,
	workspaceMatrix,
} from "./full-suite-hourly.mjs";
import { isPrimaryTestShard } from "./test-shard";

function fixtureTree(files: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "hourly-browsers-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

describe("hourly full suite", () => {
	test("discovers every workspace with tests or types, including new and type-only packages", () => {
		const root = mkdtempSync(join(tmpdir(), "hourly-suite-"));
		try {
			for (const [workspace, scripts] of [
				["apps/new-app", { "test:run": "run-tests", "type-check": "tsc" }],
				["packages/types-only", { "type-check": "tsc" }],
				["packages/tests-only", { "test:run": "run-tests" }],
				["packages/config", {}],
			] as const) {
				mkdirSync(join(root, workspace), { recursive: true });
				writeFileSync(
					join(root, workspace, "package.json"),
					JSON.stringify({ scripts }),
				);
			}
			mkdirSync(join(root, "apps/no-manifest"));
			expect(workspaceMatrix(root).include).toEqual([
				{ workspace: "apps/new-app", test: true, types: true },
				{ workspace: "packages/tests-only", test: true, types: false },
				{ workspace: "packages/types-only", test: false, types: true },
			]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("aggregates all failing workspaces into one incident for the tested SHA", () => {
		const run = {
			path: ".github/workflows/full-suite-hourly.yml",
			head_branch: "main",
			head_repository: { full_name: "example/product" },
			conclusion: "failure",
			head_sha: "a".repeat(40),
			html_url: "https://github.com/example/product/actions/runs/1",
		};
		const report = (changed = {}) =>
			ciObservation({
				projectId: "project",
				repository: "example/product",
				run: { ...run, ...changed },
				jobs: [
					{
						name: "Workspace apps/api",
						conclusion: "failure",
						html_url: "https://example.test/job/1",
					},
					{
						name: "Workspace packages/db",
						conclusion: "timed_out",
						html_url: "https://example.test/job/2",
					},
					{ name: "Workspace apps/os", conclusion: "success" },
				],
			});
		expect(report()).toMatchObject({
			kind: "ci_red",
			surface: "full-suite-hourly",
			sha: run.head_sha,
		});
		expect(report({ conclusion: "success" })).toMatchObject({
			kind: "ci_green",
			sha: run.head_sha,
		});
		expect(report().summary).toContain("Workspace apps/api");
		expect(report().summary).toContain("Workspace packages/db");
		expect(report().summary).not.toContain("Workspace apps/os");
		for (const changed of [
			{ head_branch: "topic" },
			{ path: "untrusted.yml" },
			{ head_repository: { full_name: "attacker/fork" } },
			{ conclusion: "cancelled" },
		])
			expect(() => report(changed)).toThrow();
	});
	test.each([
		'// import { firefox } from "playwright";',
		'/* import { firefox } from "playwright-core"; */',
		`const example = 'import { firefox } from "@playwright/test";';`,
		'const example = `import { firefox } from "playwright";`;',
		'// import { helper } from "./helper";',
		'/* export { helper } from "./helper"; */',
		`const example = 'import("./helper")';`,
		'const example = `outer ${`import { firefox } from "playwright";`}`;',
		'const example = "escaped \\" import { firefox } from \'playwright\';";',
		'const example = "https://example.test/*";',
	])("ignores non-executable imports: %s", (example) => {
		const root = fixtureTree({
			"spec.ts": example,
			"helper.ts": 'import { firefox } from "playwright";',
		});
		try {
			expect(sourceBrowsers(join(root, "spec.ts"))).toEqual([]);
			writeFileSync(
				join(root, "spec.ts"),
				`${example}\nimport /* browser */ { chromium } from /* module */ "playwright";\nconst result = \`loaded \${await import(/* module */ "./real")}\`;`,
			);
			writeFileSync(
				join(root, "real.ts"),
				'import { webkit } from "playwright-core";',
			);
			expect(sourceBrowsers(join(root, "spec.ts"))).toEqual([
				"chromium",
				"webkit",
			]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("follows side-effect setup imports, including cycles", () => {
		const root = fixtureTree({
			"spec.ts": 'import "./setup";\nawait run();',
			"setup.ts":
				'import "./spec";\nimport { webkit } from "playwright";\nawait webkit.launch();',
		});
		try {
			expect(sourceBrowsers(join(root, "spec.ts"))).toEqual(["webkit"]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("selects the original browser of an aliased import", () => {
		const root = fixtureTree({
			"spec.ts":
				'import { chromium as browser, firefox as\n\tother } from "playwright";',
		});
		try {
			expect(sourceBrowsers(join(root, "spec.ts"))).toEqual([
				"chromium",
				"firefox",
			]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
	test("derives each browser script's Playwright browsers from the specs it runs", () => {
		const scripts = {
			"test:unit": "vp test run",
			"test:browser:a": "bun specs/a.spec.ts && bun specs/b.spec.ts",
			"test:browser:c": "bun specs/c.spec.ts",
			"test:browser:shared": "bun specs/run.ts specs/c.spec.ts specs/b.spec.ts",
			"test:browser:all": "bun run test:browser:a && bun run test:browser:c",
		};
		const root = fixtureTree({
			"apps/web/package.json": JSON.stringify({
				scripts: {
					...scripts,
					"test:run": "bun run test:unit && bun run test:browser:all",
				},
				tedixCi: { splitTestScripts: true },
			}),
			"apps/web/specs/a.spec.ts":
				'import { chromium, type Browser } from "playwright";\nimport { helper } from "./shared";',
			"apps/web/specs/shared.ts":
				'import {\n\twebkit,\n\ttype Page,\n} from "playwright";\nimport "./a.spec";',
			"apps/web/specs/b.spec.ts":
				'import { devices, chromium } from "playwright";\n// webkit.launch() in a comment is not an import',
			"apps/web/specs/c.spec.ts": 'import assert from "node:assert";',
		});
		try {
			const workspace = join(root, "apps/web");
			expect(scriptBrowsers(workspace, scripts, "test:browser:a")).toEqual([
				"chromium",
				"webkit",
			]);
			expect(scriptBrowsers(workspace, scripts, "test:browser:c")).toEqual([]);
			expect(scriptBrowsers(workspace, scripts, "test:browser:shared")).toEqual(
				["chromium"],
			);
			expect(scriptBrowsers(workspace, scripts, "test:unit")).toEqual([]);
			expect(scriptBrowsers(workspace, scripts, "test:browser:all")).toEqual([
				"chromium",
				"webkit",
			]);
			expect(() => scriptBrowsers(workspace, scripts, "missing")).toThrow();
			// CLI flags and their values do not hide the browsers a script imports.
			const withFlags = {
				"flags:after": "bun specs/b.spec.ts --mode ci",
				"flags:between": "bun specs/run.ts --retries 2 specs/a.spec.ts -v",
				"flags:only-values": "bun specs/c.spec.ts --project webkit",
				"not:a-script": "bun test specs/b.spec.ts",
			};
			expect(scriptBrowsers(workspace, withFlags, "flags:after")).toEqual([
				"chromium",
			]);
			expect(scriptBrowsers(workspace, withFlags, "flags:between")).toEqual([
				"chromium",
				"webkit",
			]);
			expect(scriptBrowsers(workspace, withFlags, "flags:only-values")).toEqual(
				[],
			);
			expect(scriptBrowsers(workspace, withFlags, "not:a-script")).toEqual([]);
			mkdirSync(join(root, "packages"));
			expect(workspaceMatrix(root).include).toEqual([
				{
					workspace: "apps/web",
					test: true,
					testScript: "test:unit",
					types: false,
				},
				{
					workspace: "apps/web",
					test: true,
					testScript: "test:browser:a",
					browsers: "chromium webkit",
					types: false,
				},
				{
					workspace: "apps/web",
					test: true,
					testScript: "test:browser:c",
					types: false,
				},
			]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});

	test("an unsplit workspace job carries the browsers its test script launches", () => {
		const root = fixtureTree({
			"apps/web/package.json": JSON.stringify({
				scripts: { "test:run": "bun spec.ts", "type-check": "tsc" },
			}),
			"apps/web/spec.ts": 'import { chromium } from "playwright";',
			"packages/types-only/package.json": JSON.stringify({
				scripts: { "type-check": "tsc" },
			}),
		});
		try {
			expect(workspaceMatrix(root).include).toEqual([
				{
					workspace: "apps/web",
					test: true,
					browsers: "chromium",
					types: true,
				},
				{ workspace: "packages/types-only", test: false, types: true },
			]);
		} finally {
			rmSync(root, { recursive: true });
		}
	});
});

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

test("runs the boundary check in shard 1 and unsharded runs only", () => {
	expect(isPrimaryTestShard([])).toBe(true);
	expect(isPrimaryTestShard(["src/x.test.ts"])).toBe(true);
	expect(isPrimaryTestShard(["--shard", "1/4"])).toBe(true);
	expect(isPrimaryTestShard(["--shard=1/4"])).toBe(true);
	for (const shard of ["2/4", "3/4", "4/4", "2/2"])
		expect(isPrimaryTestShard(["--shard", shard])).toBe(false);
	expect(isPrimaryTestShard(["--shard=3/4"])).toBe(false);
});

type MatrixJob = {
	workspace: string;
	test: boolean;
	testScript?: string;
	shard?: string;
	browsers?: string;
	types: boolean;
};

test("slow workspaces publish complete non-overlapping shard sets on the real manifests", () => {
	const root = join(import.meta.dir, "../..");
	const matrix = workspaceMatrix(root).include as MatrixJob[];
	const jobsOf = (workspace: string, testScript: string) =>
		matrix.filter(
			(job) => job.workspace === workspace && job.testScript === testScript,
		);
	const groups = new Map<string, MatrixJob[]>();
	for (const job of matrix) {
		const key = `${job.workspace}:${job.testScript ?? ""}`;
		const group = groups.get(key);
		if (group) group.push(job);
		else groups.set(key, [job]);
	}
	for (const entries of groups.values()) {
		const shards = entries
			.map((job) => job.shard?.split("/").map(Number))
			.filter((shard): shard is number[] => shard !== undefined);
		if (!shards.length) continue;
		const count = shards[0]![1]!;
		expect(shards.map(([index]) => index ?? 0).sort((a, b) => a - b)).toEqual(
			[...Array(count).keys()].map((index) => index + 1),
		);
	}
}, 20_000);

test("lanes: push lanes run policy and types while manual runs select suites", () => {
	const plan = {
		matrix: {
			include: [
				{ workspace: "apps/api", testScript: "test:run", types: true },
				{
					workspace: "apps/os",
					testScript: "test:browser:apps",
					browsers: "chromium",
				},
			],
		},
		repository: true,
		scope: "affected",
	};
	expect(laneSelection(plan, "full")).toMatchObject({
		...plan,
		lane: "full",
		checks: ["onboarding", "scripts", "policy"],
	});
	// An affected-scoped push touched no global input: the gate is plan and
	// aggregate alone. A full-scoped push keeps the policy check.
	const gate = laneSelection(plan, "gate");
	expect(gate.matrix.include).toEqual([]);
	expect(gate).toMatchObject({ repository: false, checks: [], lane: "gate" });
	expect(laneSelection({ ...plan, scope: "full" }, "gate")).toMatchObject({
		repository: true,
		checks: ["policy"],
		matrix: { include: [] },
	});
	const verify = laneSelection(plan, "verify");
	expect(verify.matrix.include).toEqual([{ workspace: "apps/api" }]);
	expect(verify).toMatchObject({
		repository: false,
		checks: [],
		lane: "verify",
	});
	expect(
		laneSelection({ ...plan, repository: false }, "verify").checks,
	).toEqual([]);
	expect(() => laneSelection(plan, "nope")).toThrow(/Unknown suite lane/);
});
