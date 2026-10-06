/**
 * Shared contract for the repo_commit write-tier approval payload.
 *
 * Built by apps/tedi-runtime (DO) and parsed by apps/api (server guard).
 * Apps cannot import each other, so this lives in api-contract.
 *
 * Security constraint: the payload carries a SUMMARY ONLY.
 * File contents and PATs must never appear here.
 */

export const REPO_COMMIT_WRITE_KIND = "repo_commit_write" as const;

export interface RepoCommitChangeSummary {
	fileCount: number;
	/** Paths of added or modified files (capped at 40). */
	addedOrModified: string[];
	/** Paths of deleted files (capped at 40). */
	deleted: string[];
	totalBytes: number;
}

export interface RepoCommitWritePayload {
	kind: typeof REPO_COMMIT_WRITE_KIND;
	organizationId: string;
	tediId: string;
	conversationId: string;
	homeRunId: string | null;
	owner: string;
	repo: string;
	/** Branch name or 40-hex SHA used as the commit base. */
	baseRef: string;
	/** Target branch name to create or fast-forward. */
	branch: string;
	message: string;
	openPr: boolean;
	prBase: string | null;
	/** Summary-only — file contents are stored in the DO-SQLite ledger, never here. */
	changeSummary: RepoCommitChangeSummary;
	/**
	 * Exact content fingerprint over the ORDERED changeset plus the full push
	 * target, as computed at propose time by the publish fence
	 * (`buildRepoCommitDeclaration` in apps/tedi-runtime).
	 *
	 * NOT a second summary. `changeSummary` is capped (40 paths per list) and
	 * says nothing about file bytes, so an actor that can rewrite the tedi's own
	 * DO-SQLite could rewrite the declaration and the changeset together and
	 * still satisfy it. This field puts the exact-content anchor in D1, a store
	 * the tedi cannot write, so the publish fence has an operator-approved value
	 * to compare the moving bytes against.
	 *
	 * It is a lowercase 64-hex SHA-256 digest, or `null` for an approval created
	 * before this field existed (or by a runtime that predates it). Null means
	 * "no exact anchor recorded", NOT "any content is fine": the fence still
	 * enforces the declaration, the target, and the capped summary. A malformed
	 * value is rejected outright by {@link parseRepoCommitWritePayload}, which
	 * makes the whole approval unreadable and therefore fails the publish closed.
	 */
	changeFingerprint: string | null;
	riskTier: "low" | "high";
	/** FK into the repo_commit_executions DO-SQLite table row. */
	executionLedgerId: string;
}

/** Branches that are considered protected for risk classification. */
export const PROTECTED_BRANCH_RE =
	/^(main|master|production|prod|release(\/.*|-.*)?|hotfix(\/.*|-.*)?)$/i;

const SHA40_RE = /^[0-9a-f]{40}$/i;

/** Lowercase hex SHA-256, the shape the publish fence emits and compares. */
export const REPO_COMMIT_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * Classify a commit operation as low or high risk.
 *
 * HIGH when:
 *   - the target branch is protected, OR
 *   - the base is NOT a 40-hex SHA and the base name is protected.
 * LOW otherwise (feature/fix branches off a SHA base are always low).
 */
export function classifyRepoCommitRisk(opts: {
	baseRef: string;
	branch: string;
}): "low" | "high" {
	const { baseRef, branch } = opts;
	if (PROTECTED_BRANCH_RE.test(branch)) return "high";
	const baseIsSha = SHA40_RE.test(baseRef);
	if (!baseIsSha && PROTECTED_BRANCH_RE.test(baseRef)) return "high";
	return "low";
}

/** Shape-validating guard mirroring parseHomeToolWritePayload. Never throws. */
export function parseRepoCommitWritePayload(
	value: unknown,
): RepoCommitWritePayload | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const p = value as Record<string, unknown>;

	if (p.kind !== REPO_COMMIT_WRITE_KIND) return null;

	const {
		organizationId,
		tediId,
		conversationId,
		homeRunId,
		owner,
		repo,
		baseRef,
		branch,
		message,
		openPr,
		prBase,
		changeSummary,
		changeFingerprint,
		riskTier,
		executionLedgerId,
	} = p;

	if (
		typeof organizationId !== "string" ||
		organizationId.length === 0 ||
		typeof tediId !== "string" ||
		tediId.length === 0 ||
		typeof conversationId !== "string" ||
		conversationId.length === 0 ||
		typeof owner !== "string" ||
		owner.length === 0 ||
		typeof repo !== "string" ||
		repo.length === 0 ||
		typeof baseRef !== "string" ||
		baseRef.length === 0 ||
		typeof branch !== "string" ||
		branch.length === 0 ||
		typeof message !== "string" ||
		message.length === 0 ||
		typeof openPr !== "boolean" ||
		typeof executionLedgerId !== "string" ||
		executionLedgerId.length === 0
	) {
		return null;
	}

	if (homeRunId !== null && typeof homeRunId !== "string") return null;
	// Absent (a pre-fingerprint approval) is allowed and normalizes to null.
	// Present-but-malformed is NOT: it fails the whole parse, which the fence
	// reads as `fence_approval_unreadable` and refuses the publish.
	if (
		changeFingerprint !== undefined &&
		changeFingerprint !== null &&
		(typeof changeFingerprint !== "string" ||
			!REPO_COMMIT_FINGERPRINT_RE.test(changeFingerprint))
	)
		return null;
	if (prBase !== null && typeof prBase !== "string") return null;

	if (riskTier !== "low" && riskTier !== "high") return null;

	if (
		!changeSummary ||
		typeof changeSummary !== "object" ||
		Array.isArray(changeSummary)
	)
		return null;
	const cs = changeSummary as Record<string, unknown>;
	if (
		typeof cs.fileCount !== "number" ||
		!Array.isArray(cs.addedOrModified) ||
		!Array.isArray(cs.deleted) ||
		typeof cs.totalBytes !== "number"
	) {
		return null;
	}
	if (!cs.addedOrModified.every((v) => typeof v === "string")) return null;
	if (!cs.deleted.every((v) => typeof v === "string")) return null;
	// Defense-in-depth at the parse boundary: the builder caps summaries at 40
	// paths and never emits file contents, so a payload exceeding these bounds is
	// malformed/hostile. Reject rather than let apps/api allocate on crafted input.
	if (cs.addedOrModified.length > 40 || cs.deleted.length > 40) return null;
	if (cs.addedOrModified.some((v) => (v as string).length > 1024)) return null;
	if (cs.deleted.some((v) => (v as string).length > 1024)) return null;

	return {
		kind: REPO_COMMIT_WRITE_KIND,
		organizationId,
		tediId,
		conversationId,
		homeRunId: homeRunId ?? null,
		owner,
		repo,
		baseRef,
		branch,
		message,
		openPr,
		prBase: prBase ?? null,
		changeSummary: {
			fileCount: cs.fileCount as number,
			addedOrModified: cs.addedOrModified as string[],
			deleted: cs.deleted as string[],
			totalBytes: cs.totalBytes as number,
		},
		changeFingerprint: (changeFingerprint as string | undefined) ?? null,
		riskTier,
		executionLedgerId,
	};
}
