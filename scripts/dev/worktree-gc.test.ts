import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyWorktree,
	cloneFullyPushed,
	collectSiblingClones,
	findSiblingClones,
	isInside,
	parseWorktreePorcelain,
	type WorktreeEntry,
	type WorktreeFacts,
} from "./worktree-gc";

const PORCELAIN = `worktree /repo
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /repo/.claude/worktrees/agent-a1
HEAD 2222222222222222222222222222222222222222
branch refs/heads/worktree-agent-a1

worktree /tmp/scratch/wt
HEAD 3333333333333333333333333333333333333333
detached
locked claimed by a live session

`;

const entry: WorktreeEntry = {
	path: "/repo/.worktrees/fix",
	head: "abc",
	branch: "fix",
	locked: false,
	bare: false,
};

const finished: WorktreeFacts = {
	exists: true,
	changedFiles: 0,
	inUse: false,
	idleHours: 24,
	merged: true,
};

describe("parseWorktreePorcelain", () => {
	test("reads branch, detached and locked worktrees", () => {
		const entries = parseWorktreePorcelain(PORCELAIN);
		expect(entries.map((item) => item.path)).toEqual([
			"/repo",
			"/repo/.claude/worktrees/agent-a1",
			"/tmp/scratch/wt",
		]);
		expect(entries[1]?.branch).toBe("worktree-agent-a1");
		expect(entries[2]).toMatchObject({ branch: null, locked: true });
	});
});

describe("classifyWorktree", () => {
	test("removes only a merged, clean, idle, unused worktree", () => {
		expect(classifyWorktree(entry, finished, 2)).toBe("merged");
	});

	test("keeps anything that could lose work or disturb a live session", () => {
		expect(classifyWorktree({ ...entry, locked: true }, finished, 2)).toBe(
			"locked",
		);
		expect(classifyWorktree(entry, { ...finished, inUse: true }, 2)).toBe(
			"in-use",
		);
		expect(classifyWorktree(entry, { ...finished, idleHours: 1 }, 2)).toBe(
			"recent",
		);
		expect(classifyWorktree(entry, { ...finished, changedFiles: 3 }, 2)).toBe(
			"dirty",
		);
		expect(classifyWorktree(entry, { ...finished, merged: false }, 2)).toBe(
			"unmerged",
		);
	});

	test("reports a deleted directory as missing so prune can drop it", () => {
		expect(classifyWorktree(entry, { ...finished, exists: false }, 2)).toBe(
			"missing",
		);
	});
});

describe("isInside", () => {
	test("matches the directory and its children, not a sibling prefix", () => {
		expect(isInside("/repo/wt", "/repo/wt")).toBe(true);
		expect(isInside("/repo/wt/apps/api", "/repo/wt")).toBe(true);
		expect(isInside("/repo/wt-2", "/repo/wt")).toBe(false);
	});
});

const temporary: string[] = [];
afterEach(() => {
	for (const path of temporary.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function cloneFixture() {
	const root = mkdtempSync(join(tmpdir(), "tedix-gc-"));
	temporary.push(root);
	const git = (path: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd: path,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	const remote = join(root, "remote.git");
	git(root, "init", "--bare", "--initial-branch=main", remote);
	const canonical = join(root, "fixture");
	git(root, "clone", remote, canonical);
	git(canonical, "config", "user.email", "fixture@example.com");
	git(canonical, "config", "user.name", "Fixture");
	writeFileSync(join(canonical, "file"), "original");
	git(canonical, "add", ".");
	git(canonical, "commit", "-m", "initial");
	git(canonical, "push", "origin", "HEAD");
	const clone = join(root, "fixture-scratch");
	git(root, "clone", remote, clone);
	for (const path of [canonical, clone]) {
		git(
			path,
			"remote",
			"set-url",
			"origin",
			"https://github.com/tedix-hq/fixture.git",
		);
		git(
			path,
			"config",
			`url.${remote}.insteadOf`,
			"https://github.com/tedix-hq/fixture.git",
		);
		git(path, "config", "user.email", "fixture@example.com");
		git(path, "config", "user.name", "Fixture");
	}
	return { root, canonical, clone, git };
}

describe("sibling clones", () => {
	test("finds only independent same-origin clones beside canonical tedix-hq repos", () => {
		const { canonical, clone, git } = cloneFixture();
		expect(findSiblingClones(canonical)).toEqual([clone]);
		git(
			clone,
			"remote",
			"set-url",
			"origin",
			"https://github.com/other/fixture.git",
		);
		expect(findSiblingClones(canonical)).toEqual([]);
	});

	test("requires all branches and detached HEAD to be pushed, using fresh remote refs", () => {
		const { canonical, clone, git } = cloneFixture();
		expect(cloneFullyPushed(clone)).toBe(true);
		git(clone, "checkout", "--detach");
		git(clone, "commit", "--allow-empty", "-m", "unpublished");
		expect(cloneFullyPushed(clone)).toBe(false);
		git(clone, "branch", "saved");
		git(clone, "checkout", "main");
		expect(cloneFullyPushed(clone)).toBe(false);
		git(clone, "push", "origin", "saved");
		expect(cloneFullyPushed(clone)).toBe(true);
		git(canonical, "push", "origin", "--delete", "saved");
		expect(cloneFullyPushed(clone)).toBe(false);
	});

	test("keeps stashes, attached worktrees and unavailable remotes", () => {
		const { root, clone, git } = cloneFixture();
		writeFileSync(join(clone, "file"), "stash me");
		git(clone, "stash");
		expect(cloneFullyPushed(clone)).toBe(false);
		git(clone, "stash", "drop");
		const linked = join(root, "linked");
		git(clone, "worktree", "add", "--detach", linked);
		expect(cloneFullyPushed(clone)).toBe(false);
		git(clone, "worktree", "remove", linked);
		git(clone, "remote", "set-url", "origin", join(root, "missing.git"));
		expect(cloneFullyPushed(clone)).toBe(false);
	});

	test("dry run preserves clones; apply preserves dirty, recent and active clones", () => {
		const { canonical, clone, git } = cloneFixture();
		git(clone, "checkout", "--detach");
		expect(collectSiblingClones(canonical, [], 0, false)).toBe(1);
		expect(existsSync(clone)).toBe(true);
		collectSiblingClones(canonical, [], 2, true);
		expect(existsSync(clone)).toBe(true);
		collectSiblingClones(canonical, [join(clone, "src")], 0, true);
		expect(existsSync(clone)).toBe(true);
		writeFileSync(join(clone, "untracked"), "keep");
		collectSiblingClones(canonical, [], 0, true);
		expect(existsSync(clone)).toBe(true);
		rmSync(join(clone, "untracked"));
		writeFileSync(join(clone, ".git", "index.lock"), "");
		collectSiblingClones(canonical, [], 0, true);
		expect(existsSync(clone)).toBe(true);
		rmSync(join(clone, ".git", "index.lock"));
		collectSiblingClones(canonical, [], 0, true);
		expect(existsSync(clone)).toBe(false);
		expect(existsSync(canonical)).toBe(true);
	});
});
