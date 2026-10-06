/**
 * Unit tests for repo-commit-store.ts.
 *
 * Standalone bun-run script (no vitest, no cloudflare:workers imports).
 * Uses bun:sqlite in-memory DB to simulate the DO-SQLite runner.
 * Run with: bun run src/repo-commit-store.test.ts
 */

import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import type { DoSqlRunner } from "./brain-bridge-do";
import { RepoCommitStore } from "./repo-commit-store";

// ── Minimal in-memory SQL runner (mirrors cm-execution-approval.test.ts) ─────

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
				if (i < values.length) {
					query += "?";
				}
			}
			const q = query.trim();
			if (/^\s*(INSERT|UPDATE|DELETE|CREATE)/i.test(q)) {
				db.run(q, values);
				return [] as T[];
			}
			return db.query(q).all(...values) as T[];
		},
	};
}

// Shared changeset JSON used across tests
const CHANGES_JSON = JSON.stringify({
	changes: [
		{ path: "src/index.ts", content: "export const x = 1;" },
		{ path: "src/old.ts", content: null },
	],
});

function makeParkInput(id: string) {
	return {
		id,
		owner: "acme",
		repo: "app",
		baseRef: "a".repeat(40),
		branch: "feat/work",
		message: "Add feature",
		changesJson: CHANGES_JSON,
		openPr: false as const,
		riskTier: "low" as const,
	};
}

// ── 1. park then listParked returns the row ───────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	const row = store.park(makeParkInput(id));

	assert.equal(row.status, "parked", "park returns status=parked");
	assert.equal(row.riskTier, "low");
	assert.equal(row.commitSha, null, "commitSha null on park");
	assert.equal(row.error, null, "error null on park");

	const listed = store.listParked();
	assert.equal(listed.length, 1, "listParked returns 1 row");
	assert.equal(listed[0]!.id, id);
	assert.equal(listed[0]!.status, "parked");
	assert.equal(listed[0]!.changesJson, CHANGES_JSON, "changesJson preserved");
}

// ── 2. claimForExecution exactly-once ────────────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park(makeParkInput(id));

	// First claim succeeds
	const claimed = store.claimForExecution(id);
	assert.ok(claimed !== null, "first claim returns the row");
	assert.equal(claimed!.status, "committing", "claimed row status=committing");

	// Second claim returns null (already claimed)
	const claimedAgain = store.claimForExecution(id);
	assert.equal(claimedAgain, null, "second claim returns null (exactly-once)");

	// listParked should now be empty (row is in committing state)
	const listed = store.listParked();
	assert.equal(listed.length, 0, "listParked empty after claim");
}

// ── 3. claimForExecution on non-existent id returns null ─────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const result = store.claimForExecution(crypto.randomUUID());
	assert.equal(result, null, "claim on missing id returns null");
}

// ── 4. getByApprovalRequestId fetches the parked row without exposing lookups by contents

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	const approvalRequestId = crypto.randomUUID();
	store.park({ ...makeParkInput(id), approvalRequestId });

	const row = store.getByApprovalRequestId(approvalRequestId);
	assert.ok(row !== null, "row found by approvalRequestId");
	assert.equal(row!.id, id);
	assert.equal(row!.approvalRequestId, approvalRequestId);
	assert.equal(store.getByApprovalRequestId(crypto.randomUUID()), null);
}

// ── 5. Fresh store over same DB still sees parked rows (restart simulation) ───

{
	// Use the same runner (same underlying db) but construct a new RepoCommitStore
	const runner = makeSqlRunner();
	const store1 = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store1.park(makeParkInput(id));

	// Simulate restart: new store instance over same db runner
	const store2 = new RepoCommitStore(runner);
	const listed = store2.listParked();
	assert.equal(listed.length, 1, "new store instance sees existing rows");
	assert.equal(listed[0]!.id, id);
}

// ── 5. markCommitted transitions status and sets commitSha ────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park(makeParkInput(id));
	store.claimForExecution(id);
	store.markCommitted(id, { commitSha: "sha-abc123", prUrl: null });

	const row = store.get(id);
	assert.ok(row !== null);
	assert.equal(row!.status, "committed");
	assert.equal(row!.commitSha, "sha-abc123");
	assert.equal(row!.prUrl, null);

	// Should not appear in listParked
	const listed = store.listParked();
	assert.equal(listed.length, 0, "committed row not in listParked");
}

// ── 6. markCommitted with prUrl ───────────────────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park(makeParkInput(id));
	store.claimForExecution(id);
	store.markCommitted(id, {
		commitSha: "sha-xyz",
		prUrl: "https://github.com/acme/app/pull/7",
	});

	const row = store.get(id);
	assert.ok(row !== null);
	assert.equal(row!.prUrl, "https://github.com/acme/app/pull/7");
}

// ── 7. markError transitions status and sets error ────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park(makeParkInput(id));
	store.claimForExecution(id);
	store.markError(id, "GitHub authentication failed");

	const row = store.get(id);
	assert.ok(row !== null);
	assert.equal(row!.status, "error");
	assert.equal(row!.error, "GitHub authentication failed");
	assert.equal(row!.commitSha, null);
}

// ── 8. markAbandoned transitions status ───────────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park(makeParkInput(id));
	store.markAbandoned(id);

	const row = store.get(id);
	assert.ok(row !== null);
	assert.equal(row!.status, "abandoned");
	assert.equal(row!.commitSha, null);

	// Should not appear in listParked
	const listed = store.listParked();
	assert.equal(listed.length, 0, "abandoned row not in listParked");
}

// ── 9. listParked respects limit param ───────────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	for (let i = 0; i < 5; i++) {
		store.park(makeParkInput(crypto.randomUUID()));
	}
	const limited = store.listParked(3);
	assert.equal(limited.length, 3, "listParked(3) returns at most 3 rows");
}

// ── 10. park preserves openPr and prBase ─────────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park({
		id,
		owner: "acme",
		repo: "app",
		baseRef: "a".repeat(40),
		branch: "feat/pr-test",
		message: "Open PR",
		changesJson: CHANGES_JSON,
		openPr: true,
		prBase: "main",
		riskTier: "high",
	});

	const row = store.get(id);
	assert.ok(row !== null);
	assert.equal(row!.openPr, 1, "openPr stored as integer 1");
	assert.equal(row!.prBase, "main");
	assert.equal(row!.riskTier, "high");
}

// ── 11. approvalRequestId stored and retrievable ─────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	const approvalId = crypto.randomUUID();
	store.park({ ...makeParkInput(id), approvalRequestId: approvalId });

	const row = store.get(id);
	assert.ok(row !== null);
	assert.equal(row!.approvalRequestId, approvalId);
}

// ── 12. markCommitted is a no-op on non-committing rows ──────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);
	const id = crypto.randomUUID();
	store.park(makeParkInput(id));

	// Row is still `parked` — markCommitted must not transition it
	store.markCommitted(id, { commitSha: "sha-should-not-stick" });
	const afterFirst = store.get(id);
	assert.ok(afterFirst !== null);
	assert.equal(
		afterFirst!.status,
		"parked",
		"markCommitted on parked row is a no-op",
	);
	assert.equal(
		afterFirst!.commitSha,
		null,
		"commitSha not set when row was parked",
	);

	// Now claim it and commit it properly
	store.claimForExecution(id);
	store.markCommitted(id, { commitSha: "sha-first" });

	// Second markCommitted call — status already committed, must be a no-op
	store.markCommitted(id, { commitSha: "sha-second" });
	const afterSecond = store.get(id);
	assert.ok(afterSecond !== null);
	assert.equal(
		afterSecond!.status,
		"committed",
		"status stays committed on second markCommitted",
	);
	assert.equal(
		afterSecond!.commitSha,
		"sha-first",
		"commitSha unchanged on second markCommitted",
	);
}

// ── 13. markError / markAbandoned do not overwrite a committed row ────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);

	// markError after committed
	const id1 = crypto.randomUUID();
	store.park(makeParkInput(id1));
	store.claimForExecution(id1);
	store.markCommitted(id1, { commitSha: "sha-committed-1" });
	store.markError(id1, "should not overwrite committed");
	const row1 = store.get(id1);
	assert.ok(row1 !== null);
	assert.equal(
		row1!.status,
		"committed",
		"markError does not overwrite committed row",
	);
	assert.equal(row1!.error, null, "error stays null on committed row");

	// markAbandoned after committed
	const id2 = crypto.randomUUID();
	store.park(makeParkInput(id2));
	store.claimForExecution(id2);
	store.markCommitted(id2, { commitSha: "sha-committed-2" });
	store.markAbandoned(id2);
	const row2 = store.get(id2);
	assert.ok(row2 !== null);
	assert.equal(
		row2!.status,
		"committed",
		"markAbandoned does not overwrite committed row",
	);
}

// ── 14. failStuckCommitting ────────────────────────────────────────────────────

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);

	// Claim a row and backdate its updatedAt to simulate a stale committing row
	const staleId = crypto.randomUUID();
	store.park(makeParkInput(staleId));
	store.claimForExecution(staleId);
	// Manually backdate updatedAt so it looks old (1 hour ago)
	const oneHourAgo = Date.now() - 60 * 60 * 1000;
	runner.sql`
		UPDATE repo_commit_executions
		SET updatedAt = ${oneHourAgo}
		WHERE id = ${staleId}
	`;

	// A fresh committing row (updatedAt = now) — must NOT be touched
	const freshId = crypto.randomUUID();
	store.park(makeParkInput(freshId));
	store.claimForExecution(freshId);

	// A parked row — must NOT be touched
	const parkedId = crypto.randomUUID();
	store.park(makeParkInput(parkedId));

	// Call failStuckCommitting with 30-minute threshold
	const failed = store.failStuckCommitting(30 * 60 * 1000);

	// Only the stale row is returned
	assert.equal(failed.length, 1, "failStuckCommitting returns 1 stale row");
	assert.equal(failed[0]!.id, staleId, "returned row is the stale one");

	// Stale row is now `error` with the interruption message
	const staleRow = store.get(staleId);
	assert.ok(staleRow !== null);
	assert.equal(staleRow!.status, "error", "stale committing row becomes error");
	assert.ok(
		staleRow!.error?.includes("manual review required"),
		"error message mentions manual review",
	);

	// Fresh committing row is untouched
	const freshRow = store.get(freshId);
	assert.ok(freshRow !== null);
	assert.equal(
		freshRow!.status,
		"committing",
		"fresh committing row is untouched",
	);

	// Parked row is untouched
	const parkedRow = store.get(parkedId);
	assert.ok(parkedRow !== null);
	assert.equal(parkedRow!.status, "parked", "parked row is untouched");

	// Calling again returns empty (no more stale committing rows)
	const failedAgain = store.failStuckCommitting(30 * 60 * 1000);
	assert.equal(
		failedAgain.length,
		0,
		"second failStuckCommitting call returns empty",
	);
}

// ── 15. failStuckParked: aged null-approvalId parked → error; fresh/others → untouched

{
	const runner = makeSqlRunner();
	const store = new RepoCommitStore(runner);

	// An old parked row with no approvalRequestId — should be failed
	const staleId = crypto.randomUUID();
	store.park(makeParkInput(staleId));
	// Backdate createdAt to 20 minutes ago
	const twentyMinAgo = Date.now() - 20 * 60 * 1000;
	runner.sql`
		UPDATE repo_commit_executions
		SET createdAt = ${twentyMinAgo}
		WHERE id = ${staleId}
	`;

	// A fresh parked row with no approvalRequestId — must NOT be touched
	const freshId = crypto.randomUUID();
	store.park(makeParkInput(freshId));

	// A parked row WITH an approvalRequestId — must NOT be touched (has an approval pending)
	const withApprovalId = crypto.randomUUID();
	store.park({
		...makeParkInput(withApprovalId),
		approvalRequestId: crypto.randomUUID(),
	});
	// Backdate it too to ensure the approvalRequestId check (not age) guards it
	runner.sql`
		UPDATE repo_commit_executions
		SET createdAt = ${twentyMinAgo}
		WHERE id = ${withApprovalId}
	`;

	// A committing row (not parked) — must NOT be touched
	const committingId = crypto.randomUUID();
	store.park(makeParkInput(committingId));
	store.claimForExecution(committingId);
	runner.sql`
		UPDATE repo_commit_executions
		SET createdAt = ${twentyMinAgo}
		WHERE id = ${committingId}
	`;

	// Call failStuckParked with 10-minute threshold
	const failed = store.failStuckParked(10 * 60 * 1000);

	assert.equal(failed.length, 1, "failStuckParked returns 1 stale row");
	assert.equal(
		failed[0]!.id,
		staleId,
		"returned row is the stale null-approvalId parked one",
	);

	const staleRow = store.get(staleId);
	assert.ok(staleRow !== null);
	assert.equal(
		staleRow!.status,
		"error",
		"stale null-approvalId parked row becomes error",
	);
	assert.ok(
		staleRow!.error?.includes("propose never linked an approval"),
		"error message describes the failure",
	);

	// Fresh row is untouched
	const freshRow = store.get(freshId);
	assert.ok(freshRow !== null);
	assert.equal(freshRow!.status, "parked", "fresh parked row is untouched");

	// Row with approvalRequestId is untouched (has an approval pending)
	const withApprovalRow = store.get(withApprovalId);
	assert.ok(withApprovalRow !== null);
	assert.equal(
		withApprovalRow!.status,
		"parked",
		"parked row WITH approvalRequestId is untouched",
	);

	// Committing row is untouched
	const committingRow = store.get(committingId);
	assert.ok(committingRow !== null);
	assert.equal(
		committingRow!.status,
		"committing",
		"committing row is untouched by failStuckParked",
	);

	// Second call returns empty (no more stale null-approvalId parked rows)
	const failedAgain = store.failStuckParked(10 * 60 * 1000);
	assert.equal(
		failedAgain.length,
		0,
		"second failStuckParked call returns empty",
	);
}

console.log("✅ All repo-commit-store tests passed");
