/**
 * `--commit <sha>` must name a real commit.
 *
 * `git push` prints a short sha, and an agent that pads it out to 40
 * characters with invented hex records a commit that does not exist. Nothing
 * downstream catches that — the provenance validator walks commits reachable on
 * main, so a fabricated sha is simply ABSENT rather than failing loudly, while
 * `done` is proof-gated precisely so a closed item traces back to its change.
 */

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { detachedGitEnv } from "../../../scripts/oss/git-env";
import { resolveCommitFlag } from "./local-context";

let repo: string;
let head: string;

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

before(() => {
	repo = mkdtempSync(join(tmpdir(), "resolve-commit-flag-"));
	git(["init", "--quiet"], repo);
	git(["config", "user.email", "test@example.com"], repo);
	git(["config", "user.name", "Test"], repo);
	writeFileSync(join(repo, "file.txt"), "content\n");
	git(["add", "."], repo);
	git(["commit", "--quiet", "-m", "first"], repo);
	head = git(["rev-parse", "HEAD"], repo);
});

after(() => {
	rmSync(repo, { force: true, recursive: true });
});

describe("resolveCommitFlag", () => {
	it("passes a full sha through unchanged", () => {
		assert.equal(resolveCommitFlag(head, repo), head);
	});

	// The whole point: the short sha `git push` prints is now a legal input, so
	// there is no longer any motive to hand-extend one.
	it("expands the short sha that git push prints", () => {
		const short = head.slice(0, 9);
		assert.notEqual(short, head);
		assert.equal(resolveCommitFlag(short, repo), head);
	});

	it("trims surrounding whitespace", () => {
		assert.equal(resolveCommitFlag(`  ${head}\n`, repo), head);
	});

	it("rejects a short sha padded out with invented hex", () => {
		const fabricated = `${head.slice(0, 9)}${"0".repeat(31)}`;
		assert.equal(fabricated.length, 40);
		assert.throws(
			() => resolveCommitFlag(fabricated, repo),
			/does not resolve to a commit/,
		);
	});

	it("rejects a well-formed sha for a commit that does not exist", () => {
		assert.throws(
			() => resolveCommitFlag("a".repeat(40), repo),
			/does not resolve to a commit/,
		);
	});

	it("rejects a non-sha entirely", () => {
		assert.throws(
			() => resolveCommitFlag("not-a-sha", repo),
			/does not resolve to a commit/,
		);
	});

	// A tree or tag that shares the prefix is not a commit, and `^{commit}`
	// is what keeps it from being accepted as proof.
	it("rejects an object that is not a commit", () => {
		const tree = git(["rev-parse", "HEAD^{tree}"], repo);
		assert.throws(
			() => resolveCommitFlag(tree, repo),
			/does not resolve to a commit/,
		);
	});

	// Degrade, never block: outside a worktree there is nothing to resolve
	// against, and a legitimate close must not fail because the operator is
	// standing somewhere unusual.
	it("passes the value through untouched outside a git worktree", () => {
		const bare = mkdtempSync(join(tmpdir(), "resolve-commit-flag-nogit-"));
		try {
			assert.equal(resolveCommitFlag("whatever", bare), "whatever");
		} finally {
			rmSync(bare, { force: true, recursive: true });
		}
	});
});
