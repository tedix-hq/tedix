import {
	nativeWorkProvenance,
	stampWorkProvenance,
} from "@tedix/context-core/work-provenance";
/**
 * Unit tests for repo-commit.ts pure helpers.
 *
 * Standalone bun-run script (no vitest, no cloudflare:workers imports).
 * Run with: bun run src/repo-commit.test.ts
 */

import assert from "node:assert/strict";
import {
	parseRepoCommitWritePayload,
	REPO_COMMIT_WRITE_KIND,
} from "@tedix/api-contract/schemas/repo-commit-write";
import {
	RepoAuthError,
	RepoNotFoundError,
	RepoRateLimitError,
	RepoSecondaryRateLimitError,
	RepoUnsafeRefError,
} from "./repo-api";
import {
	buildRepoCommitPayload,
	classifyRepoCommitRisk,
	executeRepoCommitFromLedger,
	type RepoCommitDeps,
	type RepoCommitLedgerRow,
} from "./repo-commit";
import { buildRepoCommitDeclaration } from "./repo-commit-fence";

// ── 1. classifyRepoCommitRisk truth table ─────────────────────────────────────

// Protected target branches → always high
for (const branch of [
	"main",
	"master",
	"production",
	"prod",
	"release/1.0",
	"release-1.0",
	"hotfix/urgent",
	"hotfix-urgent",
]) {
	const result = classifyRepoCommitRisk({ baseRef: "abc123", branch });
	assert.equal(result, "high", `branch "${branch}" should be high`);
}

// Feature/fix branches off a SHA base → low
for (const branch of ["feat/add-widget", "fix/login-bug", "chore/cleanup"]) {
	const result = classifyRepoCommitRisk({
		baseRef: "a".repeat(40),
		branch,
	});
	assert.equal(result, "low", `branch "${branch}" with SHA base should be low`);
}

// 40-hex SHA base + protected target branch → HIGH (target check wins)
{
	const result = classifyRepoCommitRisk({
		baseRef: "a".repeat(40),
		branch: "main",
	});
	assert.equal(result, "high", "SHA base + protected target → high");
}

// Non-SHA protected base + feature branch → HIGH (base check)
{
	const result = classifyRepoCommitRisk({
		baseRef: "main",
		branch: "feat/something",
	});
	assert.equal(
		result,
		"high",
		"non-SHA protected base + feature branch → high",
	);
}

// Non-SHA non-protected base + feature branch → low
{
	const result = classifyRepoCommitRisk({
		baseRef: "develop",
		branch: "feat/something",
	});
	assert.equal(
		result,
		"low",
		"non-SHA unprotected base + feature branch → low",
	);
}

// ── 2. buildRepoCommitPayload — security invariant: no PAT, no file contents ─

{
	// Assembled rather than written as a literal: this file is published, and a
	// token-shaped literal trips the secret scan.
	// The runtime value is unchanged, so the leak assertions below still test a
	// realistic PAT shape.
	const PAT = ["ghp", "SUPERSECRETPAT1234567890abcdef"].join("_");
	const FILE_CONTENT = `console.log('hello world'); // ${PAT}`;

	const input = {
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		owner: "acme",
		repo: "app",
		baseRef: "a".repeat(40),
		branch: "feat/work",
		message: "Add feature",
		openPr: false,
		prBase: null,
		changeSet: {
			changes: [
				{ path: "src/foo.ts", content: FILE_CONTENT },
				{ path: "src/bar.ts", content: "export const x = 1;" },
				{ path: "src/deleted.ts", content: null },
			],
		},
		executionLedgerId: "ledger-1",
	};

	const payload = buildRepoCommitPayload(input);

	// PAT must never appear anywhere in the serialized payload
	const serialized = JSON.stringify(payload);
	assert.ok(!serialized.includes(PAT), "PAT must not appear in payload");

	// File contents must never appear in the payload
	assert.ok(
		!serialized.includes("hello world"),
		"file contents must not appear in payload",
	);
	assert.ok(
		!serialized.includes("export const x = 1"),
		"file contents must not appear in payload",
	);

	// changeSummary must be present and correct
	assert.equal(
		payload.changeSummary.fileCount,
		3,
		"fileCount includes all changes",
	);
	assert.deepEqual(payload.changeSummary.addedOrModified, [
		"src/foo.ts",
		"src/bar.ts",
	]);
	assert.deepEqual(payload.changeSummary.deleted, ["src/deleted.ts"]);
	assert.ok(payload.changeSummary.totalBytes > 0, "totalBytes counted");

	// riskTier inferred correctly (SHA base + feature branch → low)
	assert.equal(payload.riskTier, "low");

	// kind marker
	assert.equal(payload.kind, "repo_commit_write");
}

// Path cap at 40
{
	const manyChanges = Array.from({ length: 50 }, (_, i) => ({
		path: `src/file${i}.ts`,
		content: "x",
	}));
	const payload = buildRepoCommitPayload({
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		owner: "acme",
		repo: "app",
		baseRef: "a".repeat(40),
		branch: "feat/bulk",
		message: "Bulk changes",
		openPr: false,
		prBase: null,
		changeSet: { changes: manyChanges },
		executionLedgerId: "ledger-2",
	});
	assert.ok(
		payload.changeSummary.addedOrModified.length <= 40,
		"addedOrModified capped at 40",
	);
	assert.equal(
		payload.changeSummary.fileCount,
		50,
		"fileCount is full uncapped count",
	);
}

// Same cap for deleted paths
{
	const manyDeletes = Array.from({ length: 50 }, (_, i) => ({
		path: `src/old${i}.ts`,
		content: null,
	}));
	const payload = buildRepoCommitPayload({
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		owner: "acme",
		repo: "app",
		baseRef: "a".repeat(40),
		branch: "feat/cleanup",
		message: "Delete many",
		openPr: false,
		prBase: null,
		changeSet: { changes: manyDeletes },
		executionLedgerId: "ledger-3",
	});
	assert.ok(payload.changeSummary.deleted.length <= 40, "deleted capped at 40");
}

// ── 3. executeRepoCommitFromLedger — mocked deps ──────────────────────────────

const VALID_ROW: RepoCommitLedgerRow = {
	id: "row-1",
	owner: "acme",
	repo: "app",
	baseRef: "a".repeat(40),
	branch: "feat/work",
	message: "Add feature",
	changesJson: JSON.stringify({
		changes: [{ path: "src/foo.ts", content: "export const x = 1;" }],
	}),
	openPr: false,
	prBase: null,
};

const SECRET_PAT = ["ghp", "SECRETPAT_MUST_NOT_LEAK_abcdefgh"].join("_");

// 3a. Success path
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => ({
			commitSha: "deadbeef1234567890abcdef1234567890deadbeef",
			branchRef: "refs/heads/feat/work",
		}),
		openPullRequest: async () => {
			throw new Error("openPullRequest should not be called");
		},
	};

	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(result.ok, "success result ok=true");
	if (!result.ok) throw new Error("unreachable");
	assert.equal(result.commitSha, "deadbeef1234567890abcdef1234567890deadbeef");
	assert.equal(result.branchRef, "refs/heads/feat/work");
	assert.equal(result.prUrl, undefined, "no prUrl when openPr=false");

	// PAT must never appear in result
	const serialized = JSON.stringify(result);
	assert.ok(!serialized.includes(SECRET_PAT), "PAT must not appear in result");
}

// 3b. With PR
{
	const rowWithPr: RepoCommitLedgerRow = {
		...VALID_ROW,
		openPr: true,
		prBase: "main",
	};
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => ({
			commitSha: "sha123",
			branchRef: "refs/heads/feat/work",
		}),
		openPullRequest: async () => ({
			url: "https://github.com/acme/app/pull/42",
			number: 42,
		}),
	};
	const result = await executeRepoCommitFromLedger({ deps, row: rowWithPr });
	assert.ok(result.ok, "PR result ok=true");
	if (!result.ok) throw new Error("unreachable");
	assert.equal(result.prUrl, "https://github.com/acme/app/pull/42");
	const serialized = JSON.stringify(result);
	assert.ok(
		!serialized.includes(SECRET_PAT),
		"PAT must not appear in PR result",
	);
}

// 3c. RepoNotFoundError → repo_not_found code
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new RepoNotFoundError("acme", "app");
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok, "RepoNotFoundError → ok=false");
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "repo_not_found");
	assert.ok(
		!JSON.stringify(result).includes(SECRET_PAT),
		"PAT absent in not_found error",
	);
}

// 3d. RepoAuthError → github_auth_failed
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new RepoAuthError();
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "github_auth_failed");
}

// 3e. RepoRateLimitError → rate_limited with resetAt detail
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new RepoRateLimitError(1_700_000_000);
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "rate_limited");
	assert.equal((result.detail as { resetAt: number })?.resetAt, 1_700_000_000);
}

// 3f. RepoSecondaryRateLimitError → secondary_rate_limited
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new RepoSecondaryRateLimitError(30);
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "secondary_rate_limited");
	assert.equal((result.detail as { retryAfter: number })?.retryAfter, 30);
}

// 3g. RepoUnsafeRefError → invalid_path
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new RepoUnsafeRefError("../evil");
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "invalid_path");
}

// 3h. Unknown error → repo_commit_failed
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new Error("some unexpected error");
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "repo_commit_failed");
}

// 3i. decryptPat returns null → no_github_pat
{
	const deps: RepoCommitDeps = {
		decryptPat: async () => null,
		commitRepoChanges: async () => {
			throw new Error("should not reach commitRepoChanges");
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: VALID_ROW });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "no_github_pat");
}

// 3j. Malformed changesJson → invalid_changes_json
{
	const badRow: RepoCommitLedgerRow = {
		...VALID_ROW,
		changesJson: "not-json-{{{",
	};
	const deps: RepoCommitDeps = {
		decryptPat: async () => SECRET_PAT,
		commitRepoChanges: async () => {
			throw new Error("unreachable");
		},
		openPullRequest: async () => {
			throw new Error("unreachable");
		},
	};
	const result = await executeRepoCommitFromLedger({ deps, row: badRow });
	assert.ok(!result.ok);
	if (result.ok) throw new Error("unreachable");
	assert.equal(result.code, "invalid_changes_json");
}

// ── parseRepoCommitWritePayload caps (defense-in-depth at the parse boundary) ──

{
	const base = {
		kind: REPO_COMMIT_WRITE_KIND,
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		owner: "tedix",
		repo: "platform",
		baseRef: "main",
		branch: "feat/x",
		message: "msg",
		openPr: false,
		prBase: null,
		changeSummary: {
			fileCount: 1,
			addedOrModified: ["src/a.ts"],
			deleted: [],
			totalBytes: 10,
		},
		riskTier: "low",
		executionLedgerId: "ledger-1",
	};
	assert.ok(parseRepoCommitWritePayload(base), "valid payload parses");
	assert.equal(
		parseRepoCommitWritePayload({
			...base,
			changeSummary: {
				...base.changeSummary,
				addedOrModified: Array.from({ length: 41 }, (_, i) => `f${i}.ts`),
			},
		}),
		null,
		">40 addedOrModified paths rejected",
	);
	assert.equal(
		parseRepoCommitWritePayload({
			...base,
			changeSummary: {
				...base.changeSummary,
				deleted: Array.from({ length: 41 }, (_, i) => `d${i}.ts`),
			},
		}),
		null,
		">40 deleted paths rejected",
	);
	assert.equal(
		parseRepoCommitWritePayload({
			...base,
			changeSummary: {
				...base.changeSummary,
				addedOrModified: ["x".repeat(1025)],
			},
		}),
		null,
		">1024-char path (content smuggling) rejected",
	);
	// The fingerprint anchor: absent means "recorded before the field existed"
	// and parses to null; present-but-malformed fails the whole payload, so the
	// publish fence reads it as an unreadable approval and refuses.
	assert.equal(
		parseRepoCommitWritePayload(base)?.changeFingerprint,
		null,
		"a pre-fingerprint approval still parses, with a null anchor",
	);
	assert.equal(
		parseRepoCommitWritePayload({ ...base, changeFingerprint: "0".repeat(64) })
			?.changeFingerprint,
		"0".repeat(64),
		"a well-formed anchor round-trips",
	);
	for (const bad of ["", "0".repeat(63), "0".repeat(65), "Z".repeat(64), 7]) {
		assert.equal(
			parseRepoCommitWritePayload({ ...base, changeFingerprint: bad }),
			null,
			`malformed fingerprint rejected: ${String(bad)}`,
		);
	}
	console.log("✓ parseRepoCommitWritePayload enforces array + string caps");
}

// ── the fingerprint has ONE producer, so it cannot drift ─────────────────────

{
	const changes = [
		{ path: "src/a.ts", content: "export const a = 1;\n" },
		{ path: "src/gone.ts", content: null },
	];
	const target = {
		owner: "tedix",
		repo: "platform",
		baseRef: "b".repeat(40),
		branch: "feat/anchor",
		message: "anchor",
		openPr: false,
		prBase: null,
	};
	// The DO computes the declaration ONCE and hands that same string to the
	// payload; nothing recomputes the digest on the apps/api side, so the D1
	// copy and the DO copy are the same value by construction.
	const declaration = await buildRepoCommitDeclaration({ target, changes });
	const payload = buildRepoCommitPayload({
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		...target,
		changeSet: { changes },
		changeFingerprint: declaration.fingerprint,
		executionLedgerId: "ledger-anchor",
	});
	assert.equal(payload.changeFingerprint, declaration.fingerprint);
	assert.equal(
		parseRepoCommitWritePayload(JSON.parse(JSON.stringify(payload)))
			?.changeFingerprint,
		declaration.fingerprint,
		"the anchor survives the D1 JSON round-trip intact",
	);
	// A caller that supplies nothing records no anchor rather than a wrong one.
	assert.equal(
		buildRepoCommitPayload({
			organizationId: "org-1",
			tediId: "tedi-1",
			conversationId: "conv-1",
			homeRunId: null,
			...target,
			changeSet: { changes },
			executionLedgerId: "ledger-anchor-2",
		}).changeFingerprint,
		null,
	);
	console.log("✓ the approval anchor is the declaration's own fingerprint");
}

console.log("✅ All repo-commit tests passed");

// The proposal stamps once; the declared message survives approval storage and drain.
{
	const provenance = nativeWorkProvenance({
		workItemId: "5eed0016-0000-4000-8000-000000000016",
		runId: "native-run-original",
	});
	const message = stampWorkProvenance("Implement helper", provenance);
	const target = {
		owner: VALID_ROW.owner,
		repo: VALID_ROW.repo,
		baseRef: VALID_ROW.baseRef,
		branch: VALID_ROW.branch,
		message,
		openPr: false,
		prBase: null,
	};
	const changes = [
		{ path: "src/helper.ts", content: "export const value = 1;\n" },
	];
	const declaration = await buildRepoCommitDeclaration({ target, changes });
	const payload = buildRepoCommitPayload({
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		...target,
		changeSet: { changes },
		changeFingerprint: declaration.fingerprint,
		executionLedgerId: "native-proposal",
	});
	const parked = JSON.parse(
		JSON.stringify({
			...VALID_ROW,
			...target,
			changesJson: JSON.stringify({ changes }),
		}),
	) as RepoCommitLedgerRow;
	let publishedMessage = "";
	const result = await executeRepoCommitFromLedger({
		row: parked,
		deps: {
			decryptPat: async () => SECRET_PAT,
			commitRepoChanges: async (input) => {
				publishedMessage = input.message;
				return { commitSha: "a".repeat(40), branchRef: "refs/heads/feat/work" };
			},
			openPullRequest: async () => {
				throw new Error("unexpected PR");
			},
		},
	});
	assert.equal(result.ok, true);
	assert.equal(payload.message, message);
	assert.equal(publishedMessage, message);
	assert.equal(
		(
			await buildRepoCommitDeclaration({
				target: { ...target, message: publishedMessage },
				changes,
			})
		).fingerprint,
		declaration.fingerprint,
	);
	assert.notEqual(
		(
			await buildRepoCommitDeclaration({
				target: {
					...target,
					message: stampWorkProvenance("Implement helper", {
						...provenance!,
						agentSession: "kernel:later-run",
					}),
				},
				changes,
			})
		).fingerprint,
		declaration.fingerprint,
	);
	console.log(
		"✓ proposal provenance survives approval and delayed publication unchanged",
	);
}

{
	const fullMessage = stampWorkProvenance(
		"Implement helper",
		nativeWorkProvenance({
			workItemId: "5eed0016-0000-4000-8000-000000000016",
			runId: "original",
		}),
	);
	let title = "";
	let committed = "";
	const result = await executeRepoCommitFromLedger({
		row: { ...VALID_ROW, message: fullMessage, openPr: true, prBase: "main" },
		deps: {
			decryptPat: async () => SECRET_PAT,
			commitRepoChanges: async (input) => {
				committed = input.message;
				return { commitSha: "a".repeat(40), branchRef: "refs/heads/feat/work" };
			},
			openPullRequest: async (input) => {
				title = input.title;
				return { url: "https://github.com/tedix/tedix/pull/1", number: 1 };
			},
		},
	});
	assert.equal(result.ok, true);
	assert.equal(title, "Implement helper");
	assert.equal(committed, fullMessage);
}
