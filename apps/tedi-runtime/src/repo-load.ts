/**
 * repo_load tool helpers.
 *
 * Pure functions extracted from do.ts so they can be unit-tested in a plain
 * `bun run` script without pulling in the full Worker/DO dependency tree.
 *
 * The DO class owns wiring (D1 reads, workspace writes, identity resolution);
 * this module owns the stateless logic that can be reasoned about in isolation.
 */

import {
	getTediRuntimeEncryptedSecret,
	getTediRuntimeRepoConfig,
} from "@tedix/db/queries/tedi-runtime-bootstrap";
import type { RepoConfig } from "@tedix/db/schema/tedis";
import { decryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import {
	loadRepoFilesResult,
	RepoAuthError,
	RepoNotFoundError,
	RepoRateLimitError,
	RepoSecondaryRateLimitError,
	RepoTreeTruncatedError,
	RepoUnsafeRefError,
} from "./repo-api";

export const REPO_LOAD_MAX_FILES = 200;
export const REPO_LOAD_MAX_TOTAL_BYTES = 5_000_000;
export const REPO_LOAD_WORKSPACE_PREFIX = "repo/";

/**
 * Parse a GitHub HTTPS URL into owner + repo.
 * Accepts https://github.com/owner/repo[.git] or github.com/owner/repo.
 * Returns null on any malformed input (fail-soft; no throw).
 */
export function parseRepoUrl(
	repoUrl: string,
): { owner: string; repo: string } | null {
	try {
		const raw = repoUrl.trim();
		const normalized =
			raw.startsWith("http://") || raw.startsWith("https://")
				? raw
				: `https://${raw}`;
		const url = new URL(normalized);
		if (url.hostname !== "github.com") return null;
		const parts = url.pathname
			.replace(/^\/+|\/+$/g, "")
			.replace(/\.git$/, "")
			.split("/");
		if (parts.length < 2) return null;
		const owner = parts[0]!;
		const repo = parts[1]!;
		const safe = /^[A-Za-z0-9._-]+$/;
		if (!safe.test(owner) || !safe.test(repo)) return null;
		return { owner, repo };
	} catch {
		return null;
	}
}

/** Map a repo-api error to a canonical code object. Never exposes err.message verbatim. */
export function mapRepoError(err: unknown): Record<string, unknown> {
	if (err instanceof RepoNotFoundError) {
		return { ok: false, error: "repo_not_found" };
	}
	if (err instanceof RepoAuthError) {
		return { ok: false, error: "github_auth_failed" };
	}
	if (err instanceof RepoRateLimitError) {
		return { ok: false, error: "rate_limited", resetAt: err.resetAt };
	}
	if (err instanceof RepoSecondaryRateLimitError) {
		return {
			ok: false,
			error: "secondary_rate_limited",
			retryAfter: err.retryAfter,
		};
	}
	if (err instanceof RepoTreeTruncatedError) {
		return {
			ok: false,
			error: "tree_truncated",
			hint: "Pass explicit file paths to use the Contents API fallback.",
		};
	}
	if (err instanceof RepoUnsafeRefError) {
		return {
			ok: false,
			error: "invalid_path",
			hint: "Path/ref had an empty, '.' or '..' segment — pass clean relative paths.",
		};
	}
	return { ok: false, error: "repo_load_failed" };
}

/** Minimal dependencies required by runRepoLoad. */
export interface RepoLoadDeps {
	/** D1 database binding with a prepared-statement read chain. */
	db: {
		prepare(sql: string): {
			bind(...args: unknown[]): { first<T>(): Promise<T | null> };
		};
	};
	/** Base64-encoded SECRETS_MASTER_KEY, or undefined when not bound. */
	masterKey: string | undefined;
	/** Workspace: write a file by path with string content. */
	writeFile: (path: string, content: string) => Promise<void>;
}

export interface RepoLoadInput {
	tediId: string;
	paths: string[];
	ref?: string;
	maxFiles?: number;
}

/**
 * Core repo_load logic, injectable for unit testing.
 * Returns a structured result; never throws.
 */
export async function runRepoLoad(
	deps: RepoLoadDeps,
	input: RepoLoadInput,
): Promise<Record<string, unknown>> {
	const { tediId, paths, ref: inputRef, maxFiles: inputMaxFiles } = input;

	// 1. Load repo_config — distinguish a DB/parse error from a genuinely missing row
	let cfg: RepoConfig | null = null;
	{
		let repoConfig: string | null = null;
		let dbReadError = false;
		try {
			repoConfig = await getTediRuntimeRepoConfig(deps.db, tediId);
		} catch (err) {
			console.warn(
				`[repo_load] D1 read error for repo_config (${tediId}):`,
				err,
			);
			dbReadError = true;
		}
		if (dbReadError) return { ok: false, error: "repo_config_read_failed" };

		if (repoConfig) {
			try {
				const parsed: unknown =
					typeof repoConfig === "string" ? JSON.parse(repoConfig) : repoConfig;
				if (parsed && typeof parsed === "object") {
					const c = parsed as Record<string, unknown>;
					if (typeof c.repoUrl === "string" && c.repoUrl.trim()) {
						cfg = {
							repoUrl: c.repoUrl,
							branch: typeof c.branch === "string" ? c.branch : undefined,
							worktreePath:
								typeof c.worktreePath === "string" ? c.worktreePath : undefined,
						};
					}
				}
			} catch (err) {
				console.warn(
					`[repo_load] JSON.parse error for repo_config (${tediId}):`,
					err,
				);
				return { ok: false, error: "repo_config_read_failed" };
			}
		}
	}
	if (!cfg) return { ok: false, error: "no_repo_config" };

	// 2. Parse repo URL
	const parsed = parseRepoUrl(cfg.repoUrl);
	if (!parsed) return { ok: false, error: "invalid_repo_url" };
	const { owner, repo } = parsed;

	// 3. Resolve ref
	const rawRef =
		typeof inputRef === "string" && inputRef.trim()
			? inputRef.trim()
			: typeof cfg.branch === "string" && cfg.branch.trim()
				? cfg.branch.trim()
				: "main";
	const refSafe = /^[A-Za-z0-9._/-]+$/;
	if (!refSafe.test(rawRef)) return { ok: false, error: "invalid_ref" };
	// Reject dot-segments: any empty, '.', or '..' segment is a traversal attempt
	if (
		rawRef.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
	) {
		return { ok: false, error: "invalid_ref" };
	}
	const ref = rawRef;

	// 4. Load GITHUB_PAT
	let token: string | null = null;
	if (deps.masterKey) {
		try {
			const encryptedValue = await getTediRuntimeEncryptedSecret(
				deps.db,
				tediId,
				"GITHUB_PAT",
			);
			if (encryptedValue) {
				token = await decryptTediSecret(deps.masterKey, tediId, encryptedValue);
			}
		} catch {
			console.warn(`[repo_load] failed to load GITHUB_PAT for tedi ${tediId}`);
		}
	}
	if (!token) return { ok: false, error: "no_github_pat" };

	// 5. Validate paths — normalize trailing slash, reject dot-segments
	if (!Array.isArray(paths) || paths.length === 0) {
		return { ok: false, error: "paths_required" };
	}
	const validPaths = paths
		.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
		.map((p) => {
			// Normalize: strip a single trailing '/' so "src/" → "src" for the
			// dot-segment check, but keep the value as-is for the API call because
			// the Contents API uses it as a prefix filter. Re-add the trailing slash
			// after validation to preserve the caller's intent as a prefix filter.
			const trimmed = p.trim();
			// Strip one or more trailing slashes to normalise e.g. "src/" → "src"
			return trimmed.replace(/\/+$/, "");
		});
	if (validPaths.length === 0) return { ok: false, error: "paths_required" };
	// Reject any path with dot-segments (traversal attempt)
	for (const p of validPaths) {
		if (p.split("/").some((seg) => seg === "." || seg === "..")) {
			return { ok: false, error: "invalid_path" };
		}
	}

	// 6. Clamp maxFiles
	const maxFiles =
		typeof inputMaxFiles === "number" &&
		Number.isFinite(inputMaxFiles) &&
		inputMaxFiles > 0
			? Math.min(Math.floor(inputMaxFiles), REPO_LOAD_MAX_FILES)
			: REPO_LOAD_MAX_FILES;

	// 7. Fetch files
	let files: Array<{ path: string; content: string }>;
	let skippedDirectories: string[] = [];
	try {
		const result = await loadRepoFilesResult({
			owner,
			repo,
			ref,
			token,
			paths: validPaths,
		});
		files = result.files;
		skippedDirectories = result.skippedDirectories;
	} catch (err) {
		return mapRepoError(err);
	}

	// 8. Enforce caps BEFORE any write
	if (files.length > maxFiles) {
		return {
			ok: false,
			error: "too_many_files",
			count: files.length,
			limit: maxFiles,
		};
	}

	const enc = new TextEncoder();
	let totalBytes = 0;
	for (const f of files) {
		totalBytes += enc.encode(f.content).byteLength;
	}
	if (totalBytes > REPO_LOAD_MAX_TOTAL_BYTES) {
		return {
			ok: false,
			error: "batch_too_large",
			totalBytes,
			limit: REPO_LOAD_MAX_TOTAL_BYTES,
		};
	}

	// 9. Write to workspace
	const written: Array<{ path: string; bytes: number }> = [];
	try {
		for (const f of files) {
			const wsPath = `${REPO_LOAD_WORKSPACE_PREFIX}${f.path}`;
			await deps.writeFile(wsPath, f.content);
			written.push({ path: f.path, bytes: enc.encode(f.content).byteLength });
		}
	} catch {
		return {
			ok: false,
			error: "workspace_write_failed",
			written: written.length,
		};
	}

	const successResult: Record<string, unknown> = {
		ok: true,
		owner,
		repo,
		ref,
		workspacePrefix: REPO_LOAD_WORKSPACE_PREFIX,
		fileCount: written.length,
		totalBytes,
		files: written,
	};
	if (skippedDirectories.length > 0) {
		successResult.skippedDirectories = skippedDirectories;
		successResult.hint =
			"On large/truncated repos pass EXACT file paths; directory prefixes are not expanded here.";
	}
	return successResult;
}

// ── Cloudflare Computer native Git tier ─────────────────────────────

/**
 * Shared config+auth resolution for the git-backed native tier: the
 * same D1 `repo_config` row and `GITHUB_PAT` tedi secret `runRepoLoad`
 * reads, exposed for clone/fetch flows. Returns a structured error
 * object (never throws) on any missing piece.
 */
export async function loadRepoAuth(
	deps: Pick<RepoLoadDeps, "db" | "masterKey">,
	tediId: string,
): Promise<
	| { ok: true; owner: string; repo: string; branch?: string; token: string }
	| { ok: false; error: string }
> {
	let repoUrl: string | null = null;
	let branch: string | undefined;
	try {
		const repoConfig = await getTediRuntimeRepoConfig(deps.db, tediId);
		if (repoConfig) {
			const parsed: unknown = JSON.parse(repoConfig);
			if (parsed && typeof parsed === "object") {
				const c = parsed as Record<string, unknown>;
				if (typeof c.repoUrl === "string" && c.repoUrl.trim()) {
					repoUrl = c.repoUrl;
					branch = typeof c.branch === "string" ? c.branch : undefined;
				}
			}
		}
	} catch {
		return { ok: false, error: "repo_config_read_failed" };
	}
	if (!repoUrl) return { ok: false, error: "no_repo_config" };
	const parsed = parseRepoUrl(repoUrl);
	if (!parsed) return { ok: false, error: "invalid_repo_url" };

	let token: string | null = null;
	if (deps.masterKey) {
		try {
			const encryptedValue = await getTediRuntimeEncryptedSecret(
				deps.db,
				tediId,
				"GITHUB_PAT",
			);
			if (encryptedValue) {
				token = await decryptTediSecret(deps.masterKey, tediId, encryptedValue);
			}
		} catch {
			console.warn(`[repo git] failed to load GITHUB_PAT for tedi ${tediId}`);
		}
	}
	if (!token) return { ok: false, error: "no_github_pat" };
	return { ok: true, owner: parsed.owner, repo: parsed.repo, branch, token };
}

/** VFS directory the cloned working tree lands in (workspace "repo/"). */
export const REPO_CLONE_VFS_DIR = "/workspace/repo";

/**
 * Native-clone ceiling on the bytes a shallow checkout actually
 * materialises (sum of tip-tree blob sizes, KB). Deliberately *not*
 * GitHub's repo `size`, which counts packed full history and overestimates
 * a depth-1 working tree several-fold. The ceiling exists because the clone lands in the
 * Durable Object's ~128MB memory envelope and the container-side
 * filesystem is held in memory, so the quantity that matters is
 * materialised bytes, not history. Tunable.
 */
export const REPO_CLONE_MAX_CHECKOUT_KB = 100_000; // ~100 MB materialised

/** Why a repository was judged too large for the in-DO clone path. */
export type RepoCheckoutOversizeReason = "tree_bytes" | "tree_truncated";

export type RepoCheckoutProbeResult =
	| { ok: true; checkoutKb: number }
	| { ok: true; checkoutKb: null } // probe unavailable — fail open
	| {
			ok: false;
			error: "too_large_for_native";
			checkoutKb: number | null;
			reason: RepoCheckoutOversizeReason;
	  };

/**
 * Pre-flight checkout-size probe via the GitHub git/trees REST API.
 *
 * `GET /repos/{owner}/{repo}/git/trees/{ref}?recursive=1` enumerates the tip
 * tree and reports every blob's byte size, so summing the blobs yields the
 * bytes a depth-1 checkout writes — exactly what the DO memory envelope
 * constrains. The repos endpoint's `size` cannot answer that question: it is
 * the packed repository including all history.
 *
 * A `truncated: true` response is itself a verdict rather than a failure:
 * GitHub truncates above 100,000 entries / ~7MB of tree JSON, and a working
 * tree with that many files is past agent scale whatever its byte total.
 *
 * Returns a typed `too_large_for_native` above the ceiling. clone_repo
 * consumes that result by loading supplied exact paths through repo_load; it
 * preserves the `escalate: "workstation"` signal when no native file fallback
 * is possible. FAIL-OPEN on probe error (rate limit, network, unresolvable
 * ref): the shallow clone's own bounds remain, and blocking a clone on a
 * flaky metadata call would be worse than proceeding — the ceiling is defense
 * in depth, not the only guard. Credentials are never echoed in errors.
 */
export async function probeRepoCheckoutKb(
	auth: { owner: string; repo: string; token: string; ref?: string },
	fetchImpl: typeof fetch = fetch,
): Promise<RepoCheckoutProbeResult> {
	const safeRef =
		auth.ref && /^[A-Za-z0-9._/-]+$/.test(auth.ref) ? auth.ref : undefined;
	// A branch name containing "/" is ambiguous against the trees route, so
	// keep the remote default tip as a second candidate rather than silently
	// losing the gate on a 404.
	const refs = safeRef && safeRef !== "HEAD" ? [safeRef, "HEAD"] : ["HEAD"];
	try {
		for (const ref of refs) {
			const res = await fetchImpl(
				`https://api.github.com/repos/${auth.owner}/${auth.repo}/git/trees/${ref}?recursive=1`,
				{
					headers: {
						Authorization: `Bearer ${auth.token}`,
						Accept: "application/vnd.github+json",
						"User-Agent": "tedix-repo-clone",
					},
				},
			);
			if (!res.ok) continue;
			const body = (await res.json()) as {
				tree?: unknown;
				truncated?: unknown;
			};
			if (body.truncated === true) {
				return {
					ok: false,
					error: "too_large_for_native",
					checkoutKb: null,
					reason: "tree_truncated",
				};
			}
			if (!Array.isArray(body.tree)) continue;
			let bytes = 0;
			for (const entry of body.tree as Array<{
				type?: unknown;
				size?: unknown;
			}>) {
				if (entry?.type === "blob" && typeof entry.size === "number") {
					bytes += entry.size;
				}
			}
			const checkoutKb = Math.ceil(bytes / 1024);
			if (checkoutKb > REPO_CLONE_MAX_CHECKOUT_KB) {
				return {
					ok: false,
					error: "too_large_for_native",
					checkoutKb,
					reason: "tree_bytes",
				};
			}
			return { ok: true, checkoutKb };
		}
		return { ok: true, checkoutKb: null };
	} catch {
		return { ok: true, checkoutKb: null };
	}
}

export interface RepoCloneDeps {
	db: RepoLoadDeps["db"];
	masterKey: string | undefined;
	/** Typed clone over the workspace VFS (GitClient.clone). */
	clone: (options: {
		url: string;
		dir: string;
		ref?: string;
		paths?: string[];
		depth?: number;
		singleBranch?: boolean;
		headers?: Record<string, string>;
	}) => Promise<void>;
	/**
	 * Reset hook for `REPO_CLONE_VFS_DIR`. Every clone/fallback attempt clears
	 * the prior view before writing, and failures clear partial output again.
	 * Without this hook clone_repo fails closed instead of overlaying refs.
	 */
	removeCloneDir?: () => Promise<void>;
	/**
	 * Exact-file fallback used when the whole repository is too large for a
	 * native isomorphic-git clone. This deliberately does not fabricate a
	 * `.git`: callers get an explicit file-load mode and `gitAvailable:false`.
	 */
	loadFilesFallback?: (input: {
		ref?: string;
		paths: string[];
	}) => Promise<Record<string, unknown>>;
	/**
	 * Replace `repo/` with the exact successful fallback file set. A fallback
	 * must fail closed when this hook is absent or fails: overlaying files onto
	 * a durable prior checkout would mix refs/path sets and make later analysis
	 * appear source-grounded when it is reading stale files.
	 */
	replaceFallbackSnapshot?: (
		files: RepoFallbackSnapshotFile[],
	) => Promise<void>;
	/** Injectable for tests; defaults to global fetch (size probe). */
	fetchImpl?: typeof fetch;
}

export interface RepoFallbackSnapshotFile {
	path: string;
	bytes?: number;
}

export interface RepoFallbackSnapshotDeps {
	readFile: (path: string) => Promise<string | null>;
	writeFile: (path: string, content: string) => Promise<void>;
	removeRepoDir: () => Promise<void>;
}

/**
 * Turn an additive `repo_load` result into the replacement semantics promised
 * by `clone_repo`. Contents are staged in memory (bounded by repo_load's 5 MB
 * cap), then the old `repo/` tree is removed and only the fetched files are
 * restored. A failed restore removes the partial tree and throws so callers
 * cannot claim an isolated snapshot.
 */
export async function replaceRepoFallbackSnapshot(
	deps: RepoFallbackSnapshotDeps,
	files: RepoFallbackSnapshotFile[],
): Promise<void> {
	const staged: Array<{ path: string; content: string }> = [];
	const seen = new Set<string>();
	for (const file of files) {
		const path = file.path.trim();
		if (
			!path ||
			path.startsWith("/") ||
			path
				.split("/")
				.some((segment) => !segment || segment === "." || segment === "..") ||
			seen.has(path)
		) {
			throw new Error("invalid fallback snapshot file set");
		}
		seen.add(path);
		const workspacePath = `${REPO_LOAD_WORKSPACE_PREFIX}${path}`;
		const content = await deps.readFile(workspacePath);
		if (content === null) {
			throw new Error("fallback snapshot file is missing from the workspace");
		}
		staged.push({ path: workspacePath, content });
	}

	await deps.removeRepoDir();
	try {
		for (const file of staged) {
			await deps.writeFile(file.path, file.content);
		}
	} catch (error) {
		await deps.removeRepoDir().catch(() => {});
		throw error;
	}
}

/**
 * clone_repo core: shallow (default depth 1, single branch), optionally
 * sparse via `paths`, into the durable repo/ workspace with a real
 * `.git`. Auth via the tedi's GITHUB_PAT (Basic, x-access-token).
 * Never throws; structured results mirror runRepoLoad's error codes.
 */
export async function runRepoClone(
	deps: RepoCloneDeps,
	input: { tediId: string; ref?: string; paths?: string[]; depth?: number },
): Promise<Record<string, unknown>> {
	const auth = await loadRepoAuth(deps, input.tediId);
	if (!auth.ok) return auth;

	const rawRef = input.ref?.trim() || auth.branch?.trim() || undefined;
	if (rawRef !== undefined) {
		if (
			!/^[A-Za-z0-9._/-]+$/.test(rawRef) ||
			rawRef.split("/").some((s) => s === "" || s === "." || s === "..")
		) {
			return { ok: false, error: "invalid_ref" };
		}
	}
	const paths = input.paths
		?.filter((p) => typeof p === "string" && p.trim().length > 0)
		.map((p) => p.trim().replace(/\/+$/, ""));
	if (paths) {
		for (const p of paths) {
			if (p.split("/").some((s) => s === "." || s === "..")) {
				return { ok: false, error: "invalid_path" };
			}
		}
	}
	const depth =
		typeof input.depth === "number" &&
		Number.isFinite(input.depth) &&
		input.depth > 0
			? Math.min(Math.floor(input.depth), 50)
			: 1;

	// Pre-flight checkout-size ceiling. This applies to sparse checkouts too:
	// @cloudflare/computer uses isomorphic-git, whose `paths` option limits
	// only working-tree materialization. The clone still downloads every blob
	// reachable from the tip tree and retains an unbounded pack/index cache in
	// the DO, so exempting sparse clones can still exhaust isolate memory.
	const size = await probeRepoCheckoutKb(
		{ ...auth, ...(rawRef ? { ref: rawRef } : {}) },
		deps.fetchImpl,
	);
	const resetCloneDir = async (): Promise<boolean> => {
		if (!deps.removeCloneDir) return false;
		try {
			await deps.removeCloneDir();
			return true;
		} catch (error) {
			console.warn(
				"[repo clone] repo snapshot reset failed",
				error instanceof Error ? error.name : "UnknownError",
			);
			return false;
		}
	};
	if (!size.ok) {
		const oversizedClone = {
			ok: false,
			error: "too_large_for_native",
			escalate: "workstation",
			checkoutKb: size.checkoutKb,
			limitKb: REPO_CLONE_MAX_CHECKOUT_KB,
			oversizeReason: size.reason,
			hint:
				paths && paths.length > 0
					? "Repository exceeds the in-DO Git clone ceiling. Exact paths can still be loaded natively without .git; use open_computer({ repository: true }) for real Git or a full checkout."
					: "Repository exceeds the in-DO Git clone ceiling. Retry with exact paths for the automatic repo_load fallback, or use open_computer({ repository: true }) for real Git or a full checkout.",
		};

		if (paths && paths.length > 0 && deps.loadFilesFallback) {
			if (!(await resetCloneDir())) {
				return {
					...oversizedClone,
					error: "repo_snapshot_reset_failed",
				};
			}
			try {
				const fallback = await deps.loadFilesFallback({
					...(rawRef ? { ref: rawRef } : {}),
					paths,
				});
				if (fallback.ok === true) {
					const fallbackFiles = fallback.files;
					if (!Array.isArray(fallbackFiles)) {
						await resetCloneDir();
						return {
							...oversizedClone,
							error: "repo_load_fallback_isolation_unavailable",
							fallback: { attempted: true, result: fallback },
						};
					}
					const files = fallbackFiles.filter(
						(file): file is RepoFallbackSnapshotFile =>
							Boolean(file) &&
							typeof file === "object" &&
							typeof (file as { path?: unknown }).path === "string",
					);
					if (
						files.length !== fallbackFiles.length ||
						!deps.replaceFallbackSnapshot
					) {
						await resetCloneDir();
						return {
							...oversizedClone,
							error: "repo_load_fallback_isolation_unavailable",
							fallback: { attempted: true, result: fallback },
						};
					}
					try {
						await deps.replaceFallbackSnapshot(files);
					} catch {
						await resetCloneDir();
						return {
							...oversizedClone,
							error: "repo_load_fallback_isolation_failed",
							fallback: { attempted: true, result: fallback },
						};
					}
					return {
						...fallback,
						ok: true,
						mode: "repo_load_fallback",
						gitAvailable: false,
						snapshotIsolated: true,
						cloneSkipped: {
							reason: "too_large_for_native",
							checkoutKb: size.checkoutKb,
							limitKb: REPO_CLONE_MAX_CHECKOUT_KB,
							oversizeReason: size.reason,
						},
						hint: "repo/ was replaced with the exact requested files without a .git directory because the repository exceeds the native clone ceiling. Continue with workspace tools and repo_commit; use open_computer({ repository: true }) for the full Git checkout, installed software, builds, or full-repository validation.",
					};
				}
				await resetCloneDir();
				return {
					...oversizedClone,
					fallback: { attempted: true, result: fallback },
				};
			} catch (err) {
				await resetCloneDir();
				console.warn(
					"[repo clone] exact-file native fallback failed",
					err instanceof Error ? err.name : "UnknownError",
				);
				return {
					...oversizedClone,
					fallback: { attempted: true, error: "repo_load_fallback_failed" },
				};
			}
		}

		return oversizedClone;
	}

	const url = `https://github.com/${auth.owner}/${auth.repo}.git`;
	const basic = btoa(`x-access-token:${auth.token}`);
	if (!(await resetCloneDir())) {
		return {
			ok: false,
			error: "repo_snapshot_reset_failed",
			escalate: "workstation",
		};
	}
	try {
		await deps.clone({
			url,
			dir: REPO_CLONE_VFS_DIR,
			...(rawRef ? { ref: rawRef } : {}),
			...(paths && paths.length > 0 ? { paths } : {}),
			depth,
			singleBranch: true,
			headers: { Authorization: `Basic ${basic}` },
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// A failed clone can leave a partial tree that breaks the next retry;
		// clean it so a retry re-clones from scratch (fail-soft — a cleanup
		// error must not mask the original clone failure).
		await resetCloneDir();
		// Never leak the token; surface a bounded, sanitized reason.
		return {
			ok: false,
			error: "clone_failed",
			reason: message.replaceAll(auth.token, "[redacted]").slice(0, 300),
		};
	}
	return {
		ok: true,
		owner: auth.owner,
		repo: auth.repo,
		ref: rawRef ?? "(remote default)",
		depth,
		sparse: paths && paths.length > 0 ? paths : undefined,
		workspacePrefix: REPO_LOAD_WORKSPACE_PREFIX,
		gitAvailable: true,
		snapshotIsolated: true,
		hint: "Working tree is under repo/ with a real .git — use run_git for status/diff/log/commit and repo_commit for approval-gated pushes.",
	};
}

/**
 * Confine a caller-supplied `run_git` cwd to `REPO_CLONE_VFS_DIR` or a
 * subdirectory of it. Accepts undefined (defaults to the repo root),
 * the relative "repo" convention, and absolute VFS paths; rejects any cwd
 * that escapes the repo root. Pure/testable.
 */
export function confineGitCwd(
	cwd: unknown,
): { ok: true; cwd: string } | { ok: false; error: string } {
	if (cwd === undefined || cwd === null || cwd === "") {
		return { ok: true, cwd: REPO_CLONE_VFS_DIR };
	}
	if (typeof cwd !== "string") return { ok: false, error: "invalid_cwd" };
	const trimmed = cwd.trim();
	if (trimmed === "") return { ok: true, cwd: REPO_CLONE_VFS_DIR };
	// Normalize against the repo root: relative joins under it, absolute is
	// taken as-is, then `.`/`..` collapse and the result must stay inside.
	const joined = trimmed.startsWith("/")
		? trimmed
		: `${REPO_CLONE_VFS_DIR}/${trimmed.replace(/^\.\//, "")}`;
	const out: string[] = [];
	for (const seg of joined.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	const normalized = `/${out.join("/")}`;
	if (
		normalized !== REPO_CLONE_VFS_DIR &&
		!normalized.startsWith(`${REPO_CLONE_VFS_DIR}/`)
	) {
		return { ok: false, error: "cwd_escapes_repo" };
	}
	return { ok: true, cwd: normalized };
}
