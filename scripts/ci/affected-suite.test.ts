import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suiteSelection, certificationFiles } from "./full-suite-hourly.mjs";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "affected-suite-"));
	for (const [dir, name, dependencies, scripts] of [
		[
			"packages/core",
			"core",
			{ bridge: "workspace:*" },
			{ "test:run": "tests" },
		],
		["packages/bridge", "bridge", { core: "workspace:*" }, {}],
		[
			"apps/ui",
			"ui",
			{ bridge: "workspace:*" },
			{
				"test:run": "bun run test:a && bun run test:b",
				"test:a": "tests",
				"test:b": "tests",
				"type-check": "tsc",
			},
		],
		["apps/api", "api", {}, { "test:run": "tests" }],
	] as const) {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(
			join(root, dir, "package.json"),
			JSON.stringify({
				name,
				dependencies,
				scripts,
				tedixCi: { splitTestScripts: true },
			}),
		);
	}
	return root;
}

test("push selects every shard of affected workspaces, including transitive consumers through untested cycles", () => {
	const root = fixture();
	try {
		const ui = suiteSelection(root, {
			eventName: "push",
			files: ["apps/ui/src/view.tsx"],
		});
		expect(ui.repository).toBe(false);
		expect(
			ui.matrix.include.map((job: { workspace: string }) => job.workspace),
		).toEqual(["apps/ui", "apps/ui"]);
		const shared = suiteSelection(root, {
			eventName: "push",
			files: ["packages/core/src/index.ts"],
		});
		expect([
			...new Set(
				shared.matrix.include.map(
					(job: { workspace: string }) => job.workspace,
				),
			),
		]).toEqual(["apps/ui", "packages/core"]);
		expect(
			suiteSelection(root, {
				eventName: "push",
				files: ["apps/api/src/logic.ts"],
			}).matrix.include,
		).toHaveLength(1);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("global changes and unknown paths/ranges run everything; schedule and manual never reuse push certification", () => {
	const root = fixture();
	try {
		for (const file of [
			"bun.lock",
			"package.json",
			"tsconfig.base.json",
			"vite.config.ts",
			"vitest.config.mts",
			".oxlintrc.json",
			".github/README.md",
			"scripts/ci/x.mjs",
			"packages/api-contract/src/x.ts",
			"packages/db/src/schema/x.ts",
			"packages/db/migrations/001.sql",
			"packages/db/drizzle/001/migration.sql",
			"apps/api/wrangler.jsonc",
			"apps/os/cloudflare.config.ts",
			"fixtures/shared.json",
			"unknown.txt",
			"apps/deleted/src/x.ts",
		]) {
			const plan = suiteSelection(root, { eventName: "push", files: [file] });
			expect(plan.repository).toBe(true);
			expect(plan.matrix.include).toHaveLength(4);
		}
		for (const eventName of ["schedule", "workflow_dispatch", "push"]) {
			expect(suiteSelection(root, { eventName, files: null }).repository).toBe(
				true,
			);
		}
		expect(
			suiteSelection(root, { eventName: "schedule", files: ["README.md"] })
				.matrix.include,
		).toHaveLength(4);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("only the shared CI, gate, push and hook scripts still force the full suite", () => {
	const root = fixture();
	try {
		for (const file of [
			"scripts/ci/x.mjs",
			"scripts/check-package-exports.ts",
			"scripts/lint-d1.ts",
			"scripts/dev/push-queue.ts",
			"scripts/dev/push-hook-profile.test.ts",
			".githooks/pre-push",
			".githooks/pre-push.d/policy",
		]) {
			const plan = suiteSelection(root, { eventName: "push", files: [file] });
			expect(plan.repository).toBe(true);
			expect(plan.matrix.include).toHaveLength(4);
		}
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("other scripts paths select their consumer workspaces plus the repository lane", () => {
	const root = fixture();
	try {
		mkdirSync(join(root, "apps/ui/src"), { recursive: true });
		mkdirSync(join(root, "apps/api/src"), { recursive: true });
		mkdirSync(join(root, "packages/core/src"), { recursive: true });
		mkdirSync(join(root, "scripts/tools"), { recursive: true });
		mkdirSync(join(root, "scripts/release"), { recursive: true });
		writeFileSync(join(root, "scripts/tools/helper.ts"), "export const x = 1;");
		writeFileSync(
			join(root, "apps/ui/src/tool-use.ts"),
			'import { x } from "../../../scripts/tools/helper";',
		);
		const plan = suiteSelection(root, {
			eventName: "push",
			files: ["scripts/tools/helper.ts"],
		});
		expect(plan.repository).toBe(true);
		expect(plan.matrix.include.map((job) => job.workspace)).toEqual([
			"apps/ui",
			"apps/ui",
		]);
		const apiManifest = JSON.parse(
			readFileSync(join(root, "apps/api/package.json"), "utf8"),
		);
		apiManifest.scripts.dev = "bun ../../scripts/tools/helper";
		writeFileSync(
			join(root, "apps/api/package.json"),
			JSON.stringify(apiManifest),
		);
		expect(
			new Set(
				suiteSelection(root, {
					eventName: "push",
					files: ["scripts/tools/helper.ts"],
				}).matrix.include.map((job) => job.workspace),
			),
		).toEqual(new Set(["apps/api", "apps/ui"]));
		writeFileSync(
			join(root, "scripts/tools/run.ts"),
			'import { x } from "./helper";',
		);
		writeFileSync(
			join(root, "packages/core/src/uses-run.ts"),
			'import "../../../scripts/tools/run";',
		);
		expect(
			new Set(
				suiteSelection(root, {
					eventName: "push",
					files: ["scripts/tools/helper.ts"],
				}).matrix.include.map((job) => job.workspace),
			),
		).toEqual(new Set(["apps/api", "apps/ui", "packages/core"]));
		const solo = suiteSelection(root, {
			eventName: "push",
			files: ["scripts/release/publish.mjs"],
		});
		expect(solo.repository).toBe(true);
		expect(solo.matrix.include).toEqual([]);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("docs and markdown-only pushes need no workspace or repository tests", () => {
	const root = fixture();
	try {
		for (const files of [
			[],
			[
				"docs/guide.mdx",
				"docs/assets/diagram.png",
				"README.md",
				"apps/ui/src/notes.md",
			],
		]) {
			const plan = suiteSelection(root, { eventName: "push", files });
			expect(plan.matrix.include).toEqual([]);
			expect(plan.repository).toBe(false);
		}
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("diff includes all uncertified commits, ignores current run and newer pending invalidates older success", async () => {
	const head = "a".repeat(40),
		pending = "b".repeat(40),
		base = "c".repeat(40);
	const calls: string[][] = [];
	const files = await certificationFiles({
		repository: "example/product",
		sha: head,
		runId: "9",
		request: async (path: string) =>
			path.includes("/jobs?")
				? { jobs: [{ name: "Main CI", conclusion: "success" }] }
				: {
						workflow_runs: [
							{ id: 9, head_sha: head, conclusion: null },
							{ id: 8, head_sha: pending, conclusion: null },
							{
								id: 7,
								head_sha: pending,
								conclusion: "success",
								status: "completed",
								head_branch: "main",
								head_repository: { full_name: "example/product" },
								run_attempt: 1,
							},
							{
								id: 6,
								head_sha: base,
								conclusion: "success",
								status: "completed",
								head_branch: "main",
								head_repository: { full_name: "example/product" },
								run_attempt: 1,
							},
						],
					},
		git: (args: string[]) => {
			calls.push(args);
			return args[0] === "rev-list"
				? `${head}\n${pending}\n${base}\n`
				: "apps/api/src/broken.ts\0README.md\0";
		},
	});
	expect(files).toEqual(["apps/api/src/broken.ts", "README.md"]);
	expect(calls[1]).toContain(base);
	expect(calls[1]).toContain("--no-renames");
	expect(
		await certificationFiles({
			repository: "example/product",
			sha: head,
			runId: "9",
			request: async () => ({ workflow_runs: [] }),
			git: () => head,
		}),
	).toBeNull();
});

test("certification history is paginated and only a main ancestor with a successful aggregate is inherited", async () => {
	const head = "a".repeat(40),
		base = "c".repeat(40),
		other = "d".repeat(40);
	for (const conclusion of ["success", "skipped", "failure"]) {
		const pages: string[] = [];
		const result = await certificationFiles({
			repository: "example/product",
			sha: head,
			runId: "9",
			request: async (path: string) => {
				pages.push(path);
				if (path.includes("/jobs?"))
					return { jobs: [{ name: "Main CI", conclusion }] };
				const run = {
					id: 1,
					head_sha: other,
					conclusion: "success",
					status: "completed",
					head_branch: "main",
					head_repository: { full_name: "example/product" },
					run_attempt: 2,
				};
				return {
					workflow_runs: path.endsWith("page=1")
						? Array.from({ length: 100 }, () => run)
						: [{ ...run, id: 2, head_sha: base }],
				};
			},
			git: (args: string[]) =>
				args[0] === "rev-list" ? `${head}\n${base}\n` : "README.md\0",
		});
		expect(pages.some((path) => path.endsWith("page=2"))).toBe(true);
		expect(pages.some((path) => path.includes("/runs/1/"))).toBe(false);
		expect(result).toEqual(conclusion === "success" ? ["README.md"] : null);
	}
	await expect(
		certificationFiles({
			repository: "example/product",
			sha: head,
			runId: "9",
			request: async () => {
				throw new Error("unavailable");
			},
			git: () => head,
		}),
	).rejects.toThrow("unavailable");
});
