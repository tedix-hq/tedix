/**
 * Cloudflare Artifacts git helper for the Agent runtime.
 *
 * Agent-runtime tedis sync workspace text (daily logs, MEMORY.md, dreams,
 * skills) to a per-tedi Artifacts repo with `isomorphic-git` + an in-memory FS
 * from the Worker.
 *
 * The CF Artifacts Workers binding (`env.ARTIFACTS: Artifacts`) only manages
 * repos and tokens — it has no file-level API. Actual reads/writes go through
 * the standard HTTPS Git protocol against `repo.remote` with Basic-auth using
 * a freshly-minted write token.
 *
 * Repo identity is name = tediId, namespace `tedix-prod` in the binding.
 *
 * Concurrency: the AgentTediDO holds a process-local mutex around the
 * flush path, so two concurrent commits from the same DO cannot race. Two
 * different sources could still race; in that case the loser's push is
 * rejected as non-fast-forward and we surface the error. Today only one source
 * writes per tedi: the Agent-runtime DO.
 */

import {
	artifactsRepoDescriptionForTediSlug,
	artifactsRepoNameForTediId,
	type DailyLogArtifactFileWrite,
	isArtifactsErrorCode,
	TEDIX_ARTIFACTS_DEFAULT_BRANCH,
	TEDIX_ARTIFACTS_WRITE_TOKEN_TTL_SECONDS,
} from "./artifacts-contract";
// Default import + namespace access (matches CF docs example).
//
// Bind hazard: isomorphic-git iterates a hardcoded `commands` list
// (readFile, writeFile, mkdir, rmdir, unlink, stat, lstat, readdir,
// readlink, symlink) on the supplied `fs.promises` and calls
// `.bind(fs)` on each — including `readlink`/`symlink` which the docs
// MemoryFS example omits. Missing entries trigger
// `Cannot read properties of undefined (reading 'bind')` at clone time.
// Our `MemoryFS` provides ENOSYS-throwing stubs for both so the bind
// step succeeds; daily-log content has no symlinks so neither stub is
// ever actually invoked.
import git, { type HttpClient, type PushResult } from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memory-fs";
import { errorMessage } from "@tedix/worker-kit/error-message";

/**
 * Deterministic remote URL for an Artifacts repo, per the public Git protocol
 * contract: `https://<ACCOUNT_ID>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`
 * (see https://developers.cloudflare.com/artifacts/api/git-protocol/).
 *
 * We compute this locally instead of reading `repo.remote` from the binding
 * handle because `ArtifactsRepo.remote` is exposed as an RPC-getter that
 * raises `RPC receiver does not implement the method "remote"` when accessed
 * directly. Only the plain-object results from `create()`/`import()`/`fork()`
 * expose `remote` as a real string. The URL shape itself is contract.
 */
function artifactsRemoteUrl(
	accountId: string,
	namespace: string,
	repoName: string,
): string {
	return `https://${accountId}.artifacts.cloudflare.net/git/${namespace}/${repoName}.git`;
}

export type ArtifactsAssertReady = () => Promise<void>;
export interface ArtifactsPushReceipt {
	commitOid: string;
	pushedRefs: PushResult["refs"];
	acknowledgedRef: "refs/heads/main";
	fileCount: number;
}
/** Collect upload bytes before fencing the actual HTTP effect. Response bytes are original receipts. */
export function createArtifactsGitHttp(
	assertReady: ArtifactsAssertReady,
): HttpClient {
	return {
		request: async ({
			url,
			method = "GET",
			headers = {},
			body,
			signal,
			fetchOptions = {},
		}) => {
			let upload: Uint8Array<ArrayBuffer> | undefined;
			if (body) {
				const parts: Uint8Array[] = [];
				let size = 0;
				for await (const part of body) {
					parts.push(part);
					size += part.byteLength;
				}
				upload = new Uint8Array(size);
				let offset = 0;
				for (const part of parts) {
					upload.set(part, offset);
					offset += part.byteLength;
				}
			}
			await assertReady();
			const response = await fetch(url, {
				...fetchOptions,
				method,
				headers,
				body: upload,
				signal: signal ?? fetchOptions.signal,
			});
			async function* received() {
				if (!response.body) return;
				const reader = response.body.getReader();
				try {
					for (;;) {
						const next = await reader.read();
						if (next.done) return;
						yield next.value;
					}
				} finally {
					reader.releaseLock();
				}
			}
			return {
				url: response.url,
				method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: Object.fromEntries(response.headers),
				body: received(),
			};
		},
	};
}
function pushReceipt(
	commitOid: string,
	result: PushResult,
	fileCount: number,
): ArtifactsPushReceipt {
	const acknowledgedRef = "refs/heads/main" as const;
	if (
		!/^[a-f0-9]{40}$/.test(commitOid) ||
		result.ok !== true ||
		result.refs[acknowledgedRef]?.ok !== true
	)
		throw new Error("Artifacts push has no acknowledged main commit");
	return { commitOid, pushedRefs: result.refs, acknowledgedRef, fileCount };
}
function assertUniquePaths(files: readonly { path: string }[]): void {
	if (new Set(files.map((file) => file.path)).size !== files.length)
		throw new Error("Artifacts write contains duplicate file paths");
}
async function cloneOrInitialize(
	fs: MemoryFS,
	dir: string,
	remote: string,
	onAuth: () => { username: string; password: string },
	http: HttpClient,
): Promise<boolean> {
	const refs = await git.listServerRefs({ http, url: remote, onAuth });
	if (refs.length === 0) {
		await fs.promises.mkdir(dir, { recursive: true });
		await git.init({ fs, dir, defaultBranch: TEDIX_ARTIFACTS_DEFAULT_BRANCH });
		return false;
	}
	await git.clone({
		fs,
		http,
		dir,
		url: remote,
		ref: TEDIX_ARTIFACTS_DEFAULT_BRANCH,
		singleBranch: true,
		depth: 1,
		onAuth,
	});
	return true;
}
async function getReadyExistingRepoToken(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
	assertReady: ArtifactsAssertReady,
): Promise<RepoToken | null> {
	const name = artifactsRepoNameForTediId(tediId);
	await assertReady();
	let repo: ArtifactsRepo;
	try {
		repo = await artifacts.get(name);
	} catch (error) {
		if (isArtifactsErrorCode(error, "NOT_FOUND")) return null;
		throw error;
	}
	await assertReady();
	const token = await repo.createToken(
		"read",
		TEDIX_ARTIFACTS_WRITE_TOKEN_TTL_SECONDS,
	);
	return {
		remote: artifactsRemoteUrl(accountId, namespace, name),
		tokenSecret: token.plaintext.split("?expires=")[0] ?? "",
	};
}

interface RepoToken {
	remote: string;
	tokenSecret: string;
}

export interface ArtifactsRepoFileReadResult {
	path: string;
	content: string | null;
	fileFound: boolean;
	error?: string;
}

export interface ArtifactsRepoFilesReadResult {
	repoFound: boolean;
	cloneOk: boolean;
	error?: string;
	files: ArtifactsRepoFileReadResult[];
}

export interface ArtifactsRepoFileListResult {
	repoFound: boolean;
	cloneOk: boolean;
	error?: string;
	files: string[];
}

async function getExistingRepoToken(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
): Promise<RepoToken | null> {
	const name = artifactsRepoNameForTediId(tediId);
	const remote = artifactsRemoteUrl(accountId, namespace, name);
	const tokenSecretFrom = (plaintext: string): string =>
		plaintext.split("?expires=")[0] ?? "";

	try {
		const repo = await artifacts.get(name);
		const token = await repo.createToken(
			"read",
			TEDIX_ARTIFACTS_WRITE_TOKEN_TTL_SECONDS,
		);
		return { remote, tokenSecret: tokenSecretFrom(token.plaintext) };
	} catch (err) {
		if (isArtifactsErrorCode(err, "NOT_FOUND")) return null;
		throw err;
	}
}

/**
 * Get-or-create the per-tedi repo and mint a short-lived write token.
 *
 * Lazy on first-need: we attempt `get(name)` first, and only call `create()`
 * on NOT_FOUND. This means an isolate tedi's repo is provisioned on the first
 * daily-log flush, not at DO init — same as the runtime path which creates
 * the repo when the gateway boots and `buildArtifactsSecretEnvVars()` runs.
 *
 * Token rotation is per-flush (≤5 min cadence today), well within the 1h TTL.
 * We don't cache tokens across flushes — minting is cheap and the staleness
 * surface is smaller this way.
 */
async function getOrCreateRepoToken(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
	slug: string,
	assertReady: ArtifactsAssertReady,
): Promise<RepoToken> {
	const name = artifactsRepoNameForTediId(tediId);
	const remote = artifactsRemoteUrl(accountId, namespace, name);

	const tokenSecretFrom = (plaintext: string): string =>
		plaintext.split("?expires=")[0] ?? "";

	try {
		await assertReady();
		const repo = await artifacts.get(name);
		await assertReady();
		const token = await repo.createToken(
			"write",
			TEDIX_ARTIFACTS_WRITE_TOKEN_TTL_SECONDS,
		);
		return { remote, tokenSecret: tokenSecretFrom(token.plaintext) };
	} catch (err) {
		if (!isArtifactsErrorCode(err, "NOT_FOUND")) throw err;
	}

	try {
		await assertReady();
		const created = await artifacts.create(name, {
			description: artifactsRepoDescriptionForTediSlug(slug),
			readOnly: false,
			setDefaultBranch: TEDIX_ARTIFACTS_DEFAULT_BRANCH,
		});
		// `create()` returns a plain Result object; created.token is a real string.
		return { remote, tokenSecret: tokenSecretFrom(created.token) };
	} catch (err) {
		// Racing creates land on ALREADY_EXISTS — retry the get path.
		if (!isArtifactsErrorCode(err, "ALREADY_EXISTS")) throw err;
		await assertReady();
		const repo = await artifacts.get(name);
		await assertReady();
		const token = await repo.createToken(
			"write",
			TEDIX_ARTIFACTS_WRITE_TOKEN_TTL_SECONDS,
		);
		return { remote, tokenSecret: tokenSecretFrom(token.plaintext) };
	}
}

export interface CommitDailyLogsArgs {
	assertReady: ArtifactsAssertReady;
	artifacts: Artifacts;
	/** Cloudflare account ID — used to construct the deterministic remote URL. */
	accountId: string;
	/** Artifacts namespace, e.g. `tedix-prod`. Matches wrangler binding. */
	namespace: string;
	tediId: string;
	slug: string;
	/** One entry per date being updated this flush. */
	files: DailyLogArtifactFileWrite[];
	/** Commit message subject. */
	message: string;
}

/**
 * Clone the per-tedi repo into an in-memory FS, overwrite the daily-log files
 * with the caller-provided content, commit, and push back to `main`.
 *
 * Why overwrite instead of compute-the-diff here: the caller already merged
 * existing repo content and new entries before invoking us. This layer writes
 * the caller's exact bytes and returns the acknowledged original commit.
 *
 * Initialization requires a successful empty remote-ref advertisement.
 * Unknown clone failures reject the write; every push uses normal fast-forward checks.
 */
export async function commitDailyLogs(
	args: CommitDailyLogsArgs,
): Promise<ArtifactsPushReceipt> {
	assertUniquePaths(args.files);
	if (args.files.length === 0) throw new Error("Daily log commit has no files");
	const {
		artifacts,
		accountId,
		namespace,
		tediId,
		slug,
		files,
		message,
		assertReady,
	} = args;
	const { remote, tokenSecret } = await getOrCreateRepoToken(
		artifacts,
		accountId,
		namespace,
		tediId,
		slug,
		assertReady,
	);

	const http = createArtifactsGitHttp(assertReady);
	const fs = new MemoryFS();
	const dir = "/workspace";
	const onAuth = () => ({ username: "x", password: tokenSecret });

	await cloneOrInitialize(fs, dir, remote, onAuth, http);

	for (const file of files) {
		const fullPath = `${dir}/${file.path}`;
		const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
		if (parentDir && parentDir !== dir) {
			await fs.promises.mkdir(parentDir, { recursive: true });
		}
		await fs.promises.writeFile(fullPath, file.content);
		await git.add({ fs, dir, filepath: file.path });
	}

	const commitOid = await git.commit({
		fs,
		dir,
		message,
		author: {
			name: "isolate-do",
			email: `${slug}@tedix.tech`,
		},
	});

	// Push HEAD to the remote DEFAULT_BRANCH. Using `ref: "HEAD"` (instead of
	// `"main"`) handles both the cloned path (where iso-git checks out the
	// remote default but may not create a local `refs/heads/main` until first
	// commit) and the init path (where the local branch is `main` but only
	// after `init` writes HEAD). `remoteRef` pins the destination ref name.
	const pushResult = await git.push({
		fs,
		http,
		dir,
		url: remote,
		ref: "HEAD",
		remoteRef: `refs/heads/${TEDIX_ARTIFACTS_DEFAULT_BRANCH}`,
		force: false,
		onAuth,
	});

	return pushReceipt(commitOid, pushResult, files.length);
}

/**
 * Read a single file from the latest commit on `main`. Used by debug/probe
 * paths to verify a write landed. Returns null if the repo or file is missing.
 */
export async function readFileFromRepo(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
	_slug: string,
	path: string,
	assertReady: ArtifactsAssertReady,
): Promise<string | null> {
	const token = await getReadyExistingRepoToken(
		artifacts,
		accountId,
		namespace,
		tediId,
		assertReady,
	);
	if (!token) return null;
	const fs = new MemoryFS(),
		dir = "/workspace";
	const http = createArtifactsGitHttp(assertReady),
		onAuth = () => ({ username: "x", password: token.tokenSecret });
	if (!(await cloneOrInitialize(fs, dir, token.remote, onAuth, http)))
		return null;
	try {
		return (await fs.promises.readFile(`${dir}/${path}`, "utf8")) as string;
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return null;
		throw error;
	}
}

export async function readFileFromExistingRepo(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
	path: string,
): Promise<string | null> {
	const result = await readFilesFromExistingRepoWithStatus(
		artifacts,
		accountId,
		namespace,
		tediId,
		[path],
	);
	return result.files[0]?.content ?? null;
}

export async function readFilesFromExistingRepoWithStatus(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
	paths: string[],
): Promise<ArtifactsRepoFilesReadResult> {
	const token = await getExistingRepoToken(
		artifacts,
		accountId,
		namespace,
		tediId,
	);
	if (!token) {
		return {
			repoFound: false,
			cloneOk: false,
			files: paths.map((path) => ({
				path,
				content: null,
				fileFound: false,
			})),
		};
	}
	return readFilesWithTokenWithStatus(token, paths);
}

export async function listFilesFromExistingRepoWithStatus(
	artifacts: Artifacts,
	accountId: string,
	namespace: string,
	tediId: string,
): Promise<ArtifactsRepoFileListResult> {
	const token = await getExistingRepoToken(
		artifacts,
		accountId,
		namespace,
		tediId,
	);
	if (!token) {
		return {
			repoFound: false,
			cloneOk: false,
			files: [],
		};
	}
	return listFilesWithTokenWithStatus(token);
}

async function readFilesWithTokenWithStatus(
	token: RepoToken,
	paths: string[],
): Promise<ArtifactsRepoFilesReadResult> {
	const fs = new MemoryFS();
	const dir = "/workspace";
	const onAuth = () => ({ username: "x", password: token.tokenSecret });
	try {
		await git.clone({
			fs,
			http,
			dir,
			url: token.remote,
			ref: TEDIX_ARTIFACTS_DEFAULT_BRANCH,
			singleBranch: true,
			depth: 1,
			onAuth,
		});
	} catch (err) {
		const message = `clone_failed: ${errorMessage(err)}`;
		return {
			repoFound: true,
			cloneOk: false,
			error: message,
			files: paths.map((path) => ({
				path,
				content: null,
				fileFound: false,
				error: message,
			})),
		};
	}

	const files: ArtifactsRepoFileReadResult[] = [];
	for (const path of paths) {
		try {
			const data = (await fs.promises.readFile(
				`${dir}/${path}`,
				"utf8",
			)) as string;
			files.push({ path, content: data, fileFound: true });
		} catch {
			files.push({ path, content: null, fileFound: false });
		}
	}
	return { repoFound: true, cloneOk: true, files };
}

async function listFilesWithTokenWithStatus(
	token: RepoToken,
): Promise<ArtifactsRepoFileListResult> {
	const fs = new MemoryFS();
	const dir = "/workspace";
	const onAuth = () => ({ username: "x", password: token.tokenSecret });
	try {
		await git.clone({
			fs,
			http,
			dir,
			url: token.remote,
			ref: TEDIX_ARTIFACTS_DEFAULT_BRANCH,
			singleBranch: true,
			depth: 1,
			onAuth,
		});
	} catch (err) {
		return {
			repoFound: true,
			cloneOk: false,
			error: `clone_failed: ${errorMessage(err)}`,
			files: [],
		};
	}
	try {
		const files = await git.listFiles({ fs, dir });
		return { repoFound: true, cloneOk: true, files: files.sort() };
	} catch (err) {
		return {
			repoFound: true,
			cloneOk: true,
			error: `list_failed: ${errorMessage(err)}`,
			files: [],
		};
	}
}

// ── Prefix-replacing snapshot commits (Artifacts-as-git-remote, Move 2) ────

/**
 * Pure diff plan for a prefix-scoped snapshot: which repo paths under
 * `prefix` must be git-removed because the new snapshot no longer carries
 * them. Paths outside the prefix (daily logs, MEMORY.md, ...) are never
 * touched — the snapshot subtree replaces only itself.
 */
export function planPrefixRemovals(
	existingRepoPaths: string[],
	nextRepoPaths: string[],
	prefix: string,
): string[] {
	const next = new Set(nextRepoPaths);
	return existingRepoPaths
		.filter((p) => p.startsWith(prefix) && !next.has(p))
		.sort();
}

export interface CommitPrefixSnapshotArgs {
	assertReady: ArtifactsAssertReady;
	artifacts: Artifacts;
	accountId: string;
	namespace: string;
	tediId: string;
	slug: string;
	/** Repo subtree this snapshot owns, e.g. `workspace/`. Must end with `/`. */
	prefix: string;
	/** Full next state of the subtree — repo-relative paths INSIDE the prefix. */
	files: { path: string; content: string }[];
	message: string;
}

/**
 * Snapshot-commit a subtree: clone (or init on an empty repo), remove the
 * prefix's stale paths, write the full next state, commit, push. Same
 * token/clone/push machinery as {@link commitDailyLogs}; deletions are the
 * one semantic it deliberately adds — a snapshot must not resurrect files
 * the workspace deleted. Callers serialize on the DO write mutex.
 */
export async function commitPrefixSnapshot(
	args: CommitPrefixSnapshotArgs,
): Promise<
	ArtifactsPushReceipt & {
		writtenCount: number;
		removedCount: number;
	}
> {
	assertUniquePaths(args.files);
	const {
		artifacts,
		accountId,
		namespace,
		tediId,
		slug,
		prefix,
		files,
		message,
		assertReady,
	} = args;
	if (!prefix.endsWith("/")) {
		throw new Error(`snapshot prefix must end with '/': ${prefix}`);
	}
	for (const file of files) {
		if (!file.path.startsWith(prefix)) {
			throw new Error(
				`snapshot file escapes its prefix (${prefix}): ${file.path}`,
			);
		}
	}
	const { remote, tokenSecret } = await getOrCreateRepoToken(
		artifacts,
		accountId,
		namespace,
		tediId,
		slug,
		assertReady,
	);

	const http = createArtifactsGitHttp(assertReady);
	const fs = new MemoryFS();
	const dir = "/workspace";
	const onAuth = () => ({ username: "x", password: tokenSecret });

	const cloned = await cloneOrInitialize(fs, dir, remote, onAuth, http);

	const existing = cloned ? await git.listFiles({ fs, dir }) : [];
	const removals = planPrefixRemovals(
		existing,
		files.map((f) => f.path),
		prefix,
	);
	for (const filepath of removals) {
		await git.remove({ fs, dir, filepath });
		try {
			await fs.promises.unlink(`${dir}/${filepath}`);
		} catch {
			// The index removal is what the commit reads; a missing loose file
			// (never checked out at depth 1 edge cases) is not an error.
		}
	}

	for (const file of files) {
		const fullPath = `${dir}/${file.path}`;
		const parentDir = fullPath.slice(0, fullPath.lastIndexOf("/"));
		if (parentDir && parentDir !== dir) {
			await fs.promises.mkdir(parentDir, { recursive: true });
		}
		await fs.promises.writeFile(fullPath, file.content);
		await git.add({ fs, dir, filepath: file.path });
	}

	const commitOid = await git.commit({
		fs,
		dir,
		message,
		author: { name: "isolate-do", email: `${slug}@tedix.tech` },
	});

	const pushResult = await git.push({
		fs,
		http,
		dir,
		url: remote,
		ref: "HEAD",
		remoteRef: `refs/heads/${TEDIX_ARTIFACTS_DEFAULT_BRANCH}`,
		force: false,
		onAuth,
	});

	return {
		...pushReceipt(commitOid, pushResult, files.length),
		writtenCount: files.length,
		removedCount: removals.length,
	};
}
