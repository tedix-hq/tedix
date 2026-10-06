/**
 * Drain function for pending repo_commit approvals.
 *
 * Pure and injectable: the DO wires real deps (store, getStatus, executeRow);
 * tests inject fakes. Never throws — all errors are caught and logged.
 */

import type { RepoCommitRow } from "./repo-commit-store";

export type { RepoCommitRow };

export interface DrainGetStatusResult {
	status: string;
	resolution?: string | null;
}

export type DrainGetStatus = (params: {
	approvalRequestId: string;
	tediId: string;
}) => Promise<DrainGetStatusResult>;

export type DrainExecuteRow = (row: RepoCommitRow) => Promise<{
	ok: boolean;
	commitSha?: string;
	branchRef?: string;
	prUrl?: string;
	code?: string;
}>;

export interface DrainRepoCommitStore {
	failStuckCommitting(olderThanMs: number): RepoCommitRow[];
	failStuckParked(olderThanMs: number): RepoCommitRow[];
	listParked(limit?: number): RepoCommitRow[];
	claimForExecution(id: string): RepoCommitRow | null;
	markCommitted(
		id: string,
		opts: { commitSha: string; prUrl?: string | null },
	): void;
	markError(id: string, message: string): void;
	markAbandoned(id: string): void;
}

export interface DrainRepoCommitsOptions {
	store: DrainRepoCommitStore;
	tediId: string;
	getStatus: DrainGetStatus;
	executeRow: DrainExecuteRow;
	maxRows?: number;
	stuckMs?: number;
}

/**
 * Process pending repo_commit approvals for one tedi turn.
 *
 * Bounded to maxRows per call, fail-soft, never throws.
 *
 * Status polls are run in parallel (Promise.allSettled) for all eligible parked
 * rows, then execution (claimForExecution + executeRow) is serialized for the
 * approved subset to avoid concurrent SQLite writes and double-execution.
 */
export async function drainRepoCommits(
	opts: DrainRepoCommitsOptions,
): Promise<void> {
	const {
		store,
		tediId,
		getStatus,
		executeRow,
		maxRows = 5,
		stuckMs = 60_000,
	} = opts;

	try {
		store.failStuckCommitting(stuckMs);
	} catch (err) {
		console.warn(
			"[repo_commit_drain] failStuckCommitting error:",
			err instanceof Error ? err.message : String(err),
		);
	}

	try {
		store.failStuckParked(stuckMs * 10); // 10 min TTL for orphan parked rows
	} catch (err) {
		console.warn(
			"[repo_commit_drain] failStuckParked error:",
			err instanceof Error ? err.message : String(err),
		);
	}

	let parked: RepoCommitRow[];
	try {
		parked = store.listParked(maxRows);
	} catch (err) {
		console.warn(
			"[repo_commit_drain] listParked error:",
			err instanceof Error ? err.message : String(err),
		);
		return;
	}

	// Eligible rows are those with an approvalRequestId to poll.
	const eligible = parked.filter((r) => r.approvalRequestId !== null);
	console.warn(
		`[repo_commit_drain] parked=${parked.length} eligible=${eligible.length}`,
	);

	// Parallel status poll for all eligible rows (read-only, safe to parallelize).
	const pollResults = await Promise.allSettled(
		eligible.map(async (row) => {
			// approvalRequestId is non-null: filtered above via `!== null`
			const approvalRequestId = row.approvalRequestId as string;
			const statusResult = await getStatus({ approvalRequestId, tediId });
			return { row, statusResult };
		}),
	);

	// Serialize the write operations (claim + execute + mark) for approved rows.
	for (const result of pollResults) {
		if (result.status === "rejected") {
			console.warn(
				"[repo_commit_drain] getStatus error:",
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason),
			);
			continue;
		}

		const { row, statusResult } = result.value;
		const { status } = statusResult;
		console.warn(
			`[repo_commit_drain] row=${row.id} status=${status} approvalId=${row.approvalRequestId}`,
		);

		if (status === "approved") {
			let claimed: RepoCommitRow | null = null;
			try {
				claimed = store.claimForExecution(row.id);
			} catch (err) {
				console.warn(
					`[repo_commit_drain] claimForExecution error for ${row.id}:`,
					err instanceof Error ? err.message : String(err),
				);
				continue;
			}

			if (!claimed) continue;

			let execResult: {
				ok: boolean;
				commitSha?: string;
				branchRef?: string;
				prUrl?: string;
				code?: string;
			};
			try {
				execResult = await executeRow(claimed);
			} catch (err) {
				console.warn(
					`[repo_commit_drain] executeRow threw for ${row.id}:`,
					err instanceof Error ? err.message : String(err),
				);
				try {
					store.markError(row.id, "executeRow threw unexpectedly");
				} catch {}
				continue;
			}

			if (execResult.ok && execResult.commitSha) {
				try {
					store.markCommitted(row.id, {
						commitSha: execResult.commitSha,
						prUrl: execResult.prUrl ?? null,
					});
				} catch (err) {
					console.warn(
						`[repo_commit_drain] markCommitted error for ${row.id}:`,
						err instanceof Error ? err.message : String(err),
					);
				}
			} else {
				const code = execResult.code ?? "execute_failed";
				try {
					store.markError(row.id, code);
				} catch (err) {
					console.warn(
						`[repo_commit_drain] markError error for ${row.id}:`,
						err instanceof Error ? err.message : String(err),
					);
				}
			}
		} else if (
			status === "rejected" ||
			status === "cancelled" ||
			status === "expired"
		) {
			try {
				store.markAbandoned(row.id);
			} catch (err) {
				console.warn(
					`[repo_commit_drain] markAbandoned error for ${row.id}:`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
		// "pending" → leave untouched
	}
}
