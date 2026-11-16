import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detachedGitEnv } from "../oss/git-env";
import {
	baseCheckout,
	failureNamesChangedFile,
	gateComparableOnBase,
	markBaseFailures,
	MAX_BASE_RERUNS,
} from "./preflight-baseline.mjs";

const roots: string[] = [];
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A repository whose base commit holds `baseFiles`, with one more commit on top. */
function fixture(baseFiles: Record<string, string>) {
	const root = mkdtempSync(join(tmpdir(), "preflight-base-"));
	roots.push(root);
	const repo = join(root, "repo");
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: existsSync(repo) ? repo : root,
			encoding: "utf8",
			env: {
				...detachedGitEnv(),
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Base test",
				GIT_AUTHOR_EMAIL: "base@example.invalid",
				GIT_COMMITTER_NAME: "Base test",
				GIT_COMMITTER_EMAIL: "base@example.invalid",
			},
		});
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	git("init", "-q", "-b", "main", repo);
	writeFileSync(join(repo, "README.md"), "base\n");
	for (const [name, text] of Object.entries(baseFiles))
		writeFileSync(join(repo, name), text);
	git("add", ".");
	git("commit", "-q", "-m", "base");
	const base = git("rev-parse", "HEAD");
	writeFileSync(join(repo, "change.ts"), "export const changed = true;\n");
	git("add", ".");
	git("commit", "-q", "-m", "change");
	const checkout = () => baseCheckout({ repoRoot: repo, base, install: null });
	const leftovers = () =>
		existsSync(join(root, "repo/.worktrees"))
			? readdirSync(join(root, "repo/.worktrees"))
			: [];
	return { repo, base, checkout, leftovers };
}

/** A gate that fails wherever the tree holds `broken.ts`, as a type-check would. */
const typeCheck = (repo: string) => ({
	name: "type-check apps/os",
	cwd: repo,
	cmd: [
		"sh",
		"-c",
		"test ! -f broken.ts || { echo 'broken.ts(1,1): error TS2322: wrong'; exit 1; }",
	],
});
const failed = (gate: { name: string }, output: string) => ({
	gate,
	output,
	kind: "change",
});

test("a gate that the push base fails too is main's failure, and the checkout is removed", () => {
	const f = fixture({ "broken.ts": "export const x: number = 'no';\n" });
	const failures = markBaseFailures(
		[failed(typeCheck(f.repo), "broken.ts(1,1): error TS2322: wrong")],
		{ files: ["change.ts"], checkout: f.checkout() },
	);
	expect(failures[0]!.kind).toBe("main");
	expect(f.leftovers()).toEqual([]);
});

test("a gate that passes on the push base stays the change's failure", () => {
	const f = fixture({});
	const failures = markBaseFailures(
		[failed(typeCheck(f.repo), "other.ts(1,1): error TS2322: wrong")],
		{ files: ["change.ts"], checkout: f.checkout() },
	);
	expect(failures[0]!.kind).toBe("change");
	expect(f.leftovers()).toEqual([]);
});

test("a failure naming a changed file is the change's even when main is red in that gate", () => {
	const f = fixture({ "broken.ts": "export const x: number = 'no';\n" });
	let reruns = 0;
	const checkout = {
		failsToo: () => {
			reruns += 1;
			return true;
		},
		remove: () => {},
	};
	const failures = markBaseFailures(
		[
			failed(
				typeCheck(f.repo),
				"broken.ts(1,1): error TS2322: wrong\nchange.ts(1,1): error TS2322: wrong",
			),
		],
		{ files: ["change.ts"], checkout },
	);
	expect(failures[0]!.kind).toBe("change");
	expect(reruns).toBe(0);
	// A workspace tool prints package-relative paths.
	expect(
		failureNamesChangedFile("src/lib/a.ts(3,1): error", [
			"apps/os/src/lib/a.ts",
		]),
	).toBe(true);
	expect(
		failureNamesChangedFile("src/lib/b.ts(3,1): error", ["README.md"]),
	).toBe(false);
	// An unscoped run cannot rule the change out.
	expect(failureNamesChangedFile("anything", null)).toBe(true);
});

test("a base run that only timed out, or a base that cannot be checked out, proves nothing", () => {
	const f = fixture({});
	const timesOut = {
		name: "procedure parity API registries",
		cwd: f.repo,
		cmd: [
			"sh",
			"-c",
			"echo ' FAIL  src/a.test.ts > slow'; echo 'Error: Test timed out in 20000ms.'; exit 1",
		],
	};
	const checkout = f.checkout();
	expect(checkout.failsToo(timesOut)).toBe(false);
	checkout.remove();
	const missing = baseCheckout({
		repoRoot: f.repo,
		base: "f".repeat(40),
		install: null,
	});
	expect(missing.failsToo(typeCheck(f.repo))).toBe(false);
	missing.remove();
	expect(f.leftovers()).toEqual([]);
});

test("only tree-wide gates are compared, and only a few per push", () => {
	for (const name of [
		"lint:repo (architecture boundaries)",
		"type-check apps/os",
		"type-check scripts/",
		"procedure parity API registries and MCP scope coverage",
		"tests (packages/cli)",
	])
		expect(gateComparableOnBase(name)).toBe(true);
	// These take the changed files or the pushed commits as arguments.
	for (const name of [
		"node_modules matches the lockfile",
		"format:check (Oxfmt)",
		"tests related to the changed files (apps/api)",
		"tests reaching the changed files (packages/cli, 3 of 90 files)",
		"OSS secret and customer-identity scan",
		"changed script tests",
		"migration order against the push base",
		"migration gates for a changed migration",
	])
		expect(gateComparableOnBase(name)).toBe(false);

	let reruns = 0;
	const failures = markBaseFailures(
		["a", "b", "c"].map((name) =>
			failed({ name: `type-check apps/${name}` }, "x"),
		),
		{
			files: [],
			checkout: {
				failsToo: () => {
					reruns += 1;
					return true;
				},
				remove: () => {},
			},
		},
	);
	expect(reruns).toBe(MAX_BASE_RERUNS);
	expect(failures.map((failure) => failure.kind)).toEqual([
		"main",
		"main",
		"change",
	]);
});

test("the gate runner ends a failed run with the verdict the push queue reads", () => {
	const bin = mkdtempSync(join(tmpdir(), "preflight-verdict-"));
	roots.push(bin);
	// Every gate passes except the API parity suite, whose fixture times out.
	writeFileSync(
		join(bin, "bun"),
		`#!/bin/sh
case "$*" in
  *fleet-authority-coverage.test.ts*)
    echo ' FAIL  src/rpc/fleet-authority-coverage.test.ts [ src/rpc/fleet-authority-coverage.test.ts ]'
    echo 'Error: Hook timed out in 120000ms.'
    exit 1 ;;
  *reviewed-rpc-endpoint-scopes.test.ts*)
    if [ -n "$ALSO_REJECT" ]; then
      echo 'AssertionError: reviewed endpoint without a valid scope'
      exit 1
    fi ;;
esac
exit 0
`,
		{ mode: 0o755 },
	);
	const run = (extra: Record<string, string>) =>
		spawnSync(
			process.execPath,
			[
				"scripts/ci/preflight-gates.mjs",
				"--local-fast",
				"--files",
				"packages/api-contract/src/contracts/example.ts",
			],
			{
				cwd: new URL("../..", import.meta.url).pathname,
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH}`,
					TEDIX_PUSH_TRAIN_RANGES: "[]",
					CI: "true",
					...extra,
				},
				encoding: "utf8",
			},
		);
	const gate = "procedure parity API registries and MCP scope coverage";
	const timedOut = run({});
	expect(timedOut.status).toBe(1);
	expect(timedOut.stderr).toContain(`✗ ${gate}`);
	expect(timedOut.stderr).toContain("the change is not blamed");
	expect(timedOut.stderr.trim().split("\n").at(-1)).toBe(
		`pre-push-verdict: ${JSON.stringify({ kind: "infrastructure", gate })}`,
	);
	// A real rejection in another gate of the same run still counts.
	const rejected = run({ ALSO_REJECT: "1" });
	expect(rejected.status).toBe(1);
	expect(rejected.stderr.trim().split("\n").at(-1)).toBe(
		`pre-push-verdict: ${JSON.stringify({ kind: "change", gate: "procedure parity MCP scope mapping" })}`,
	);
}, 60_000);
