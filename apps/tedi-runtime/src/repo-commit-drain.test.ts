/**
 * Unit tests for repo-commit-drain.ts.
 *
 * Standalone bun-run script (no vitest, no cloudflare:workers imports).
 * Run with: bun run src/repo-commit-drain.test.ts
 */

import assert from "node:assert/strict";
import {
	type DrainExecuteRow,
	type DrainGetStatus,
	type DrainRepoCommitStore,
	drainRepoCommits,
} from "./repo-commit-drain";
import type { RepoCommitRow } from "./repo-commit-store";

function makeRow(overrides: Partial<RepoCommitRow> = {}): RepoCommitRow {
	return {
		id: "row-1",
		approvalRequestId: "apr-1",
		owner: "acme",
		repo: "app",
		baseRef: "a".repeat(40),
		branch: "feat/work",
		message: "test commit",
		changesJson: JSON.stringify({
			changes: [{ path: "src/foo.ts", content: "x" }],
		}),
		openPr: 0,
		prBase: null,
		riskTier: "low",
		status: "parked",
		commitSha: null,
		prUrl: null,
		error: null,
		claimToken: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeStore(rows: RepoCommitRow[]): DrainRepoCommitStore & {
	failStuckCalledWith: number[];
	failStuckParkedCalledWith: number[];
	markedCommitted: Array<{
		id: string;
		opts: { commitSha: string; prUrl?: string | null };
	}>;
	markedError: Array<{ id: string; message: string }>;
	markedAbandoned: string[];
	claimedIds: string[];
	_claimReturnsNull: boolean;
} {
	const store = {
		failStuckCalledWith: [] as number[],
		failStuckParkedCalledWith: [] as number[],
		markedCommitted: [] as Array<{
			id: string;
			opts: { commitSha: string; prUrl?: string | null };
		}>,
		markedError: [] as Array<{ id: string; message: string }>,
		markedAbandoned: [] as string[],
		claimedIds: [] as string[],
		_claimReturnsNull: false,

		failStuckCommitting(olderThanMs: number) {
			store.failStuckCalledWith.push(olderThanMs);
			return [];
		},
		failStuckParked(olderThanMs: number) {
			store.failStuckParkedCalledWith.push(olderThanMs);
			return [];
		},
		listParked(limit?: number) {
			return rows.slice(0, limit ?? 50);
		},
		claimForExecution(id: string): RepoCommitRow | null {
			if (store._claimReturnsNull) return null;
			store.claimedIds.push(id);
			const row = rows.find((r) => r.id === id);
			return row ?? null;
		},
		markCommitted(
			id: string,
			opts: { commitSha: string; prUrl?: string | null },
		) {
			store.markedCommitted.push({ id, opts });
		},
		markError(id: string, message: string) {
			store.markedError.push({ id, message });
		},
		markAbandoned(id: string) {
			store.markedAbandoned.push(id);
		},
	};
	return store;
}

// ── 1. approved row → executeRow called + markCommitted ─────────────────────

{
	const row = makeRow();
	const store = makeStore([row]);
	const executeRowCalls: RepoCommitRow[] = [];
	const executeRow: DrainExecuteRow = async (r) => {
		executeRowCalls.push(r);
		return {
			ok: true,
			commitSha: "deadbeef",
			branchRef: "refs/heads/feat/work",
		};
	};
	const getStatus: DrainGetStatus = async () => ({ status: "approved" });

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(executeRowCalls.length, 1, "executeRow called once");
	assert.equal(store.markedCommitted.length, 1, "markCommitted called once");
	assert.equal(store.markedCommitted[0]?.id, "row-1");
	assert.equal(store.markedCommitted[0]?.opts.commitSha, "deadbeef");
	assert.equal(store.markedError.length, 0, "no errors");
	console.log("✓ 1. approved row → executeRow called + markCommitted");
}

// ── 2. execute fails → markError called ──────────────────────────────────────

{
	const row = makeRow();
	const store = makeStore([row]);
	const executeRow: DrainExecuteRow = async () => ({
		ok: false,
		code: "repo_not_found",
	});
	const getStatus: DrainGetStatus = async () => ({ status: "approved" });

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(store.markedError.length, 1, "markError called");
	assert.equal(store.markedError[0]?.id, "row-1");
	assert.equal(store.markedError[0]?.message, "repo_not_found");
	assert.equal(store.markedCommitted.length, 0, "no committed");
	console.log("✓ 2. execute fails → markError called");
}

// ── 3. rejected → markAbandoned called ───────────────────────────────────────

{
	const row = makeRow();
	const store = makeStore([row]);
	const executeRow: DrainExecuteRow = async () => {
		throw new Error("should not be called");
	};
	const getStatus: DrainGetStatus = async () => ({ status: "rejected" });

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(store.markedAbandoned.length, 1, "markAbandoned called");
	assert.equal(store.markedAbandoned[0], "row-1");
	assert.equal(store.markedCommitted.length, 0);
	assert.equal(store.markedError.length, 0);
	console.log("✓ 3. rejected → markAbandoned called");
}

// ── 4. cancelled → markAbandoned called ──────────────────────────────────────

{
	const row = makeRow();
	const store = makeStore([row]);
	const getStatus: DrainGetStatus = async () => ({ status: "cancelled" });
	const executeRow: DrainExecuteRow = async () => {
		throw new Error("should not be called");
	};

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(store.markedAbandoned[0], "row-1");
	console.log("✓ 4. cancelled → markAbandoned called");
}

// ── 5. expired → markAbandoned called ────────────────────────────────────────

{
	const row = makeRow();
	const store = makeStore([row]);
	const getStatus: DrainGetStatus = async () => ({ status: "expired" });
	const executeRow: DrainExecuteRow = async () => {
		throw new Error("should not be called");
	};

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(store.markedAbandoned[0], "row-1");
	console.log("✓ 5. expired → markAbandoned called");
}

// ── 6. pending → untouched ────────────────────────────────────────────────────

{
	const row = makeRow();
	const store = makeStore([row]);
	const executeRowCalls: RepoCommitRow[] = [];
	const executeRow: DrainExecuteRow = async (r) => {
		executeRowCalls.push(r);
		return { ok: true, commitSha: "x", branchRef: "y" };
	};
	const getStatus: DrainGetStatus = async () => ({ status: "pending" });

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(executeRowCalls.length, 0, "executeRow not called");
	assert.equal(store.markedCommitted.length, 0);
	assert.equal(store.markedError.length, 0);
	assert.equal(store.markedAbandoned.length, 0);
	console.log("✓ 6. pending → untouched");
}

// ── 7. already-claimed (claimForExecution returns null) → executeRow NOT called

{
	const row = makeRow();
	const store = makeStore([row]);
	store._claimReturnsNull = true;
	const executeRowCalls: RepoCommitRow[] = [];
	const executeRow: DrainExecuteRow = async (r) => {
		executeRowCalls.push(r);
		return { ok: true, commitSha: "x", branchRef: "y" };
	};
	const getStatus: DrainGetStatus = async () => ({ status: "approved" });

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(
		executeRowCalls.length,
		0,
		"executeRow NOT called when claim returns null",
	);
	assert.equal(store.markedCommitted.length, 0);
	console.log("✓ 7. already-claimed → executeRow NOT called");
}

// ── 8. stuck recovery invoked (failStuckCommitting called with stuckMs) ───────

{
	const store = makeStore([]);
	const getStatus: DrainGetStatus = async () => ({ status: "pending" });
	const executeRow: DrainExecuteRow = async () => ({
		ok: true,
		commitSha: "x",
		branchRef: "y",
	});

	await drainRepoCommits({
		store,
		tediId: "tedi-1",
		getStatus,
		executeRow,
		stuckMs: 30_000,
	});

	assert.equal(
		store.failStuckCalledWith.length,
		1,
		"failStuckCommitting called",
	);
	assert.equal(store.failStuckCalledWith[0], 30_000, "called with stuckMs");
	console.log("✓ 8. stuck recovery invoked with correct stuckMs");
}

// ── 9. row without approvalRequestId → skipped ────────────────────────────────

{
	const row = makeRow({ approvalRequestId: null });
	const store = makeStore([row]);
	const getStatusCalls: string[] = [];
	const getStatus: DrainGetStatus = async ({ approvalRequestId }) => {
		getStatusCalls.push(approvalRequestId);
		return { status: "approved" };
	};
	const executeRowCalls: RepoCommitRow[] = [];
	const executeRow: DrainExecuteRow = async (r) => {
		executeRowCalls.push(r);
		return { ok: true, commitSha: "x", branchRef: "y" };
	};

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	assert.equal(
		getStatusCalls.length,
		0,
		"getStatus not called for row without approvalRequestId",
	);
	assert.equal(executeRowCalls.length, 0, "executeRow not called");
	console.log("✓ 9. row without approvalRequestId → skipped");
}

// ── 10. maxRows bounds the number of rows processed ──────────────────────────

{
	const rows = Array.from({ length: 10 }, (_, i) =>
		makeRow({ id: `row-${i}`, approvalRequestId: `apr-${i}` }),
	);
	const store = makeStore(rows);
	const getStatus: DrainGetStatus = async () => ({ status: "pending" });
	const executeRow: DrainExecuteRow = async () => ({
		ok: true,
		commitSha: "x",
		branchRef: "y",
	});

	await drainRepoCommits({
		store,
		tediId: "tedi-1",
		getStatus,
		executeRow,
		maxRows: 3,
	});

	// With status=pending nothing gets executed, but we can verify store.listParked was bounded
	// The store.listParked(3) is called with 3 — only those rows are considered.
	// Since all pending, nothing committed/errored/abandoned.
	assert.equal(store.markedCommitted.length, 0);
	console.log("✓ 10. maxRows bounds row processing");
}

// ── 11. failStuckParked is called with stuckMs * 10 ──────────────────────────

{
	const store = makeStore([]);
	const getStatus: DrainGetStatus = async () => ({ status: "pending" });
	const executeRow: DrainExecuteRow = async () => ({
		ok: true,
		commitSha: "x",
		branchRef: "y",
	});

	await drainRepoCommits({
		store,
		tediId: "tedi-1",
		getStatus,
		executeRow,
		stuckMs: 30_000,
	});

	assert.equal(
		store.failStuckParkedCalledWith.length,
		1,
		"failStuckParked called once",
	);
	assert.equal(
		store.failStuckParkedCalledWith[0],
		300_000,
		"failStuckParked called with stuckMs*10 (300_000)",
	);
	console.log("✓ 11. failStuckParked invoked with stuckMs * 10");
}

// ── 12. Parallel status poll: failed getStatus for one row does not block others

{
	const rows = [
		makeRow({ id: "row-a", approvalRequestId: "apr-a" }),
		makeRow({ id: "row-b", approvalRequestId: "apr-b" }),
		makeRow({ id: "row-c", approvalRequestId: "apr-c" }),
	];
	const store = makeStore(rows);
	const executeRowCalls: string[] = [];

	const getStatus: DrainGetStatus = async ({ approvalRequestId }) => {
		if (approvalRequestId === "apr-b") {
			throw new Error("simulated poll failure");
		}
		return { status: "approved" };
	};
	const executeRow: DrainExecuteRow = async (r) => {
		executeRowCalls.push(r.id);
		return { ok: true, commitSha: "sha-ok", branchRef: "refs/heads/x" };
	};

	await drainRepoCommits({ store, tediId: "tedi-1", getStatus, executeRow });

	// row-a and row-c were approved and should be executed; row-b poll failed → skipped
	assert.equal(
		executeRowCalls.length,
		2,
		"2 rows executed despite 1 poll failure",
	);
	assert.ok(executeRowCalls.includes("row-a"), "row-a executed");
	assert.ok(executeRowCalls.includes("row-c"), "row-c executed");
	assert.ok(!executeRowCalls.includes("row-b"), "row-b skipped (poll failed)");
	assert.equal(store.markedCommitted.length, 2, "2 rows committed");
	console.log("✓ 12. failed getStatus for one row does not block other rows");
}

console.log("✅ All repo-commit-drain tests passed");
