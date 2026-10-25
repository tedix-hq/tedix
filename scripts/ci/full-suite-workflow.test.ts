import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const workflow = readFileSync(
	new URL("../../.github/workflows/full-suite-hourly.yml", import.meta.url),
	"utf8",
);
const aggregate = workflow.split("\n  aggregate:\n")[1]!;
const command = aggregate.split("        run: |\n")[1]!;

test("repository checks run in parallel and every matrix member gates Main CI", () => {
	const repository = workflow
		.split("\n  repository:\n")[1]!
		.split("\n  aggregate:\n")[0]!;
	expect(repository).toContain("fail-fast: false");
	expect(repository).toContain("check: [onboarding, scripts, policy]");
	for (const command of [
		"bun run-local --smoke --no-install",
		"bun run test:scripts",
		"bun run type-check:scripts",
		"bun run docs:public:check",
		"bun run verify --all --ci-policy",
	])
		expect(repository).toContain(command);
	expect(aggregate).toContain("needs: [plan, workspace, repository]");
	expect(aggregate).toContain("for lane in WORKSPACE REPOSITORY; do");
});

test("scheduled and push runs coalesce around the latest main commit", () => {
	const triggers = workflow.split("\npermissions:")[0]!;
	const concurrency = workflow
		.split("\nconcurrency:\n")[1]!
		.split("\nenv:\n")[0]!;
	expect(triggers).toMatch(/push:\n\s+branches: \[main\]/);
	expect(triggers).not.toMatch(/paths(?:-ignore)?:/);
	expect(concurrency).toMatch(/^\s*group: main-certification$/m);
	expect(concurrency).toMatch(/^\s*cancel-in-progress: true$/m);
	expect(aggregate).toContain("if: ${{ always() }}");
});

test("aggregate requires every selected shard and accepts only explicitly unselected skips", () => {
	const check = (overrides: Record<string, string>) =>
		spawnSync("bash", ["-e", "-c", command], {
			env: {
				...process.env,
				PLAN: "success",
				WORKSPACE_REQUIRED: "true",
				REPOSITORY_REQUIRED: "true",
				WORKSPACE: "success",
				REPOSITORY: "success",
				...overrides,
			},
		}).status;
	expect(check({})).toBe(0);
	expect(
		check({
			WORKSPACE_REQUIRED: "false",
			REPOSITORY_REQUIRED: "false",
			WORKSPACE: "skipped",
			REPOSITORY: "skipped",
		}),
	).toBe(0);
	for (const status of ["failure", "cancelled", "skipped", ""]) {
		for (const job of ["PLAN", "WORKSPACE", "REPOSITORY"]) {
			expect(check({ [job]: status })).not.toBe(0);
		}
	}
	expect(check({ WORKSPACE_REQUIRED: "false", PLAN: "failure" })).not.toBe(0);
	for (const job of ["WORKSPACE", "REPOSITORY"]) {
		expect(check({ [`${job}_REQUIRED`]: "false", [job]: "failure" })).not.toBe(
			0,
		);
		expect(check({ [`${job}_REQUIRED`]: "", [job]: "skipped" })).not.toBe(0);
	}
});

const browserAction = readFileSync(
	new URL(
		"../../.github/actions/playwright-browsers/action.yml",
		import.meta.url,
	),
	"utf8",
);

test("browser cache separates Ubuntu releases while sharing image revisions", () => {
	const resolve = browserAction
		.split("      run: |\n")[1]!
		.split("\n    - name:")[0]!
		.replace(/^        /gm, "");
	const directory = mkdtempSync(join(tmpdir(), "playwright-cache-"));
	const key = (image: string, revision: string, architecture = "X64") => {
		const output = join(directory, `${image}-${revision}-${architecture}`);
		const result = spawnSync(
			"bash",
			["-e", "-c", `bun() { printf 'Version 1.64.1\\n'; }\n${resolve}`],
			{
				env: {
					...process.env,
					RUNNER_OS: "Linux",
					RUNNER_ARCH: architecture,
					ImageOS: image,
					ImageVersion: revision,
					BROWSERS: "webkit",
					GITHUB_OUTPUT: output,
				},
				encoding: "utf8",
			},
		);
		expect(result.status, result.stderr).toBe(0);
		return readFileSync(output, "utf8")
			.split("\n")
			.find((line) => line.startsWith("key="));
	};
	try {
		const ubuntu24 = key("ubuntu24", "20261012.1");
		expect(key("ubuntu26", "20261012.1")).not.toBe(ubuntu24);
		expect(key("ubuntu24", "20261020.1")).toBe(ubuntu24);
		expect(key("ubuntu24", "20261012.1", "ARM64")).not.toBe(ubuntu24);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("browser jobs install only their planned browsers, restoring the cache first", () => {
	const workspace = workflow
		.split("\n  workspace:\n")[1]!
		.split("\n  repository:\n")[0]!;
	const install = workspace.indexOf(
		"uses: ./.github/actions/playwright-browsers",
	);
	expect(install).toBeGreaterThan(-1);
	expect(workspace).toContain("browsers: ${{ matrix.browsers }}");
	expect(workspace).not.toContain("test:browser:install");
	expect(install).toBeLessThan(workspace.indexOf("- name: Full test suite"));

	const restore = browserAction.indexOf("uses: actions/cache/restore@");
	const download = browserAction.indexOf(
		"playwright install $deps --only-shell $BROWSERS",
	);
	expect(browserAction).toContain("deps=--with-deps");
	expect(browserAction).toContain('sudo dpkg -i "${chosen[@]}"');
	const save = browserAction.indexOf("uses: actions/cache/save@");
	expect(restore).toBeGreaterThan(-1);
	expect(restore).toBeLessThan(download);
	expect(download).toBeLessThan(save);
	expect(browserAction).toContain(
		"if: steps.restore.outputs.cache-hit != 'true'",
	);
	expect(browserAction).toContain("path: ~/.cache/ms-playwright");
	expect(browserAction).toContain("playwright --version");
	for (const [, action] of browserAction.matchAll(/^\s*uses:\s+([^\s#]+)/gm))
		expect(action).toMatch(/@[0-9a-f]{40}$/);
});

test("install jobs reuse a lockfile-keyed dependency cache before validating it", () => {
	const workspace = workflow
		.split("\n  workspace:\n")[1]!
		.split("\n  repository:\n")[0]!;
	const repository = workflow
		.split("\n  repository:\n")[1]!
		.split("\n  aggregate:\n")[0]!;
	for (const job of [workspace, repository]) {
		const cache = job.indexOf("uses: actions/cache@");
		const install = job.indexOf("bun install --frozen-lockfile");
		expect(cache).toBeGreaterThan(-1);
		expect(cache).toBeLessThan(install);
		expect(job).toContain("path: ~/.bun/install/cache");
		expect(job).toContain("hashFiles('bun.lock')");
		expect(job).toContain("restore-keys: bun-install-");
		expect(job).toContain("bun-version: ${{ env.BUN_VERSION }}");
	}
});

test("only browser suites run under the recorded infrastructure rerun", () => {
	const step = workflow
		.split("- name: Full test suite\n")[1]!
		.split("- name: Type-check")[0]!;
	expect(step).toContain('if [ -n "$BROWSERS" ]; then');
	expect(step).toContain(
		'node scripts/ci/rerun-on-infrastructure.mjs -- "${command[@]}"',
	);
	expect(workflow).toContain(
		'echo "FROZEN_INSTALL_SECONDS=$((SECONDS - started))" >> "$GITHUB_ENV"',
	);
});
