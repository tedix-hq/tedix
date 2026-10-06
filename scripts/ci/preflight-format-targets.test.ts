import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detachedGitEnv } from "../oss/git-env";
import { formatCheckCommand } from "./preflight-format-targets.mjs";
import { NULL_SHA } from "./push-range-selection.mjs";

const roots: string[] = [];
const nodeModules = fileURLToPath(
	new URL("../../node_modules", import.meta.url),
);
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function git(root: string, ...args: string[]) {
	const result = spawnSync("git", args, {
		cwd: root,
		env: detachedGitEnv(),
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}
function commit(root: string) {
	git(root, "add", "--all");
	git(
		root,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@tedix.invalid",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"-qm",
		"fixture",
	);
	return git(root, "rev-parse", "HEAD");
}
function repository() {
	const root = mkdtempSync(join(tmpdir(), "tedix-format-targets-"));
	roots.push(root);
	git(root, "init", "-q", "-b", "main");
	writeFileSync(join(root, ".gitignore"), "node_modules\nignored.ts\n");
	writeFileSync(join(root, "baseline.ts"), "export const baseline = true;\n");
	const base = commit(root);
	git(root, "update-ref", "refs/remotes/origin/main", base);
	return { root, base };
}
const full = ["bun", "run", "format:check"];
const scoped = (...paths: string[]) => [
	...full,
	"--",
	"--no-error-on-unmatched-pattern",
	"--",
	...paths.map((path) => `./${path}`),
];
function select(root: string, base: string, head = "HEAD") {
	return formatCheckCommand(root, { ranges: [{ base, head }] });
}

describe("format targets from real pushed Git ranges", () => {
	test("new ref retains exact added filenames, including spaces, options and newlines", () => {
		const { root } = repository();
		const names = [
			"two words.ts",
			"--check.ts",
			"!literal.ts",
			"line\nbreak.ts",
		];
		for (const name of names)
			writeFileSync(join(root, name), "export const x = 1;\n");
		commit(root);
		expect(select(root, NULL_SHA)).toEqual(scoped(...names.sort()));
	});

	test("renames select the destination and committed deletions never become unmatched input", () => {
		const { root, base } = repository();
		git(root, "mv", "baseline.ts", "renamed.ts");
		commit(root);
		expect(select(root, base)).toEqual(scoped("renamed.ts"));
		const renamed = git(root, "rev-parse", "HEAD");
		git(root, "rm", "renamed.ts");
		commit(root);
		expect(select(root, renamed)).toBeNull();
	});

	test("same-head multi-ref pushes use the union; other heads retain full checkout checks", () => {
		const { root, base } = repository();
		writeFileSync(join(root, "first.ts"), "export const first = 1;\n");
		const middle = commit(root);
		writeFileSync(join(root, "second.ts"), "export const second = 2;\n");
		const head = commit(root);
		expect(
			formatCheckCommand(root, {
				ranges: [
					{ base, head },
					{ base: middle, head },
				],
			}),
		).toEqual(scoped("first.ts", "second.ts"));
		expect(
			formatCheckCommand(root, {
				ranges: [
					{ base, head: middle },
					{ base: middle, head },
				],
			}),
		).toEqual(full);
	});

	test("unknown, explicit all, empty ranges and missing tracked files fail back to full", () => {
		const { root, base } = repository();
		writeFileSync(join(root, "added.ts"), "export const added = 1;\n");
		const head = commit(root);
		expect(formatCheckCommand(root, { ranges: [] })).toEqual(full);
		expect(
			formatCheckCommand(root, { ranges: [{ base, head }], all: true }),
		).toEqual(full);
		expect(select(root, "unknown-revision")).toEqual(full);
		expect(select(root, base, "unknown-revision")).toEqual(full);
		unlinkSync(join(root, "added.ts"));
		expect(select(root, base)).toEqual(full);
	});

	test("symlinks and glob-shaped filenames retain full scans", () => {
		const { root, base } = repository();
		symlinkSync("baseline.ts", join(root, "link.ts"));
		commit(root);
		expect(select(root, base)).toEqual(full);
		const beforeGlob = git(root, "rev-parse", "HEAD");
		writeFileSync(join(root, "[literal].ts"), "export const x = 1;\n");
		commit(root);
		expect(select(root, beforeGlob)).toEqual(full);
	});

	test.each([
		"package.json",
		"bun.lock",
		"vite.config.ts",
		".gitignore",
		".prettierignore",
		".oxfmtrc.json",
		".editorconfig",
		".gitattributes",
	])("%s changes retain full format policy", (name) => {
		const { root, base } = repository();
		writeFileSync(join(root, name), "changed\n");
		commit(root);
		expect(select(root, base)).toEqual(full);
	});
});

function run(root: string, command: string[]) {
	return spawnSync(command[0]!, command.slice(1), {
		cwd: root,
		encoding: "utf8",
		env: { ...detachedGitEnv(), NO_COLOR: "1" },
	});
}

test("actual Oxfmt full and scoped checks agree before and after repair, including ignored targets", () => {
	const { root } = repository();
	symlinkSync(resolve(nodeModules), join(root, "node_modules"), "dir");
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({
			scripts: { "format:check": "vp fmt --check", format: "vp fmt" },
		}),
	);
	writeFileSync(
		join(root, "vite.config.ts"),
		'export default { fmt: { useTabs: true, ignorePatterns: ["configured.ts"] } };\n',
	);
	const initialFormat = run(root, ["bun", "run", "format"]);
	expect(initialFormat.status).toBe(0);
	const base = commit(root);
	const names = ["two words.ts", "--check.ts"];
	for (const name of names)
		writeFileSync(join(root, name), 'export const bad={x:1,y:"value"}\n');
	commit(root);
	const command = select(root, base)!;
	expect(command).toEqual(scoped(...names.sort()));
	const fullBad = run(root, full);
	const scopedBad = run(root, command);
	expect(fullBad.status).toBe(1);
	expect(scopedBad.status).toBe(fullBad.status);
	const repaired = run(root, [
		"bun",
		"run",
		"format",
		"--",
		"--",
		...names.map((name) => `./${name}`),
	]);
	expect(repaired.status).toBe(0);
	expect(run(root, full).status).toBe(0);
	expect(run(root, command).status).toBe(0);
	const repairedHead = commit(root);
	writeFileSync(join(root, "LICENSE"), "Unformatted plain text\n");
	writeFileSync(join(root, "configured.ts"), "const bad={x:1}\n");
	const unsupportedHead = commit(root);
	const unsupported = select(root, repairedHead)!;
	expect(unsupported).toEqual(scoped("LICENSE", "configured.ts"));
	expect(run(root, unsupported).status).toBe(0);
	writeFileSync(join(root, "ignored.ts"), "const bad={x:1}\n");
	git(root, "add", "-f", "ignored.ts");
	writeFileSync(join(root, "LICENSE"), "Unformatted plain text\n");
	commit(root);
	const ignored = select(root, unsupportedHead)!;
	expect(ignored).toEqual(full);
	expect(run(root, ignored).status).toBe(0);
	expect(run(root, full).status).toBe(0);
}, 30_000);
