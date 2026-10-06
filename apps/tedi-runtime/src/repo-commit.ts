/**
 * repo_commit pure helpers.
 *
 * Pure functions extracted from the DO so they can be unit-tested in a plain
 * `bun run` script without pulling in the full Worker/DO dependency tree.
 *
 * The DO class owns wiring (ledger reads, workspace reads, identity resolution,
 * approval polling); this module owns the stateless logic that can be reasoned
 * about in isolation.
 *
 * Security invariant: PATs are injected via deps at call time, never stored in
 * payloads, never logged, and never returned in results. changeSummary carries
 * paths only — file contents stay in the DO-SQLite ledger (repo-commit-store.ts).
 */

import {
	classifyRepoCommitRisk,
	REPO_COMMIT_WRITE_KIND,
	type RepoCommitWritePayload,
} from "@tedix/api-contract/schemas/repo-commit-write";
import {
	RepoAuthError,
	RepoNotFoundError,
	RepoRateLimitError,
	RepoSecondaryRateLimitError,
	RepoUnsafeRefError,
} from "./repo-api";
import { REPO_COMMIT_SUMMARY_PATH_CAP } from "./repo-commit-fence";

export { classifyRepoCommitRisk, REPO_COMMIT_WRITE_KIND };

/** Shared with the publish fence, which compares these capped lists. */
const PATH_CAP = REPO_COMMIT_SUMMARY_PATH_CAP;

export interface RepoCommitChangeSet {
	/** Path → content string (null = delete). */
	changes: { path: string; content: string | null }[];
}

export interface BuildRepoCommitPayloadInput {
	organizationId: string;
	tediId: string;
	conversationId: string;
	homeRunId: string | null;
	owner: string;
	repo: string;
	baseRef: string;
	branch: string;
	message: string;
	openPr: boolean;
	prBase: string | null;
	changeSet: RepoCommitChangeSet;
	/**
	 * Exact content fingerprint from the publish fence's declaration for this
	 * same changeset ({@link buildRepoCommitDeclaration}). Pass the declaration's
	 * own value — never recompute it here. The fingerprint has exactly one
	 * producer, so the copy that reaches D1 and the copy in the tedi's DO store
	 * cannot disagree. Omitted only where no declaration exists.
	 */
	changeFingerprint?: string | null;
	executionLedgerId: string;
}

/**
 * Build the approval payload from the change set.
 *
 * Produces a summary (paths + byte counts) only — never file contents or tokens.
 * addedOrModified and deleted path lists are each capped at PATH_CAP entries.
 */
export function buildRepoCommitPayload(
	input: BuildRepoCommitPayloadInput,
): RepoCommitWritePayload {
	const enc = new TextEncoder();

	let totalBytes = 0;
	const addedOrModifiedPaths: string[] = [];
	const deletedPaths: string[] = [];

	for (const c of input.changeSet.changes) {
		if (c.content === null) {
			deletedPaths.push(c.path);
		} else {
			addedOrModifiedPaths.push(c.path);
			totalBytes += enc.encode(c.content).byteLength;
		}
	}

	const riskTier = classifyRepoCommitRisk({
		baseRef: input.baseRef,
		branch: input.branch,
	});

	const payload: RepoCommitWritePayload = {
		kind: REPO_COMMIT_WRITE_KIND,
		organizationId: input.organizationId,
		tediId: input.tediId,
		conversationId: input.conversationId,
		homeRunId: input.homeRunId,
		owner: input.owner,
		repo: input.repo,
		baseRef: input.baseRef,
		branch: input.branch,
		message: input.message,
		openPr: input.openPr,
		prBase: input.prBase,
		changeSummary: {
			fileCount: input.changeSet.changes.length,
			addedOrModified: addedOrModifiedPaths.slice(0, PATH_CAP),
			deleted: deletedPaths.slice(0, PATH_CAP),
			totalBytes,
		},
		changeFingerprint: input.changeFingerprint ?? null,
		riskTier,
		executionLedgerId: input.executionLedgerId,
	};

	return payload;
}

export type RepoCommitExecuteResult =
	| { ok: true; commitSha: string; branchRef: string; prUrl?: string }
	| {
			ok: false;
			error: string;
			code: string;
			detail?: Record<string, unknown>;
	  };

/** Row shape from the DO-SQLite ledger (only what executeRepoCommitFromLedger needs). */
export interface RepoCommitLedgerRow {
	id: string;
	owner: string;
	repo: string;
	baseRef: string;
	branch: string;
	message: string;
	/** JSON-serialized { changes: {path, content|null}[] }. */
	changesJson: string;
	openPr: number | boolean;
	prBase: string | null;
}

export interface RepoCommitDeps {
	/** Decrypt and return the GitHub PAT for this tedi, or null on failure. */
	decryptPat: () => Promise<string | null>;
	commitRepoChanges: (args: {
		owner: string;
		repo: string;
		baseRef: string;
		branch: string;
		message: string;
		changes: { path: string; content: string | null }[];
		token: string;
	}) => Promise<{ commitSha: string; branchRef: string }>;
	openPullRequest: (args: {
		owner: string;
		repo: string;
		head: string;
		base: string;
		title: string;
		body: string;
		token: string;
	}) => Promise<{ url: string; number: number }>;
}

/**
 * Core executor — pure and injectable for unit testing.
 *
 * Reads the change set from the ledger row, obtains the PAT via deps.decryptPat
 * (PAT never leaks into the result), commits the changes, and optionally opens
 * a PR. Maps every RepoError to a structured code. Never throws.
 */
export async function executeRepoCommitFromLedger(args: {
	deps: RepoCommitDeps;
	row: RepoCommitLedgerRow;
}): Promise<RepoCommitExecuteResult> {
	const { deps, row } = args;

	let changeSet: RepoCommitChangeSet;
	try {
		const parsed: unknown = JSON.parse(row.changesJson);
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!Array.isArray((parsed as Record<string, unknown>).changes)
		) {
			return {
				ok: false,
				error: "Malformed changesJson in ledger row",
				code: "invalid_changes_json",
			};
		}
		changeSet = parsed as RepoCommitChangeSet;
	} catch {
		return {
			ok: false,
			error: "Failed to parse changesJson",
			code: "invalid_changes_json",
		};
	}

	let pat: string | null;
	try {
		pat = await deps.decryptPat();
	} catch {
		return {
			ok: false,
			error: "PAT decryption failed",
			code: "pat_decrypt_failed",
		};
	}
	if (!pat) {
		return {
			ok: false,
			error: "No GitHub PAT available",
			code: "no_github_pat",
		};
	}

	let commitResult: { commitSha: string; branchRef: string };
	try {
		commitResult = await deps.commitRepoChanges({
			owner: row.owner,
			repo: row.repo,
			baseRef: row.baseRef,
			branch: row.branch,
			message: row.message,
			changes: changeSet.changes,
			token: pat,
		});
	} catch (err) {
		// PAT stays local — it must never appear in the mapped error result
		console.warn(
			"[repo_commit_execute] error:",
			err instanceof Error ? err.message : String(err),
		);
		const _m = mapRepoError(err);
		return _m.ok
			? _m
			: {
					..._m,
					detail: {
						..._m.detail,
						raw: err instanceof Error ? err.message : String(err),
					},
				};
	}

	// Open PR if requested
	if (row.openPr && row.prBase) {
		try {
			const pr = await deps.openPullRequest({
				owner: row.owner,
				repo: row.repo,
				head: row.branch,
				base: row.prBase,
				title: row.message.split(/\r?\n/, 1)[0] ?? "",
				body: "",
				token: pat,
			});
			// PAT is no longer referenced after this point
			return {
				ok: true,
				commitSha: commitResult.commitSha,
				branchRef: commitResult.branchRef,
				prUrl: pr.url,
			};
		} catch (err) {
			console.warn(
				"[repo_commit_execute] error:",
				err instanceof Error ? err.message : String(err),
			);
			const _m = mapRepoError(err);
			return _m.ok
				? _m
				: {
						..._m,
						detail: {
							..._m.detail,
							raw: err instanceof Error ? err.message : String(err),
						},
					};
		}
	}

	return {
		ok: true,
		commitSha: commitResult.commitSha,
		branchRef: commitResult.branchRef,
	};
}

/** Map a repo-api error to a safe structured code. Never exposes err.message verbatim. */
function mapRepoError(err: unknown): RepoCommitExecuteResult {
	if (err instanceof RepoNotFoundError) {
		return {
			ok: false,
			error: "Repository not found or not accessible",
			code: "repo_not_found",
		};
	}
	if (err instanceof RepoAuthError) {
		return {
			ok: false,
			error: "GitHub authentication failed",
			code: "github_auth_failed",
		};
	}
	if (err instanceof RepoRateLimitError) {
		return {
			ok: false,
			error: "GitHub rate limit exceeded",
			code: "rate_limited",
			detail: { resetAt: err.resetAt },
		};
	}
	if (err instanceof RepoSecondaryRateLimitError) {
		return {
			ok: false,
			error: "GitHub secondary rate limit hit",
			code: "secondary_rate_limited",
			detail: { retryAfter: err.retryAfter },
		};
	}
	if (err instanceof RepoUnsafeRefError) {
		return {
			ok: false,
			error: "Unsafe ref or path segment rejected",
			code: "invalid_path",
		};
	}
	return {
		ok: false,
		error: "Commit operation failed",
		code: "repo_commit_failed",
	};
}
