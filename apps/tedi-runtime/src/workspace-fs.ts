/**
 * Computer owns the durable DO-SQLite workspace, native Git, and isolate shell.
 * Pi and Code Mode consume WorkspaceFsLike paths rooted at /workspace;
 * native Computer tools use absolute paths. Canonical identity and artifacts
 * live in D1, Artifacts, and R2; full Linux execution uses workstation leases.
 */

import { tracing } from "cloudflare:workers";
import {
	type EagerMount,
	type MountWriteAPI,
	type WorkspaceClient,
	R2Bucket,
	type R2BucketBinding,
	Workspace as WorkspaceVfs,
} from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { withDynamicWorkerLoaderDiagnostics } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { createGovernedComputerGitClient } from "./computer-git-policy";
import { createCloudflareObserver } from "@cloudflare/computer/observe/cloudflare";
import {
	createAITools,
	createExecTool,
	type ExecToolOutput,
	type WorkspaceLike,
} from "@cloudflare/computer/tools";
import type { FileInfo, WorkspaceFsLike } from "@cloudflare/shell";
import type { ToolSet } from "ai";
import { z } from "zod";
import { createPrivacySafeComputerObserver } from "./computer-observer";
import { computerReadToolModelOutput } from "./computer-read-model-output";

/** Root all relative tool paths under the VFS workspace root. */
const VFS_ROOT = "/workspace";
export const COMPUTER_ISOLATE_BACKEND_ID = "isolate";

/**
 * Read-only mirror of the tedi's portable R2 layer, mounted into the
 * VFS so workspace tools (read/grep/find/bash) can see the identity
 * prefix without a bespoke fetch. Callers address it as `.r2/...`.
 */
const R2_MOUNT_ROOT = `${VFS_ROOT}/.r2`;
/**
 * Only canonical identity keys belong in the projection. The per-tedi R2
 * prefix also contains generated artifacts and turn summaries; mounting that
 * whole prefix makes unrelated growth capable of disabling every workspace
 * tool at mount time.
 */
const R2_IDENTITY_KEYS = [
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"AGENTS.md",
	"TOOLS.md",
	"MEMORY.md",
	"memory/MEMORY.md",
] as const;

/** Materialization bounds: identity files are small; cap defensively. */
const R2_MOUNT_MAX_BYTES = 8 * 1024 * 1024;
const R2_MOUNT_MAX_ENTRIES = R2_IDENTITY_KEYS.length;

/**
 * Late-bound source for the R2 identity mount. Resolved at
 * materialization time (first workspace fs access), not construction,
 * because the DO learns its tedi identity asynchronously. Return null
 * to mount nothing (unbound/test environments) — the `.r2/` root then
 * stays an empty read-only directory.
 */
export type R2IdentityMountBucket = R2BucketBinding;

export type R2IdentityMountSource = () => Promise<{
	bucket: R2BucketBinding;
	prefix: string;
} | null>;

/**
 * R2 mounts are one-shot projections with no sync-back API. Live identity reads
 * use the Artifacts/R2 storage owners; this read-only projection serves tools.
 */
function r2IdentityMount(source: R2IdentityMountSource): EagerMount {
	return {
		kind: "tedix-r2-identity",
		mode: "read-only",
		strategy: "eager",
		maxBytes: R2_MOUNT_MAX_BYTES,
		maxEntries: R2_MOUNT_MAX_ENTRIES,
		async materialize(api: MountWriteAPI): Promise<void> {
			const resolved = await source();
			if (!resolved) {
				console.warn(
					"[workspace-fs] r2 identity mount: no source resolved; mounting empty",
				);
				return;
			}
			// Keep the upstream R2 mount provider, but present it a bounded view of
			// the bucket. A tedi prefix also owns artifacts/ and turn summaries;
			// those are not identity and can easily exceed the provider's mount
			// entry ceiling. Exact-prefix listings preserve the native provider's
			// streaming materializer without broad-scanning or projecting noise.
			const identityBucket: R2BucketBinding = {
				async list() {
					const candidates = await Promise.all(
						R2_IDENTITY_KEYS.map(async (relativeKey) => {
							const key = `${resolved.prefix}${relativeKey}`;
							const page = await resolved.bucket.list({
								prefix: key,
								limit: 100,
							});
							return page.objects.find((object) => object.key === key) ?? null;
						}),
					);
					const objects = candidates.filter(
						(object): object is { key: string; size: number } =>
							object !== null,
					);
					return { objects, truncated: false };
				},
				get: (key) => resolved.bucket.get(key),
			};
			const inner = R2Bucket(identityBucket, {
				prefix: resolved.prefix,
				mode: "read-only",
				maxBytes: R2_MOUNT_MAX_BYTES,
				maxEntries: R2_MOUNT_MAX_ENTRIES,
			});
			await inner.materialize(api);
		},
	};
}

/**
 * Thrown when a caller path resolves outside the `/workspace` root.
 * NOT an ENOENT — it must propagate as a real error (an escape attempt
 * is a boundary violation, not a missing file), so `isEnoent` never
 * matches it and the adapter rethrows instead of returning null.
 */
export class WorkspacePathError extends Error {
	readonly code = "EWORKSPACE_ESCAPE" as const;
	constructor(readonly requested: string) {
		super(`path escapes workspace root: ${requested}`);
		this.name = "WorkspacePathError";
	}
}

/**
 * Collapse `.` / `..` / empty segments. A `..` that would pop above an
 * absolute root is dropped at the root (POSIX-style), so the result of
 * an absolute input is always absolute and never climbs past `/`.
 */
function normalizeSegments(p: string): string {
	const isAbs = p.startsWith("/");
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") {
			out.pop();
			continue;
		}
		out.push(seg);
	}
	return (isAbs ? "/" : "") + out.join("/");
}

/**
 * Map a caller path (relative "repo/x" convention, an SDK-style workspace
 * absolute path such as "/repo/x", or an already-absolute VFS path) to a
 * normalized absolute VFS path CONFINED to `/workspace`.
 *
 * WorkspaceFsLike callers can use "/repo/x". Those are workspace-rooted
 * logical paths, not host filesystem paths; map them to "/workspace/repo/x".
 * Already-rooted "/workspace/..." paths remain unchanged. Relative escapes
 * ("../secret") and explicit VFS-root escapes ("/workspace/../secret") are
 * rejected. The confinement holds identically across the mount subtrees
 * (.r2/, repo/), since every mount lives under the root. A `..` that stays
 * inside the root ("scratch/../repo/x") is allowed. Throws
 * `WorkspacePathError` on escape.
 */
export function toVfsPath(path: string): string {
	const trimmed = path.trim();
	if (trimmed === "" || trimmed === "." || trimmed === "/") return VFS_ROOT;
	const joined =
		trimmed === VFS_ROOT || trimmed.startsWith(`${VFS_ROOT}/`)
			? trimmed
			: trimmed.startsWith("/")
				? `${VFS_ROOT}${trimmed}`
				: `${VFS_ROOT}/${trimmed.replace(/^\.\//, "")}`;
	const normalized = normalizeSegments(joined);
	if (normalized !== VFS_ROOT && !normalized.startsWith(`${VFS_ROOT}/`)) {
		throw new WorkspacePathError(path);
	}
	return normalized;
}

function fromVfsPath(path: string): string {
	if (path === VFS_ROOT) return "";
	return path.startsWith(`${VFS_ROOT}/`)
		? path.slice(VFS_ROOT.length + 1)
		: path;
}

function isEnoent(err: unknown): boolean {
	const code = (err as { code?: string } | null)?.code;
	return (
		code === "ENOENT" ||
		(err instanceof Error && /ENOENT|no such file/i.test(err.message))
	);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) chunks.push(value);
	}
	let total = 0;
	for (const c of chunks) total += c.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

type MkdirOptions = { recursive?: boolean };
type RmOptions = { recursive?: boolean; force?: boolean };

/**
 * Default `exclude` set for the workspace glob path. These are directories a
 * tedi workspace really grows — not a generic checkout's ignore file:
 *
 *   - `.git`         — a native clone writes a real `.git` object store into
 *                      the VFS (Computer's git resolves a repo by stat-ing
 *                      `/workspace/repo/.git`). It is by far the largest
 *                      directory in any checkout, it is read through the git
 *                      client rather than by path, and it is per-object, so
 *                      it dominates both the walk and the returned set.
 *   - `node_modules` — it does appear here: a workstation lease installs
 *                      into the same workspace the VFS syncs.
 *   - `npm-global`   — same lane, same reason.
 *
 * Deliberately NOT excluded:
 *   - `repo/`  — the tedi's own checkout is the point of most globs. The
 *     snapshot collector excludes it because foreign git objects must not
 *     enter the Artifacts repo; that is a write-side concern, not a read one.
 *   - `.r2/`   — the identity mount exists precisely so find/grep/read can
 *     see SOUL/IDENTITY/MEMORY without a bespoke fetch, and it is capped at
 *     seven entries, so it costs nothing to walk.
 *
 * Patterns are Computer's `find` dialect, matched whole against the path
 * relative to the searched directory. A leading globstar segment compiles to
 * an OPTIONAL leading path, so one entry prunes the name at the root and at
 * every depth; an excluded directory is never descended into.
 */
export const WORKSPACE_GLOB_DEFAULT_EXCLUDE: readonly string[] = [
	"**/.git",
	"**/node_modules",
	"**/npm-global",
];

export interface WorkspaceGlobOptions {
	/**
	 * Replaces `WORKSPACE_GLOB_DEFAULT_EXCLUDE` outright. Widen by spreading
	 * the default set; pass `[]` for a genuinely unfiltered walk, which is
	 * what a caller whose job is "find everything" must do explicitly rather
	 * than be filtered silently.
	 */
	exclude?: readonly string[];
}

/**
 * Pi and Code Mode share WorkspaceFsLike. Code Mode additionally requires
 * deleteFile and diffContent for its workspace state contract. `glob` widens
 * the shared signature with an optional options argument, which keeps it
 * assignable to `WorkspaceFsLike` for every consumer that ignores it.
 */
export type TediWorkspaceFs = Omit<WorkspaceFsLike, "glob"> & {
	glob(pattern: string, options?: WorkspaceGlobOptions): Promise<FileInfo[]>;
	deleteFile(path: string): Promise<boolean>;
	diffContent(path: string, newContent: string): Promise<string>;
};

/** Storage surface the VFS needs — structurally `ctx.storage`. */
export type WorkspaceVfsStorage = ConstructorParameters<
	typeof WorkspaceVfs
>[0]["storage"];

type WorkerShellBackendOptions = ConstructorParameters<
	typeof WorkerShellBackend
>[0];

export type TediComputerExecution = Pick<
	WorkerShellBackendOptions,
	"ctx" | "loader" | "workspace"
>;

/** Construct the DO-SQLite workspace and its canonical isolate backend. */
export function createTediWorkspaceVfs(
	storage: WorkspaceVfsStorage,
	opts?: {
		execution?: TediComputerExecution;
		identityMount?: R2IdentityMountSource;
	},
): WorkspaceVfs {
	return new WorkspaceVfs({
		storage,
		git: createGovernedComputerGitClient(),
		...(opts?.execution
			? {
					backends: [
						new WorkerShellBackend({
							...opts.execution,
							loader: opts.execution.loader
								? withDynamicWorkerLoaderDiagnostics(opts.execution.loader, {
										surface: "tedi_workspace_shell",
										reason: "tedi_workspace_shell_invocation",
									})
								: opts.execution.loader,
							// Make the release's default-deny policy structural at our
							// integration seam, rather than relying on an upstream default.
							egress: { mode: "none" },
							id: COMPUTER_ISOLATE_BACKEND_ID,
						}),
					],
				}
			: {}),
		observer: createPrivacySafeComputerObserver(
			createCloudflareObserver({ tracing }),
		),
		...(opts?.identityMount
			? { mounts: { [R2_MOUNT_ROOT]: r2IdentityMount(opts.identityMount) } }
			: {}),
	});
}

/** Initialized Computer capability consumed by tools and Pi. */
export interface ComputerWorkspaceSurface {
	fs: Pick<
		WorkspaceClient["fs"],
		| "stat"
		| "lstat"
		| "readFile"
		| "writeFile"
		| "mkdir"
		| "rm"
		| "rename"
		| "find"
		| "grep"
		| "readdir"
		| "symlink"
		| "readlink"
	>;
	runtime: Pick<WorkspaceClient["runtime"], "exec">;
}

/** Native Computer tools with Tedix path, policy, and facet boundaries. */
export function createTediComputerTools(ws: ComputerWorkspaceSurface): ToolSet {
	const fs = ws.fs;
	// The native FileStore mkdirs before writing. Existing directories beside
	// the read-only identity mount must be an idempotent operation.
	const workspace: WorkspaceLike & Pick<ComputerWorkspaceSurface, "runtime"> = {
		fs: {
			stat: fs.stat.bind(fs),
			readFile: fs.readFile.bind(fs),
			writeFile: fs.writeFile.bind(fs),
			mkdir: (path, options) => ensureVfsDirectory(fs, path, options),
			rm: fs.rm.bind(fs),
			find: fs.find.bind(fs),
			grep: fs.grep.bind(fs),
			readdir: fs.readdir.bind(fs),
		},
		runtime: ws.runtime,
	};
	const shell = {
		defaultBackend: COMPUTER_ISOLATE_BACKEND_ID,
		backends: {
			[COMPUTER_ISOLATE_BACKEND_ID]: {
				description:
					"Cloudflare Computer just-bash sandbox over the durable workspace. " +
					"Use it for text processing, file traversal, and Git inspection. " +
					"It has no network access or native processes; use governed HTTP capabilities for network reads and the Computer container workstation for full repository commands.",
			},
		},
		maxBytes: 65_536,
	};
	const tools = createAITools({
		workspace,
		read: {
			includeLineNumbers: true,
			maxBytes: 65_536,
			maxLines: 1_000,
		},
		shell,
	});
	const nativeGrep = tools.grep!;
	const nativeRead = tools.read!;
	const nativeExec = tools.exec!;
	if (nativeGrep.type === "provider")
		throw new Error("Computer grep must be a function tool");
	if (nativeExec.type === "provider")
		throw new Error("Computer exec must be a function tool");
	return {
		...tools,
		grep: {
			...nativeGrep,
			description:
				"Search workspace text. query is literal by default; set regex: true for regular expressions, including alternation such as ledger|preview. Results include paths and line numbers and can include surrounding lines.",
		},
		read: {
			...nativeRead,
			toModelOutput: computerReadToolModelOutput,
		},
		exec: {
			...nativeExec,
			description:
				"Run shell commands over your durable workspace (default cwd: /workspace). Use pipelines, text processing, file traversal, and local Git, including git -C. This sandbox has no network access or native processes. Use governed HTTP tools for network reads; open_computer selects full Linux for installed software, builds, tests, or full repository validation. Output is bounded; narrow large queries.",
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.describe(
						"Shell command, for example: grep -n TODO /workspace/repo/src/main.ts",
					),
				cwd: z
					.string()
					.optional()
					.describe("Working directory; defaults to /workspace."),
				env: z
					.record(z.string(), z.string())
					.optional()
					.describe("Environment variables for this command."),
			}),
			execute: async (input, options) => {
				const handles = new Set<{ [Symbol.dispose](): void }>();
				const ownedExec = createExecTool({
					...shell,
					workspace: {
						runtime: {
							exec: async (command, execOptions) => {
								const handle = await ws.runtime.exec(command, execOptions);
								handles.add(handle);
								return handle;
							},
						},
					},
				});
				try {
					// The terminal native object is transferable across the facet RPC boundary.
					let terminal: ExecToolOutput | undefined;
					for await (const event of ownedExec.execute!(
						input,
						options,
					) as AsyncIterable<ExecToolOutput>)
						terminal = event;
					return terminal;
				} finally {
					for (const handle of handles) handle[Symbol.dispose]();
				}
			},
		},
	};
}

function toFileInfo(input: {
	path: string;
	name: string;
	isDirectory: boolean;
	isSymbolicLink?: boolean;
	size?: number;
	mtime?: number;
}): FileInfo {
	return {
		path: fromVfsPath(input.path),
		name: input.name,
		type: input.isDirectory
			? "directory"
			: input.isSymbolicLink
				? "symlink"
				: "file",
		mimeType: "application/octet-stream",
		size: input.size ?? 0,
		createdAt: input.mtime ?? 0,
		updatedAt: input.mtime ?? 0,
	};
}

/**
 * Adapt the VFS to the pinned `@cloudflare/shell` `WorkspaceFsLike`
 * surface: null-on-missing reads,
 * relative-path convention, `FileInfo` result shapes.
 */
export function adaptVfsToWorkspaceFs(
	ws: Pick<ComputerWorkspaceSurface, "fs">,
): TediWorkspaceFs {
	const fs = ws.fs;
	const statImpl = async (
		path: string,
		kind: "stat" | "lstat",
	): Promise<FileInfo | null> => {
		try {
			const s = await fs[kind](toVfsPath(path));
			return toFileInfo({
				path: toVfsPath(path),
				name: s.name || path.split("/").pop() || path,
				isDirectory: s.isDirectory,
				isSymbolicLink: s.isSymbolicLink,
				size: s.size,
				mtime: s.mtime,
			});
		} catch (err) {
			if (isEnoent(err)) return null;
			throw err;
		}
	};
	return {
		async readFile(path: string): Promise<string | null> {
			try {
				return await fs.readFile(toVfsPath(path), "utf8");
			} catch (err) {
				if (isEnoent(err)) return null;
				throw err;
			}
		},
		async readFileBytes(path: string): Promise<Uint8Array | null> {
			try {
				const stream = await fs.readFile(toVfsPath(path));
				return await drain(stream);
			} catch (err) {
				if (isEnoent(err)) return null;
				throw err;
			}
		},
		async writeFile(path: string, content: string): Promise<void> {
			await ensureParentDir(fs, toVfsPath(path));
			await fs.writeFile(toVfsPath(path), content);
		},
		async writeFileBytes(
			path: string,
			data: Uint8Array | ArrayBuffer,
		): Promise<void> {
			await ensureParentDir(fs, toVfsPath(path));
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
			await fs.writeFile(toVfsPath(path), bytes);
		},
		async appendFile(
			path: string,
			content: string | Uint8Array,
		): Promise<void> {
			const vfsPath = toVfsPath(path);
			const existing = await this.readFileBytes(path);
			const addition =
				typeof content === "string"
					? new TextEncoder().encode(content)
					: content;
			if (!existing) {
				await ensureParentDir(fs, vfsPath);
				await fs.writeFile(vfsPath, addition);
				return;
			}
			const merged = new Uint8Array(existing.byteLength + addition.byteLength);
			merged.set(existing, 0);
			merged.set(addition, existing.byteLength);
			await fs.writeFile(vfsPath, merged);
		},
		async exists(path: string): Promise<boolean> {
			return (await statImpl(path, "stat")) !== null;
		},
		async stat(path: string): Promise<FileInfo | null> {
			return statImpl(path, "stat");
		},
		async lstat(path: string): Promise<FileInfo | null> {
			return statImpl(path, "lstat");
		},
		async mkdir(path: string, options?: MkdirOptions): Promise<void> {
			await ensureVfsDirectory(fs, toVfsPath(path), options);
		},
		async readDir(
			dir?: string,
			opts?: { limit?: number; offset?: number },
		): Promise<FileInfo[]> {
			const vfsDir = toVfsPath(dir ?? "");
			let entries: Awaited<ReturnType<typeof fs.readdir>>;
			try {
				entries = await fs.readdir(vfsDir, opts);
			} catch (err) {
				if (isEnoent(err)) return [];
				throw err;
			}
			return entries.map((e) =>
				toFileInfo({
					path: `${vfsDir}/${e.name}`,
					name: e.name,
					isDirectory: e.isDirectory,
					isSymbolicLink: e.isSymbolicLink,
					size: e.size,
					mtime: e.mtime,
				}),
			);
		},
		async rm(path: string, options?: RmOptions): Promise<void> {
			try {
				await fs.rm(toVfsPath(path), {
					...(options?.recursive ? { recursive: true as const } : {}),
					...(options?.force ? { force: true as const } : {}),
				});
			} catch (err) {
				if (options?.force && isEnoent(err)) return;
				throw err;
			}
		},
		async cp(src: string, dest: string): Promise<void> {
			const bytes = await this.readFileBytes(src);
			if (bytes === null) {
				throw Object.assign(new Error(`ENOENT: ${src}`), { code: "ENOENT" });
			}
			await this.writeFileBytes(dest, bytes);
		},
		async mv(src: string, dest: string): Promise<void> {
			await fs.rename(toVfsPath(src), toVfsPath(dest));
		},
		async symlink(target: string, linkPath: string): Promise<void> {
			await ensureParentDir(fs, toVfsPath(linkPath));
			await fs.symlink(toVfsPath(target), toVfsPath(linkPath));
		},
		async readlink(path: string): Promise<string> {
			return fromVfsPath(await fs.readlink(toVfsPath(path)));
		},
		async glob(
			pattern: string,
			options?: WorkspaceGlobOptions,
		): Promise<FileInfo[]> {
			// `?? default` and not `|| default`: an explicit empty array is a
			// caller asking for the unfiltered walk, not an absent option.
			const exclude = options?.exclude ?? WORKSPACE_GLOB_DEFAULT_EXCLUDE;
			const matches = await fs.find(VFS_ROOT, pattern, {
				exclude: [...exclude],
			});
			return matches.map((m) =>
				toFileInfo({
					path: m.path,
					name: m.path.split("/").pop() ?? m.path,
					isDirectory: m.type === "dir",
				}),
			);
		},
		async deleteFile(path: string): Promise<boolean> {
			try {
				await fs.rm(toVfsPath(path), {});
				return true;
			} catch (err) {
				if (isEnoent(err)) return false;
				throw err;
			}
		},
		async diffContent(path: string, newContent: string): Promise<string> {
			const existing = (await this.readFile(path)) ?? "";
			const { createPatch } = await import("diff");
			return createPatch(path, existing, newContent);
		},
	} as TediWorkspaceFs;
}

/** Called inside the owning workspace DO's concurrency barrier. */
export async function writeReversibleWorkspaceFile(
	workspace: Pick<TediWorkspaceFs, "readFile" | "writeFile">,
	path: string,
	content: string,
): Promise<{ previousContent: string | null }> {
	if (typeof content !== "string" || content.length > 250_000)
		throw new Error("Content exceeds the reversible workspace limit (250000)");
	const previousContent = await workspace.readFile(path);
	if (previousContent !== null && previousContent.length > 250_000)
		throw new Error(
			"Existing file exceeds the reversible workspace limit (250000)",
		);
	await workspace.writeFile(path, content);
	return { previousContent };
}

/** Compare and restore at the owner; a conflict never mutates current bytes. */
export async function restoreWorkspaceFile(
	workspace: Pick<TediWorkspaceFs, "readFile" | "writeFile" | "deleteFile">,
	path: string,
	expectedContent: string,
	previousContent: string | null,
): Promise<void> {
	if (
		typeof expectedContent !== "string" ||
		expectedContent.length > 250_000 ||
		(previousContent !== null &&
			(typeof previousContent !== "string" || previousContent.length > 250_000))
	)
		throw new Error("Invalid reversible workspace receipt");
	if ((await workspace.readFile(path)) !== expectedContent)
		throw new Error(
			"workspace_rollback_conflict: file changed after the approved write",
		);
	if (previousContent === null) await workspace.deleteFile(path);
	else await workspace.writeFile(path, previousContent);
}

/** Preserve idempotent mkdir without swallowing permission or storage errors. */
async function ensureVfsDirectory(
	fs: Pick<WorkspaceVfs["fs"], "stat" | "mkdir">,
	path: string,
	options?: MkdirOptions,
): Promise<void> {
	if (options?.recursive) {
		try {
			if ((await fs.stat(path)).isDirectory) return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	await fs.mkdir(path, options);
}

async function ensureParentDir(
	fs: Pick<WorkspaceVfs["fs"], "stat" | "mkdir">,
	vfsPath: string,
): Promise<void> {
	const parent = vfsPath.slice(0, vfsPath.lastIndexOf("/"));
	if (!parent || parent === VFS_ROOT) return;
	await ensureVfsDirectory(fs, parent, { recursive: true });
}

// ── Workspace snapshot collection ───────────────────────────────────────
//
// Walks the live VFS into a deterministic file set for a git snapshot
// commit. Exclusions are structural, not advisory:
//   - `repo/`  — cloned third-party repos (own git history; snapshotting
//     them would balloon the Artifacts repo with foreign objects), and
//   - `.r2/`   — the read-only R2 identity mount (already durable in R2).
// Oversized files are skipped (recorded, never truncated silently); the
// walk stops at `maxFiles` with `truncated: true` so a pathological
// workspace can never wedge the snapshot path.

export interface WorkspaceSnapshotFile {
	path: string;
	content: string;
}

export interface WorkspaceSnapshotSkip {
	path: string;
	reason: "too-large" | "unreadable";
}

export interface WorkspaceSnapshotCollection {
	files: WorkspaceSnapshotFile[];
	skipped: WorkspaceSnapshotSkip[];
	truncated: boolean;
}

export const WORKSPACE_SNAPSHOT_EXCLUDED_ROOTS = ["repo", ".r2"] as const;
export const WORKSPACE_SNAPSHOT_MAX_FILES = 2_000;
export const WORKSPACE_SNAPSHOT_MAX_FILE_CHARS = 400_000;

export async function collectWorkspaceSnapshotFiles(
	workspaceFs: Pick<TediWorkspaceFs, "readDir" | "readFile">,
	opts?: { maxFiles?: number; maxFileChars?: number },
): Promise<WorkspaceSnapshotCollection> {
	const maxFiles = opts?.maxFiles ?? WORKSPACE_SNAPSHOT_MAX_FILES;
	const maxFileChars = opts?.maxFileChars ?? WORKSPACE_SNAPSHOT_MAX_FILE_CHARS;
	const files: WorkspaceSnapshotFile[] = [];
	const skipped: WorkspaceSnapshotSkip[] = [];
	const excluded = new Set<string>(WORKSPACE_SNAPSHOT_EXCLUDED_ROOTS);
	// BFS keeps sibling ordering stable for deterministic commits.
	const queue: string[] = [""];
	while (queue.length > 0) {
		const dir = queue.shift() as string;
		const entries = await workspaceFs.readDir(dir);
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			const rel = dir ? `${dir}/${entry.name}` : entry.name;
			if (dir === "" && excluded.has(entry.name)) continue;
			if (entry.type === "symlink") continue;
			if (entry.type === "directory") {
				queue.push(rel);
				continue;
			}
			if (files.length >= maxFiles) {
				return { files, skipped, truncated: true };
			}
			let content: string | null = null;
			try {
				content = await workspaceFs.readFile(rel);
			} catch {
				skipped.push({ path: rel, reason: "unreadable" });
				continue;
			}
			if (content === null) {
				skipped.push({ path: rel, reason: "unreadable" });
				continue;
			}
			if (content.length > maxFileChars) {
				skipped.push({ path: rel, reason: "too-large" });
				continue;
			}
			files.push({ path: rel, content });
		}
	}
	return { files, skipped, truncated: false };
}
