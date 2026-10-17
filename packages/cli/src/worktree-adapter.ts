import { execFileSync } from "node:child_process";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	existsSync,
	appendFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";

export interface WorktreeRequest {
	workItemId: string;
	attemptId: string;
	agentSession: string;
	cwd?: string;
	root?: string;
}

export interface ProvisionedWorktree {
	path: string;
	branch: string;
	reused: boolean;
}

interface WorktreeMarker {
	version: 1;
	workItemId: string;
	attemptId: string;
	agentSession: string;
	branch: string;
}

const MARKER_SUFFIX = ".tedix.json";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: detachedGitEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function safeSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function canonicalProspectivePath(path: string): string {
	const tail: string[] = [];
	let cursor = resolve(path);
	while (!existsSync(cursor)) {
		tail.unshift(basename(cursor));
		const parent = dirname(cursor);
		if (parent === cursor) break;
		cursor = parent;
	}
	return resolve(realpathSync(cursor), ...tail);
}

function markerAt(path: string): WorktreeMarker | null {
	try {
		const value = JSON.parse(
			readFileSync(`${path}${MARKER_SUFFIX}`, "utf8"),
		) as WorktreeMarker;
		return value.version === 1 ? value : null;
	} catch {
		return null;
	}
}

function sameMarker(left: WorktreeMarker, right: WorktreeMarker): boolean {
	return (
		left.workItemId === right.workItemId &&
		left.attemptId === right.attemptId &&
		left.agentSession === right.agentSession &&
		left.branch === right.branch
	);
}

/**
 * Provision an isolated local Git adapter after authoritative admission.
 * The marker is advisory correlation data; it is never an Attempt credential.
 */
export function provisionAttemptWorktree(
	request: WorktreeRequest,
): ProvisionedWorktree {
	const cwd = resolve(request.cwd ?? process.cwd());
	const repo = realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
	const commonDir = realpathSync(
		resolve(repo, git(repo, ["rev-parse", "--git-common-dir"])),
	);
	const primaryRepo = dirname(commonDir);
	const suffix = `${request.workItemId.slice(0, 8)}-${request.attemptId.slice(0, 8)}`;
	const harness =
		safeSegment(request.agentSession.split(":", 1)[0] ?? "agent") || "agent";
	const branch = `${harness}/work-${suffix}`;
	const root = canonicalProspectivePath(
		request.root ?? join(primaryRepo, ".worktrees"),
	);
	const path = join(root, suffix);
	const marker = `${path}${MARKER_SUFFIX}`;
	const rootFromRepo = relative(primaryRepo, root);
	if (
		!rootFromRepo.startsWith("..") &&
		!isAbsolute(rootFromRepo) &&
		rootFromRepo !== ".worktrees" &&
		!rootFromRepo.startsWith(".worktrees/")
	) {
		throw new Error(
			"Worktree root inside the repository must be under .worktrees",
		);
	}
	const expected: WorktreeMarker = {
		version: 1,
		workItemId: request.workItemId,
		attemptId: request.attemptId,
		agentSession: request.agentSession,
		branch,
	};

	if (existsSync(path)) {
		const marker = markerAt(path);
		if (!marker || !sameMarker(marker, expected)) {
			throw new Error(
				`Refusing to reuse ${path}: it is not owned by this exact Work Item, Attempt, and Agent-Session`,
			);
		}
		const actualRepo = realpathSync(
			git(path, ["rev-parse", "--show-toplevel"]),
		);
		const actualBranch = git(path, ["branch", "--show-current"]);
		if (actualRepo !== realpathSync(path) || actualBranch !== branch) {
			throw new Error(
				`Refusing to reuse ${path}: Git worktree identity drifted`,
			);
		}
		return { path, branch, reused: true };
	}
	if (existsSync(marker)) {
		throw new Error(
			`Refusing to create ${path}: its correlation sidecar already exists`,
		);
	}

	if (rootFromRepo === ".worktrees" || rootFromRepo.startsWith(".worktrees/")) {
		const exclude = join(commonDir, "info", "exclude");
		mkdirSync(dirname(exclude), { recursive: true });
		const existing = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
		if (!existing.split("\n").includes("/.worktrees/")) {
			appendFileSync(exclude, "\n/.worktrees/\n");
		}
	}
	mkdirSync(root, { recursive: true });
	git(primaryRepo, ["worktree", "add", "-b", branch, path, "origin/main"]);
	const temp = `${marker}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(expected, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temp, marker);
	return { path, branch, reused: false };
}

export interface WorktreeCleanupRequest {
	workItemId: string;
	agentSession: string;
	attemptId?: string;
	cwd?: string;
}

export interface WorktreeCleanupResult {
	path: string;
	removed: boolean;
	reason?: string;
}

/** Called only after the board confirms a terminal lifecycle operation. */
export function cleanupAttemptWorktrees(
	request: WorktreeCleanupRequest,
): WorktreeCleanupResult[] {
	const cwd = resolve(request.cwd ?? process.cwd());
	const commonDir = realpathSync(
		resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"])),
	);
	const primaryRepo = dirname(commonDir);
	const entries = git(primaryRepo, ["worktree", "list", "--porcelain", "-z"])
		.split("\0\0")
		.map((block) => block.split("\0"));
	const results: WorktreeCleanupResult[] = [];
	let fetched = false;
	for (const entry of entries) {
		const path = entry.find((line) => line.startsWith("worktree "))?.slice(9);
		if (!path || path === primaryRepo) continue;
		const marker = markerAt(path);
		if (
			!marker ||
			marker.workItemId !== request.workItemId ||
			marker.agentSession !== request.agentSession ||
			(request.attemptId && marker.attemptId !== request.attemptId)
		)
			continue;
		try {
			if (
				entry.some((line) => line === "locked" || line.startsWith("locked "))
			) {
				throw new Error("worktree is locked");
			}
			if (git(path, ["branch", "--show-current"]) !== marker.branch) {
				throw new Error("worktree branch differs from its marker");
			}
			if (git(path, ["status", "--porcelain", "--untracked-files=all"])) {
				throw new Error("worktree has local changes");
			}
			if (!fetched) {
				git(primaryRepo, [
					"fetch",
					"origin",
					"+refs/heads/main:refs/remotes/origin/main",
				]);
				fetched = true;
			}
			git(primaryRepo, [
				"merge-base",
				"--is-ancestor",
				git(path, ["rev-parse", "HEAD"]),
				"origin/main",
			]);
			// Keep this CLI process in an existing directory when settling from the worktree.
			const current = relative(path, process.cwd());
			if (
				current === "" ||
				(!current.startsWith("..") && !isAbsolute(current))
			) {
				process.chdir(primaryRepo);
			}
			git(primaryRepo, ["worktree", "remove", path]);
			unlinkSync(`${path}${MARKER_SUFFIX}`);
			results.push({ path, removed: true });
		} catch (error) {
			results.push({
				path,
				removed: false,
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return results;
}
