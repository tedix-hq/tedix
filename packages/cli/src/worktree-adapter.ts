import { execFileSync } from "node:child_process";
import { detachedGitEnv } from "../../../scripts/oss/git-env";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
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
	const repoName = safeSegment(basename(primaryRepo)) || "repo";
	const suffix = `${request.workItemId.slice(0, 8)}-${request.attemptId.slice(0, 8)}`;
	const harness =
		safeSegment(request.agentSession.split(":", 1)[0] ?? "agent") || "agent";
	const branch = `${harness}/work-${suffix}`;
	const root = canonicalProspectivePath(
		request.root ?? join(dirname(primaryRepo), ".tedix-worktrees", repoName),
	);
	const path = join(root, suffix);
	const marker = `${path}${MARKER_SUFFIX}`;
	const rootFromRepo = relative(primaryRepo, root);
	if (!rootFromRepo.startsWith("..") && !isAbsolute(rootFromRepo)) {
		throw new Error("Worktree root must be outside the primary repository");
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
