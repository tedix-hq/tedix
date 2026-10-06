/**
 * DO-local durable store for Code Mode execution audit and approval parking.
 *
 * Records every `execute` tool call in `cm_executions` (DO-SQLite) with a
 * risk tier and status lifecycle. Every attempt — parked or run — lands a row
 * so the operator always has an audit trail.
 *
 * Risk classification: arbitrary model-supplied JS against the live DO-SQLite
 * workspace is always HIGH. Policy-tier auto-approve cannot carry a HIGH-risk
 * write — only an operator approval (or an explicit session pre-authorization).
 *
 * Approval bridge: a parked row links to a kernel approval card
 * (`tediApprovalRequests` in apps/api) via `approval_request_id`. On approval,
 * the DO's `drainPendingCodemodeExecutions` authorizes one exact code replay
 * (`CmSessionGate`) and marks the row `replay_authorized`; the model re-issues
 * the same `execute` code, which consumes the one-shot grant and runs inline.
 * The parked code is never re-run here.
 *
 * Follow-on: TTL eviction on old rows.
 */

import type { DoSqlRunner } from "./brain-bridge-do";

export type CmExecutionStatus =
	| "parked"
	| "authorized_ran"
	| "rejected"
	| "error"
	// Parked row whose kernel approval card resolved `approved`: the drain
	// authorized one replay of the exact code hash, and the model re-issues
	// `execute` (which then runs inline). The parked code itself is never re-run.
	| "replay_authorized"
	// Historic rows before exact replay grants used session_authorized.
	| "session_authorized"
	// Parked row whose card was rejected / cancelled / expired.
	| "abandoned";

export type CmRiskTier = "HIGH";

export type CmResolvedBy = "policy" | "operator";

export interface CmExecution {
	id: string;
	session_id: string;
	code_hash: string;
	risk_tier: CmRiskTier;
	status: CmExecutionStatus;
	created_at: number;
	resolved_at: number | null;
	result: string | null;
	error: string | null;
	resolved_by: CmResolvedBy | null;
	/** Kernel approval ledger row id (tediApprovalRequests) once proposed. */
	approval_request_id: string | null;
}

export interface CmExecutionInsert {
	id: string;
	sessionId: string;
	codeHash: string;
	resolvedBy?: CmResolvedBy;
}

export interface CmExecutionResolve {
	id: string;
	status: "authorized_ran" | "error";
	resolvedBy: CmResolvedBy;
	result?: unknown;
	error?: string;
}

/** Simple SHA-256 hex of UTF-8 code (platform-neutral). */
export async function hashCode(code: string): Promise<string> {
	const bytes = new TextEncoder().encode(code);
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export class CmExecutionStore {
	private readonly runner: DoSqlRunner;
	private schemaReady = false;

	constructor(runner: DoSqlRunner) {
		this.runner = runner;
	}

	ensureSchema(): void {
		if (this.schemaReady) return;
		this.runner.sql`
			CREATE TABLE IF NOT EXISTS cm_executions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				code_hash TEXT NOT NULL,
				risk_tier TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				resolved_at INTEGER,
				result TEXT,
				error TEXT,
				resolved_by TEXT,
				approval_request_id TEXT
			)
		`;
		// Additive migration for DOs created before the approval bridge: ALTER
		// is a no-op error if the column already exists, so swallow it.
		try {
			this.runner
				.sql`ALTER TABLE cm_executions ADD COLUMN approval_request_id TEXT`;
		} catch {
			// column already present
		}
		this.schemaReady = true;
	}

	/** Record a new parked execution — session not authorized. */
	park(input: CmExecutionInsert): CmExecution {
		this.ensureSchema();
		const now = Date.now();
		const row: CmExecution = {
			id: input.id,
			session_id: input.sessionId,
			code_hash: input.codeHash,
			risk_tier: "HIGH",
			status: "parked",
			created_at: now,
			resolved_at: null,
			result: null,
			error: null,
			resolved_by: null,
			approval_request_id: null,
		};
		this.runner.sql`
			INSERT INTO cm_executions
				(id, session_id, code_hash, risk_tier, status, created_at,
				 resolved_at, result, error, resolved_by, approval_request_id)
			VALUES
				(${row.id}, ${row.session_id}, ${row.code_hash}, ${row.risk_tier},
				 ${row.status}, ${row.created_at}, ${null}, ${null}, ${null}, ${null},
				 ${null})
		`;
		return row;
	}

	/** Record an authorized execution row BEFORE running. */
	markAuthorizedPre(input: CmExecutionInsert): CmExecution {
		this.ensureSchema();
		const now = Date.now();
		const row: CmExecution = {
			id: input.id,
			session_id: input.sessionId,
			code_hash: input.codeHash,
			risk_tier: "HIGH",
			status: "authorized_ran",
			created_at: now,
			resolved_at: null,
			result: null,
			error: null,
			resolved_by: input.resolvedBy ?? "policy",
			approval_request_id: null,
		};
		this.runner.sql`
			INSERT INTO cm_executions
				(id, session_id, code_hash, risk_tier, status, created_at,
				 resolved_at, result, error, resolved_by, approval_request_id)
			VALUES
				(${row.id}, ${row.session_id}, ${row.code_hash}, ${row.risk_tier},
				 ${row.status}, ${row.created_at}, ${null}, ${null}, ${null},
				 ${row.resolved_by}, ${null})
		`;
		return row;
	}

	/** Update result/error after execution completes. */
	resolve(input: CmExecutionResolve): void {
		this.ensureSchema();
		const now = Date.now();
		const resultText =
			input.result !== undefined ? JSON.stringify(input.result) : null;
		this.runner.sql`
			UPDATE cm_executions
			SET status = ${input.status},
			    resolved_at = ${now},
			    result = ${resultText},
			    error = ${input.error ?? null},
			    resolved_by = ${input.resolvedBy}
			WHERE id = ${input.id}
		`;
	}

	/** Fetch a single row by id. Returns null when not found. */
	get(id: string): CmExecution | null {
		this.ensureSchema();
		const rows = this.runner.sql<CmExecution>`
			SELECT id, session_id, code_hash, risk_tier, status, created_at,
			       resolved_at, result, error, resolved_by, approval_request_id
			FROM cm_executions
			WHERE id = ${id}
			LIMIT 1
		`;
		return rows[0] ?? null;
	}

	/** Link a parked row to its kernel approval ledger card (tediApprovalRequests). */
	updateApprovalId(id: string, approvalRequestId: string): void {
		this.ensureSchema();
		this.runner.sql`
			UPDATE cm_executions
			SET approval_request_id = ${approvalRequestId}
			WHERE id = ${id}
		`;
	}

	/**
	 * Parked rows that have an approval card linked — the drain set. Newest first.
	 */
	listParked(limit = 10): CmExecution[] {
		this.ensureSchema();
		return this.runner.sql<CmExecution>`
			SELECT id, session_id, code_hash, risk_tier, status, created_at,
			       resolved_at, result, error, resolved_by, approval_request_id
			FROM cm_executions
			WHERE status = ${"parked"} AND approval_request_id IS NOT NULL
			ORDER BY created_at DESC
			LIMIT ${limit}
		`;
	}

	/**
	 * Settle a parked row after its card was `approved`: one exact code-hash
	 * replay is now authorized. The parked code itself is not re-run.
	 */
	markReplayAuthorized(
		id: string,
		resolvedBy: CmResolvedBy = "operator",
	): void {
		this.ensureSchema();
		this.runner.sql`
			UPDATE cm_executions
			SET status = ${"replay_authorized"},
			    resolved_at = ${Date.now()},
			    resolved_by = ${resolvedBy}
			WHERE id = ${id} AND status = ${"parked"}
		`;
	}

	/** Settle a parked row whose card was rejected / cancelled / expired. */
	markAbandoned(id: string, reason?: string): void {
		this.ensureSchema();
		this.runner.sql`
			UPDATE cm_executions
			SET status = ${"abandoned"},
			    resolved_at = ${Date.now()},
			    resolved_by = ${"operator"},
			    error = ${reason ?? null}
			WHERE id = ${id} AND status = ${"parked"}
		`;
	}
}

export type { DoSqlRunner };
