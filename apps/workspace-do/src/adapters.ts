/**
 * The three shared adapters, bound to this workspace object's own SQLite.
 * Compliance applies the shared `evaluateCall` rules; the change record is
 * append-only in the object; memory writes are revisions with provenance.
 */
import {
	type ApprovalState,
	evaluateCall,
} from "@tedix/agent-governance/compliance";
import { hashValue } from "@tedix/agent-governance/hash";
import type {
	AccountabilityAdapter,
	CallDescription,
	CallOutcome,
	ChangeRecord,
	ChangeRecordInput,
	ComplianceAdapter,
	ComplianceDecision,
	LedgerQuery,
} from "@tedix/agent-governance/types";
import type { WorkspaceStorage } from "./runtime";

export const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS change_records (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT,
	id TEXT NOT NULL UNIQUE,
	recorded_at TEXT NOT NULL,
	resource TEXT NOT NULL,
	operation TEXT NOT NULL,
	actor_id TEXT NOT NULL,
	outcome TEXT NOT NULL,
	record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_records_resource ON change_records(resource, sequence);
CREATE TABLE IF NOT EXISTS approval_receipts (
	request_id TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	resource TEXT NOT NULL,
	operation TEXT NOT NULL,
	args_hash TEXT NOT NULL,
	consumed INTEGER NOT NULL DEFAULT 0,
	decided_by TEXT,
	decided_at TEXT
);
CREATE INDEX IF NOT EXISTS approval_receipts_call ON approval_receipts(resource, operation, args_hash);
`;

interface LedgerRow {
	sequence: number;
	id: string;
	recorded_at: string;
	record: string;
}

export class SqlAccountabilityAdapter implements AccountabilityAdapter {
	constructor(private readonly storage: WorkspaceStorage) {
		storage.run(LEDGER_SCHEMA);
	}

	async append(input: ChangeRecordInput): Promise<ChangeRecord> {
		const id = crypto.randomUUID();
		const recordedAt = new Date().toISOString();
		const partial = { ...input, id, recordedAt };
		const [row] = this.storage.exec<LedgerRow>(
			"INSERT INTO change_records (id, recorded_at, resource, operation, actor_id, outcome, record) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING sequence, id, recorded_at, record",
			id,
			recordedAt,
			input.resource,
			input.operation,
			input.actor.id,
			input.outcome,
			JSON.stringify(partial),
		);
		if (!row) throw new Error("change record insert returned no row");
		const record: ChangeRecord = { ...partial, sequence: row.sequence };
		this.storage.run(
			"UPDATE change_records SET record = ? WHERE sequence = ?",
			JSON.stringify(record),
			row.sequence,
		);
		return record;
	}

	async list(query: LedgerQuery = {}): Promise<ChangeRecord[]> {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (query.resource) {
			conditions.push("resource = ?");
			params.push(query.resource);
		}
		if (query.actorId) {
			conditions.push("actor_id = ?");
			params.push(query.actorId);
		}
		if (query.afterSequence !== undefined) {
			conditions.push("sequence > ?");
			params.push(query.afterSequence);
		}
		const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = Math.min(Math.max(query.limit ?? 100, 1), 1_000);
		return this.storage
			.exec<LedgerRow>(
				`SELECT sequence, id, recorded_at, record FROM change_records ${where} ORDER BY sequence ASC LIMIT ?`,
				...params,
				limit,
			)
			.map((row) => JSON.parse(row.record) as ChangeRecord);
	}

	async get(id: string): Promise<ChangeRecord | null> {
		const [row] = this.storage.exec<LedgerRow>(
			"SELECT sequence, id, recorded_at, record FROM change_records WHERE id = ?",
			id,
		);
		return row ? (JSON.parse(row.record) as ChangeRecord) : null;
	}

	async export() {
		return {
			exportedAt: new Date().toISOString(),
			records: await this.list({ limit: 1_000 }),
		};
	}
}

export interface WorkspacePolicy {
	/** Writes by this actor kind need a human approval receipt. */
	writesNeedApproval: boolean;
}

/**
 * Compliance for in-object calls. Reads always pass. A write passes when the
 * workspace policy allows it for this actor or the call carries an approval
 * receipt this object has recorded as granted; otherwise it holds for a
 * human. Decisions and outcomes are kept beside the change records.
 */
export class SqlComplianceAdapter implements ComplianceAdapter {
	constructor(
		private readonly storage: WorkspaceStorage,
		private readonly policy: WorkspacePolicy,
	) {
		storage.run(LEDGER_SCHEMA);
	}

	/**
	 * A receipt covers exactly one call: same resource, operation and
	 * argument hash as the held call, and not yet consumed by a run.
	 */
	private async receiptFor(call: CallDescription) {
		const argsHash = await hashValue(call.args);
		const [row] = this.storage.exec<{ request_id: string; state: string }>(
			"SELECT request_id, state FROM approval_receipts WHERE resource = ? AND operation = ? AND args_hash = ? AND consumed = 0 ORDER BY decided_at DESC LIMIT 1",
			call.resource,
			call.operation,
			argsHash,
		);
		return row;
	}

	private async approvalState(call: CallDescription): Promise<ApprovalState> {
		if (!call.riskTier || call.riskTier === "read") return "not_required";
		if (!this.policy.writesNeedApproval && !call.destructive)
			return "not_required";
		const receipt = await this.receiptFor(call);
		if (receipt?.state === "approved") return "granted";
		if (receipt?.state === "denied") return "denied";
		return "pending";
	}

	async check(call: CallDescription): Promise<ComplianceDecision> {
		return evaluateCall({
			riskTier: call.riskTier,
			blastRadius: call.blastRadius,
			destructive: call.destructive,
			approval: await this.approvalState(call),
		});
	}

	async record(
		call: CallDescription,
		decision: ComplianceDecision,
		outcome: CallOutcome,
	): Promise<void> {
		// A granted receipt is spent by the run it covered, applied or not.
		if (decision.verdict !== "allow" || outcome.status === "not_applied")
			return;
		const receipt = await this.receiptFor(call);
		if (receipt?.state === "approved") {
			this.storage.run(
				"UPDATE approval_receipts SET consumed = 1 WHERE request_id = ?",
				receipt.request_id,
			);
		}
	}

	recordApproval(
		requestId: string,
		state: "approved" | "denied",
		by: string,
		call: { resource: string; operation: string; argsHash: string },
	) {
		this.storage.run(
			"INSERT OR REPLACE INTO approval_receipts (request_id, state, resource, operation, args_hash, consumed, decided_by, decided_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
			requestId,
			state,
			call.resource,
			call.operation,
			call.argsHash,
			by,
			new Date().toISOString(),
		);
	}
}
