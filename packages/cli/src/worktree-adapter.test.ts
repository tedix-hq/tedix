import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import { provisionAttemptWorktree } from "./worktree-adapter";

/**
 * MUST spawn git with {@link detachedGitEnv}. The pre-push hook runs this suite
 * with `GIT_DIR` pointing at the real repository, and a child git that inherits
 * it ignores both its own `cwd` and the path argument: `git init --bare
 * <tmp>/remote.git` then re-initialises the actual checkout as bare, which
 * breaks every worktree in the repo.
 */
function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
	}).trim();
}

function fixture(): { repo: string; root: string } {
	const base = mkdtempSync(join(tmpdir(), "tedix-worktree-test-"));
	const remote = join(base, "remote.git");
	const repo = join(base, "repo");
	const root = join(base, "worktrees");
	mkdirSync(repo);
	git(base, ["init", "--bare", remote]);
	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.name", "Tedix Test"]);
	git(repo, ["config", "user.email", "test@tedix.dev"]);
	writeFileSync(join(repo, "README.md"), "fixture\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-m", "fixture"]);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-u", "origin", "main"]);
	return { repo, root };
}

describe("provisionAttemptWorktree", () => {
	test("creates a clean attempt-unique worktree and idempotently reuses it", () => {
		const { repo, root } = fixture();
		const request = {
			cwd: repo,
			root,
			workItemId: "5eed0012-0000-4000-8000-000000000012",
			attemptId: "5eed0023-0000-4000-8000-000000000023",
			agentSession: "codex:session",
		};
		const created = provisionAttemptWorktree(request);
		expect(created.reused).toBe(false);
		expect(git(created.path, ["status", "--porcelain"])).toBe("");
		expect(existsSync(`${created.path}.tedix.json`)).toBe(true);
		expect(provisionAttemptWorktree(request)).toEqual({
			...created,
			reused: true,
		});
	});

	test("refuses foreign metadata and roots inside the primary repository", () => {
		const { repo, root } = fixture();
		const request = {
			cwd: repo,
			root,
			workItemId: "5eed0012-0000-4000-8000-000000000012",
			attemptId: "5eed0023-0000-4000-8000-000000000023",
			agentSession: "codex:session",
		};
		const created = provisionAttemptWorktree(request);
		const marker = JSON.parse(
			readFileSync(`${created.path}.tedix.json`, "utf8"),
		);
		writeFileSync(
			`${created.path}.tedix.json`,
			JSON.stringify({ ...marker, attemptId: "foreign" }),
		);
		expect(() => provisionAttemptWorktree(request)).toThrow(
			"Refusing to reuse",
		);
		expect(() =>
			provisionAttemptWorktree({ ...request, root: join(repo, "nested") }),
		).toThrow("outside the primary repository");
	});

	test("refuses branch collisions and symlinked roots without deleting either", () => {
		const { repo, root } = fixture();
		const request = {
			cwd: repo,
			root,
			workItemId: "5eed0012-0000-4000-8000-000000000012",
			attemptId: "5eed0023-0000-4000-8000-000000000023",
			agentSession: "codex:session",
		};
		const branch = "codex/work-5eed0012-5eed0023";
		git(repo, ["branch", branch]);
		expect(() => provisionAttemptWorktree(request)).toThrow();
		expect(git(repo, ["branch", "--list", branch])).toContain(branch);

		const linkedRoot = join(root, "linked-root");
		mkdirSync(root, { recursive: true });
		symlinkSync(repo, linkedRoot);
		expect(() =>
			provisionAttemptWorktree({
				...request,
				attemptId: "739bd035-d548-45cb-b1ff-381364c73498",
				root: linkedRoot,
			}),
		).toThrow("outside the primary repository");
		expect(existsSync(linkedRoot)).toBe(true);
	});

	test("refuses an orphaned sidecar before creating a worktree", () => {
		const { repo, root } = fixture();
		const path = join(root, "5eed0012-5eed0023");
		mkdirSync(root, { recursive: true });
		writeFileSync(`${path}.tedix.json`, "{}\n");
		expect(() =>
			provisionAttemptWorktree({
				cwd: repo,
				root,
				workItemId: "5eed0012-0000-4000-8000-000000000012",
				attemptId: "5eed0023-0000-4000-8000-000000000023",
				agentSession: "codex:session",
			}),
		).toThrow("sidecar already exists");
		expect(existsSync(path)).toBe(false);
	});
});
