import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultPushBase,
	NULL_SHA,
	parsePushRanges,
	selectPushRangeFiles,
} from "./push-range-selection.mjs";
import { detachedGitEnv } from "../oss/git-env";

function git(repo, args) {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: repo,
		env: detachedGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
	return result.stdout.toString().trim();
}

function commit(repo, subject) {
	git(repo, [
		"-c",
		"user.name=Tedix Test",
		"-c",
		"user.email=test@tedix.invalid",
		"commit",
		"-m",
		subject,
	]);
	return git(repo, ["rev-parse", "HEAD"]);
}

function writeAndCommit(repo, file) {
	writeFileSync(join(repo, file), `${file}\n`);
	git(repo, ["add", file]);
	return commit(repo, "add fixture file");
}

function repository() {
	const path = mkdtempSync(join(tmpdir(), "tedix-push-ranges-"));
	git(path, ["init", "-b", "main"]);
	const base = writeAndCommit(path, "baseline.txt");
	git(path, ["update-ref", "refs/remotes/origin/main", base]);
	return { base, path };
}

describe("selectPushRangeFiles", () => {
	test("selects the bootstrap tree even when Actions fetched origin/main at HEAD", () => {
		const { base, path } = repository();
		expect(
			selectPushRangeFiles(path, [{ base: NULL_SHA, head: base }]),
		).toEqual(["baseline.txt"]);
	});
	test("uses origin/main's merge-base for a new branch with two files", () => {
		const { base, path } = repository();
		git(path, ["checkout", "-q", "-b", "new-branch", base]);
		writeAndCommit(path, "first.ts");
		const head = writeAndCommit(path, "second.ts");

		expect(selectPushRangeFiles(path, [{ base: NULL_SHA, head }])).toEqual([
			"first.ts",
			"second.ts",
		]);
	});

	test("selects an existing remote range", () => {
		const { base, path } = repository();
		const head = writeAndCommit(path, "existing.ts");

		expect(selectPushRangeFiles(path, [{ base, head }])).toEqual([
			"existing.ts",
		]);
	});

	test("selects the whole parentless replacement tree without a merge base", () => {
		const { base, path } = repository();
		git(path, ["checkout", "--orphan", "publication"]);
		git(path, ["rm", "--cached", "baseline.txt"]);
		const head = writeAndCommit(path, "published.ts");

		expect(selectPushRangeFiles(path, [{ base, head }])).toEqual([
			"published.ts",
		]);
		expect(() =>
			selectPushRangeFiles(path, [{ base: "not-a-revision", head }]),
		).toThrow("invalid --base revision not-a-revision");
	});

	test("includes both paths when a file moves between gate domains", () => {
		const { base, path } = repository();
		git(path, ["checkout", "-q", "-b", "rename", base]);
		git(path, ["mv", "baseline.txt", "packages-db-moved.ts"]);
		const head = commit(path, "move fixture file");

		expect(selectPushRangeFiles(path, [{ base, head }])).toEqual([
			"baseline.txt",
			"packages-db-moved.ts",
		]);
	});

	test("refuses an invalid explicit revision instead of returning no files", () => {
		const { path } = repository();
		expect(() =>
			selectPushRangeFiles(path, [{ base: "not-a-revision", head: "HEAD" }]),
		).toThrow("invalid --base revision not-a-revision");
	});

	test("uses the empty tree for an initial repository without origin/main", () => {
		const path = mkdtempSync(join(tmpdir(), "tedix-push-ranges-initial-"));
		git(path, ["init", "-b", "main"]);
		writeAndCommit(path, "initial.txt");

		expect(
			selectPushRangeFiles(path, [{ base: NULL_SHA, head: "HEAD" }]),
		).toEqual(["initial.txt"]);
	});

	test("unions all pushed ranges and preserves unusual filenames", () => {
		const { base, path } = repository();
		const mainHead = writeAndCommit(path, "main.ts");
		git(path, ["checkout", "-q", "-b", "other", base]);
		writeAndCommit(path, " leading.ts");
		writeAndCommit(path, "trailing.ts ");
		writeAndCommit(path, "line\nbreak.ts");
		const otherHead = writeAndCommit(path, "unicode-✓.ts");

		expect(
			selectPushRangeFiles(path, [
				{ base, head: mainHead },
				{ base, head: otherHead },
			]),
		).toEqual([
			" leading.ts",
			"line\nbreak.ts",
			"main.ts",
			"trailing.ts ",
			"unicode-✓.ts",
		]);
	});
});

describe("parsePushRanges", () => {
	test("keeps every consecutive base and head pair", () => {
		expect(
			parsePushRanges([
				"--base",
				"a",
				"--head",
				"b",
				"--base",
				"c",
				"--head",
				"d",
			]),
		).toEqual([
			{ base: "a", head: "b" },
			{ base: "c", head: "d" },
		]);
	});
});

describe("defaultPushBase", () => {
	test("uses origin/main when the branch has no upstream", () => {
		const { base, path } = repository();
		writeAndCommit(path, "next.ts");
		expect(defaultPushBase(path)).toBe(base);
	});

	test("returns null without an upstream or origin/main so verify scans everything", () => {
		const path = mkdtempSync(join(tmpdir(), "tedix-push-ranges-no-remote-"));
		git(path, ["init", "-b", "main"]);
		writeAndCommit(path, "initial.txt");
		expect(defaultPushBase(path)).toBeNull();
	});
});
