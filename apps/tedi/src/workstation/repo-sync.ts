import type { WorkstationRepoStrategy } from "@tedix/api-contract/schemas/workstation";
import type { TediConfig } from "../types";
import {
	WorkstationDispatchUnknownError,
	workstationExec,
	workstationExecutionStatus,
	withWorkstationObservationDeadline,
	type WorkstationExecResult,
	type WorkstationRuntimeBody,
} from "./computer-body";
import { startCheckoutOperation } from "./checkout-lock";
import { WORKSTATION_REPOS_DIR } from "./paths";

const DEFAULT_REPO_MARKER_FILE = ".git/tedix-workstation-repo.json";
const DEFAULT_REPO_STRATEGY = "clone" satisfies WorkstationRepoStrategy;

export type RepoSyncOptions = {
	authorize?: () => Promise<void>;
	originalPreflight?: RepoTreePreflight;
	markerFile?: string;
	repoStrategy?: WorkstationRepoStrategy;
	reposRoot?: string;
	/** Label recorded on a quarantine commit made by this sync. */
	turnKey?: string;
	workdirSource?: "configured-or-derived" | "derived";
};

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertSafePathSegment(value: string, label: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		throw new Error(`Unsafe ${label} in repository URL: ${value}`);
	}
	return value;
}

function normalizeReposRoot(reposRoot: string): string {
	const normalized = reposRoot.replace(/\/+$/g, "");
	if (!normalized.startsWith("/") || normalized.split("/").includes("..")) {
		throw new Error(`Invalid repository root: ${reposRoot}`);
	}
	return normalized;
}

function deriveRepoWorkdir(repoUrl: string, reposRoot: string): string {
	const url = new URL(repoUrl);
	const parts = url.pathname
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	if (parts.length < 2) {
		throw new Error(`Cannot derive repository worktree path from ${repoUrl}`);
	}
	const owner = assertSafePathSegment(parts[parts.length - 2]!, "owner");
	const repo = assertSafePathSegment(parts[parts.length - 1]!, "repo");
	return `${reposRoot}/${owner}/${repo}`;
}

function validateRepoWorkdir(workdir: string, reposRoot: string): string {
	const normalized = workdir.replace(/\/+$/g, "");
	if (!normalized.startsWith(`${reposRoot}/`)) {
		throw new Error(`Repository worktree path must live under ${reposRoot}`);
	}
	if (normalized.split("/").includes("..")) {
		throw new Error("Repository worktree path must not contain '..'");
	}
	return normalized;
}

function resolveRepoWorkdir(
	repo: NonNullable<TediConfig["repoConfig"]>,
	reposRoot: string,
	workdirSource: NonNullable<RepoSyncOptions["workdirSource"]>,
): string {
	return validateRepoWorkdir(
		workdirSource === "derived"
			? deriveRepoWorkdir(repo.repoUrl, reposRoot)
			: repo.worktreePath || deriveRepoWorkdir(repo.repoUrl, reposRoot),
		reposRoot,
	);
}

function repoMarkerContent(
	tediConfig: TediConfig,
	repo: NonNullable<TediConfig["repoConfig"]>,
	repoStrategy: WorkstationRepoStrategy,
	workdir: string,
): string {
	return `${JSON.stringify(
		{
			tediId: tediConfig.id,
			slug: tediConfig.slug,
			repoUrl: repo.repoUrl,
			branch: repo.branch || "main",
			canonicalPath: workdir,
			repoStrategy,
		},
		null,
		2,
	)}\n`;
}

function validateRepoBranch(branch: string): string {
	if (
		!branch ||
		branch.startsWith("-") ||
		branch.startsWith("/") ||
		branch.endsWith("/") ||
		branch.endsWith(".lock") ||
		branch.includes("..") ||
		branch.includes("@{") ||
		branch.includes("\\") ||
		!/^[A-Za-z0-9._/-]+$/.test(branch)
	) {
		throw new Error(`Unsafe repository branch: ${branch}`);
	}
	return branch;
}

export type RepoSyncResult =
	| {
			configured: false;
			strategy: WorkstationRepoStrategy;
			status: "not_configured";
	  }
	| {
			branch: string;
			configured: true;
			repoUrl: string;
			strategy: WorkstationRepoStrategy;
			status:
				| "cloned"
				| "dirty"
				| "failed"
				| "refused"
				| "skipped_credentials"
				| "syncing"
				| "unsupported_strategy"
				| "updated";
			workdir: string;
			error?: string;
			executionId?: string;
			executionState?: "admitting" | "missing" | "running" | "terminal";
			orphanedPath?: string;
			treePreflight?: RepoTreePreflight;
	  };

/**
 * Wall-clock budget enforced by Cloudflare Sandbox's retained execution for
 * the initial shallow clone. The caller never waits on this budget: it starts
 * or reattaches to the stable execution and returns `syncing` immediately.
 */
export const REPO_CLONE_TIMEOUT_MS = 20 * 60_000;

function repoStrategyFromOptions(
	options: RepoSyncOptions,
): WorkstationRepoStrategy {
	return options.repoStrategy ?? DEFAULT_REPO_STRATEGY;
}

function unsupportedRepoStrategyResult(input: {
	branch: string;
	repoUrl: string;
	strategy: WorkstationRepoStrategy;
	workdir: string;
}): RepoSyncResult {
	return {
		branch: input.branch,
		configured: true,
		error: `Repo strategy ${input.strategy} is not supported by the Cloudflare Sandbox workstation backend yet; use clone fallback`,
		repoUrl: input.repoUrl,
		status: "unsupported_strategy",
		strategy: input.strategy,
		workdir: input.workdir,
	};
}

async function nativeExecOrThrow(
	sandbox: WorkstationRuntimeBody,
	command: string,
	options: { timeout?: number },
): Promise<WorkstationExecResult> {
	const result = await withWorkstationObservationDeadline(
		() => workstationExec(sandbox, command, options),
		{
			timeoutMs: options.timeout,
			operation: "repo sync command",
		},
	);
	if (
		result.exitCode !== 0 ||
		result.timedOut ||
		result.signal !== undefined ||
		result.truncated
	) {
		const detail = result.stderr || result.stdout || "no output";
		const timeoutHint = result.timedOut
			? " (command timed out; Sandbox observation completed successfully)"
			: "";
		throw new Error(
			`Cloudflare Sandbox command failed with exitCode=${result.exitCode}${timeoutHint}: ${command}\n${detail}`,
		);
	}
	return result;
}

type RepoCloneExecution = {
	branch: string;
	processId: string;
	repoUrl: string;
	startedAt: string;
};

function repoCloneExecutionPath(workdir: string): string {
	return `${workdir}.sync-process.json`;
}

async function readRepoCloneExecution(
	sandbox: WorkstationRuntimeBody,
	workdir: string,
): Promise<RepoCloneExecution | null> {
	try {
		const result = await nativeExecOrThrow(
			sandbox,
			`cat ${shellSingleQuote(repoCloneExecutionPath(workdir))} 2>/dev/null || { [ ! -e ${shellSingleQuote(repoCloneExecutionPath(workdir))} ] || exit 1; }`,
			{ timeout: 5_000 },
		);
		const raw = (result.stdout ?? "").trim();
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object")
			throw new Error("Invalid clone launch identity");
		const record = parsed as Partial<RepoCloneExecution>;
		return typeof record.branch === "string" &&
			typeof record.processId === "string" &&
			typeof record.repoUrl === "string" &&
			typeof record.startedAt === "string"
			? (record as RepoCloneExecution)
			: (() => {
					throw new Error("Invalid clone launch identity");
				})();
	} catch (error) {
		throw new Error("Clone launch identity unavailable", { cause: error });
	}
}

async function observeRepoCloneExecution(
	sandbox: WorkstationRuntimeBody,
	input: { branch: string; repoUrl: string; workdir: string },
): Promise<
	| { processId: string; state: "admitting" | "running" }
	| {
			exitCode: number;
			processId: string;
			state: "terminal";
			stderr: string;
			stdout: string;
	  }
	| null
> {
	const execution = await readRepoCloneExecution(sandbox, input.workdir);
	if (!execution) return null;
	const status = await workstationExecutionStatus(
		sandbox,
		execution.processId,
		{ includeLogs: true },
	).catch(() => ({
		exitCode: null,
		found: false,
		running: false,
		stderr: "",
		stdout: "",
		timedOut: false,
		signal: undefined,
		terminal: false,
	}));
	if (execution.branch !== input.branch || execution.repoUrl !== input.repoUrl)
		throw new Error(
			"Prior clone repository identity changed; refusing replacement",
		);

	if (!status.found) {
		// An absent capability cannot prove whether a previously dispatched
		// clone is still writing. Keep its identity and refuse automatic replay.
		return { processId: execution.processId, state: "admitting" };
	}
	if (status.running || !status.terminal) {
		return { processId: execution.processId, state: "running" };
	}
	return {
		exitCode:
			status.timedOut || status.signal !== undefined
				? 1
				: (status.exitCode ?? 1),
		processId: execution.processId,
		state: "terminal",
		stderr: status.stderr ?? "",
		stdout: status.stdout ?? "",
	};
}

function isGitCredentialUnavailableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /fatal: could not read Username for 'https:\/\/github\.com'|authentication failed|repository not found/i.test(
		message,
	);
}

function repoSyncErrorMarkerPath(workdir: string): string {
	return `${workdir}.sync-error.json`;
}
async function readRepoSyncErrorMarker(
	sandbox: WorkstationRuntimeBody,
	workdir: string,
): Promise<{ at?: string; error?: string; status?: string } | null> {
	try {
		const result = await nativeExecOrThrow(
			sandbox,
			`cat ${shellSingleQuote(repoSyncErrorMarkerPath(workdir))} 2>/dev/null || true`,
			{ timeout: 5_000 },
		);
		const raw = (result.stdout ?? "").trim();
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		return parsed as { at?: string; error?: string; status?: string };
	} catch {
		return null;
	}
}

/**
 * Outcome of the clean-tree preflight the runtime performs before a delegated
 * coding turn is allowed to touch the shared workstation checkout.
 *
 * - `clean`      — the tree was already provably empty; nothing was touched.
 * - `quarantined` — leftovers were committed to a rescue branch first, then the
 *   tree was reset to the fetched base. Nothing was destroyed.
 * - `refused`    — the tree could not be made provably clean (or quarantine
 *   itself failed). The turn must not proceed; `reason` is model-visible.
 */
export type RepoTreePreflightOutcome = "clean" | "quarantined" | "refused";

export type RepoTreePreflight = {
	at: string;
	branch: string;
	outcome: RepoTreePreflightOutcome;
	workdir: string;
	/** Stable digest of the porcelain lines that were found dirty. */
	fingerprint?: string;
	quarantinedPaths?: number;
	reason?: string;
	rescueBranch?: string;
	/**
	 * The sha this checkout was prepared at — the fetched `origin/<branch>` tip
	 * the turn is allowed to build on. Recorded into the checkout's git config
	 * so the pre-push hook can refuse a branch that does not descend from it.
	 * Present only on a non-refused outcome.
	 */
	startSha?: string;
	turnKey?: string;
	/** Returned by the native transaction, never trusted from persisted marker bytes. */
	authoritySource?:
		| "fresh_preparation"
		| "observed_marker"
		| "restored_authority";
};

/** All Git decisions and mutations run under one native checkout operation. */
const REPO_TRANSACTION = String.raw`
const fs = require("node:fs"),
	path = require("node:path"),
	cp = require("node:child_process");
const i = JSON.parse(process.argv[1]),
	w = i.workdir;
function git(args, tolerated = false, timeout = 60000) {
	const r = cp.spawnSync("git", ["-C", w, ...args], {
		encoding: "utf8",
		timeout,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (r.error || r.signal || r.status === null)
		throw new Error(
			"Git transaction output unavailable: " + (r.error?.message || r.signal),
		);
	if (r.status !== 0 && !tolerated)
		throw new Error(r.stderr || r.stdout || "git exited " + r.status);
	return r;
}
function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}
function write(file, value) {
	const tmp = file + "." + i.nonce + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(value) + "\n", {
		flag: "wx",
		mode: 0o600,
	});
	fs.renameSync(tmp, file);
}
function status() {
	return git([
		"-c",
		"core.fsmonitor=false",
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
	]).stdout.trim();
}
// Read-only fast path: a current native checkout, not a persisted ready flag.
function settledPreflight() {
 const marker = read(w + ".tree-preflight.json");
 if (!marker) return null;
 if (typeof marker.turnKey !== "string" || typeof marker.workdir !== "string" || typeof marker.branch !== "string" || !["clean", "quarantined", "refused"].includes(marker.outcome))
  throw new Error("Invalid native preflight marker");
 if (marker.turnKey !== i.turnKey) {
  if (i.original?.turnKey === i.turnKey) throw new Error("Native prepared base does not match task authority");
  return null;
 }
 if (i.original?.turnKey === i.turnKey && (i.original.workdir !== w || i.original.branch !== i.branch)) throw new Error("Original prepared repository identity mismatch");
 if (marker.workdir !== w || marker.branch !== i.branch) throw new Error("Native preflight repository identity mismatch");
 // A refused/in-progress claim never grants permission to reset again.
 if (marker.outcome === "refused") return {...marker, authoritySource: "observed_marker"};
 if (!/^[a-f0-9]{40}$/.test(marker.startSha) ||
  (i.original?.turnKey === i.turnKey && marker.startSha !== i.original.startSha))
  throw new Error("Native prepared base does not match task authority");
 if (!fs.existsSync(path.join(w, ".git"))) return null;
 if (git(["rev-parse", "--is-inside-work-tree"]).stdout.trim() !== "true") throw new Error("Native checkout is not a work tree");
 const prepared = git(["config", "--get", "tedix.preparedStartSha"], true);
 if (prepared.status === 1) return null;
 if (prepared.status !== 0 || prepared.stdout.trim() !== marker.startSha)
  throw new Error("Native checkout no longer proves its prepared base");
 // HEAD and dirty paths may legitimately have changed during this turn.
 git(["cat-file", "-e", marker.startSha + "^{commit}"]);
 return {...marker, authoritySource: "observed_marker"};
}
function preflight(perTurn) {
 if (perTurn) { const settled = settledPreflight(); if (settled) return settled; }
	const marker = w + ".tree-preflight.json",
		previous = read(marker);
	if (i.original?.turnKey === i.turnKey) {
		if (previous) {
			if (
				previous.turnKey !== i.turnKey ||
				previous.startSha !== i.original.startSha
			)
				throw new Error("Native prepared base does not match task authority");
		}
		const original = i.original;
		if (!/^[a-f0-9]{40}$/.test(original.startSha))
			throw new Error("Invalid original prepared base");
		if (status()) throw new Error("refusing replacement over dirty checkout");
		if (
			git(["rev-parse", "HEAD"]).stdout !==
			git(["rev-parse", "refs/remotes/origin/" + original.branch]).stdout
		)
			throw new Error("refusing replacement over unrelated HEAD");
		if (
			git(["cat-file", "-e", original.startSha + "^{commit}"], true).status !==
			0
		)
			git(["fetch", "--no-tags", "origin", original.startSha]);
		git([
			"-c",
			"core.hooksPath=/dev/null",
			"checkout",
			"--detach",
			"--no-overwrite-ignore",
			original.startSha,
		]);
		git(["config", "tedix.preparedStartSha", original.startSha]);
		write(marker, original);
		return {...original, authoritySource: "restored_authority"};
	}
	if (perTurn && previous?.turnKey === i.turnKey) throw new Error("Native prepared base unavailable for same-turn restoration");
 const base = {
		at: i.at,
		branch: i.branch,
		outcome: "refused",
		reason: "clean-tree preflight did not complete",
		turnKey: i.turnKey,
		workdir: w,
	};
	if (perTurn) write(marker, base);
	let fingerprint, quarantinedPaths, rescueBranch;
	try {
		const cleared = git(
			["config", "--unset-all", "tedix.preparedStartSha"],
			true,
		);
		if (cleared.status !== 0 && cleared.status !== 5)
			throw new Error("could not revoke previous prepared start");
		const dirty = status();
		if (dirty) {
			const lines = dirty
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
			quarantinedPaths = lines.length;
			let hash = 0x811c9dc5;
			const sorted = lines.sort().join("\n");
			for (let n = 0; n < sorted.length; n++) {
				hash ^= sorted.charCodeAt(n);
				hash = Math.imul(hash, 0x01000193) >>> 0;
			}
			fingerprint = hash.toString(16).padStart(8, "0");
			const symbolic = git(
				["symbolic-ref", "--quiet", "--short", "HEAD"],
				true,
			);
			const previousRef = (
				symbolic.status === 0
					? symbolic.stdout
					: git(["rev-parse", "HEAD"]).stdout
			).trim();
			const segment =
				i.turnKey
					.trim()
					.replace(/[^A-Za-z0-9._-]+/g, "-")
					.replace(/^[-.]+|[-.]+$/g, "")
					.slice(0, 64) || "run";
			const rescue =
				"tedi/rescue/" + segment + "/" + i.at.replace(/[:.]/g, "-");
			git(["checkout", "-b", rescue]);
			git(["add", "-A"]);
			const trailers = [
				"Quarantined-From: " + previousRef,
				"Workstation-Run: " + i.turnKey,
				...(i.workItemId ? ["Work-Item: " + i.workItemId] : []),
				"Tree-Fingerprint: " + fingerprint,
			].join("\n");
			git([
				"-c",
				"user.name=Tedix Workstation",
				"-c",
				"user.email=workstation@tedix.dev",
				"commit",
				"--no-verify",
				"-m",
				"chore(workstation): quarantine dirty checkout " + fingerprint,
				"-m",
				trailers,
			]);
			rescueBranch = rescue;
			git(["checkout", previousRef]);
		}
		git(["fetch", "origin", i.branch]);
		if (git(["checkout", i.branch], true).status !== 0)
			git(["checkout", "-b", i.branch, "--track", "origin/" + i.branch]);
		git(["reset", "--hard", "origin/" + i.branch]);
		const first = git(["clean", "-ffd"], true);
		const failed = new Set();
		for (const line of (first.stdout + "\n" + first.stderr).split("\n")) {
			const p = /failed to remove\s+(.+?)\s*$/.exec(line)?.[1];
			if (p && !p.includes("..") && !p.startsWith("/"))
				failed.add(p.replace(/\/+$/, ""));
		}
		for (const p of failed)
			fs.rmSync(path.join(w, p), { recursive: true, force: true });
		if (failed.size) git(["clean", "-ffd"], true);
		const remaining = status();
		if (remaining)
			throw new Error(
				"checkout is STILL dirty after reset and clean: " +
					remaining.split("\n").slice(0, 10).join("; "),
			);
		const startSha = git(["rev-parse", "HEAD"]).stdout.trim();
		if (!/^[a-f0-9]{40}$/.test(startSha))
			throw new Error("Invalid prepared HEAD");
		git(["config", "core.hooksPath", ".githooks"]);
		git(["config", "tedix.workstationCheckout", "true"]);
		git(["config", "tedix.preparedBranch", i.branch]);
		git(["config", "tedix.preparedStartSha", startSha]);
		const result = {
			...base,
			outcome: rescueBranch ? "quarantined" : "clean",
			reason: undefined,
			startSha,
			fingerprint,
			quarantinedPaths,
			rescueBranch,
		};
		if (perTurn) write(marker, result);
		return {...result, authoritySource: "fresh_preparation"};
	} catch (e) {
		try {
			git(["config", "--unset-all", "tedix.preparedStartSha"], true);
		} catch {}
		const result = {
			...base,
			fingerprint,
			quarantinedPaths,
			rescueBranch,
			reason:
				"workstation checkout could not be verified clean: " +
				e.message +
				". The turn must not start from this tree.",
		};
		if (perTurn) {
			try {
				write(marker, result);
			} catch {}
		}
		return result;
	}
}
function main() {
 if (i.mode === "observe-preflight") return settledPreflight();
	if (i.mode === "preflight") return preflight(true);
	const marker = w + ".sync-process.json",
		existing = read(marker);
	if (
		existing &&
		(!existing.processId || !existing.branch || !existing.repoUrl)
	)
		throw new Error("Invalid clone launch identity");
	if (i.mode === "clone") {
		if (
			!existing ||
			existing.processId !== i.processId ||
			existing.repoUrl !== i.repoUrl ||
			existing.branch !== i.branch
		)
			throw new Error("Clone authority changed");
		if (fs.existsSync(w))
			throw new Error(
				"Clone destination appeared after admission; preserving it",
			);
		const r = cp.spawnSync(
			"git",
			[
				"clone",
				"--depth",
				"1",
				"--single-branch",
				"--no-tags",
				"--branch",
				i.branch,
				i.repoUrl,
				w,
			],
			{ stdio: "inherit" },
		);
		if (r.error || r.signal || r.status !== 0) process.exit(r.status || 1);
		return { cloned: true };
	}
	if (existing && existing.processId !== i.terminalId)
		return {
			status: "syncing",
			executionId: existing.processId,
			executionState: "admitting",
		};
	if (
		existing &&
		(existing.repoUrl !== i.repoUrl || existing.branch !== i.branch)
	)
		throw new Error(
			"Prior clone repository identity changed; refusing replacement",
		);
	const isGit =
		fs.existsSync(path.join(w, ".git")) &&
		git(["rev-parse", "--is-inside-work-tree"], true).status === 0;
	if (isGit) {
		git(["remote", "set-url", "origin", i.repoUrl]);
		const treePreflight = preflight(false);
		if (treePreflight.outcome === "refused") {
			write(w + ".sync-error.json", {
				at: i.at,
				error: treePreflight.reason,
				status: "refused",
			});
			return { status: "refused", error: treePreflight.reason, treePreflight };
		}
		git(["config", "core.hooksPath", ".githooks"]);
		git(["config", "tedix.workstationCheckout", "true"]);
		fs.rmSync(w + ".sync-error.json", { force: true });
		fs.rmSync(marker, { force: true });
		write(path.join(w, i.markerFile), i.repoMarker);
		return { status: "updated", treePreflight };
	}
	if (existing)
		throw new Error(
			"Terminal clone did not produce a verified Git worktree; preserving its identity",
		);
	fs.mkdirSync(path.dirname(w), { recursive: true });
	let orphanedPath;
	if (fs.existsSync(w)) {
		orphanedPath = w + ".orphan." + i.nonce;
		fs.renameSync(w, orphanedPath);
	}
	write(marker, {
		branch: i.branch,
		processId: i.processId,
		repoUrl: i.repoUrl,
		startedAt: i.at,
	});
	return {
		status: "syncing",
		executionId: i.processId,
		executionState: "admitting",
		needsClone: true,
		orphanedPath,
	};
}
try {
	console.log(JSON.stringify(main()));
} catch (e) {
	console.error(e.message);
	process.exitCode = 1;
}
`;

function repoTransactionCommand(input: Record<string, unknown>): string {
	return `bun -e ${shellSingleQuote(REPO_TRANSACTION)} ${shellSingleQuote(JSON.stringify({ ...input, nonce: crypto.randomUUID() }))}`;
}

async function runRepoTransaction<T>(
	body: WorkstationRuntimeBody,
	input: Record<string, unknown>,
	authorize: () => Promise<void>,
	mode: "shared" | "exclusive" = "exclusive",
): Promise<T> {
	const operation = await startCheckoutOperation(body, {
		command: repoTransactionCommand(input),
		mode,
		timeout: 360000,
		authorize,
	});
	const result = await operation.process
		.output({ encoding: "utf8", maxBytes: 1024 * 1024, timeout: 375000 })
		.catch(() => {
			throw new WorkstationDispatchUnknownError(operation.id);
		});
	if (
		result.exitCode !== 0 ||
		result.truncated ||
		result.timedOut ||
		result.signal !== undefined
	)
		throw new Error(result.stderr || "Repository transaction failed");
	return JSON.parse(result.stdout) as T;
}

export async function ensureCleanRepoTreeForTurn(
	sandbox: WorkstationRuntimeBody,
	tediConfig: TediConfig,
	options: RepoSyncOptions & {
		turnKey: string;
		now?: Date;
		workItemId?: string | null;
	},
): Promise<RepoTreePreflight | null> {
	const repo = tediConfig.repoConfig;
	if (!repo || repoStrategyFromOptions(options) !== "clone") return null;
	const workdir = resolveRepoWorkdir(
		repo,
		normalizeReposRoot(options.reposRoot ?? WORKSTATION_REPOS_DIR),
		options.workdirSource ?? "configured-or-derived",
	);
	const branch = validateRepoBranch(repo.branch || "main");
	const input = {
		workdir,
		branch,
		turnKey: options.turnKey,
		at: (options.now ?? new Date()).toISOString(),
		workItemId: options.workItemId,
		original: options.originalPreflight,
	};
	const authorize = options.authorize ?? (async () => {});
	const observed = await runRepoTransaction<RepoTreePreflight | null>(
		sandbox,
		{ ...input, mode: "observe-preflight" },
		authorize,
		"shared",
	);
	if (observed) return observed;
	// The shared process has exited. The exclusive transaction rechecks all state.
	return runRepoTransaction(
		sandbox,
		{ ...input, mode: "preflight" },
		authorize,
	);
}

export async function syncRepoIfConfigured(
	sandbox: WorkstationRuntimeBody,
	tediConfig: TediConfig,
	options: RepoSyncOptions = {},
): Promise<RepoSyncResult> {
	const strategy = repoStrategyFromOptions(options),
		repo = tediConfig.repoConfig;
	if (!repo) return { configured: false, status: "not_configured", strategy };
	let workdir = "",
		branch = "";
	try {
		workdir = resolveRepoWorkdir(
			repo,
			normalizeReposRoot(options.reposRoot ?? WORKSTATION_REPOS_DIR),
			options.workdirSource ?? "configured-or-derived",
		);
		branch = validateRepoBranch(repo.branch || "main");
		const base = {
			configured: true as const,
			branch,
			workdir,
			repoUrl: repo.repoUrl,
			strategy,
		};
		if (strategy !== "clone") return unsupportedRepoStrategyResult(base);
		const observed = await observeRepoCloneExecution(sandbox, {
			branch,
			workdir,
			repoUrl: repo.repoUrl,
		});
		if (observed?.state === "admitting" || observed?.state === "running")
			return {
				...base,
				status: "syncing",
				executionId: observed.processId,
				executionState: observed.state,
			};
		if (observed?.state === "terminal" && observed.exitCode !== 0)
			return {
				...base,
				status: isGitCredentialUnavailableError(
					observed.stderr || observed.stdout,
				)
					? "skipped_credentials"
					: "failed",
				executionId: observed.processId,
				executionState: "terminal",
				error: observed.stderr || observed.stdout || "Native clone failed",
			};
		const processId = `repo-clone-${crypto.randomUUID()}`;
		const input = {
			mode: "sync",
			workdir,
			branch,
			repoUrl: repo.repoUrl,
			turnKey: options.turnKey ?? "repo-sync",
			at: new Date().toISOString(),
			markerFile: options.markerFile ?? DEFAULT_REPO_MARKER_FILE,
			repoMarker: JSON.parse(
				repoMarkerContent(tediConfig, repo, strategy, workdir),
			),
			processId,
			terminalId: observed?.processId,
		};
		const result = await runRepoTransaction<
			Extract<RepoSyncResult, { configured: true }> & { needsClone?: boolean }
		>(sandbox, input, options.authorize ?? (async () => {}));
		if (result.needsClone) {
			try {
				await startCheckoutOperation(sandbox, {
					command: repoTransactionCommand({ ...input, mode: "clone" }),
					executionId: processId,
					timeout: REPO_CLONE_TIMEOUT_MS,
					authorize: options.authorize ?? (async () => {}),
				});
			} catch (error) {
				return {
					...base,
					status: "syncing",
					executionId: processId,
					executionState: "admitting",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			return {
				...base,
				status: "syncing",
				executionId: processId,
				executionState: "running",
				orphanedPath: result.orphanedPath,
			};
		}
		return { ...base, ...result };
	} catch (error) {
		return {
			configured: true,
			branch,
			workdir,
			repoUrl: repo.repoUrl,
			strategy,
			status:
				error instanceof WorkstationDispatchUnknownError
					? "syncing"
					: isGitCredentialUnavailableError(error)
						? "skipped_credentials"
						: "failed",
			...(error instanceof WorkstationDispatchUnknownError
				? {
						executionId: error.executionId,
						executionState: "admitting" as const,
					}
				: {}),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function readRepoSyncStatus(
	sandbox: WorkstationRuntimeBody,
	tediConfig: TediConfig,
	options: RepoSyncOptions = {},
): Promise<RepoSyncResult> {
	const repoStrategy = repoStrategyFromOptions(options);
	const repo = tediConfig.repoConfig;
	if (!repo) {
		return {
			configured: false,
			status: "not_configured",
			strategy: repoStrategy,
		};
	}

	const reposRoot = normalizeReposRoot(
		options.reposRoot ?? WORKSTATION_REPOS_DIR,
	);
	const workdirSource = options.workdirSource ?? "configured-or-derived";
	let workdir = "";
	let branch = "";
	try {
		workdir = resolveRepoWorkdir(repo, reposRoot, workdirSource);
		branch = validateRepoBranch(repo.branch || "main");
		if (repoStrategy !== "clone") {
			return unsupportedRepoStrategyResult({
				branch,
				repoUrl: repo.repoUrl,
				strategy: repoStrategy,
				workdir,
			});
		}
		const execution = await observeRepoCloneExecution(sandbox, {
			branch,
			repoUrl: repo.repoUrl,
			workdir,
		});
		if (execution?.state === "admitting" || execution?.state === "running") {
			return {
				branch,
				configured: true,
				executionId: execution.processId,
				executionState: execution.state,
				repoUrl: repo.repoUrl,
				status: "syncing",
				strategy: repoStrategy,
				workdir,
			};
		}
		const marker = await readRepoSyncErrorMarker(sandbox, workdir);
		if (marker?.error) {
			return {
				branch,
				configured: true,
				error: marker.at
					? `${marker.error} (recorded ${marker.at})`
					: marker.error,
				...(execution
					? {
							executionId: execution.processId,
							executionState: execution.state,
						}
					: {}),
				repoUrl: repo.repoUrl,
				status:
					marker.status === "skipped_credentials"
						? "skipped_credentials"
						: marker.status === "refused"
							? "refused"
							: "failed",
				strategy: repoStrategy,
				workdir,
			};
		}
		if (execution?.state === "terminal" && execution.exitCode !== 0) {
			const detail = execution.stderr || execution.stdout || "no output";
			return {
				branch,
				configured: true,
				error: `Cloudflare Sandbox clone failed with exitCode=${execution.exitCode}: ${repo.repoUrl}\n${detail}`,
				executionId: execution.processId,
				executionState: "terminal",
				repoUrl: repo.repoUrl,
				status: isGitCredentialUnavailableError(detail)
					? "skipped_credentials"
					: "failed",
				strategy: repoStrategy,
				workdir,
			};
		}
		const check = await nativeExecOrThrow(
			sandbox,
			`if [ -e ${shellSingleQuote(`${workdir}/.git`)} ] && git -C ${shellSingleQuote(workdir)} rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo "git"; else echo "missing"; fi`,
			{ timeout: 5_000 },
		);
		const state = (check.stdout ?? "").trim();
		if (state === "git") {
			// A successful clone still needs the exclusive sync finalizer to
			// configure the checkout and remove its retained execution marker.
			// Keep wake scheduling that writer before native process evidence expires.
			if (execution?.state === "terminal") {
				return {
					branch,
					configured: true,
					executionId: execution.processId,
					executionState: "terminal",
					repoUrl: repo.repoUrl,
					status: "syncing",
					strategy: repoStrategy,
					workdir,
				};
			}
			return {
				branch,
				configured: true,
				repoUrl: repo.repoUrl,
				status: "updated",
				strategy: repoStrategy,
				workdir,
			};
		}
		if (execution?.state === "terminal") {
			return {
				branch,
				configured: true,
				error: `Cloudflare Sandbox clone ${execution.processId} exited successfully but ${workdir} is not a Git worktree`,
				executionId: execution.processId,
				executionState: "terminal",
				repoUrl: repo.repoUrl,
				status: "failed",
				strategy: repoStrategy,
				workdir,
			};
		}
		return {
			branch,
			configured: true,
			...(execution
				? {
						executionId: execution.processId,
						executionState: execution.state,
					}
				: { executionState: "missing" as const }),
			repoUrl: repo.repoUrl,
			status: "syncing",
			strategy: repoStrategy,
			workdir,
		};
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		return {
			branch,
			configured: true,
			error,
			repoUrl: repo.repoUrl,
			status: "failed",
			strategy: repoStrategy,
			workdir: workdir || "",
		};
	}
}
