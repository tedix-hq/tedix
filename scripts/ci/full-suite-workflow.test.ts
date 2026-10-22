import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

test("every main push is certified and scheduled runs cannot supersede its lane", () => {
	const triggers = workflow.split("\npermissions:")[0]!;
	expect(triggers).toMatch(/push:\n\s+branches: \[main\]/);
	expect(triggers).not.toMatch(/paths(?:-ignore)?:/);
	expect(workflow).toContain(
		"group: main-certification-${{ github.event_name }}-${{ github.sha }}-${{ github.run_id }}",
	);
	expect(workflow).toContain("cancel-in-progress: false");
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
