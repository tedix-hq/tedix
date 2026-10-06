import type {
	ArtifactsAssertReady,
	ArtifactsPushReceipt,
} from "./artifacts-git";
/**
 * Workspace I/O for isolate tedis.
 *
 * Two backends:
 *   - SOUL.md / IDENTITY.md / USER.md / AGENTS.md / TOOLS.md / MEMORY.md
 *     →  Cloudflare Artifacts first,
 *     then R2 fallback (`tedix-tedi-production` / <tediId>/...). Reads use a
 *     short-lived read token and never create a repo as a side effect.
 *   - Daily logs (`workspace/daily/YYYY-MM-DD.md`)  →  Cloudflare Artifacts
 *     per-tedi repo (`tedix-prod` namespace, repo name = tediId). Committed
 *     via `isomorphic-git` from `artifacts-git.ts` so isolate writes land in
 *     the same git history a container counterpart's `artifacts` daemon
 *     would push to. Legacy R2 daily-log entries from P6.2 are left in place
 *     (not migrated, not deleted).
 */

import {
	artifactsRepoNameForTediId,
	type DailyLogArtifactBatch,
	type DailyLogArtifactEntry,
	type DailyLogArtifactFileWrite,
	dailyLogArtifactPath,
	formatDailyLogEntry,
} from "./artifacts-contract";
import { errorMessage } from "@tedix/worker-kit/error-message";

export { utcDateSlug } from "./artifacts-contract";

const DEFAULT_PREFIX_FILES = [
	"SOUL.md",
	"IDENTITY.md",
	"USER.md",
	"AGENTS.md",
	"TOOLS.md",
	"memory/MEMORY.md",
];
const IDENTITY_SOURCE_FILE_BY_PATH: Record<string, string> = {
	"memory/MEMORY.md": "MEMORY.md",
};

export interface WorkspaceFile {
	key: string;
	text: string;
}

type IdentityFileSource = "artifacts" | "r2" | "missing";

export interface IdentityFileReadDiagnostic {
	path: string;
	source: IdentityFileSource;
	key: string | null;
	chars: number;
	artifact: {
		attempted: boolean;
		repoFound?: boolean;
		fileFound?: boolean;
		error?: string;
	};
	r2: {
		attempted: boolean;
		fileFound?: boolean;
		error?: string;
	};
}

export interface IdentityReadDiagnostics {
	checkedAt: string;
	tediId: string;
	artifacts: {
		bound: boolean;
		configured: boolean;
		namespace?: string;
		repoName: string;
		repoFound?: boolean;
		cloneOk?: boolean;
		error?: string;
	};
	files: IdentityFileReadDiagnostic[];
	provisionedFiles: string[];
	missingFiles: string[];
	usedR2Fallback: boolean;
	lastReadError?: string;
}

export interface ReadIdentityFilesOptions {
	bucket: R2Bucket;
	tediId: string;
	files?: string[];
	artifacts?: Artifacts;
	artifactsAccountId?: string;
	artifactsNamespace?: string;
	artifactsReader?: (path: string) => Promise<string | null>;
}

function aggregateRepoFound(
	current: boolean | undefined,
	next: boolean | undefined,
): boolean | undefined {
	if (next === true) return true;
	if (current === true) return true;
	if (next === false) return current ?? false;
	return current;
}

export async function readIdentityFilesWithDiagnostics(
	opts: ReadIdentityFilesOptions,
): Promise<{
	files: WorkspaceFile[];
	diagnostics: IdentityReadDiagnostics;
}> {
	const {
		bucket,
		tediId,
		artifacts,
		artifactsAccountId,
		artifactsNamespace,
		artifactsReader,
		files = DEFAULT_PREFIX_FILES,
	} = opts;
	const out: WorkspaceFile[] = [];
	const fileDiagnostics = new Map<string, IdentityFileReadDiagnostic>();
	const repoName = artifactsRepoNameForTediId(tediId);
	const diagnostics: IdentityReadDiagnostics = {
		checkedAt: new Date().toISOString(),
		tediId,
		artifacts: {
			bound: Boolean(artifacts),
			configured: Boolean(
				artifacts && artifactsAccountId && artifactsNamespace,
			),
			...(artifactsNamespace ? { namespace: artifactsNamespace } : {}),
			repoName,
		},
		files: [],
		provisionedFiles: [],
		missingFiles: [],
		usedR2Fallback: false,
	};
	const getFileDiag = (path: string): IdentityFileReadDiagnostic => {
		let diag = fileDiagnostics.get(path);
		if (!diag) {
			diag = {
				path,
				source: "missing",
				key: null,
				chars: 0,
				artifact: { attempted: false },
				r2: { attempted: false },
			};
			fileDiagnostics.set(path, diag);
		}
		return diag;
	};

	if (
		!artifactsReader &&
		artifacts &&
		artifactsAccountId &&
		artifactsNamespace
	) {
		try {
			const { readFilesFromExistingRepoWithStatus } =
				await import("./artifacts-git");
			const result = await readFilesFromExistingRepoWithStatus(
				artifacts,
				artifactsAccountId,
				artifactsNamespace,
				tediId,
				files,
			);
			diagnostics.artifacts.repoFound = result.repoFound;
			diagnostics.artifacts.cloneOk = result.cloneOk;
			if (result.error) {
				diagnostics.artifacts.error = result.error;
				diagnostics.lastReadError = result.error;
			}
			for (const artifactFile of result.files) {
				const diag = getFileDiag(artifactFile.path);
				diag.artifact = {
					attempted: true,
					repoFound: result.repoFound,
					fileFound: artifactFile.fileFound,
					...(artifactFile.error ? { error: artifactFile.error } : {}),
				};
				if (artifactFile.error) diagnostics.lastReadError = artifactFile.error;
				if (artifactFile.content && artifactFile.content.trim().length > 0) {
					diag.source = "artifacts";
					diag.key = artifactFile.path;
					diag.chars = artifactFile.content.length;
					out.push({ key: artifactFile.path, text: artifactFile.content });
				}
			}
		} catch (err) {
			const message = errorMessage(err);
			diagnostics.artifacts.error = message;
			diagnostics.lastReadError = message;
			for (const file of files) {
				const diag = getFileDiag(file);
				diag.artifact = {
					attempted: true,
					repoFound: diagnostics.artifacts.repoFound,
					error: message,
				};
			}
		}
	}

	for (const file of files) {
		const diag = getFileDiag(file);
		if (artifactsReader) {
			try {
				const text = await artifactsReader(file);
				diag.artifact = {
					attempted: true,
					repoFound: text != null ? true : undefined,
					fileFound: text != null,
				};
				diagnostics.artifacts.repoFound = aggregateRepoFound(
					diagnostics.artifacts.repoFound,
					diag.artifact.repoFound,
				);
				if (text && text.trim().length > 0) {
					diag.source = "artifacts";
					diag.key = file;
					diag.chars = text.length;
					out.push({ key: file, text });
					continue;
				}
			} catch (err) {
				const message = errorMessage(err);
				diag.artifact = {
					attempted: true,
					repoFound: diagnostics.artifacts.repoFound,
					error: message,
				};
				diagnostics.lastReadError = message;
				console.warn(
					`[isolate.workspace] Artifacts read failed for ${tediId}/${file}:`,
					err,
				);
			}
		} else if (diag.source === "artifacts") {
			continue;
		}

		const key = `${tediId}/${file}`;
		try {
			diag.r2.attempted = true;
			const obj = await bucket.get(key);
			if (!obj) {
				diag.r2.fileFound = false;
				continue;
			}
			const text = await obj.text();
			diag.r2.fileFound = true;
			if (text && text.trim().length > 0) {
				diag.source = "r2";
				diag.key = key;
				diag.chars = text.length;
				diagnostics.usedR2Fallback = true;
				out.push({ key, text });
			}
		} catch (err) {
			const message = errorMessage(err);
			diag.r2 = { attempted: true, error: message };
			diagnostics.lastReadError = message;
			console.warn(`[isolate.workspace] R2 read failed for ${key}:`, {
				error: errorMessage(err),
			});
		}
	}
	diagnostics.files = files.map((file) => getFileDiag(file));
	diagnostics.provisionedFiles = diagnostics.files
		.filter((file) => file.source !== "missing")
		.map((file) => file.path);
	diagnostics.missingFiles = diagnostics.files
		.filter((file) => file.source === "missing")
		.map((file) => file.path);
	return { files: out, diagnostics };
}

export type DailyLogEntry = DailyLogArtifactEntry;

/**
 * Daily log path inside the per-tedi Artifacts repo.
 *
 * The repo is per-tedi (name = tediId), so no orgs/tedis/{id} prefix is
 * needed — the repo IS the tenant boundary. Container tedis sync the whole
 * canonical workspace tree; Agent-runtime tedis only write the daily
 * logs at this path, and any container counterpart would see them under the
 * same `workspace/daily/` prefix.
 */
export function dailyLogPath(date: string): string {
	return dailyLogArtifactPath(date);
}

export type DailyLogBatch = DailyLogArtifactBatch;

/**
 * Commit one or more days of new daily-log entries to the per-tedi CF
 * Artifacts repo in a single push.
 *
 * Pipeline per flush:
 *   1. Resolve / lazily-create the per-tedi repo + mint a write token.
 *   2. Shallow-clone `main` into an in-memory tree (or `git.init` on first
 *      ever flush for a brand-new repo).
 *   3. For each date in the batch: read the existing file (if any), append
 *      the new entries with the same `## ISO  role  turnId` block format
 *      the R2 path used, write back.
 *   4. Single commit with N file changes, push to `main`.
 *
 * Concurrency hazard: identical to the old R2 path. Two simultaneous flushes
 * would race the read-modify-write. The AgentTediDO holds `dailyLogWriteLock`
 * around this call so the alarm-tick and threshold-eager paths serialize.
 */
export async function commitDailyLogEntries(
	artifacts: Artifacts,
	opts: {
		assertReady: ArtifactsAssertReady;
		accountId: string;
		namespace: string;
		tediId: string;
		slug: string;
		batches: DailyLogBatch[];
	},
): Promise<ArtifactsPushReceipt | null> {
	const nonEmpty = opts.batches.filter((b) => b.entries.length > 0);
	if (nonEmpty.length === 0) return null;

	// Defer import so anyone importing types from workspace.ts (tests, etc.)
	// doesn't pay the isomorphic-git module-load cost up front.
	const { commitDailyLogs, readFileFromRepo } = await import("./artifacts-git");

	const files: DailyLogArtifactFileWrite[] = [];
	let totalEntries = 0;
	for (const batch of nonEmpty) {
		const path = dailyLogPath(batch.date);
		const existing = await readFileFromRepo(
			artifacts,
			opts.accountId,
			opts.namespace,
			opts.tediId,
			opts.slug,
			path,
			opts.assertReady,
		);
		const head = existing ?? `# Daily Log ${batch.date}\n`;
		const block = batch.entries.map(formatDailyLogEntry).join("");
		const next = head.endsWith("\n") ? `${head}${block}` : `${head}\n${block}`;
		files.push({ path, content: next });
		totalEntries += batch.entries.length;
	}

	const dates = nonEmpty.map((b) => b.date).join(",");
	return commitDailyLogs({
		artifacts,
		assertReady: opts.assertReady,
		accountId: opts.accountId,
		namespace: opts.namespace,
		tediId: opts.tediId,
		slug: opts.slug,
		files,
		message: `daily log ${dates} (+${totalEntries} entries)`,
	});
}

export function selectIdentityWorkspaceFiles(
	workspaceFiles: Record<string, unknown>,
	missingFiles: string[],
): DailyLogArtifactFileWrite[] {
	const out: DailyLogArtifactFileWrite[] = [];
	for (const path of missingFiles) {
		const sourcePath = IDENTITY_SOURCE_FILE_BY_PATH[path] ?? path;
		const content = workspaceFiles[sourcePath];
		if (typeof content === "string" && content.trim().length > 0) {
			out.push({ path, content });
		}
	}
	return out;
}

export async function commitIdentityWorkspaceFiles(
	artifacts: Artifacts,
	opts: {
		assertReady: ArtifactsAssertReady;
		accountId: string;
		namespace: string;
		tediId: string;
		slug: string;
		files: DailyLogArtifactFileWrite[];
	},
): Promise<ArtifactsPushReceipt | null> {
	if (opts.files.length === 0) return null;
	const { commitDailyLogs } = await import("./artifacts-git");
	return commitDailyLogs({
		artifacts,
		assertReady: opts.assertReady,
		accountId: opts.accountId,
		namespace: opts.namespace,
		tediId: opts.tediId,
		slug: opts.slug,
		files: opts.files,
		message: `provision identity files ${opts.files.map((file) => file.path).join(", ")}`,
	});
}

export function composeSystemPrompt(
	slug: string,
	identityFiles: WorkspaceFile[],
): string {
	if (identityFiles.length === 0) {
		return `You are ${slug}, a Tedix digital worker. Respond concisely. (Identity files not yet provisioned.)`;
	}
	const blocks = identityFiles
		.map((f) => `## ${f.key}\n\n${f.text.trim()}`)
		.join("\n\n");
	return `You are ${slug}, a Tedix digital worker.\n\n${blocks}`;
}
