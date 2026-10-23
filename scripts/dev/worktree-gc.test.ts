import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyWorktree,
	cloneFullyPushed,
	collectSiblingClones,
	deleteMergedBranch,
	findSiblingClones,
	mergedBranches,
	inBase,
	isInside,
	parseWorktreePorcelain,
	readWorktreeFacts,
	removeWorktree,
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
	}, 60_000);

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
	}, 60_000);
});

function worktreeFixture() {
	const root = mkdtempSync(join(tmpdir(), "tedix-gc-worktree-"));
	temporary.push(root);
	const canonical = root;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git(canonical, "init", "--initial-branch=main");
	git(canonical, "config", "user.email", "fixture@example.com");
	git(canonical, "config", "user.name", "Fixture");
	writeFileSync(join(canonical, "file"), "original");
	writeFileSync(join(canonical, ".gitignore"), "node_modules/\ndist/\n");
	writeFileSync(join(canonical, "second file"), "second");
	git(canonical, "add", ".");
	git(canonical, "commit", "-m", "tracked fixture files");
	git(canonical, "update-ref", "refs/remotes/origin/main", "HEAD");
	git(canonical, "worktree", "add", "--detach", join(root, "linked"));
	const path = realpathSync(join(root, "linked"));
	const entry = parseWorktreePorcelain(
		git(canonical, "worktree", "list", "--porcelain"),
	).find((entry) => entry.path === path)!;
	const facts = () =>
		readWorktreeFacts(canonical, entry, "origin/main", [], Date.now());
	const verdict = () => classifyWorktree(entry, facts(), 0);
	const eraseTracked = () => {
		for (const name of ["file", "second file", ".gitignore"])
			rmSync(join(path, name));
	};
	return { canonical, path, entry, facts, verdict, eraseTracked, git };
}

describe("worktree removal", () => {
	test("removes clean merged worktrees with ignored dependencies and build output", () => {
		const { canonical, path, entry } = worktreeFixture();
		for (const name of ["node_modules", "dist"]) {
			mkdirSync(join(path, name));
			writeFileSync(join(path, name, "output"), "generated");
		}
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => [])).toBe(
			true,
		);
		expect(existsSync(path)).toBe(false);
	});

	test("recognizes and finishes an empty interrupted tree without force", () => {
		const { canonical, path, entry, eraseTracked, verdict } = worktreeFixture();
		mkdirSync(join(path, "node_modules"));
		writeFileSync(join(path, "node_modules", "output"), "generated");
		eraseTracked();
		expect(verdict()).toBe("interrupted");
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => [])).toBe(
			true,
		);
		expect(existsSync(path)).toBe(false);
	});

	test("keeps partial deletions, staged changes, untracked files and sparse checkouts", () => {
		const { canonical, path, entry, eraseTracked, verdict, git } =
			worktreeFixture();
		rmSync(join(path, "file"));
		expect(verdict()).toBe("dirty");
		git(path, "restore", ".");
		eraseTracked();
		writeFileSync(join(path, "untracked"), "keep");
		expect(verdict()).toBe("dirty");
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => [])).toBe(
			false,
		);
		rmSync(join(path, "untracked"));
		git(path, "add", "-u");
		expect(verdict()).toBe("dirty");
		git(path, "reset", "HEAD");
		git(path, "config", "core.sparseCheckout", "true");
		expect(verdict()).toBe("dirty");
	});

	test("rechecks lock, activity, age, merge status and HEAD before removal", () => {
		const { canonical, path, entry, eraseTracked, git } = worktreeFixture();
		eraseTracked();
		expect(removeWorktree(canonical, entry, "origin/main", 2, () => [])).toBe(
			false,
		);
		expect(
			removeWorktree(canonical, entry, "origin/main", 0, () => [
				join(path, "src"),
			]),
		).toBe(false);
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => null)).toBe(
			false,
		);
		git(canonical, "worktree", "lock", path);
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => [])).toBe(
			false,
		);
		git(canonical, "worktree", "unlock", path);
		git(path, "commit", "--allow-empty", "-m", "unmerged");
		const current = { ...entry, head: git(path, "rev-parse", "HEAD").trim() };
		git(canonical, "branch", "custom-base", current.head);
		expect(removeWorktree(canonical, current, "custom-base", 0, () => [])).toBe(
			false,
		);
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => [])).toBe(
			false,
		);
		expect(existsSync(join(path, ".git"))).toBe(true);
	});

	test("uses a long bounded timeout and restores missing tracked files on failure", () => {
		const { canonical, path, entry, git } = worktreeFixture();
		const errors = spyOn(console, "error").mockImplementation(() => {});
		try {
			const remove = (_cwd: string, args: string[], timeout = 0) => {
				expect(args).toEqual(["worktree", "remove", path]);
				expect(timeout).toBe(30 * 60 * 1000);
				rmSync(join(path, "file"));
				writeFileSync(join(path, "second file"), "concurrent edit");
				throw Object.assign(new Error("Command failed"), {
					stderr: "fatal: permission denied",
				});
			};
			expect(
				removeWorktree(canonical, entry, "origin/main", 0, () => [], remove),
			).toBe(false);
			expect(errors.mock.calls.flat().join("\n")).toContain(
				"fatal: permission denied",
			);
			expect(readFileSync(join(path, "file"), "utf8")).toBe("original");
			expect(readFileSync(join(path, "second file"), "utf8")).toBe(
				"concurrent edit",
			);
			expect(git(path, "ls-files", "--deleted")).toBe("");
		} finally {
			errors.mockRestore();
		}
	});

	test("does not remove untracked build files exposed during interrupted recovery", () => {
		const { canonical, path, entry, eraseTracked, git } = worktreeFixture();
		mkdirSync(join(path, "build"));
		writeFileSync(join(path, "build", "keep"), "untracked work");
		eraseTracked();
		expect(removeWorktree(canonical, entry, "origin/main", 0, () => [])).toBe(
			false,
		);
		expect(readFileSync(join(path, "build", "keep"), "utf8")).toBe(
			"untracked work",
		);
		expect(git(path, "ls-files", "--deleted")).toBe("");
	});
});

describe("merged branches", () => {
	test("deletes branches already in the base even when HEAD is elsewhere, keeps unmerged ones", () => {
		const { canonical, git } = worktreeFixture();
		git(canonical, "branch", "finished");
		git(canonical, "checkout", "-q", "-b", "unfinished");
		writeFileSync(join(canonical, "file"), "changed");
		git(canonical, "commit", "-qam", "not in main yet");
		git(canonical, "checkout", "-q", "-b", "elsewhere");

		expect(mergedBranches(canonical, "origin/main")).toEqual(["finished"]);
		expect(deleteMergedBranch(canonical, "finished", "origin/main")).toBe(true);
		expect(deleteMergedBranch(canonical, "unfinished", "origin/main")).toBe(
			false,
		);
		expect(git(canonical, "branch", "--format=%(refname:short)")).toBe(
			"elsewhere\nmain\nunfinished\n",
		);
	});
});

describe("what counts as finished", () => {
	test("keeps a worktree holding ignored files that are not build output", () => {
		const { canonical, path, verdict } = worktreeFixture();
		mkdirSync(join(path, "node_modules"));
		writeFileSync(join(path, "node_modules", "dep"), "generated");
		expect(verdict()).toBe("merged");
		writeFileSync(join(canonical, ".git", "info", "exclude"), "notes.md\n");
		writeFileSync(join(path, "notes.md"), "hand-written");
		expect(verdict()).toBe("dirty");
	});

	test("treats a branch whose commits landed rebased as merged", () => {
		const { canonical, git } = worktreeFixture();
		git(canonical, "checkout", "-q", "-b", "lane");
		writeFileSync(join(canonical, "lane"), "lane work");
		git(canonical, "add", "lane");
		git(canonical, "commit", "-qm", "lane work");
		git(canonical, "checkout", "-q", "main");
		writeFileSync(join(canonical, "other"), "someone else landed first");
		git(canonical, "add", "other");
		git(canonical, "commit", "-qm", "other work");
		expect(inBase(canonical, "lane", "main")).toBe(false);
		git(canonical, "cherry-pick", "lane");
		expect(inBase(canonical, "lane", "main")).toBe(true);
		git(canonical, "checkout", "-q", "lane");
		writeFileSync(join(canonical, "lane"), "unlanded follow-up");
		git(canonical, "commit", "-qam", "unlanded follow-up");
		expect(inBase(canonical, "lane", "main")).toBe(false);
	});
});
