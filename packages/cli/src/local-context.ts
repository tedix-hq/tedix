import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "../../../scripts/oss/git-env";

export interface LocalRepoContext {
	cwd: string;
	gitRoot?: string;
	head?: string;
	origin?: string;
	status?: string;
}

function runGit(args: string[], cwd: string): string | undefined {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (result.status !== 0) return undefined;
	const text = result.stdout.trim();
	return text || undefined;
}

/**
 * Resolve a `--commit` value to the full 40-character sha it names, or fail.
 *
 * Two failures this closes:
 *
 * 1. `git push` prints a short sha. An agent that types it into
 *    `work done --commit` and pads it out to 40 characters with invented hex
 *    produces a value that is not a git object at all. Nothing downstream
 *    catches it: the provenance validator walks commits reachable on
 *    main, so a fabricated sha is simply ABSENT rather than failing loudly, and
 *    `done` is proof-gated precisely so a closed item can be traced back.
 * 2. Retyping a full sha by hand invites a transposition that lands on no
 *    object either.
 *
 * Resolving rather than merely validating also removes the motive for the first
 * failure: the short sha the push printed is now a legal input.
 *
 * Degrades rather than blocks when it cannot know: outside a git worktree (a
 * CI shell, a container, a non-repo cwd) there is nothing to resolve against,
 * so the value passes through untouched. The check is a cheap local guard, not
 * the authority — it must never stop a legitimate close just because the
 * operator is standing somewhere unusual.
 */
export function resolveCommitFlag(value: string, cwd = process.cwd()): string {
	const trimmed = value.trim();
	if (!runGit(["rev-parse", "--show-toplevel"], cwd)) return trimmed;

	// `^{commit}` rejects a tag or tree that happens to share the prefix, and
	// `--verify` makes an ambiguous short sha an error rather than a guess.
	const resolved = runGit(
		["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`],
		cwd,
	);
	if (resolved) return resolved;

	throw new Error(
		`--commit ${trimmed} does not resolve to a commit in this repository. ` +
			"A proof sha must name a real commit; pass the value from " +
			"`git rev-parse HEAD` (a short sha is fine, it will be expanded). " +
			"If the commit is genuinely elsewhere, run the command from a checkout " +
			"that contains it.",
	);
}

export function readLocalRepoContext(cwd = process.cwd()): LocalRepoContext {
	const gitRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
	if (!gitRoot) return { cwd };
	return {
		cwd,
		gitRoot,
		head: runGit(["rev-parse", "--short", "HEAD"], cwd),
		origin: runGit(["remote", "get-url", "origin"], cwd),
		status: runGit(["status", "--short", "--branch"], cwd),
	};
}

export function renderLocalRepoContext(context: LocalRepoContext): string {
	const lines = ["Local terminal context:", `- cwd: ${context.cwd}`];
	if (!context.gitRoot) {
		lines.push("- git: not inside a git worktree");
		return lines.join("\n");
	}
	lines.push(`- gitRoot: ${context.gitRoot}`);
	if (context.origin) lines.push(`- origin: ${context.origin}`);
	if (context.head) lines.push(`- head: ${context.head}`);
	if (context.status) {
		lines.push("- gitStatus:");
		lines.push(...context.status.split("\n").map((line) => `  ${line}`));
	}
	return lines.join("\n");
}

export function appendLocalRepoContext(content: string, cwd = process.cwd()) {
	const rendered = renderLocalRepoContext(readLocalRepoContext(cwd));
	return `${content.trim()}\n\n${rendered}`;
}
