/**
 * Unit tests for repo-commit-fence.ts — the repo_commit publish fence.
 *
 * Standalone bun-run script (no vitest, no cloudflare:workers imports).
 * Uses bun:sqlite in-memory DB to simulate the DO-SQLite runner.
 * Run with: bun run src/repo-commit-fence.test.ts
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { REPO_COMMIT_WRITE_KIND } from "@tedix/api-contract/schemas/repo-commit-write";
import type { DoSqlRunner } from "./brain-bridge-do";
import { drainRepoCommits } from "./repo-commit-drain";
import {
	authorizeRepoCommitPublish,
	buildRepoCommitDeclaration,
	parseApprovedRepoCommitAction,
	parseRepoCommitFenceDenial,
	parseRepoCommitLedgerChanges,
	REPO_COMMIT_FENCE_VERSION,
	RepoCommitFenceStore,
	repoCommitFenceDenialError,
	type RepoCommitFenceChange,
	type RepoCommitFenceTarget,
} from "./repo-commit-fence";
import { RepoCommitStore } from "./repo-commit-store";

function makeSqlRunner(): DoSqlRunner {
	const db = new Database(":memory:");
	return {
		sql<T = Record<string, string | number | boolean | null>>(
			strings: TemplateStringsArray,
			...values: (string | number | boolean | null)[]
		): T[] {
			let query = "";
			for (let i = 0; i < strings.length; i++) {
				query += strings[i];
				if (i < values.length) query += "?";
			}
			const q = query.trim();
			if (/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER)/i.test(q)) {
				db.run(q, values);
				return [] as T[];
			}
			return db.query(q).all(...values) as T[];
		},
	};
}

const LEDGER_ID = "11111111-1111-4111-8111-111111111111";

const TARGET: RepoCommitFenceTarget = {
	owner: "acme",
	repo: "app",
	baseRef: "a".repeat(40),
	branch: "feat/fence",
	message: "Add the fence",
	openPr: false,
	prBase: null,
};

const CHANGES: RepoCommitFenceChange[] = [
	{ path: "src/index.ts", content: "export const x = 1;\n" },
	{ path: "src/old.ts", content: null },
];

function changesJson(changes: RepoCommitFenceChange[]): string {
	return JSON.stringify({ changes });
}

function approvalPayload(overrides: Record<string, unknown> = {}): string {
	const encoder = new TextEncoder();
	let totalBytes = 0;
	const addedOrModified: string[] = [];
	const deleted: string[] = [];
	for (const c of CHANGES) {
		if (c.content === null) deleted.push(c.path);
		else {
			addedOrModified.push(c.path);
			totalBytes += encoder.encode(c.content).byteLength;
		}
	}
	return JSON.stringify({
		kind: REPO_COMMIT_WRITE_KIND,
		organizationId: "org-1",
		tediId: "tedi-1",
		conversationId: "conv-1",
		homeRunId: null,
		owner: TARGET.owner,
		repo: TARGET.repo,
		baseRef: TARGET.baseRef,
		branch: TARGET.branch,
		message: TARGET.message,
		openPr: TARGET.openPr,
		prBase: TARGET.prBase,
		changeSummary: {
			fileCount: CHANGES.length,
			addedOrModified,
			deleted,
			totalBytes,
		},
		riskTier: "low",
		executionLedgerId: LEDGER_ID,
		...overrides,
	});
}

async function declarationJsonFor(
	target: RepoCommitFenceTarget = TARGET,
	changes: RepoCommitFenceChange[] = CHANGES,
): Promise<string> {
	return JSON.stringify(await buildRepoCommitDeclaration({ target, changes }));
}

// ── buildRepoCommitDeclaration ──────────────────────────────────────────────

{
	const a = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: CHANGES,
	});
	const b = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: CHANGES,
	});
	assert.equal(a.fingerprint, b.fingerprint, "declaration is deterministic");
	assert.equal(a.version, REPO_COMMIT_FENCE_VERSION);
	assert.match(a.fingerprint, /^[0-9a-f]{64}$/);
	assert.equal(a.fileCount, 2);
	assert.deepEqual(a.addedOrModified, ["src/index.ts"]);
	assert.deepEqual(a.deleted, ["src/old.ts"]);

	// One byte of content changes the fingerprint.
	const mutated = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: [
			{ path: "src/index.ts", content: "export const x = 2;\n" },
			{ path: "src/old.ts", content: null },
		],
	});
	assert.notEqual(a.fingerprint, mutated.fingerprint, "content is bound");

	// The target is bound too.
	const retargeted = await buildRepoCommitDeclaration({
		target: { ...TARGET, branch: "main" },
		changes: CHANGES,
	});
	assert.notEqual(a.fingerprint, retargeted.fingerprint, "target is bound");

	// Order is bound: same set, different sequence, different fingerprint.
	const reordered = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: [CHANGES[1]!, CHANGES[0]!],
	});
	assert.notEqual(a.fingerprint, reordered.fingerprint, "order is bound");
	console.log("PASS declaration fingerprint binds content, target and order");
}

// ── declared-and-matching publish is AUTHORIZED ─────────────────────────────

{
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: await declarationJsonFor(),
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, true, "declared + matching push is allowed");
	assert.ok(
		verdict.authorized && verdict.declaration.fingerprint.length === 64,
	);
	console.log("PASS declared and matching publish is authorized");
}

// ── mismatched publish is REFUSED ───────────────────────────────────────────

{
	// Content swapped after the declaration was recorded.
	const declared = await declarationJsonFor();
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: declared,
		target: TARGET,
		changesJson: changesJson([
			{ path: "src/index.ts", content: "export const x = 999;\n" },
			{ path: "src/old.ts", content: null },
		]),
	});
	assert.equal(verdict.authorized, false, "content mismatch is refused");
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_content_mismatch",
	);
	console.log("PASS content mismatch is refused");
}

{
	// Push target retargeted after approval (branch escalated to main).
	const escalated: RepoCommitFenceTarget = { ...TARGET, branch: "main" };
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: await declarationJsonFor(escalated),
		target: escalated,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false, "retargeted push is refused");
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_target_mismatch",
	);
	console.log("PASS retargeted push is refused even when self-consistent");
}

{
	// The row is linked to an approval that authorizes a DIFFERENT execution.
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload({
			executionLedgerId: "22222222-2222-4222-8222-222222222222",
		}),
		declarationJson: await declarationJsonFor(),
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false, "borrowed approval is refused");
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_ledger_mismatch",
	);
	console.log("PASS an approval for another execution cannot publish this one");
}

{
	// Approval summary disagrees with the bytes (declaration and changeset were
	// both rewritten, but the operator-visible summary was not).
	const rewritten: RepoCommitFenceChange[] = [
		{ path: "src/index.ts", content: "export const x = 1;\n" },
		{ path: "src/old.ts", content: "resurrected\n" },
	];
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: await declarationJsonFor(TARGET, rewritten),
		target: TARGET,
		changesJson: changesJson(rewritten),
	});
	assert.equal(verdict.authorized, false, "approval summary is cross-checked");
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_content_mismatch",
	);
	console.log("PASS the operator-visible approval summary is cross-checked");
}

// ── the D1-carried fingerprint is the anchor the DO cannot rewrite ──────────

{
	// The attack the capped summary cannot see. An actor with write access to
	// the tedi's own DO-SQLite rewrites BOTH the parked changeset and the
	// declaration that constrains it, choosing replacement bytes with the same
	// paths and the same byte length. Target, fileCount, totalBytes and both
	// capped path lists are all preserved, so every check that lives inside the
	// DO — and the operator-visible approval summary in D1 — still agrees.
	const swapped: RepoCommitFenceChange[] = [
		{ path: "src/index.ts", content: "export const x = 9;\n" },
		{ path: "src/old.ts", content: null },
	];
	const honest = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: CHANGES,
	});
	const forged = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: swapped,
	});
	assert.notEqual(forged.fingerprint, honest.fingerprint);
	assert.equal(
		forged.fileCount,
		honest.fileCount,
		"summary is indistinguishable",
	);
	assert.equal(forged.totalBytes, honest.totalBytes);
	assert.deepEqual(forged.addedOrModified, honest.addedOrModified);
	assert.deepEqual(forged.deleted, honest.deleted);

	// Without the approval-carried anchor this publish would be authorized.
	const unanchored = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: JSON.stringify(forged),
		target: TARGET,
		changesJson: changesJson(swapped),
	});
	assert.equal(
		unanchored.authorized,
		true,
		"pre-change approvals keep publishing on declaration + summary alone",
	);

	// With it, the swap is refused: the anchor lives in D1, which the tedi's own
	// store cannot rewrite.
	const anchored = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload({
			changeFingerprint: honest.fingerprint,
		}),
		declarationJson: JSON.stringify(forged),
		target: TARGET,
		changesJson: changesJson(swapped),
	});
	assert.equal(
		anchored.authorized,
		false,
		"an equal-shape content swap is refused",
	);
	assert.equal(
		anchored.authorized === false && anchored.code,
		"fence_content_mismatch",
	);
	console.log(
		"PASS an approval fingerprint that disagrees with the bytes refuses the publish",
	);
}

{
	// The honest case still publishes: approval fingerprint, declaration and the
	// bytes about to move all agree.
	const honest = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: CHANGES,
	});
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload({
			changeFingerprint: honest.fingerprint,
		}),
		declarationJson: JSON.stringify(honest),
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, true, "a matching fingerprint publishes");
	assert.equal(
		verdict.authorized === true && verdict.declaration.fingerprint,
		honest.fingerprint,
	);
	console.log("PASS a matching approval fingerprint still publishes");
}

{
	// A malformed anchor is not "no anchor": the shared parser rejects the whole
	// payload, so the publish fails closed rather than falling back.
	assert.equal(
		parseApprovedRepoCommitAction(
			approvalPayload({ changeFingerprint: "nope" }),
		),
		null,
	);
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload({ changeFingerprint: "nope" }),
		declarationJson: await declarationJsonFor(),
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false);
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_approval_unreadable",
	);
	console.log("PASS a malformed approval fingerprint fails closed");
}

{
	// Forward-compatible: an approval that carries its own exact fingerprint and
	// disagrees with the bytes is refused.
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload({ changeFingerprint: "f".repeat(64) }),
		declarationJson: await declarationJsonFor(),
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false);
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_content_mismatch",
	);
	console.log("PASS an approval-carried fingerprint is honoured when present");
}

// ── undeclared / unverifiable publish is REFUSED ────────────────────────────

{
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: null,
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false, "undeclared push is refused");
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_undeclared",
	);
	console.log("PASS undeclared publish is refused");
}

{
	for (const bad of ["", "not json", "{}", '{"version":"v1"}']) {
		const verdict = await authorizeRepoCommitPublish({
			ledgerId: LEDGER_ID,
			approvalRequestId: "approval-1",
			approvalPayloadJson: approvalPayload(),
			declarationJson: bad,
			target: TARGET,
			changesJson: changesJson(CHANGES),
		});
		assert.equal(verdict.authorized, false, `malformed declaration: ${bad}`);
		assert.equal(
			verdict.authorized === false && verdict.code,
			"fence_undeclared",
		);
	}
	console.log("PASS a malformed declaration is undeclared, not unconstrained");
}

{
	// Declaration recorded under an older fence version.
	const stale = JSON.stringify({
		...JSON.parse(await declarationJsonFor()),
		version: "v0",
	});
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: "approval-1",
		approvalPayloadJson: approvalPayload(),
		declarationJson: stale,
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false);
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_version_mismatch",
	);
	console.log("PASS a declaration from another fence version is refused");
}

{
	const verdict = await authorizeRepoCommitPublish({
		ledgerId: LEDGER_ID,
		approvalRequestId: null,
		approvalPayloadJson: null,
		declarationJson: await declarationJsonFor(),
		target: TARGET,
		changesJson: changesJson(CHANGES),
	});
	assert.equal(verdict.authorized, false, "no approval link is refused");
	assert.equal(
		verdict.authorized === false && verdict.code,
		"fence_approval_missing",
	);
	console.log("PASS a row with no approval link cannot publish");
}

{
	for (const bad of [null, "", "not json", "{}", '{"kind":"something_else"}']) {
		const verdict = await authorizeRepoCommitPublish({
			ledgerId: LEDGER_ID,
			approvalRequestId: "approval-1",
			approvalPayloadJson: bad,
			declarationJson: await declarationJsonFor(),
			target: TARGET,
			changesJson: changesJson(CHANGES),
		});
		assert.equal(verdict.authorized, false, `unreadable approval: ${bad}`);
		assert.equal(
			verdict.authorized === false && verdict.code,
			"fence_approval_unreadable",
		);
	}
	console.log("PASS an unreadable approval refuses the publish");
}

{
	for (const bad of [
		"not json",
		"[]",
		'{"changes":"nope"}',
		'{"changes":[1]}',
	]) {
		const verdict = await authorizeRepoCommitPublish({
			ledgerId: LEDGER_ID,
			approvalRequestId: "approval-1",
			approvalPayloadJson: approvalPayload(),
			declarationJson: await declarationJsonFor(),
			target: TARGET,
			changesJson: bad,
		});
		assert.equal(verdict.authorized, false, `unverifiable changeset: ${bad}`);
		assert.equal(
			verdict.authorized === false && verdict.code,
			"fence_unverifiable",
		);
	}
	console.log("PASS an unreadable changeset refuses the publish");
}

// ── denial is distinguishable from success in the tool result shape ─────────

{
	// This is the shape the DO builds for the tool result from the persisted
	// error string. It must never read as a success.
	const denialError = repoCommitFenceDenialError("fence_content_mismatch");
	const denial = parseRepoCommitFenceDenial(denialError);
	assert.ok(denial, "a persisted fence denial is recognizable");
	assert.equal(denial.code, "fence_content_mismatch");
	assert.ok(denial.reason.length > 0, "a denial carries a legible reason");

	const deniedResult = {
		ok: false,
		denied: true,
		published: false,
		status: "denied",
		error: "repo_commit_publish_denied",
		deniedBy: "repo_commit_publish_fence",
		deniedCode: denial.code,
		deniedReason: denial.reason,
	};
	const successResult = {
		ok: true,
		denied: false,
		published: true,
		status: "committed",
		commitSha: "b".repeat(40),
	};

	assert.notEqual(deniedResult.ok, successResult.ok, "ok differs");
	assert.notEqual(deniedResult.denied, successResult.denied, "denied differs");
	assert.notEqual(
		deniedResult.published,
		successResult.published,
		"published differs",
	);
	assert.notEqual(deniedResult.status, successResult.status, "status differs");
	assert.equal(
		"commitSha" in deniedResult,
		false,
		"a denied publish carries no commit sha",
	);
	assert.equal(
		"error" in successResult,
		false,
		"a successful publish carries no error",
	);
	console.log("PASS a denial is distinguishable from a success");
}

{
	// Ordinary execution failures are NOT fence denials — the marker must not
	// over-claim.
	for (const other of [
		null,
		undefined,
		"repo_not_found",
		"github_auth_failed",
		"publish_fence_denied:not_a_real_code",
	]) {
		assert.equal(
			parseRepoCommitFenceDenial(other),
			null,
			`not a fence denial: ${String(other)}`,
		);
	}
	console.log("PASS non-fence errors are not reported as fence denials");
}

// ── declaration store ───────────────────────────────────────────────────────

{
	const store = new RepoCommitFenceStore(makeSqlRunner());
	assert.equal(store.getDeclarationJson(LEDGER_ID), null, "nothing declared");

	const declaration = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: CHANGES,
	});
	store.declare(LEDGER_ID, declaration);
	const stored = store.getDeclarationJson(LEDGER_ID);
	assert.ok(stored);
	assert.equal(JSON.parse(stored).fingerprint, declaration.fingerprint);

	// Write-once: a second declare cannot re-point an existing declaration.
	const other = await buildRepoCommitDeclaration({
		target: { ...TARGET, branch: "main" },
		changes: CHANGES,
	});
	store.declare(LEDGER_ID, other);
	assert.equal(
		JSON.parse(store.getDeclarationJson(LEDGER_ID) as string).fingerprint,
		declaration.fingerprint,
		"declarations are write-once",
	);

	assert.equal(store.get(LEDGER_ID)?.publishedCommitSha, null);
	store.recordPublishedCommit(LEDGER_ID, "c".repeat(40));
	assert.equal(store.get(LEDGER_ID)?.publishedCommitSha, "c".repeat(40));
	store.recordPublishedCommit(LEDGER_ID, "d".repeat(40));
	assert.equal(
		store.get(LEDGER_ID)?.publishedCommitSha,
		"c".repeat(40),
		"the published sha is written once",
	);
	console.log("PASS declaration store is write-once and records the commit");
}

// ── parsers ─────────────────────────────────────────────────────────────────

{
	assert.deepEqual(parseRepoCommitLedgerChanges(changesJson(CHANGES)), CHANGES);
	const approved = parseApprovedRepoCommitAction(approvalPayload());
	assert.ok(approved);
	assert.equal(approved.executionLedgerId, LEDGER_ID);
	assert.equal(approved.target.branch, TARGET.branch);
	assert.equal(approved.fingerprint, null);
	const withFingerprint = parseApprovedRepoCommitAction(
		approvalPayload({ changeFingerprint: "e".repeat(64) }),
	);
	assert.equal(withFingerprint?.fingerprint, "e".repeat(64));
	console.log("PASS parsers read the ledger changeset and the approved action");
}

// ── Integration: the drain refuses before any byte moves ────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const fenceStore = new RepoCommitFenceStore(runner);

	const goodId = "aaaaaaaa-0000-4000-8000-000000000001";
	const badId = "aaaaaaaa-0000-4000-8000-000000000002";
	const undeclaredId = "aaaaaaaa-0000-4000-8000-000000000003";

	function park(id: string, changes: RepoCommitFenceChange[]) {
		store.park({
			id,
			approvalRequestId: `approval-${id}`,
			owner: TARGET.owner,
			repo: TARGET.repo,
			baseRef: TARGET.baseRef,
			branch: TARGET.branch,
			message: TARGET.message,
			changesJson: changesJson(changes),
			openPr: TARGET.openPr,
			prBase: TARGET.prBase,
			riskTier: "low",
		});
	}

	park(goodId, CHANGES);
	park(badId, CHANGES);
	park(undeclaredId, CHANGES);

	const declaration = await buildRepoCommitDeclaration({
		target: TARGET,
		changes: CHANGES,
	});
	fenceStore.declare(goodId, declaration);
	fenceStore.declare(badId, declaration);
	// undeclaredId: deliberately never declared.

	// The bad row's changeset is rewritten AFTER it was declared and approved —
	// the ledger now holds bytes nobody approved.
	runner.sql`
		UPDATE repo_commit_executions
		SET changesJson = ${changesJson([
			{ path: "src/index.ts", content: "export const backdoor = true;\n" },
			{ path: "src/old.ts", content: null },
		])}
		WHERE id = ${badId}
	`;

	const pushed: string[] = [];

	await drainRepoCommits({
		store,
		tediId: "tedi-1",
		getStatus: async () => ({ status: "approved" }),
		executeRow: async (row) => {
			// Mirrors the DO's executeRow: fence first, publish only on authorize.
			const verdict = await authorizeRepoCommitPublish({
				ledgerId: row.id,
				approvalRequestId: row.approvalRequestId,
				approvalPayloadJson: approvalPayload({ executionLedgerId: row.id }),
				declarationJson: fenceStore.getDeclarationJson(row.id),
				target: {
					owner: row.owner,
					repo: row.repo,
					baseRef: row.baseRef,
					branch: row.branch,
					message: row.message,
					openPr: row.openPr === 1,
					prBase: row.prBase,
				},
				changesJson: row.changesJson,
			});
			if (!verdict.authorized) {
				return { ok: false, code: repoCommitFenceDenialError(verdict.code) };
			}
			pushed.push(row.id);
			const commitSha = "f".repeat(40);
			fenceStore.recordPublishedCommit(row.id, commitSha);
			return { ok: true, commitSha, branchRef: `refs/heads/${row.branch}` };
		},
	});

	assert.deepEqual(
		pushed,
		[goodId],
		"only the declared, matching row is pushed",
	);

	const good = store.get(goodId);
	assert.equal(good?.status, "committed");
	assert.equal(parseRepoCommitFenceDenial(good?.error), null);
	assert.equal(fenceStore.get(goodId)?.publishedCommitSha, "f".repeat(40));

	const bad = store.get(badId);
	assert.equal(
		bad?.status,
		"error",
		"a refused publish is terminal, not retried",
	);
	assert.equal(bad?.commitSha, null, "nothing was pushed");
	assert.equal(
		parseRepoCommitFenceDenial(bad?.error)?.code,
		"fence_content_mismatch",
	);

	const undeclared = store.get(undeclaredId);
	assert.equal(undeclared?.status, "error");
	assert.equal(undeclared?.commitSha, null);
	assert.equal(
		parseRepoCommitFenceDenial(undeclared?.error)?.code,
		"fence_undeclared",
	);
	console.log(
		"PASS drain publishes only the declared, matching row and refuses the rest",
	);
}

console.log("repo-commit-fence.test.ts: integration assertions passed");
