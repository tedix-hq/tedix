/**
 * DO-local durable store for repo_commit executions.
 *
 * Persists each commit request (including the full changeset JSON) to DO-SQLite
 * with a status lifecycle: parked → committing → committed | error | abandoned.
 *
 * The changeset (file contents) lives HERE in changesJson — it is never surfaced
 * in approval payloads, logs, or results. This store is the single source of
 * truth for the changeset until the commit succeeds or is abandoned.
 *
 * Modelled exactly on CmExecutionStore from cm-execution-store.ts.
 */

import type { DoSqlRunner } from "./brain-bridge-do";

export type RepoCommitStatus =
	| "parked"
	| "committing"
	| "committed"
	| "error"
	| "abandoned";

export interface RepoCommitRow {
	id: string;
	approvalRequestId: string | null;
	owner: string;
	repo: string;
	baseRef: string;
	branch: string;
	message: string;
	/** JSON-serialized { changes: { path: string; content: string | null }[] }. */
	changesJson: string;
	openPr: number;
	prBase: string | null;
	riskTier: "low" | "high";
	status: RepoCommitStatus;
	commitSha: string | null;
	prUrl: string | null;
	error: string | null;
	/**
	 * Random token written by claimForExecution to achieve exactly-once semantics.
	 * The SELECT after UPDATE only returns the row if this token matches.
	 */
	claimToken: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface RepoCommitParkInput {
	id: string;
	approvalRequestId?: string | null;
	owner: string;
	repo: string;
	baseRef: string;
	branch: string;
	message: string;
	changesJson: string;
	openPr: boolean;
	prBase?: string | null;
	riskTier: "low" | "high";
}

export class RepoCommitStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS repo_commit_executions (
				id TEXT PRIMARY KEY,
				approvalRequestId TEXT,
				owner TEXT NOT NULL,
				repo TEXT NOT NULL,
				baseRef TEXT NOT NULL,
				branch TEXT NOT NULL,
				message TEXT NOT NULL,
				changesJson TEXT NOT NULL,
				openPr INTEGER NOT NULL,
				prBase TEXT,
				riskTier TEXT NOT NULL,
				status TEXT NOT NULL,
				commitSha TEXT,
				prUrl TEXT,
				error TEXT,
				claimToken TEXT,
				createdAt INTEGER NOT NULL,
				updatedAt INTEGER NOT NULL
			)
		`;
		this.schemaReady = true;
	}

	/** Park a new commit request — full changeset stored, status=parked. */
	park(input: RepoCommitParkInput): RepoCommitRow {
		this.ensureSchema();
		const now = Date.now();
		const row: RepoCommitRow = {
			id: input.id,
			approvalRequestId: input.approvalRequestId ?? null,
			owner: input.owner,
			repo: input.repo,
			baseRef: input.baseRef,
			branch: input.branch,
			message: input.message,
			changesJson: input.changesJson,
			openPr: input.openPr ? 1 : 0,
			prBase: input.prBase ?? null,
			riskTier: input.riskTier,
			status: "parked",
			commitSha: null,
			prUrl: null,
			error: null,
			claimToken: null,
			createdAt: now,
			updatedAt: now,
		};
		this.runner.sql`
			INSERT INTO repo_commit_executions
				(id, approvalRequestId, owner, repo, baseRef, branch, message,
				 changesJson, openPr, prBase, riskTier, status,
				 commitSha, prUrl, error, claimToken, createdAt, updatedAt)
			VALUES
				(${row.id}, ${row.approvalRequestId}, ${row.owner}, ${row.repo},
				 ${row.baseRef}, ${row.branch}, ${row.message},
				 ${row.changesJson}, ${row.openPr}, ${row.prBase}, ${row.riskTier},
				 ${row.status}, ${null}, ${null}, ${null}, ${null}, ${row.createdAt}, ${row.updatedAt})
		`;
		return row;
	}

	/** List all rows with status=parked, oldest first, up to limit. */
	listParked(limit = 50): RepoCommitRow[] {
		this.ensureSchema();
		return this.runner.sql<RepoCommitRow>`
			SELECT id, approvalRequestId, owner, repo, baseRef, branch, message,
			       changesJson, openPr, prBase, riskTier, status,
			       commitSha, prUrl, error, claimToken, createdAt, updatedAt
			FROM repo_commit_executions
			WHERE status = 'parked'
			ORDER BY createdAt ASC
			LIMIT ${limit}
		`;
	}

	/**
	 * Conditional transition: parked → committing.
	 * Returns the claimed row if this call performed the transition,
	 * or null if the row was already claimed (exactly-once guarantee).
	 *
	 * Uses a random claimToken written atomically with the status transition.
	 * The SELECT after the UPDATE only returns the row when our specific token
	 * is present, so concurrent callers each get a unique token and at most one
	 * will see a matching row.
	 */
	claimForExecution(id: string): RepoCommitRow | null {
		this.ensureSchema();
		const now = Date.now();
		const token = crypto.randomUUID();
		this.runner.sql`
			UPDATE repo_commit_executions
			SET status = 'committing', claimToken = ${token}, updatedAt = ${now}
			WHERE id = ${id} AND status = 'parked'
		`;
		const rows = this.runner.sql<RepoCommitRow>`
			SELECT id, approvalRequestId, owner, repo, baseRef, branch, message,
			       changesJson, openPr, prBase, riskTier, status,
			       commitSha, prUrl, error, claimToken, createdAt, updatedAt
			FROM repo_commit_executions
			WHERE id = ${id} AND status = 'committing' AND claimToken = ${token}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	/** Mark a row as committed with the resulting SHA and optional PR URL.
	 * Only transitions a row that is currently `committing`; a row already in
	 * a terminal state (committed / error / abandoned) or still parked is left
	 * untouched (idempotent second-call safety).
	 */
	markCommitted(
		id: string,
		opts: { commitSha: string; prUrl?: string | null },
	): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			UPDATE repo_commit_executions
			SET status = 'committed',
			    commitSha = ${opts.commitSha},
			    prUrl = ${opts.prUrl ?? null},
			    updatedAt = ${now}
			WHERE id = ${id} AND status = 'committing'
		`;
	}

	/** Mark a row as errored with a message.
	 * Never overwrites a terminal row (committed / error / abandoned).
	 */
	markError(id: string, message: string): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			UPDATE repo_commit_executions
			SET status = 'error', error = ${message}, updatedAt = ${now}
			WHERE id = ${id} AND status NOT IN ('committed', 'error', 'abandoned')
		`;
	}

	/** Mark a row as abandoned (e.g. operator rejected the approval).
	 * Never overwrites a terminal row (committed / error / abandoned).
	 */
	markAbandoned(id: string): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			UPDATE repo_commit_executions
			SET status = 'abandoned', updatedAt = ${now}
			WHERE id = ${id} AND status NOT IN ('committed', 'error', 'abandoned')
		`;
	}

	/**
	 * Fail-safe recovery for rows stranded in `committing` (e.g. the DO died
	 * between claimForExecution and markCommitted/markError).
	 *
	 * IMPORTANT — these rows are marked `error`, NOT re-parked. Re-parking would
	 * allow re-execution, but the GitHub commit may have ALREADY landed before
	 * the DO crashed, so re-running could produce a duplicate commit. The error
	 * message instructs the operator to perform a manual review before retrying.
	 *
	 * Returns the stale rows that were failed (empty array if none found).
	 */
	failStuckCommitting(olderThanMs: number): RepoCommitRow[] {
		this.ensureSchema();
		const cutoff = Date.now() - olderThanMs;
		const stale = this.runner.sql<RepoCommitRow>`
			SELECT id, approvalRequestId, owner, repo, baseRef, branch, message,
			       changesJson, openPr, prBase, riskTier, status,
			       commitSha, prUrl, error, claimToken, createdAt, updatedAt
			FROM repo_commit_executions
			WHERE status = 'committing' AND updatedAt < ${cutoff}
		`;
		if (stale.length === 0) return [];
		const now = Date.now();
		const errorMsg =
			"execution interrupted before completion; commit may or may not have landed — manual review required";
		for (const row of stale) {
			this.runner.sql`
				UPDATE repo_commit_executions
				SET status = 'error', error = ${errorMsg}, updatedAt = ${now}
				WHERE id = ${row.id}
			`;
		}
		return stale;
	}

	/**
	 * Fail-safe sweep for parked rows that never received an approvalRequestId.
	 *
	 * A row can be stranded in `parked` with approvalRequestId=NULL when the DO
	 * dies between park() and updateApprovalId(), or when the kernel returns a
	 * non-string approval id. These rows are invisible to drainRepoCommits (which
	 * skips null-approvalId rows) and will never transition on their own.
	 *
	 * Marks them `error`; does NOT re-park, since there is no approval to poll.
	 * Returns the rows that were failed (empty array if none found).
	 */
	failStuckParked(olderThanMs: number): RepoCommitRow[] {
		this.ensureSchema();
		const cutoff = Date.now() - olderThanMs;
		const stale = this.runner.sql<RepoCommitRow>`
			SELECT id, approvalRequestId, owner, repo, baseRef, branch, message,
			       changesJson, openPr, prBase, riskTier, status,
			       commitSha, prUrl, error, claimToken, createdAt, updatedAt
			FROM repo_commit_executions
			WHERE status = 'parked' AND approvalRequestId IS NULL AND createdAt < ${cutoff}
		`;
		if (stale.length === 0) return [];
		const now = Date.now();
		const errorMsg =
			"propose never linked an approval — approval id was never written before the DO restarted";
		for (const row of stale) {
			this.runner.sql`
				UPDATE repo_commit_executions
				SET status = 'error', error = ${errorMsg}, updatedAt = ${now}
				WHERE id = ${row.id}
			`;
		}
		return stale;
	}

	/** Store the approvalRequestId returned by the kernel after parking. */
	updateApprovalId(id: string, approvalRequestId: string): void {
		this.ensureSchema();
		const now = Date.now();
		this.runner.sql`
			UPDATE repo_commit_executions
			SET approvalRequestId = ${approvalRequestId}, updatedAt = ${now}
			WHERE id = ${id} AND status = 'parked'
		`;
	}

	/** Fetch a single row by id. Returns null when not found. */
	get(id: string): RepoCommitRow | null {
		this.ensureSchema();
		const rows = this.runner.sql<RepoCommitRow>`
			SELECT id, approvalRequestId, owner, repo, baseRef, branch, message,
			       changesJson, openPr, prBase, riskTier, status,
			       commitSha, prUrl, error, claimToken, createdAt, updatedAt
			FROM repo_commit_executions
			WHERE id = ${id}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	/** Fetch a single row by approvalRequestId. Returns null when not found. */
	getByApprovalRequestId(approvalRequestId: string): RepoCommitRow | null {
		this.ensureSchema();
		const rows = this.runner.sql<RepoCommitRow>`
			SELECT id, approvalRequestId, owner, repo, baseRef, branch, message,
			       changesJson, openPr, prBase, riskTier, status,
			       commitSha, prUrl, error, claimToken, createdAt, updatedAt
			FROM repo_commit_executions
			WHERE approvalRequestId = ${approvalRequestId}
			ORDER BY createdAt DESC
			LIMIT 1
		`;
		return rows[0] ?? null;
	}
}

export type { DoSqlRunner };
