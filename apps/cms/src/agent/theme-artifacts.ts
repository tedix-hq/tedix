import { type CmsSandbox, type CmsJobClient } from "../sandbox";
import {
	startCmsJob,
	getCmsJob,
	readCmsProcessLogs,
	cmsProcessStartedAt,
	cmsProcessDurationMs,
	cmsProcessExitCode,
	cmsProcessOutcome,
} from "./preview-exec-runner";
import { isPathEditable } from "./constraints";
import themeArtifactAuthor from "./theme-artifact-author.json";

/** Resolve immutable Git objects without creating tokens or touching a Sandbox. */
export async function readThemeArtifactTree(
	repo: ArtifactsRepo,
	commit: string,
) {
	const metadata = await repo.readCommit(commit);
	if (
		!metadata ||
		metadata.hash !== commit ||
		!/^[a-f0-9]{40}$/.test(metadata.treeHash)
	)
		throw new Error("Artifacts commit unavailable");
	return metadata.treeHash;
}

export async function readThemeArtifactTreeEntries(
	repo: ArtifactsRepo,
	hash: string,
) {
	const entries = await repo.readTree(hash);
	if (!entries) throw new Error("Artifacts tree unavailable");
	const names = new Set<string>();
	for (const entry of entries) {
		if (
			!entry.name ||
			entry.name === "." ||
			entry.name === ".." ||
			/[\\/\0]/.test(entry.name) ||
			names.has(entry.name) ||
			!/^[a-f0-9]{40}$/.test(entry.hash)
		)
			throw new Error("Invalid Artifacts tree");
		names.add(entry.name);
	}
	return entries;
}

export async function resolveThemeArtifactFile(
	repo: ArtifactsRepo,
	root: string,
	path: string,
) {
	const hash = await findThemeArtifactFile(repo, root, path);
	if (!hash) throw new Error("Artifacts source file unavailable");
	return hash;
}

/** Missing entries are distinct from failed reads or malformed trees. */
export async function findThemeArtifactFile(
	repo: ArtifactsRepo,
	root: string,
	path: string,
) {
	const parts = path.split("/");
	let hash = root;
	for (let index = 0; index < parts.length; index++) {
		const entry = (await readThemeArtifactTreeEntries(repo, hash)).find(
			(item) => item.name === parts[index],
		);
		if (!entry) return null;
		if (index === parts.length - 1) {
			if (
				(entry.type !== "blob" && entry.type !== "exec") ||
				!["100644", "100755"].includes(entry.mode)
			)
				throw new Error("Artifacts source is not a regular file");
			return entry.hash;
		}
		if (entry.type !== "tree" || !["40000", "040000"].includes(entry.mode))
			throw new Error("Artifacts source is not a directory");
		hash = entry.hash;
	}
	throw new Error("Artifacts source file unavailable");
}

export async function readThemeArtifactBlob(
	repo: ArtifactsRepo,
	hash: string,
	maxBytes?: number,
) {
	const blob = await repo.readBlob(hash);
	if (!blob || (maxBytes !== undefined && blob.size > maxBytes))
		throw new Error("Artifacts source blob unavailable or too large");
	const content = new TextDecoder("utf-8", {
		fatal: true,
		ignoreBOM: true,
	}).decode(await blob.arrayBuffer());
	return { content, size: blob.size };
}

/** Read-only view consumed by the existing canonical editable-source digest. */
export async function themeArtifactSourceView(
	repo: ArtifactsRepo,
	root: string,
	templateSlug: string,
) {
	const files = new Map<string, string>();
	async function walk(hash: string, prefix: string, ancestors: Set<string>) {
		if (ancestors.has(hash)) throw new Error("Cyclic Artifacts tree");
		const next = new Set(ancestors).add(hash);
		for (const entry of await readThemeArtifactTreeEntries(repo, hash)) {
			const path = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.type === "tree" && ["40000", "040000"].includes(entry.mode))
				await walk(entry.hash, path, next);
			else if (isPathEditable(path, templateSlug)) {
				if (
					!["blob", "exec"].includes(entry.type) ||
					!["100644", "100755"].includes(entry.mode)
				)
					throw new Error("Editable Artifacts source is not a regular file");
				files.set(`/workspace/${path}`, entry.hash);
			}
		}
	}
	const src = (await readThemeArtifactTreeEntries(repo, root)).find(
		(entry) => entry.name === "src",
	);
	if (!src || src.type !== "tree" || !["40000", "040000"].includes(src.mode))
		throw new Error("Artifacts source directory unavailable");
	await walk(src.hash, "src", new Set([root]));
	return {
		async listFiles() {
			return [...files.keys()].map((path) => ({
				type: "file",
				relativePath: path.slice("/workspace/".length),
			}));
		},
		async readFile(path: string) {
			const hash = files.get(path);
			if (!hash) throw new Error("Artifacts source file unavailable");
			const blob = await repo.readBlob(hash);
			if (!blob) throw new Error("Artifacts source blob unavailable");
			return {
				content: new Uint8Array(await blob.arrayBuffer()),
				size: blob.size,
			};
		},
	};
}

const WORKSPACE = "/workspace";
const THEME_ARTIFACT_SEED_TIMEOUT_MS = 5 * 60 * 1000;
type SandboxArtifactSeedClient = CmsJobClient & Pick<CmsSandbox, "writeFile">;
export type ThemeArtifactSeedStatus =
	| "running"
	| "complete"
	| "failed"
	| "timeout"
	| "cancelled";

export interface ThemeArtifactSeedLaunch {
	jobId: string;
	processId: string;
	startedAt: number;
}

export interface ThemeArtifactSeedSnapshot {
	jobId: string;
	status: ThemeArtifactSeedStatus;
	exitCode: number | null;
	running: boolean;
	startedAt: number | null;
	durationMs: number | null;
	seed: Record<string, unknown> | null;
	stdoutTail: string;
	stderrTail: string;
	logTail: string;
	message: string;
}

export interface ThemeArtifactSeedCancelSnapshot extends ThemeArtifactSeedSnapshot {
	cancelled: boolean;
	previousStatus: string | null;
}

export type ThemeArtifactSeedContext = {
	orgSlug: string;
	sandbox: SandboxArtifactSeedClient;
	artifactCommitSandbox?: (jobId: string) => SandboxArtifactSeedClient;
};

export function isIsolatedThemeArtifactCommit(jobId: string): boolean {
	return /^tac-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(jobId);
}

export function themeArtifactCommitSandbox(
	ctx: ThemeArtifactSeedContext,
	jobId: string,
): SandboxArtifactSeedClient {
	if (!isIsolatedThemeArtifactCommit(jobId)) return ctx.sandbox;
	if (!ctx.artifactCommitSandbox)
		throw new Error("Isolated CMS artifact execution is unavailable");
	return ctx.artifactCommitSandbox(jobId);
}

function shellSingleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function safeId(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function tailLines(output: string, limit = 120): string {
	const lines = output.split("\n");
	return lines.slice(Math.max(0, lines.length - limit)).join("\n");
}

function themeArtifactSeedJobId(): string {
	return `tas-${Date.now().toString(36)}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;
}

function assertThemeArtifactSeedJobId(jobId: string): void {
	if (!/^[a-zA-Z0-9._-]{1,96}$/.test(jobId)) {
		throw new Error(`Invalid CMS theme artifact seed jobId "${jobId}"`);
	}
}

function parseSeedResult(stdout: string): Record<string, unknown> | null {
	const lines = stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (const line of lines.reverse()) {
		if (!line.startsWith("{") || !line.endsWith("}")) continue;
		try {
			return JSON.parse(line) as Record<string, unknown>;
		} catch {}
	}
	return null;
}

function buildThemeArtifactSeedScript(input: {
	branch: string;
	forceSeed: boolean;
	orgSlug: string;
	remotePath: string;
	tokenPath: string;
}): string {
	return `#!/bin/sh
set -eu

ORG_SLUG=${shellSingleQuote(input.orgSlug)}
BRANCH=${shellSingleQuote(input.branch)}
FORCE_SEED=${input.forceSeed ? "1" : "0"}
WORKSPACE=${shellSingleQuote(WORKSPACE)}
TOKEN_FILE=${shellSingleQuote(input.tokenPath)}
REMOTE_FILE=${shellSingleQuote(input.remotePath)}
TMP="/tmp/tedix-cms-theme-artifacts-${safeId(input.orgSlug)}-$$"

cleanup() {
  rm -rf "$TMP"
  rm -f "$TOKEN_FILE" "$REMOTE_FILE" "$0"
}
trap cleanup EXIT INT TERM

mkdir -p "$TMP"
cd "$WORKSPACE"
if command -v rsync >/dev/null 2>&1; then
  rsync -a \\
    --exclude '.git' \\
    --exclude '.env' \\
    --exclude '.env.*' \\
    --exclude '.dev.vars' \\
    --exclude 'node_modules' \\
    --exclude 'dist' \\
    --exclude '.astro' \\
    --exclude '.wrangler' \\
    ./ "$TMP"/
else
  tar \\
    --exclude './.git' \\
    --exclude './.env' \\
    --exclude './.env.*' \\
    --exclude './.dev.vars' \\
    --exclude './node_modules' \\
    --exclude './dist' \\
    --exclude './.astro' \\
    --exclude './.wrangler' \\
    -cf - . | tar -xf - -C "$TMP"
fi

cd "$TMP"
git init -q
git checkout -B "$BRANCH" >/dev/null 2>&1
git config user.name ${shellSingleQuote(themeArtifactAuthor.name)}
git config user.email ${shellSingleQuote(themeArtifactAuthor.email)}
git remote add origin "$(cat "$REMOTE_FILE")"

TOKEN="$(cat "$TOKEN_FILE")"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $TOKEN"

set +e
REMOTE_HEAD="$(git ls-remote --heads origin "$BRANCH" 2>/dev/null | awk '{print $1}' | head -1)"
REMOTE_STATUS=$?
set -e
if [ "$REMOTE_STATUS" -eq 0 ] && [ -n "$REMOTE_HEAD" ] && [ "$FORCE_SEED" != "1" ]; then
  printf '{"seeded":false,"skippedReason":"remote_branch_exists","remoteHead":"%s"}\\n' "$REMOTE_HEAD"
  exit 0
fi

git add -A
if git diff --cached --quiet; then
  printf '{"seeded":false,"skippedReason":"empty_workspace"}\\n'
  exit 0
fi

git commit -q -m "Seed CMS theme source for $ORG_SLUG"
COMMIT="$(git rev-parse HEAD)"
FILE_COUNT="$(git ls-files | wc -l | tr -d ' ')"
git push -u origin "$BRANCH" --force >/dev/null 2>&1
printf '{"seeded":true,"commit":"%s","fileCount":%s,"branch":"%s"}\\n' "$COMMIT" "$FILE_COUNT" "$BRANCH"
`;
}

export async function startThemeArtifactRepoSeed(
	ctx: ThemeArtifactSeedContext,
	input: {
		branch: string;
		forceSeed: boolean;
		remote: string;
		token: string;
		jobId?: string;
	},
): Promise<ThemeArtifactSeedLaunch> {
	const jobId = input.jobId ?? themeArtifactSeedJobId();
	assertThemeArtifactSeedJobId(jobId);
	const base = `/tmp/tedix-theme-artifact-seed-${safeId(ctx.orgSlug)}-${jobId}-${crypto.randomUUID()}`;
	const scriptPath = `${base}.sh`,
		tokenPath = `${base}.token`,
		remotePath = `${base}.remote`;
	const script = buildThemeArtifactSeedScript({
		branch: input.branch,
		forceSeed: input.forceSeed,
		orgSlug: ctx.orgSlug,
		remotePath,
		tokenPath,
	});
	await Promise.all([
		ctx.sandbox.writeFile(scriptPath, script),
		ctx.sandbox.writeFile(tokenPath, input.token),
		ctx.sandbox.writeFile(remotePath, input.remote),
	]);
	const process = await startCmsJob(
		ctx.sandbox,
		`theme-seed:${jobId}`,
		[
			"bash",
			"-lc",
			`chmod 700 ${shellSingleQuote(scriptPath)} && chmod 600 ${shellSingleQuote(tokenPath)} ${shellSingleQuote(remotePath)} && sh ${shellSingleQuote(scriptPath)}`,
		],
		{ cwd: "/workspace", timeout: THEME_ARTIFACT_SEED_TIMEOUT_MS },
	);
	return {
		jobId,
		processId: process.id,
		startedAt: cmsProcessStartedAt(await process.status()) ?? Date.now(),
	};
}
async function readThemeArtifactRepoJobStatus(
	sandbox: SandboxArtifactSeedClient,
	jobId: string,
	jobKind: "theme-seed" | "theme-commit",
): Promise<ThemeArtifactSeedSnapshot> {
	assertThemeArtifactSeedJobId(jobId);
	const process = await getCmsJob(sandbox, `${jobKind}:${jobId}`);
	if (!process)
		return {
			jobId,
			status: "failed",
			exitCode: null,
			running: false,
			startedAt: null,
			durationMs: null,
			seed: null,
			stdoutTail: "",
			stderrTail: "",
			logTail: "",
			message: "CMS theme artifact seed process was not found",
		};
	const logs = await readCmsProcessLogs(process);
	const state = await process.status();
	let status: ThemeArtifactSeedStatus = cmsProcessOutcome(state);
	const seed = parseSeedResult(logs.stdout);
	if (status === "complete" && !seed) status = "failed";
	const startedAt = cmsProcessStartedAt(state);
	return {
		jobId,
		status,
		exitCode: cmsProcessExitCode(state),
		running: status === "running",
		startedAt,
		durationMs: cmsProcessDurationMs(state),
		seed: seed ? { ...seed, ok: status === "complete" } : null,
		stdoutTail: tailLines(logs.stdout),
		stderrTail: tailLines(logs.stderr),
		logTail: tailLines([logs.stdout, logs.stderr].filter(Boolean).join("\n")),
		message: `CMS theme artifact ${jobKind === "theme-seed" ? "seed" : "commit"} ${status}`,
	};
}
export async function readThemeArtifactRepoSeedStatus(
	sandbox: SandboxArtifactSeedClient,
	jobId: string,
): Promise<ThemeArtifactSeedSnapshot> {
	return readThemeArtifactRepoJobStatus(sandbox, jobId, "theme-seed");
}
export async function readThemeArtifactRepoCommitStatus(
	sandbox: SandboxArtifactSeedClient,
	jobId: string,
): Promise<ThemeArtifactSeedSnapshot> {
	return readThemeArtifactRepoJobStatus(sandbox, jobId, "theme-commit");
}
export async function cancelThemeArtifactRepoSeed(
	sandbox: SandboxArtifactSeedClient,
	jobId: string,
): Promise<ThemeArtifactSeedCancelSnapshot> {
	const before = await readThemeArtifactRepoSeedStatus(sandbox, jobId);
	if (!before.running)
		return { ...before, cancelled: false, previousStatus: before.status };
	const process = await getCmsJob(sandbox, `theme-seed:${jobId}`);
	if (!process)
		throw new Error("CMS theme seed disappeared during cancellation");
	await process.kill();
	await process.waitForExit({ timeout: 10_000 });
	return {
		...(await readThemeArtifactRepoSeedStatus(sandbox, jobId)),
		cancelled: true,
		previousStatus: before.status,
	};
}
