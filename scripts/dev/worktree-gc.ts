#!/usr/bin/env bun

/**
 * Finds and removes finished git worktrees of this repository.
 *
 * Parallel agents leave worktrees in `.claude/worktrees`, `~/.codex/worktrees`,
 * `/tmp` scratchpads and `.worktrees/`. `git worktree list` sees all of them,
 * wherever they live. Also scans the canonical checkout's parent for sibling
 * clones sharing a tedix-hq origin with a canonical checkout in that folder.
 * Clones must be clean, idle, unused and fully pushed to the current remote.
 *
 * A worktree is removable only when nothing can be lost and nobody is using it:
 * its HEAD is already in the base branch (directly or as rebased copies of its
 * commits), it has no changes (untracked files and ignored files other than
 * build output and caches count), it is not locked, no process has its working directory inside it,
 * and git has not touched it for `--min-idle` hours. Everything else is
 * reported and kept. Empty interrupted removals with an unchanged index and
 * HEAD on origin/main can be recovered under the same idle/lock/use guards.
 * The default is a dry run; `--apply` removes with plain
 * `git worktree remove` (never `--force`) and deletes their branches, plus any
 * other local branch that no worktree has checked out and whose commits are
 * already in the base branch.
 *
 *   bun run worktree:gc                 # report
 *   bun run worktree:gc --apply         # remove the "merged" rows
 *   bun run worktree:gc --base origin/main --min-idle 4
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
	interrupted?: boolean;
};

export type Verdict =
	| "missing"
	| "locked"
	| "in-use"
	| "recent"
	| "dirty"
	| "unmerged"
	| "interrupted"
	| "merged";

/** Only these verdicts are acted on by `--apply`. */
export const REMOVABLE: ReadonlySet<Verdict> = new Set([
	"missing",
	"merged",
	"interrupted",
]);

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
	if (facts.interrupted && facts.merged) return "interrupted";
	if (facts.changedFiles > 0) return "dirty";
	return facts.merged ? "merged" : "unmerged";
}

/** True when `path` is `root` or inside it. */
export function isInside(path: string, root: string): boolean {
	return (
		path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
	);
}

function git(
	cwd: string,
	args: string[],
	timeout = 30_000,
	input?: string,
): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		timeout,
		input,
		maxBuffer: 64 * 1024 * 1024,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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
	// File times and Date.now() come from different clocks; a write that lands
	// "after" now is simply fresh, never negative idle time.
	return newest === 0
		? Number.POSITIVE_INFINITY
		: Math.max(0, now - newest) / 3_600_000;
}

export function readWorktreeFacts(
	cwd: string,
	entry: WorktreeEntry,
	base: string,
	cwds: string[],
	now: number,
): WorktreeFacts {
	const exists = existsSync(entry.path);
	const status = exists
		? tryGit(entry.path, [
				"status",
				"--porcelain",
				"-z",
				"--untracked-files=all",
				"--ignored=matching",
			])
		: "";
	const changes = (status ?? "x")
		.split("\0")
		.filter(
			(change) =>
				change &&
				!(change.startsWith("!! ") && DISPOSABLE.test(change.slice(3))),
		);
	const merged = exists && inBase(cwd, entry.head, base);
	let interrupted = false;
	if (
		merged &&
		changes.length > 0 &&
		status !== null &&
		tryGit(cwd, ["merge-base", "--is-ancestor", entry.head, "origin/main"]) !==
			null &&
		tryGit(entry.path, ["diff", "--cached", "--quiet", "HEAD", "--"]) !==
			null &&
		tryGit(entry.path, ["config", "--bool", "core.sparseCheckout"])?.trim() !==
			"true"
	) {
		const tracked = tryGit(entry.path, ["ls-files", "-z"])
			?.split("\0")
			.filter(Boolean);
		const deleted = new Set(
			changes
				.filter((change) => change.startsWith(" D "))
				.map((change) => change.slice(3)),
		);
		// Missing .gitignore files can expose the build directories left by git.
		// They must become ignored again after restoring tracked files, before removal.
		interrupted =
			!!tracked?.length &&
			tracked.every((path) => deleted.has(path)) &&
			changes.every(
				(change) =>
					change.startsWith(" D ") ||
					(change.startsWith("?? ") &&
						/(?:^|\/)(?:node_modules|dist|build|coverage|\.next|\.turbo|\.svelte-kit)\//.test(
							change.slice(3),
						)),
			);
	}
	return {
		exists,
		changedFiles: changes.length,
		inUse: exists && cwds.some((dir) => isInside(dir, entry.path)),
		idleHours: exists ? idleHours(entry.path, now) : Number.POSITIVE_INFINITY,
		merged,
		interrupted,
	};
}

function restoreMissingTracked(path: string): void {
	if (!existsSync(join(path, ".git")))
		throw new Error(
			"worktree .git is missing; refusing to restore through a parent repository",
		);
	const deleted = git(path, ["ls-files", "--deleted", "-z"]);
	if (deleted)
		git(path, ["checkout-index", "-z", "--stdin"], 30 * 60 * 1000, deleted);
}

function gitFailure(error: unknown): string {
	const stderr = (error as { stderr?: string | Buffer }).stderr;
	return stderr?.toString().trim() || String(error);
}

export function removeWorktree(
	cwd: string,
	entry: WorktreeEntry,
	base: string,
	minIdleHours: number,
	workingDirectories = processWorkingDirectories,
	runGit = git,
): boolean {
	const safe = () => {
		const live = workingDirectories();
		const listed = tryGit(cwd, ["worktree", "list", "--porcelain"]);
		const current =
			listed &&
			parseWorktreePorcelain(listed).find((item) => item.path === entry.path);
		if (
			live === null ||
			!current ||
			current.head !== entry.head ||
			current.bare
		)
			return false;
		const verdict = classifyWorktree(
			current,
			readWorktreeFacts(cwd, current, base, live, Date.now()),
			minIdleHours,
		);
		return verdict === "merged" || verdict === "interrupted";
	};
	if (!safe()) return false;
	try {
		// checkout-index without --force restores only missing paths, never edits.
		restoreMissingTracked(entry.path);
		if (
			!safe() ||
			tryGit(entry.path, ["status", "--porcelain", "--untracked-files=all"]) !==
				""
		)
			return false;
		runGit(cwd, ["worktree", "remove", entry.path], 30 * 60 * 1000);
		return true;
	} catch (error) {
		console.error(`  could not remove ${entry.path}: ${gitFailure(error)}`);
		try {
			restoreMissingTracked(entry.path);
		} catch (restoreError) {
			console.error(
				`  could not restore missing tracked files in ${entry.path}: ${gitFailure(restoreError)}`,
			);
		}
		return false;
	}
}

export function findSiblingClones(mainPath: string): string[] {
	const parent = dirname(mainPath);
	const repos = readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(parent, entry.name))
		.filter((path) => existsSync(join(path, ".git")));
	const origins = new Map<string, string>();
	for (const path of repos) {
		const origin = tryGit(path, [
			"config",
			"--get",
			"remote.origin.url",
		])?.trim();
		if (origin) origins.set(path, origin);
	}
	const canonical = new Map<string, string>();
	for (const [path, origin] of origins) {
		const name = origin.match(
			/^(?:https:\/\/github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])tedix-hq\/([^/]+?)(?:\.git)?$/,
		)?.[1];
		if (name === basename(path)) canonical.set(origin, path);
	}
	return [...origins]
		.filter(
			([path, origin]) =>
				canonical.has(origin) &&
				canonical.get(origin) !== path &&
				// Linked worktrees are removed through their owning repository, never rm.
				statSync(join(path, ".git")).isDirectory(),
		)
		.map(([path]) => path);
}

export function cloneFullyPushed(path: string): boolean {
	const worktrees = tryGit(path, ["worktree", "list", "--porcelain"]);
	if (!worktrees || parseWorktreePorcelain(worktrees).length !== 1)
		return false;
	if (tryGit(path, ["rev-parse", "--verify", "refs/stash"]) !== null)
		return false;
	const remote = tryGit(path, ["ls-remote", "--heads", "origin"]);
	const refs = tryGit(path, [
		"for-each-ref",
		"--format=%(objectname)",
		"refs/heads",
		"refs/tags",
	]);
	const head = tryGit(path, ["rev-parse", "HEAD"]);
	if (!remote || refs === null || !head) return false;
	const tips = remote
		.trim()
		.split("\n")
		.map((line) => line.split(/\s/)[0] ?? "");
	return [...new Set(`${head}\n${refs}`.split("\n").filter(Boolean))].every(
		(ref) =>
			tips.some(
				(tip) =>
					tryGit(path, ["merge-base", "--is-ancestor", ref, tip]) !== null,
			),
	);
}

export function collectSiblingClones(
	mainPath: string,
	cwds: string[],
	minIdle: number,
	apply: boolean,
): number {
	let count = 0;
	for (const path of findSiblingClones(mainPath)) {
		const safe = () => {
			const live = processWorkingDirectories();
			return (
				live !== null &&
				!live.some((dir) => isInside(dir, path)) &&
				!cwds.some((dir) => isInside(dir, path)) &&
				idleHours(path, Date.now()) >= minIdle &&
				!readdirSync(join(path, ".git")).some((name) =>
					name.endsWith(".lock"),
				) &&
				tryGit(path, ["status", "--porcelain", "--untracked-files=all"]) ===
					"" &&
				cloneFullyPushed(path)
			);
		};
		const removable = safe();
		if (removable) count += 1;
		console.log(
			`\nclone (${removable ? "fully pushed, removable" : "kept"})  ${path}`,
		);
		if (apply && removable && safe()) {
			rmSync(path, { recursive: true });
			console.log(`  removed clone ${path}`);
		}
	}
	return count;
}

export function parseArgs(argv: string[]) {
	let apply = false;
	let base = "origin/main";
	let minIdleValue: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--apply") {
			apply = true;
			continue;
		}
		if (flag === "--base" || flag === "--min-idle") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error(`${flag} needs a value`);
			index += 1;
			if (flag === "--base") base = value;
			else minIdleValue = value;
			continue;
		}
		throw new Error(
			flag?.startsWith("-")
				? `Unknown option: ${flag}`
				: `Unexpected argument: ${flag}`,
		);
	}
	const minIdleHours = Number(minIdleValue ?? 2);
	if (!Number.isFinite(minIdleHours) || minIdleHours < 0)
		throw new Error("--min-idle must be a finite non-negative number of hours");
	return { apply, base, minIdleHours };
}

/** Ignored paths that are only build output, caches or per-checkout settings. */
const DISPOSABLE =
	/(?:^|\/)(?:node_modules|dist|build|out|coverage|storybook-static|\.cache|\.output|\.wrangler|\.cloudflare|\.astro|\.turbo|\.next|\.svelte-kit)\/|\.tsbuildinfo$|(?:^|\/)(?:wrangler\.local\.generated\.json|\.DS_Store)$|^\.claude\/settings\.local\.json$/;

/**
 * True when every commit of `rev` is in `base`: it is an ancestor, or each of
 * its own commits has a patch-identical copy there (a rebased lane branch).
 */
export function inBase(cwd: string, rev: string, base: string): boolean {
	if (tryGit(cwd, ["merge-base", "--is-ancestor", rev, base]) !== null)
		return true;
	const cherry = tryGit(cwd, ["cherry", base, rev]);
	return cherry !== null && !/^\+/m.test(cherry);
}

/** Local branches whose commits are all in `base`, except `main`. */
export function mergedBranches(cwd: string, base: string): string[] {
	return git(cwd, ["branch", "--format=%(refname:short)"])
		.split("\n")
		.map((line) => line.trim())
		.filter(
			(branch) => branch && branch !== "main" && inBase(cwd, branch, base),
		);
}

/**
 * `git branch -d` checks against HEAD or the branch's upstream, not `base`, so
 * it refuses most finished lane branches. Check `base` ourselves, then force.
 */
export function deleteMergedBranch(
	cwd: string,
	branch: string,
	base: string,
): boolean {
	if (!inBase(cwd, branch, base)) return false;
	return tryGit(cwd, ["branch", "-D", branch]) !== null;
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
	const worktrees = parseWorktreePorcelain(
		git(cwd, ["worktree", "list", "--porcelain"]),
	);
	const rows = worktrees
		.filter((entry) => !entry.bare && entry.path !== mainPath)
		.map((entry) => {
			const facts = readWorktreeFacts(
				cwd,
				entry,
				options.base,
				cwds ?? [],
				now,
			);
			return {
				entry,
				facts,
				verdict: classifyWorktree(entry, facts, options.minIdleHours),
			};
		});

	const order: Verdict[] = [
		"merged",
		"interrupted",
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

	const checkedOut = new Set(worktrees.map((entry) => entry.branch));
	const branches = mergedBranches(cwd, options.base).filter(
		(branch) => !checkedOut.has(branch),
	);
	if (branches.length > 0) {
		const action = options.apply ? "deleting" : "removable";
		console.log(
			`\nmerged branches without a worktree (${branches.length}, ${action})`,
		);
		for (const branch of branches) console.log(`  ${branch}`);
	}

	const clones = collectSiblingClones(
		mainPath,
		cwds ?? [],
		options.minIdleHours,
		options.apply,
	);
	if (!options.apply) {
		const count =
			rows.filter((row) => REMOVABLE.has(row.verdict)).length +
			branches.length +
			clones;
		console.log(`\n${count} removable. Re-run with --apply to remove them.`);
		return;
	}
	let removed = 0;
	for (const { entry, verdict } of rows) {
		if (verdict !== "merged" && verdict !== "interrupted") continue;
		if (!removeWorktree(cwd, entry, options.base, options.minIdleHours))
			continue;
		removed += 1;
		if (entry.branch) deleteMergedBranch(cwd, entry.branch, options.base);
	}
	git(cwd, ["worktree", "prune"]);
	const deleted = branches.filter((branch) =>
		deleteMergedBranch(cwd, branch, options.base),
	).length;
	console.log(
		`\nRemoved ${removed} worktrees, deleted ${deleted} merged branches and pruned missing worktrees.`,
	);
}

if (import.meta.main) main();
