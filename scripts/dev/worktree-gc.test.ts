import { describe, expect, test } from "bun:test";
import {
	classifyWorktree,
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
