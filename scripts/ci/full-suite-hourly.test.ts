import { describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	readFileSync,
	chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
	workspaceMatrix,
	ciObservation,
	sourceBrowsers,
	scriptBrowsers,
	reviewPlan,
	reviewFindings,
} from "./full-suite-hourly.mjs";

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
});

describe("advisory review planning", () => {
	test("uses the pushed range independently of wider certification", () => {
		const calls: string[][] = [];
		const git = (args: string[]) => {
			calls.push(args);
			return "apps/os/src/components/button.tsx\0";
		};
		expect(
			reviewPlan(
				{ eventName: "push", before: "a".repeat(40), sha: "b".repeat(40) },
				git,
			),
		).toEqual({ highRisk: false, base: "a".repeat(40) });
		expect(calls[0]).toEqual([
			"diff",
			"--name-only",
			"--no-renames",
			"-z",
			"a".repeat(40),
			"b".repeat(40),
			"--",
		]);
		expect(
			reviewPlan(
				{ eventName: "push", before: "a".repeat(40), sha: "b".repeat(40) },
				() => "packages/db/migrations/removed.sql\0",
			).highRisk,
		).toBe(true);
	});
	test("scheduled runs and unavailable ranges never pretend a push was reviewed", () => {
		const git = () => {
			throw new Error("missing base");
		};
		expect(reviewPlan({ eventName: "schedule" }, git).highRisk).toBe(false);
		expect(
			reviewPlan(
				{ eventName: "push", before: "a".repeat(40), sha: "b".repeat(40) },
				git,
			),
		).toMatchObject({ highRisk: false, reason: "Push range unavailable" });
		expect(
			reviewPlan(
				{ eventName: "push", before: "0".repeat(40), sha: "b".repeat(40) },
				git,
			).highRisk,
		).toBe(false);
	});
	test("findings require severity and file:line in the changed files", () => {
		const findings = [
			{
				severity: "high",
				file: "apps/api/src/index.ts",
				line: 12,
				message: "Missing validation",
			},
		];
		expect(reviewFindings({ findings }, ["apps/api/src/index.ts"])).toEqual(
			findings,
		);
		for (const invalid of [
			{ ...findings[0], line: 0 },
			{ ...findings[0], severity: "maybe" },
			{ ...findings[0], file: "other.ts" },
		])
			expect(() =>
				reviewFindings({ findings: [invalid] }, ["apps/api/src/index.ts"]),
			).toThrow();
	});
});

test("review command attaches unavailable, completed and failed receipts without board credentials", () => {
	const root = fixtureTree({
		".agents/skills/code-review/SKILL.md": "Review changed code.",
		"apps/api/src/index.ts": "export const first = 1;\n",
	});
	const script = resolve("scripts/ci/full-suite-hourly.mjs");
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	try {
		git("init", "-q");
		git("config", "user.email", "test@example.invalid");
		git("config", "user.name", "Fixture");
		git("add", ".");
		git("commit", "-qm", "base");
		const base = git("rev-parse", "HEAD");
		writeFileSync(
			join(root, "apps/api/src/index.ts"),
			"export const first = 2;\n",
		);
		git("add", ".");
		git(
			"commit",
			"-qm",
			"change\n\nWork-Item: 11111111-1111-1111-1111-111111111111",
		);
		writeFileSync(
			join(root, "apps/api/src/index.ts"),
			"export const first = 3;\n",
		);
		git("add", ".");
		git(
			"commit",
			"-qm",
			"change again\n\nWork-Item: 22222222-2222-2222-2222-222222222222",
		);
		const env = {
			...process.env,
			ANTHROPIC_API_KEY: "",
			CLAUDE_CODE_OAUTH_TOKEN: "",
			REVIEW_BASE: base,
			GITHUB_SHA: git("rev-parse", "HEAD"),
			GITHUB_STEP_SUMMARY: join(root, "summary.md"),
		};
		const run = (extra = {}) => {
			execFileSync("node", [script, "review"], {
				cwd: root,
				env: { ...env, ...extra },
				stdio: "pipe",
			});
			return JSON.parse(
				readFileSync(join(root, "high-risk-review.json"), "utf8"),
			);
		};
		expect(run()).toMatchObject({
			status: "skipped",
			findingsCount: null,
			workItemIds: [
				"22222222-2222-2222-2222-222222222222",
				"11111111-1111-1111-1111-111111111111",
			],
		});
		const cli = join(root, "claude");
		const response = {
			structured_output: {
				findings: [
					{
						severity: "high",
						file: "apps/api/src/index.ts",
						line: 1,
						message: "Fixture finding",
					},
				],
			},
		};
		writeFileSync(
			cli,
			`#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify(response)}'\n`,
		);
		chmodSync(cli, 0o755);
		const credentials = {
			ANTHROPIC_API_KEY: "fixture-only",
			PATH: `${root}:${process.env.PATH}`,
		};
		expect(run(credentials)).toMatchObject({
			status: "reviewed",
			findingsCount: 1,
		});
		expect(readFileSync(join(root, "high-risk-review.md"), "utf8")).toContain(
			"[high] apps/api/src/index.ts:1",
		);
		writeFileSync(
			cli,
			"#!/bin/sh\ncat >/dev/null\nprintf '%s' '{\"is_error\":true}'\n",
		);
		expect(run(credentials)).toMatchObject({
			status: "failed",
			findingsCount: null,
		});
	} finally {
		rmSync(root, { recursive: true });
	}
});
