/**
 * repo_commit publish fence — bind the approved action to the bytes that move.
 *
 * Why this exists
 * ---------------
 * `repo_commit` is already approval-gated: propose parks the full changeset in
 * DO-SQLite, the kernel creates a `repo_commit_write` approval row in D1 that
 * carries a *summary*, and the drain publishes the parked changeset once that
 * approval reads `approved`. Nothing in that chain bound the approval to the
 * changeset. The approval approved an INTENT; the publish was trusted to match
 * it, and the publisher read its instructions from a store the approval never
 * saw.
 *
 * This module makes the push a DECLARED action:
 *
 *   1. At propose time the tedi records a DECLARATION — an exact content
 *      fingerprint over the ordered changeset plus the full push target
 *      (owner, repo, baseRef, branch, message, openPr, prBase) — in its own
 *      DO-SQLite table, keyed by the execution ledger id.
 *   2. At publish time, before any byte reaches GitHub, the fence recomputes
 *      the fingerprint from the changeset that is actually about to be pushed
 *      and requires it to equal the declaration, AND re-reads the operator's
 *      approval payload from D1 and requires that approval to name this exact
 *      ledger row, this exact target, and this exact change summary.
 *   3. Anything else is REFUSED. Not warned about, not retried: an undeclared,
 *      mismatched or unverifiable push is denied and the row goes terminal.
 *
 * The GitHub-API commit path builds the commit server-side from the declared
 * changeset, so there are no pre-existing commit ids to name the way a
 * local-git gatekeeper names `pushedCommits`. The exact content fingerprint is
 * the equivalent declaration, and {@link recordPublishedCommit} writes the sha
 * that the declaration actually produced back onto the declaration row, so the
 * ledger links "what was declared" to "what moved".
 */

import { parseRepoCommitWritePayload } from "@tedix/api-contract/schemas/repo-commit-write";
import type { DoSqlRunner } from "./brain-bridge-do";
import { sha256Hex } from "@tedix/worker-kit/crypto";

/** Bump when the canonical fingerprint encoding changes. Declarations recorded
 * under an older version fail closed rather than compare across encodings. */
export const REPO_COMMIT_FENCE_VERSION = "v1";

/**
 * Path-list cap shared with `buildRepoCommitPayload`'s change summary. The
 * approval card carries at most this many paths per list, so the fence can only
 * compare the capped prefix against what it is about to push.
 */
export const REPO_COMMIT_SUMMARY_PATH_CAP = 40;

/** Marker prefix stored in `repo_commit_executions.error` for a fence denial.
 * Lets the tool result render a denial AS a denial rather than as a generic
 * failure. */
export const REPO_COMMIT_FENCE_DENIAL_PREFIX = "publish_fence_denied:";

export type RepoCommitFenceDenialCode =
	/** The changeset about to be pushed could not be read or parsed. */
	| "fence_unverifiable"
	/** No declaration was recorded for this ledger row at propose time. */
	| "fence_undeclared"
	/** The declaration exists but was recorded under a different fence version. */
	| "fence_version_mismatch"
	/** The operator approval could not be read, parsed, or is not a repo commit. */
	| "fence_approval_unreadable"
	/** The row carries no approval to verify against. */
	| "fence_approval_missing"
	/** The approval names a different execution ledger row. */
	| "fence_ledger_mismatch"
	/** The push target differs from the declared/approved target. */
	| "fence_target_mismatch"
	/** The bytes about to be pushed differ from what was declared/approved. */
	| "fence_content_mismatch";

const DENIAL_REASONS: Record<RepoCommitFenceDenialCode, string> = {
	fence_unverifiable:
		"the changeset about to be published could not be read, so it cannot be checked against the approval",
	fence_undeclared:
		"no publish declaration was recorded for this commit, so there is nothing binding the approval to these bytes",
	fence_version_mismatch:
		"the publish declaration was recorded under a different fence version and cannot be compared",
	fence_approval_unreadable:
		"the operator approval record could not be read or is not a repo_commit approval",
	fence_approval_missing:
		"this commit is not linked to an operator approval, so no approved action authorizes the push",
	fence_ledger_mismatch:
		"the linked approval authorizes a different commit execution, not this one",
	fence_target_mismatch:
		"the push target (repository, base, branch, message or PR settings) differs from what was approved",
	fence_content_mismatch:
		"the file contents about to be published differ from the changeset that was declared and approved",
};

/** The `error` string persisted for a denial. */
export function repoCommitFenceDenialError(
	code: RepoCommitFenceDenialCode,
): string {
	return `${REPO_COMMIT_FENCE_DENIAL_PREFIX}${code}`;
}

export interface RepoCommitFenceDenial {
	code: RepoCommitFenceDenialCode;
	reason: string;
}

/** Recognize a persisted fence denial. Returns null for any other error. */
export function parseRepoCommitFenceDenial(
	error: string | null | undefined,
): RepoCommitFenceDenial | null {
	if (typeof error !== "string") return null;
	if (!error.startsWith(REPO_COMMIT_FENCE_DENIAL_PREFIX)) return null;
	const code = error.slice(REPO_COMMIT_FENCE_DENIAL_PREFIX.length);
	if (!(code in DENIAL_REASONS)) return null;
	const typed = code as RepoCommitFenceDenialCode;
	return { code: typed, reason: DENIAL_REASONS[typed] };
}

// ── Declaration ─────────────────────────────────────────────────────────────

export interface RepoCommitFenceChange {
	path: string;
	content: string | null;
}

/** Everything about the push that is not file bytes. All of it is fingerprinted. */
export interface RepoCommitFenceTarget {
	owner: string;
	repo: string;
	baseRef: string;
	branch: string;
	message: string;
	openPr: boolean;
	prBase: string | null;
}

export interface RepoCommitDeclaration {
	version: string;
	/** SHA-256 over the canonical encoding of target + ordered changeset. */
	fingerprint: string;
	fileCount: number;
	totalBytes: number;
	/** Capped path lists, exactly as the approval summary carries them. */
	addedOrModified: string[];
	deleted: string[];
}

/**
 * Build the declaration for a proposed commit.
 *
 * Change ORDER is part of the fingerprint: two writes to the same path commit
 * differently depending on order, so the declaration binds the sequence, not
 * the set.
 */
export async function buildRepoCommitDeclaration(input: {
	target: RepoCommitFenceTarget;
	changes: RepoCommitFenceChange[];
}): Promise<RepoCommitDeclaration> {
	const encoder = new TextEncoder();
	const entries: string[] = [];
	const addedOrModified: string[] = [];
	const deleted: string[] = [];
	let totalBytes = 0;

	for (const change of input.changes) {
		if (change.content === null) {
			deleted.push(change.path);
			entries.push(JSON.stringify(["D", change.path]));
			continue;
		}
		const byteLength = encoder.encode(change.content).byteLength;
		totalBytes += byteLength;
		addedOrModified.push(change.path);
		entries.push(
			JSON.stringify([
				"M",
				change.path,
				byteLength,
				await sha256Hex(change.content),
			]),
		);
	}

	const canonical = [
		REPO_COMMIT_FENCE_VERSION,
		JSON.stringify([
			input.target.owner,
			input.target.repo,
			input.target.baseRef,
			input.target.branch,
			input.target.message,
			input.target.openPr,
			input.target.prBase,
		]),
		String(entries.length),
		...entries,
	].join("\n");

	return {
		version: REPO_COMMIT_FENCE_VERSION,
		fingerprint: await sha256Hex(canonical),
		fileCount: input.changes.length,
		totalBytes,
		addedOrModified: addedOrModified.slice(0, REPO_COMMIT_SUMMARY_PATH_CAP),
		deleted: deleted.slice(0, REPO_COMMIT_SUMMARY_PATH_CAP),
	};
}

/** Parse a stored declaration. Returns null for anything malformed — the caller
 * must treat that as undeclared, never as "no constraint". */
export function parseRepoCommitDeclaration(
	json: string | null | undefined,
): RepoCommitDeclaration | null {
	if (typeof json !== "string" || json.length === 0) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	const d = parsed as Record<string, unknown>;
	if (typeof d.version !== "string" || d.version.length === 0) return null;
	if (
		typeof d.fingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(d.fingerprint)
	)
		return null;
	if (typeof d.fileCount !== "number" || typeof d.totalBytes !== "number")
		return null;
	if (!Array.isArray(d.addedOrModified) || !Array.isArray(d.deleted))
		return null;
	if (!d.addedOrModified.every((v) => typeof v === "string")) return null;
	if (!d.deleted.every((v) => typeof v === "string")) return null;
	return {
		version: d.version,
		fingerprint: d.fingerprint,
		fileCount: d.fileCount,
		totalBytes: d.totalBytes,
		addedOrModified: d.addedOrModified as string[],
		deleted: d.deleted as string[],
	};
}

/** Parse the ordered changeset out of a ledger row's `changesJson`. */
export function parseRepoCommitLedgerChanges(
	changesJson: string,
): RepoCommitFenceChange[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(changesJson);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	const changes = (parsed as Record<string, unknown>).changes;
	if (!Array.isArray(changes)) return null;
	const out: RepoCommitFenceChange[] = [];
	for (const entry of changes) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			return null;
		const c = entry as Record<string, unknown>;
		if (typeof c.path !== "string" || c.path.length === 0) return null;
		if (c.content !== null && typeof c.content !== "string") return null;
		out.push({ path: c.path, content: c.content as string | null });
	}
	return out;
}

// ── The approved action, read back from D1 ──────────────────────────────────

export interface ApprovedRepoCommitAction {
	executionLedgerId: string;
	target: RepoCommitFenceTarget;
	changeSummary: {
		fileCount: number;
		addedOrModified: string[];
		deleted: string[];
		totalBytes: number;
	};
	/**
	 * Exact content fingerprint carried by the approval itself, when present.
	 *
	 * `RepoCommitWritePayload.changeFingerprint` now declares this field, so the
	 * kernel persists the propose-time declaration onto the D1 approval and the
	 * strongest binding — operator-approved record to exact bytes — is live.
	 *
	 * Still nullable, and deliberately so: an approval created before the field
	 * existed carries no anchor. Those keep publishing under the declaration,
	 * target and capped-summary checks rather than becoming unpublishable. A
	 * present-but-malformed value never reaches here — the shared parser rejects
	 * the whole payload, which the fence reads as `fence_approval_unreadable`.
	 */
	fingerprint: string | null;
}

/** Parse the operator approval payload into the action it authorizes.
 * Returns null when the payload is absent, malformed, or not a repo commit. */
export function parseApprovedRepoCommitAction(
	payloadJson: string | null | undefined,
): ApprovedRepoCommitAction | null {
	if (typeof payloadJson !== "string" || payloadJson.length === 0) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(payloadJson);
	} catch {
		return null;
	}
	const payload = parseRepoCommitWritePayload(raw);
	if (!payload) return null;
	return {
		executionLedgerId: payload.executionLedgerId,
		target: {
			owner: payload.owner,
			repo: payload.repo,
			baseRef: payload.baseRef,
			branch: payload.branch,
			message: payload.message,
			openPr: payload.openPr,
			prBase: payload.prBase,
		},
		changeSummary: payload.changeSummary,
		fingerprint: payload.changeFingerprint,
	};
}

// ── Verification ────────────────────────────────────────────────────────────

export type RepoCommitFenceVerdict =
	| { authorized: true; declaration: RepoCommitDeclaration }
	| { authorized: false; code: RepoCommitFenceDenialCode; reason: string };

function deny(code: RepoCommitFenceDenialCode): RepoCommitFenceVerdict {
	return { authorized: false, code, reason: DENIAL_REASONS[code] };
}

function sameStringList(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameTarget(
	a: RepoCommitFenceTarget,
	b: RepoCommitFenceTarget,
): boolean {
	return (
		a.owner === b.owner &&
		a.repo === b.repo &&
		a.baseRef === b.baseRef &&
		a.branch === b.branch &&
		a.message === b.message &&
		a.openPr === b.openPr &&
		(a.prBase ?? null) === (b.prBase ?? null)
	);
}

/**
 * Authorize one publish. Fail-closed by construction: every path that is not a
 * positive, complete match returns a denial.
 *
 * `approvalPayloadJson` is the payload column of the operator approval row,
 * re-read from D1 at publish time rather than carried from the poll, so the
 * check runs against the authority as it stands when the bytes move.
 */
export async function authorizeRepoCommitPublish(input: {
	ledgerId: string;
	approvalRequestId: string | null;
	approvalPayloadJson: string | null;
	declarationJson: string | null;
	target: RepoCommitFenceTarget;
	changesJson: string;
}): Promise<RepoCommitFenceVerdict> {
	const changes = parseRepoCommitLedgerChanges(input.changesJson);
	if (!changes) return deny("fence_unverifiable");

	const declaration = parseRepoCommitDeclaration(input.declarationJson);
	if (!declaration) return deny("fence_undeclared");
	if (declaration.version !== REPO_COMMIT_FENCE_VERSION)
		return deny("fence_version_mismatch");

	if (!input.approvalRequestId) return deny("fence_approval_missing");
	const approved = parseApprovedRepoCommitAction(input.approvalPayloadJson);
	if (!approved) return deny("fence_approval_unreadable");
	if (approved.executionLedgerId !== input.ledgerId)
		return deny("fence_ledger_mismatch");
	if (!sameTarget(approved.target, input.target))
		return deny("fence_target_mismatch");

	// Recompute over the bytes actually about to be pushed, against the target
	// actually about to be used.
	const actual = await buildRepoCommitDeclaration({
		target: input.target,
		changes,
	});
	if (actual.fingerprint !== declaration.fingerprint)
		return deny("fence_content_mismatch");

	// Independent cross-check against the operator-visible approval summary: the
	// declaration lives in the same DO store as the changeset, the approval does
	// not.
	if (
		approved.changeSummary.fileCount !== actual.fileCount ||
		approved.changeSummary.totalBytes !== actual.totalBytes ||
		!sameStringList(
			approved.changeSummary.addedOrModified,
			actual.addedOrModified,
		) ||
		!sameStringList(approved.changeSummary.deleted, actual.deleted)
	) {
		return deny("fence_content_mismatch");
	}

	if (approved.fingerprint && approved.fingerprint !== actual.fingerprint)
		return deny("fence_content_mismatch");

	return { authorized: true, declaration: actual };
}

// ── Durable declaration store (DO-SQLite, own table) ────────────────────────

export interface RepoCommitDeclarationRow {
	ledgerId: string;
	declarationJson: string;
	publishedCommitSha: string | null;
	createdAt: number;
	updatedAt: number;
}

/**
 * Declarations live in their own table, separate from
 * `repo_commit_executions`. The changeset writer and the declaration are not
 * the same row on purpose: the fence is the record of what was asked for, not
 * part of the payload it constrains.
 */
export class RepoCommitFenceStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS repo_commit_declarations (
				ledgerId TEXT PRIMARY KEY,
				declarationJson TEXT NOT NULL,
				publishedCommitSha TEXT,
				createdAt INTEGER NOT NULL,
				updatedAt INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/**
	 * Record the declaration for a ledger row. Write-once: a second call for the
	 * same ledger id leaves the original in place, so a later propose cannot
	 * re-declare an already-declared commit into whatever it now holds.
	 */
	declare(ledgerId: string, declaration: RepoCommitDeclaration): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			INSERT OR IGNORE INTO repo_commit_declarations
				(ledgerId, declarationJson, publishedCommitSha, createdAt, updatedAt)
			VALUES (${ledgerId}, ${JSON.stringify(declaration)}, ${null}, ${now}, ${now})
		`;
	}

	/** Raw declaration JSON for a ledger row, or null when never declared. */
	getDeclarationJson(ledgerId: string): string | null {
		this.ensureSchema();
		const rows = this.runner.sql<RepoCommitDeclarationRow>`
			SELECT ledgerId, declarationJson, publishedCommitSha, createdAt, updatedAt
			FROM repo_commit_declarations
			WHERE ledgerId = ${ledgerId}
			LIMIT 1
		`;
		return rows[0]?.declarationJson ?? null;
	}

	get(ledgerId: string): RepoCommitDeclarationRow | null {
		this.ensureSchema();
		const rows = this.runner.sql<RepoCommitDeclarationRow>`
			SELECT ledgerId, declarationJson, publishedCommitSha, createdAt, updatedAt
			FROM repo_commit_declarations
			WHERE ledgerId = ${ledgerId}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	/** Bind the declaration to the commit it actually produced. Written once,
	 * after a successful publish. */
	recordPublishedCommit(ledgerId: string, commitSha: string): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			UPDATE repo_commit_declarations
			SET publishedCommitSha = ${commitSha}, updatedAt = ${now}
			WHERE ledgerId = ${ledgerId} AND publishedCommitSha IS NULL
		`;
	}
}
