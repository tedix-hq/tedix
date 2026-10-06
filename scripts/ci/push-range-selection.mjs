import { spawnSync } from "node:child_process";
import { detachedGitEnv } from "../oss/git-env.ts";

export const NULL_SHA = "0".repeat(40);
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function runGit(repoRoot, args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	if (result.error || result.status !== 0) {
		const detail =
			result.error?.message || result.stderr?.trim() || "unknown error";
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout.trim();
}

function runGitRaw(repoRoot, args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		env: detachedGitEnv(),
	});
	if (result.error || result.status !== 0) {
		const detail =
			result.error?.message ||
			result.stderr?.toString().trim() ||
			"unknown error";
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout;
}

function commitFor(repoRoot, revision, flag) {
	try {
		return runGit(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
	} catch (error) {
		throw new Error(`invalid ${flag} revision ${revision}: ${error.message}`);
	}
}

function hasParent(repoRoot, commit) {
	const result = spawnSync("git", ["rev-parse", "--verify", `${commit}^`], {
		cwd: repoRoot,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	return result.error === undefined && result.status === 0;
}

function filesInDiff(repoRoot, ...revisions) {
	const output = runGitRaw(repoRoot, [
		"diff",
		"--name-only",
		"--no-renames",
		"-z",
		...revisions,
	]);
	return output.toString("utf8").split("\0").slice(0, -1);
}

function gitOutput(repoRoot, args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		env: detachedGitEnv(),
	});
	return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * The base a bare `verify` compares HEAD against: the merge-base with the
 * branch's upstream, else origin/main. A fork, `git init` copy or tarball has
 * neither, and returns null so the caller runs every gate.
 */
export function defaultPushBase(repoRoot) {
	return (
		gitOutput(repoRoot, ["merge-base", "HEAD", "@{upstream}"]) ||
		gitOutput(repoRoot, [
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/main^{commit}",
		]) ||
		null
	);
}

/** Parses every complete `--base <sha> --head <sha>` pair from a preflight CLI. */
export function parsePushRanges(argv) {
	const ranges = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== "--base") continue;
		const base = argv[index + 1];
		if (!base || argv[index + 2] !== "--head" || !argv[index + 3]) {
			throw new Error("--base must be followed by <sha> --head <sha>");
		}
		ranges.push({ base, head: argv[index + 3] });
		index += 3;
	}
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] !== "--head") continue;
		if (argv[index - 2] !== "--base") {
			throw new Error("--head requires a preceding --base <sha>");
		}
	}
	return ranges;
}

/**
 * Returns the union of files Git will receive for explicit pre-push ranges.
 * New remote refs use the local origin/main merge-base; an initial repository
 * or parentless history replacement validates its whole tree against Git's
 * empty tree.
 */
export function selectPushRangeFiles(repoRoot, ranges) {
	const files = new Set();
	for (const { base, head } of ranges) {
		const headCommit = commitFor(repoRoot, head, "--head");
		const baseCommit =
			base === NULL_SHA ? null : commitFor(repoRoot, base, "--base");
		const changed =
			baseCommit === null || !hasParent(repoRoot, headCommit)
				? filesForNewRemoteRef(repoRoot, headCommit)
				: filesInDiff(repoRoot, `${baseCommit}...${headCommit}`);
		for (const file of changed) files.add(file);
	}
	return [...files].sort();
}

function filesForNewRemoteRef(repoRoot, headCommit) {
	// Actions has already fetched origin/main at HEAD on the bootstrap push.
	// A root commit still introduces its entire tree, not an empty merge-base diff.
	if (!hasParent(repoRoot, headCommit)) {
		return filesInDiff(repoRoot, EMPTY_TREE_SHA, headCommit);
	}
	let originMain;
	try {
		originMain = commitFor(repoRoot, "origin/main", "origin/main");
	} catch {
		if (hasParent(repoRoot, headCommit)) {
			throw new Error(
				`cannot select a new remote ref from ${headCommit}: origin/main is unavailable and the branch is not an initial repository`,
			);
		}
		return filesInDiff(repoRoot, EMPTY_TREE_SHA, headCommit);
	}
	const mergeBase = runGit(repoRoot, ["merge-base", headCommit, originMain]);
	return filesInDiff(repoRoot, `${mergeBase}...${headCommit}`);
}
