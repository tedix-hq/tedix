/**
 * GitHub REST API client for git-over-HTTPS repo access.
 *
 * Phase 1 (read): Trees/Blobs API — load repo file trees and blob content.
 * Phase 2 (write): Git data API — create blobs, trees, commits, refs, and PRs.
 *
 * All network goes through the tedi DO host — the Worker Loader isolate stays
 * network-blocked and reaches repo content only through workspace RPC.
 *
 * GitHub API truncation threshold: Trees API truncates at ~100k entries or ~7 MB
 * response. When `truncated:true` and `paths` is given, we fall back to the
 * Contents API per-path. Without paths, we throw `RepoTreeTruncatedError` — the
 * caller must supply explicit paths or use shallow sparse fetches.
 *
 * Blob size: the Git Blobs API returns base64 content; blobs >100 MB are not
 * accessible via the API (GitHub blocks them). The Contents API additionally
 * refuses files >1 MB — use `loadRepoFilesResult` + `readRepoBlob` for large files, not
 * the Contents API.
 *
 * Rate limits: unauthenticated = 60/h, authenticated = 5000/h, secondary rate
 * limits apply to bursts. `RepoRateLimitError` surfaces `resetAt` (epoch s) so
 * callers can back off. `RepoSecondaryRateLimitError` surfaces `retryAfter`
 * (seconds) for burst write operations (create-blob × N + tree + commit + ref).
 */

const GH_API = "https://api.github.com";
const GH_ACCEPT = "application/vnd.github+json";
const GH_API_VERSION = "2022-11-28";
const USER_AGENT = "tedix-repo-api/1";

// ── Typed errors ──────────────────────────────────────────────────────────────

export class RepoNotFoundError extends Error {
	readonly name = "RepoNotFoundError";
	constructor(owner: string, repo: string) {
		super(`Repository ${owner}/${repo} not found or not accessible`);
	}
}

export class RepoAuthError extends Error {
	readonly name = "RepoAuthError";
	constructor(message = "GitHub authentication failed") {
		super(message);
	}
}

export class RepoRateLimitError extends Error {
	readonly name = "RepoRateLimitError";
	readonly resetAt: number;
	constructor(resetAt: number) {
		super(
			`GitHub rate limit exceeded; resets at ${new Date(resetAt * 1000).toISOString()}`,
		);
		this.resetAt = resetAt;
	}
}

export class RepoTreeTruncatedError extends Error {
	readonly name = "RepoTreeTruncatedError";
	constructor(owner: string, repo: string, ref: string) {
		super(
			`Tree for ${owner}/${repo}@${ref} was truncated by GitHub (>100k entries or >7 MB). ` +
				"Pass explicit `paths` prefixes to enable per-path Contents API fallback.",
		);
	}
}

export class RepoSecondaryRateLimitError extends Error {
	readonly name = "RepoSecondaryRateLimitError";
	readonly retryAfter: number;
	constructor(retryAfter: number) {
		super(`GitHub secondary rate limit hit; retry after ${retryAfter}s`);
		this.retryAfter = retryAfter;
	}
}

export class RepoUnsafeRefError extends Error {
	readonly name = "RepoUnsafeRefError";
	constructor(value: string) {
		super(`Unsafe ref/path segment rejected: "${value}"`);
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RepoBlobRef {
	path: string;
	sha: string;
	size: number;
}

interface LoadRepoTreeOptions {
	owner: string;
	repo: string;
	ref: string;
	token: string;
	paths?: string[];
}

interface ReadRepoBlobOptions {
	owner: string;
	repo: string;
	sha: string;
	token: string;
}

interface LoadRepoFilesOptions {
	owner: string;
	repo: string;
	ref: string;
	token: string;
	paths: string[];
}

// ── URL-safety helpers ────────────────────────────────────────────────────────

/**
 * Encode a single path segment that must never contain '/'.
 * Rejects '', '.', '..', or any '/' — throws RepoUnsafeRefError.
 */
function encodeSegment(s: string): string {
	if (s === "" || s === "." || s === ".." || s.includes("/")) {
		throw new RepoUnsafeRefError(s);
	}
	return encodeURIComponent(s);
}

/**
 * Encode a slash-delimited ref or file path.
 * Each '/' segment must be non-empty and must not be '.' or '..'.
 * Throws RepoUnsafeRefError on any bad segment.
 */
function encodePathish(s: string): string {
	const segments = s.split("/");
	for (const seg of segments) {
		if (seg === "" || seg === "." || seg === "..") {
			throw new RepoUnsafeRefError(s);
		}
	}
	return segments.map(encodeURIComponent).join("/");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: GH_ACCEPT,
		"X-GitHub-Api-Version": GH_API_VERSION,
		"User-Agent": USER_AGENT,
	};
}

async function ghFetch<T>(url: string, token: string): Promise<T> {
	const res = await fetch(url, { headers: ghHeaders(token) });

	if (res.status === 404) {
		// surface owner/repo from URL for a better message; caller catches and wraps
		throw new RepoNotFoundError("(unknown)", "(unknown)");
	}

	if (res.status === 401) {
		throw new RepoAuthError("GitHub returned 401 Unauthorized");
	}

	if (res.status === 403) {
		// Secondary rate-limit: Retry-After header (no x-ratelimit-reset)
		const retryAfter = res.headers.get("Retry-After");
		if (retryAfter !== null) {
			throw new RepoSecondaryRateLimitError(Number(retryAfter));
		}
		const resetHeader = res.headers.get("x-ratelimit-reset");
		// Rate limit 403 always includes x-ratelimit-remaining: 0
		if (resetHeader !== null) {
			throw new RepoRateLimitError(Number(resetHeader));
		}
		throw new RepoAuthError("GitHub returned 403 Forbidden");
	}

	if (!res.ok) {
		throw new Error(
			`GitHub API error: ${res.status} ${res.statusText} — ${url}`,
		);
	}

	return res.json() as Promise<T>;
}

/** Decode a GitHub blob's content field per its encoding. */
function decodeGhContent(content: string, encoding: string): string {
	if (encoding === "base64") {
		// GitHub wraps base64 at 60 chars with newlines; strip them
		const stripped = content.replace(/\n/g, "");
		// atob() alone yields a Latin-1 string: any multi-byte UTF-8 sequence
		// (em dashes, accents, emoji) survives as per-byte code points and the
		// later UTF-8 re-encode in utf8ToBase64() double-encodes it (e2 80 94
		// became c3 a2 c2 80 c2 94 in committed files). Decode the raw bytes
		// as UTF-8 instead.
		const bytes = Uint8Array.from(atob(stripped), (c) => c.charCodeAt(0));
		return new TextDecoder("utf-8").decode(bytes);
	}
	// "utf-8" returned for small text files in the Contents API
	return content;
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Result from `resolvePathsViaContents`. */
export interface ResolvePathsResult {
	blobs: RepoBlobRef[];
	/** Paths that returned a directory listing (JSON array) — not expanded. */
	skippedDirectories: string[];
}

/** Resolve explicit paths via the Contents API (fallback for truncated trees). */
export async function resolvePathsViaContents({
	owner,
	repo,
	ref,
	token,
	paths,
}: Required<LoadRepoTreeOptions>): Promise<ResolvePathsResult> {
	interface ContentsFile {
		type: string;
		path: string;
		sha: string;
		size: number;
	}

	const blobs: RepoBlobRef[] = [];
	const skippedDirectories: string[] = [];

	await Promise.all(
		paths.map(async (path) => {
			// Normalize: strip trailing slash(es) before encoding so "src/" → "src".
			// This prevents encodePathish from rejecting the empty trailing segment.
			// The normalised path is also what we report in skippedDirectories.
			const normPath = path.replace(/\/+$/, "");
			const url = `${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/contents/${encodePathish(normPath)}?ref=${encodePathish(ref)}`;
			let item: ContentsFile | ContentsFile[];
			try {
				item = await ghFetch<ContentsFile | ContentsFile[]>(url, token);
			} catch (err) {
				if (err instanceof RepoNotFoundError) return; // path doesn't exist — skip
				throw err;
			}
			// GitHub returns a JSON array when the path resolves to a directory.
			// We do NOT recursively crawl directories here — skip and record them.
			if (Array.isArray(item)) {
				skippedDirectories.push(normPath);
				return;
			}
			if (item.type === "file") {
				blobs.push({ path: item.path, sha: item.sha, size: item.size });
			}
		}),
	);

	return { blobs, skippedDirectories };
}

/**
 * Fetch and decode a single git blob by SHA.
 * GitHub returns base64-encoded content with newline wrapping.
 */
export async function readRepoBlob({
	owner,
	repo,
	sha,
	token,
}: ReadRepoBlobOptions): Promise<string> {
	const url = `${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/blobs/${encodeSegment(sha)}`;

	interface BlobResponse {
		content: string;
		encoding: string;
	}

	let data: BlobResponse;
	try {
		data = await ghFetch<BlobResponse>(url, token);
	} catch (err) {
		if (err instanceof RepoNotFoundError) {
			throw new RepoNotFoundError(owner, repo);
		}
		throw err;
	}

	return decodeGhContent(data.content, data.encoding);
}

/** Result from `loadRepoFilesResult`. */
export interface LoadRepoFilesResult {
	files: Array<{ path: string; content: string }>;
	/** Directory paths that were skipped (truncated-tree Contents API fallback). */
	skippedDirectories: string[];
}

/**
 * Convenience: load the tree for `paths`, then fetch all matching blobs with
 * bounded concurrency (~6 in-flight at a time).
 *
 * Returns both the loaded files and any directory paths that were skipped
 * (only possible when the tree is truncated and a path resolves to a directory).
 *
 * Phase 2 note: for `repo_commit`, the inverse is create-blob per file → then
 * create-tree → commit → ref. The same concurrency cap (6) avoids GitHub's
 * secondary rate limit on burst POST operations.
 */
export async function loadRepoFilesResult({
	owner,
	repo,
	ref,
	token,
	paths,
}: LoadRepoFilesOptions): Promise<LoadRepoFilesResult> {
	// For truncated trees we need skippedDirectories; go through the lower-level
	// resolvePathsViaContents directly. For non-truncated trees, skippedDirectories
	// is always empty (the tree API only returns blobs/trees, never raw directory arrays).
	const url = `${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/trees/${encodePathish(ref)}?recursive=1`;

	interface TreeResponse {
		truncated: boolean;
		tree: Array<{
			path?: string;
			type: string;
			sha: string;
			size?: number;
		}>;
	}

	let data: TreeResponse;
	try {
		data = await ghFetch<TreeResponse>(url, token);
	} catch (err) {
		if (err instanceof RepoNotFoundError) {
			throw new RepoNotFoundError(owner, repo);
		}
		throw err;
	}

	let blobs: RepoBlobRef[];
	let skippedDirectories: string[] = [];

	if (data.truncated) {
		if (!paths || paths.length === 0) {
			throw new RepoTreeTruncatedError(owner, repo, ref);
		}
		const resolved = await resolvePathsViaContents({
			owner,
			repo,
			ref,
			token,
			paths,
		});
		blobs = resolved.blobs;
		skippedDirectories = resolved.skippedDirectories;
	} else {
		const allBlobs = data.tree.filter(
			(e): e is typeof e & { path: string } =>
				e.type === "blob" && typeof e.path === "string",
		);
		if (!paths || paths.length === 0) {
			blobs = allBlobs.map((e) => ({
				path: e.path,
				sha: e.sha,
				size: e.size ?? 0,
			}));
		} else {
			blobs = allBlobs
				.filter((e) => paths.some((prefix) => e.path.startsWith(prefix)))
				.map((e) => ({ path: e.path, sha: e.sha, size: e.size ?? 0 }));
		}
	}

	const CONCURRENCY = 6;
	const files: Array<{ path: string; content: string }> = [];
	const queue = [...blobs];

	async function worker() {
		while (queue.length > 0) {
			const blob = queue.shift();
			if (!blob) break;
			const content = await readRepoBlob({ owner, repo, sha: blob.sha, token });
			files.push({ path: blob.path, content });
		}
	}

	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, blobs.length || 1) }, worker),
	);

	return { files, skippedDirectories };
}

// ── Phase 2: write API ─────────────────────────────────────────────────────────

interface CommitRepoChangesParams {
	owner: string;
	repo: string;
	/** Branch name or 40-char hex SHA to base the commit on. */
	baseRef: string;
	/** Target branch to create or fast-forward. */
	branch: string;
	message: string;
	/** null content = delete that path. */
	changes: { path: string; content: string | null }[];
	token: string;
}

interface OpenPullRequestParams {
	owner: string;
	repo: string;
	/** Source branch name. */
	head: string;
	/** Target branch (e.g. "main"). */
	base: string;
	title: string;
	body: string;
	token: string;
}

/** POST/PATCH with JSON body; reuses the same error-handling as ghFetch. */
async function ghWrite<T>(
	url: string,
	method: "POST" | "PATCH",
	body: unknown,
	token: string,
	/** When true, a 422 response is returned as-is rather than thrown. */
	allow422 = false,
): Promise<T> {
	const res = await fetch(url, {
		method,
		headers: {
			...ghHeaders(token),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (res.status === 404) {
		throw new RepoNotFoundError("(unknown)", "(unknown)");
	}

	if (res.status === 401) {
		throw new RepoAuthError("GitHub returned 401 Unauthorized");
	}

	if (res.status === 403) {
		// Secondary rate-limit: 403 + Retry-After header (no x-ratelimit-reset)
		const retryAfter = res.headers.get("Retry-After");
		if (retryAfter !== null) {
			throw new RepoSecondaryRateLimitError(Number(retryAfter));
		}
		// Primary rate-limit via 403 (x-ratelimit-reset)
		const resetHeader = res.headers.get("x-ratelimit-reset");
		if (resetHeader !== null) {
			throw new RepoRateLimitError(Number(resetHeader));
		}
		throw new RepoAuthError("GitHub returned 403 Forbidden");
	}

	if (allow422 && res.status === 422) {
		return res.json() as Promise<T>;
	}

	if (!res.ok) {
		throw new Error(
			`GitHub API error: ${res.status} ${res.statusText} — ${url}`,
		);
	}

	return res.json() as Promise<T>;
}

/** Encode UTF-8 text as base64 without exceeding Worker argument limits. */
export function utf8ToBase64(content: string): string {
	const bytes = new TextEncoder().encode(content);
	const chunkSize = 0x8000;
	let binary = "";

	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}

	return btoa(binary);
}

/** True when s looks like a 40-char lowercase hex SHA. */
function isSha(s: string): boolean {
	return /^[0-9a-f]{40}$/.test(s);
}

/**
 * Commit file changes to a GitHub repo via the Git data API — no git binary.
 *
 * Flow: resolve baseRef → get base commit → create blobs (bounded ~6 concurrency)
 * → create tree → create commit → create or fast-forward branch ref.
 */
export async function commitRepoChanges({
	owner,
	repo,
	baseRef,
	branch,
	message,
	changes,
	token,
}: CommitRepoChangesParams): Promise<{ commitSha: string; branchRef: string }> {
	// Defense-in-depth: reject any change whose path is empty, starts with '/',
	// or has any dot-segment component ("" / "." / ".."). Layer 1 (do.ts
	// repoCommitProposeTool) enforces this before readFile; this layer ensures a
	// future caller that skips layer 1 cannot commit an escaped path.
	for (const change of changes) {
		const segs = change.path.split("/");
		if (
			change.path === "" ||
			change.path.startsWith("/") ||
			segs.some((seg) => seg === "" || seg === "." || seg === "..")
		) {
			throw new RepoUnsafeRefError(change.path);
		}
	}

	// 1. Resolve baseRef → commit SHA
	let baseCommitSha: string;
	if (isSha(baseRef)) {
		baseCommitSha = baseRef;
	} else {
		interface RefResponse {
			object: { sha: string };
		}
		const refData = await ghFetch<RefResponse>(
			`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/ref/heads/${encodePathish(baseRef)}`,
			token,
		);
		baseCommitSha = refData.object.sha;
	}

	// 2. Get the base commit → tree SHA
	interface CommitResponse {
		tree: { sha: string };
	}
	const commitData = await ghFetch<CommitResponse>(
		`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/commits/${encodeSegment(baseCommitSha)}`,
		token,
	);
	const baseTreeSha = commitData.tree.sha;

	// 3. Create blobs for non-null changes with bounded concurrency (~6 in-flight)
	const CONCURRENCY = 6;
	const blobShas = new Map<string, string>(); // path → blob sha
	const nonNullChanges = changes.filter((c) => c.content !== null) as {
		path: string;
		content: string;
	}[];

	const blobQueue = [...nonNullChanges];

	async function blobWorker() {
		while (blobQueue.length > 0) {
			const change = blobQueue.shift();
			if (!change) break;
			interface BlobCreateResponse {
				sha: string;
			}
			const blobData = await ghWrite<BlobCreateResponse>(
				`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/blobs`,
				"POST",
				{
					content: utf8ToBase64(change.content),
					encoding: "base64",
				},
				token,
			);
			blobShas.set(change.path, blobData.sha);
		}
	}

	await Promise.all(
		Array.from(
			{ length: Math.min(CONCURRENCY, nonNullChanges.length || 1) },
			blobWorker,
		),
	);

	// 4. Create a new tree
	const treeEntries = changes.map((c) => {
		if (c.content === null) {
			// Deletion: sha: null signals GitHub to remove the path
			return {
				path: c.path,
				mode: "100644" as const,
				type: "blob" as const,
				sha: null,
			};
		}
		return {
			path: c.path,
			mode: "100644" as const,
			type: "blob" as const,
			sha: blobShas.get(c.path)!,
		};
	});

	interface TreeCreateResponse {
		sha: string;
	}
	const treeData = await ghWrite<TreeCreateResponse>(
		`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/trees`,
		"POST",
		{ base_tree: baseTreeSha, tree: treeEntries },
		token,
	);
	const newTreeSha = treeData.sha;

	// 5. Create the commit
	interface CommitCreateResponse {
		sha: string;
	}
	const newCommitData = await ghWrite<CommitCreateResponse>(
		`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/commits`,
		"POST",
		{ message, tree: newTreeSha, parents: [baseCommitSha] },
		token,
	);
	const newCommitSha = newCommitData.sha;

	// 6. Create or fast-forward the branch ref
	// Try POST first; if the ref already exists (422), fall through to PATCH.
	interface RefCreateResponse {
		sha?: string;
		message?: string;
	}
	const postResult = await ghWrite<RefCreateResponse>(
		`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/refs`,
		"POST",
		{ ref: `refs/heads/${branch}`, sha: newCommitSha },
		token,
		true, // allow 422
	);

	if (
		postResult.message?.includes("Reference already exists") ||
		"sha" in postResult === false
	) {
		// Branch exists — fast-forward it
		await ghWrite(
			`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/refs/heads/${encodePathish(branch)}`,
			"PATCH",
			{ sha: newCommitSha, force: false },
			token,
		);
	}

	return { commitSha: newCommitSha, branchRef: `refs/heads/${branch}` };
}

/**
 * Open a pull request for a branch that has already been pushed.
 */
export async function openPullRequest({
	owner,
	repo,
	head,
	base,
	title,
	body,
	token,
}: OpenPullRequestParams): Promise<{ url: string; number: number }> {
	interface PullsCreateResponse {
		html_url: string;
		number: number;
	}
	const data = await ghWrite<PullsCreateResponse>(
		`${GH_API}/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/pulls`,
		"POST",
		{ head, base, title, body },
		token,
	);
	return { url: data.html_url, number: data.number };
}
