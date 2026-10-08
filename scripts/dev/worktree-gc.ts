#!/usr/bin/env bun

/**
 * Finds and removes finished git worktrees of this repository.
 *
 * Parallel agents leave worktrees in `.claude/worktrees`, `~/.codex/worktrees`,
 * `/tmp` scratchpads and `.worktrees/`. `git worktree list` sees all of them,
 * wherever they live, so this reads that list instead of scanning folders.
 *
 * A worktree is removable only when nothing can be lost and nobody is using it:
 * its HEAD is already in the base branch, it has no changes (untracked files
 * count), it is not locked, no process has its working directory inside it,
 * and git has not touched it for `--min-idle` hours. Everything else is
 * reported and kept. The default is a dry run; `--apply` removes with plain
 * `git worktree remove` (never `--force`) and deletes merged branches with
 * `git branch -d`.
 *
 *   bun run worktree:gc                 # report
 *   bun run worktree:gc --apply         # remove the "merged" rows
 *   bun run worktree:gc --base origin/main --min-idle 4
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type WorktreeEntry = {
	path: string;
	head: string;
	/** Short branch name, or null when detached. */
	branch: string | null;
	locked: boolean;
	bare: boolean;
};

export type WorktreeFacts = {
	exists: boolean;
	changedFiles: number;
	inUse: boolean;
	idleHours: number;
	merged: boolean;
};

export type Verdict =
	| "missing"
	| "locked"
	| "in-use"
	| "recent"
	| "dirty"
	| "unmerged"
	| "merged";

/** Only these verdicts are acted on by `--apply`. */
export const REMOVABLE: ReadonlySet<Verdict> = new Set(["missing", "merged"]);

export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	for (const block of text.split(/\n\n+/)) {
		const lines = block.split("\n").filter(Boolean);
		const path = lines
			.find((line) => line.startsWith("worktree "))
			?.slice("worktree ".length);
		if (!path) continue;
		const branchRef = lines
			.find((line) => line.startsWith("branch "))
			?.slice("branch ".length);
		entries.push({
			path,
			head: lines.find((line) => line.startsWith("HEAD "))?.slice(5) ?? "",
			branch: branchRef ? branchRef.replace(/^refs\/heads\//, "") : null,
			locked: lines.some(
				(line) => line === "locked" || line.startsWith("locked "),
			),
			bare: lines.includes("bare"),
		});
	}
	return entries;
}

/** Checks run cheapest-and-safest first; the first match decides. */
export function classifyWorktree(
	entry: WorktreeEntry,
	facts: WorktreeFacts,
	minIdleHours: number,
): Verdict {
	if (!facts.exists) return "missing";
	if (entry.locked) return "locked";
	if (facts.inUse) return "in-use";
	if (facts.idleHours < minIdleHours) return "recent";
	if (facts.changedFiles > 0) return "dirty";
	return facts.merged ? "merged" : "unmerged";
}

/** True when `path` is `root` or inside it. */
export function isInside(path: string, root: string): boolean {
	return (
		path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
	);
}

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function tryGit(cwd: string, args: string[]): string | null {
	try {
		return git(cwd, args);
	} catch {
		return null;
	}
}

/** Working directories of every process this user can see, via lsof. */
function processWorkingDirectories(): string[] | null {
	try {
		const output = execFileSync("lsof", ["-d", "cwd", "-Fn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			maxBuffer: 64 * 1024 * 1024,
		});
		return output
			.split("\n")
			.filter((line) => line.startsWith("n/"))
			.map((line) => line.slice(1));
	} catch (error) {
		// lsof exits 1 when some processes are unreadable but still prints the rest.
		const stdout = (error as { stdout?: string }).stdout;
		if (typeof stdout !== "string" || stdout.length === 0) return null;
		return stdout
			.split("\n")
			.filter((line) => line.startsWith("n/"))
			.map((line) => line.slice(1));
	}
}

/** Hours since git last wrote this worktree's index or HEAD reflog. */
function idleHours(path: string, now: number): number {
	const gitDir = tryGit(path, ["rev-parse", "--absolute-git-dir"])?.trim();
	const candidates = gitDir
		? [join(gitDir, "index"), join(gitDir, "logs/HEAD"), join(gitDir, "HEAD")]
		: [path];
	const newest = Math.max(
		...candidates
			.filter((file) => existsSync(file))
			.map((file) => statSync(file).mtimeMs),
		0,
	);
	return newest === 0 ? Number.POSITIVE_INFINITY : (now - newest) / 3_600_000;
}

function parseArgs(argv: string[]) {
	const value = (flag: string) => {
		const index = argv.indexOf(flag);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	return {
		apply: argv.includes("--apply"),
		base: value("--base") ?? "origin/main",
		minIdleHours: Number(value("--min-idle") ?? 2),
	};
}

function main(): void {
	const options = parseArgs(process.argv.slice(2));
	const cwd = process.cwd();
	const mainPath = git(cwd, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	])
		.trim()
		.replace(/\/\.git$/, "");
	if (!tryGit(cwd, ["rev-parse", "--verify", "--quiet", options.base])) {
		console.error(
			`Base ${options.base} does not exist. Fetch it or pass --base.`,
		);
		process.exit(1);
	}
	const cwds = processWorkingDirectories();
	if (cwds === null && options.apply) {
		console.error(
			"lsof is unavailable, so live worktrees cannot be detected; refusing --apply.",
		);
		process.exit(1);
	}
	const now = Date.now();
	const rows = parseWorktreePorcelain(
		git(cwd, ["worktree", "list", "--porcelain"]),
	)
		.filter((entry) => !entry.bare && entry.path !== mainPath)
		.map((entry) => {
			const exists = existsSync(entry.path);
			const facts: WorktreeFacts = {
				exists,
				changedFiles: exists
					? (tryGit(entry.path, ["status", "--porcelain"]) ?? "x")
							.split("\n")
							.filter(Boolean).length
					: 0,
				inUse: exists && (cwds ?? []).some((dir) => isInside(dir, entry.path)),
				idleHours: exists
					? idleHours(entry.path, now)
					: Number.POSITIVE_INFINITY,
				merged:
					exists &&
					tryGit(cwd, [
						"merge-base",
						"--is-ancestor",
						entry.head,
						options.base,
					]) !== null,
			};
			return {
				entry,
				facts,
				verdict: classifyWorktree(entry, facts, options.minIdleHours),
			};
		});

	const order: Verdict[] = [
		"merged",
		"missing",
		"dirty",
		"unmerged",
		"recent",
		"in-use",
		"locked",
	];
	for (const verdict of order) {
		const group = rows.filter((row) => row.verdict === verdict);
		if (group.length === 0) continue;
		const action = REMOVABLE.has(verdict)
			? options.apply
				? "removing"
				: "removable"
			: "kept";
		console.log(`\n${verdict} (${group.length}, ${action})`);
		for (const { entry, facts } of group) {
			const detail =
				verdict === "dirty" ? ` ${facts.changedFiles} changed` : "";
			console.log(`  ${entry.branch ?? "(detached)"}${detail}  ${entry.path}`);
		}
	}

	if (!options.apply) {
		const count = rows.filter((row) => REMOVABLE.has(row.verdict)).length;
		console.log(`\n${count} removable. Re-run with --apply to remove them.`);
		return;
	}
	let removed = 0;
	for (const { entry, verdict } of rows) {
		if (verdict !== "merged") continue;
		if (tryGit(cwd, ["worktree", "remove", entry.path]) === null) {
			console.error(`  could not remove ${entry.path}`);
			continue;
		}
		removed += 1;
		if (entry.branch) tryGit(cwd, ["branch", "-d", entry.branch]);
	}
	git(cwd, ["worktree", "prune"]);
	console.log(`\nRemoved ${removed} worktrees and pruned missing ones.`);
}

if (import.meta.main) main();
