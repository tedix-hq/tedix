import {
	HOLDS,
	type ActionClass,
	type Hold,
} from "@tedix/api-contract/utils/approval-holds";
/**
 * Compliance and accountability bound to the workspace object's SQLite.
 * Compliance applies the shared `evaluateCall` rules; change records are
 * append-only. Memory revisions live in `memory-adapter.ts`.
 */
import {
	type ApprovalState,
	evaluateCall,
} from "@tedix/agent-governance/compliance";
import { hashValue } from "@tedix/agent-governance/hash";
import { chainHash, recordDigest } from "@tedix/agent-governance/seal";
import {
	type AccountabilityAdapter,
	type CallDescription,
	type CallOutcome,
	CHANGE_RECORD_SCHEMA_VERSION,
	type ChangeEnvironment,
	type ChangeRecord,
	type ChangeRecordInput,
	type ComplianceAdapter,
	type ComplianceDecision,
	type LedgerQuery,
} from "@tedix/agent-governance/types";
import type { ApprovalMode } from "@tedix/api-contract/schemas/workspace-agent-access";
import { actionClass, STAGED_REASON, stagesCall } from "./approval-modes";
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

export interface ChangeRecordQuery extends LedgerQuery {
	from?: string;
	until?: string;
}

interface LedgerRow {
	sequence: number;
	id: string;
	recorded_at: string;
	record: string;
	record_digest: string | null;
	chain_hash: string | null;
}

/** A record as `list` returns it: content plus the seal fields. */
export type SealedChangeRecord = ChangeRecord & {
	recordDigest: string | null;
	chainHash: string | null;
};

function sealedRecord(row: LedgerRow): SealedChangeRecord {
	return {
		...(JSON.parse(row.record) as ChangeRecord),
		recordDigest: row.record_digest,
		chainHash: row.chain_hash,
	};
}

/**
 * The workspace's change ledger. Records use the same contract and the same
 * digest and chain hash as the gateway ledger (`@tedix/agent-governance/seal`),
 * so an export verifies with `verifyChain`. A workspace object has one
 * writer, so each record is chained as it is appended; there are no
 * checkpoints here (`verifyChain` reports the records as uncheckpointed).
 * Records written before chaining existed are chained, oldest first, by the
 * next append.
 */
export class SqlAccountabilityAdapter implements AccountabilityAdapter {
	#tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly storage: WorkspaceStorage,
		private readonly environment: ChangeEnvironment = {},
	) {
		storage.run(LEDGER_SCHEMA);
		const columns = new Set(
			storage
				.exec<{ name: string }>("PRAGMA table_info(change_records)")
				.map((column) => column.name),
		);
		if (!columns.has("record_digest"))
			storage.run("ALTER TABLE change_records ADD COLUMN record_digest TEXT");
		if (!columns.has("chain_hash"))
			storage.run("ALTER TABLE change_records ADD COLUMN chain_hash TEXT");
	}

	/** Appends run one at a time: each record chains to the one before it. */
	append(input: ChangeRecordInput): Promise<ChangeRecord> {
		const next = this.#tail.then(() => this.#append(input));
		this.#tail = next.catch(() => undefined);
		return next;
	}

	/** Chain every record not chained yet, in sequence order. */
	async #sealBacklog(): Promise<void> {
		const [last] = this.storage.exec<{ chain_hash: string }>(
			"SELECT chain_hash FROM change_records WHERE chain_hash IS NOT NULL ORDER BY sequence DESC LIMIT 1",
		);
		let previous = last?.chain_hash ?? null;
		const rows = this.storage.exec<LedgerRow>(
			"SELECT sequence, id, recorded_at, record, record_digest, chain_hash FROM change_records WHERE chain_hash IS NULL ORDER BY sequence ASC",
		);
		for (const row of rows) {
			const digest = await recordDigest(
				JSON.parse(row.record) as Record<string, unknown>,
			);
			const link = await chainHash(previous, row.sequence, digest);
			this.storage.run(
				"UPDATE change_records SET record_digest = ?, chain_hash = ? WHERE sequence = ? AND chain_hash IS NULL",
				digest,
				link,
				row.sequence,
			);
			previous = link;
		}
	}

	async #append(input: ChangeRecordInput): Promise<ChangeRecord> {
		const id = crypto.randomUUID();
		const recordedAt = new Date().toISOString();
		const environment = { ...this.environment, ...input.environment };
		const partial = {
			schemaVersion: CHANGE_RECORD_SCHEMA_VERSION,
			...input,
			...(Object.keys(environment).length ? { environment } : {}),
			id,
			recordedAt,
		};
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
		await this.#sealBacklog();
		return record;
	}

	async list(query: ChangeRecordQuery = {}): Promise<SealedChangeRecord[]> {
		const conditions: string[] = [];
		const params: unknown[] = [];
		if (query.from !== undefined) {
			conditions.push("recorded_at >= ?");
			params.push(query.from);
		}
		if (query.until !== undefined) {
			conditions.push("recorded_at < ?");
			params.push(query.until);
		}
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
				`SELECT sequence, id, recorded_at, record, record_digest, chain_hash FROM change_records ${where} ORDER BY sequence ASC LIMIT ?`,
				...params,
				limit,
			)
			.map(sealedRecord);
	}

	countRange(from: string, until: string): number {
		return this.storage.exec<{ count: number }>(
			"SELECT COUNT(*) AS count FROM change_records WHERE recorded_at >= ? AND recorded_at < ?",
			from,
			until,
		)[0]!.count;
	}

	async get(id: string): Promise<SealedChangeRecord | null> {
		const [row] = this.storage.exec<LedgerRow>(
			"SELECT sequence, id, recorded_at, record, record_digest, chain_hash FROM change_records WHERE id = ?",
			id,
		);
		return row ? sealedRecord(row) : null;
	}

	async export() {
		return {
			exportedAt: new Date().toISOString(),
			records: await this.list({ limit: 1_000 }),
		};
	}
}

/** The decision reason of a call the Read only mode refused. */
export const READ_ONLY_REASON = "read_only_mode";

/** What one turn's approval mode needs to decide a call. */
export interface TurnHolds {
	mode: ApprovalMode;
	/** Other people can open the workspace, so reading a computer asks. */
	computerReadsHeld: boolean;
	/** "Approve all like this" covers this gate and class in this turn. */
	approvedAll: (resource: string, cls: ActionClass) => boolean;
	/** A signed-in person sent the turn themself: a held file or Work write stages. */
	personSent?: boolean;
}

function holdFor(
	call: CallDescription,
	holds: TurnHolds,
): Hold | "granted" | "stage" {
	const cls = actionClass({
		...call,
		args: Array.isArray(call.args) ? call.args : [call.args],
		organizationId: call.actor.organizationId,
	});
	// A plain read never waits; only a gate that holds one does.
	const plainRead = !call.riskTier || call.riskTier === "read";
	if (cls === "read" && plainRead) return "run";
	if (cls === "computer_read" && !holds.computerReadsHeld) return "run";
	const hold = HOLDS[cls][holds.mode];
	if (hold !== "ask") return hold;
	if (
		stagesCall({
			resource: call.resource,
			operation: call.operation,
			args: Array.isArray(call.args) ? call.args : [call.args],
			cls,
			mode: holds.mode,
			personSent: holds.personSent === true,
		})
	)
		return "stage";
	return holds.approvedAll(call.resource, cls) ? "granted" : "ask";
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

	private async approvalState(
		call: CallDescription,
		holds?: TurnHolds,
	): Promise<{ state: ApprovalState; reason?: string }> {
		const hold = holds ? holdFor(call, holds) : null;
		if (hold === "run") return { state: "not_required" };
		if (hold === "granted")
			return { state: "granted", reason: "approved_for_this_turn" };
		if (hold === "stage") {
			// Accepting a staged change runs its call once with the receipt.
			const receipt = await this.receiptFor(call);
			if (receipt?.state === "approved") return { state: "granted" };
			if (receipt?.state === "denied") return { state: "denied" };
			return { state: "pending", reason: STAGED_REASON };
		}
		if (hold === "refuse") {
			// A decision the person made on a card before still counts.
			const receipt = await this.receiptFor(call);
			return receipt?.state === "approved"
				? { state: "granted" }
				: { state: "denied", reason: READ_ONLY_REASON };
		}
		// The account adapter queues the exact call in the canonical connection
		// approval service. Read only was refused above; no local receipt grants it.
		if (call.resource === "connected_account" && call.operation === "write")
			return { state: "not_required" };
		// A read the mode asks for goes straight to the person's receipt.
		const askedRead =
			hold === "ask" && (!call.riskTier || call.riskTier === "read");
		if (!askedRead) {
			// File tools only stage a proposal. Publishing still requires the draft decision.
			if (
				call.resource === "app_draft" &&
				["editFile", "writeFile", "restoreVersion"].includes(call.operation) &&
				call.riskTier === "bounded_write" &&
				!call.destructive
			)
				return { state: "not_required" };
			// These chat methods check the initiating person's current build access.
			// Steering also checks ownership of the run before sending anything.
			if (
				call.resource === "work" &&
				["startRun", "sendRunMessage", "stopRun"].includes(call.operation) &&
				call.riskTier === "bounded_write" &&
				call.blastRadius === "single_resource" &&
				!call.destructive
			)
				return { state: "not_required" };
			if (!call.riskTier || call.riskTier === "read")
				return { state: "not_required" };
			if (!this.policy.writesNeedApproval && !call.destructive)
				return { state: "not_required" };
		}
		const receipt = await this.receiptFor(call);
		if (receipt?.state === "approved") return { state: "granted" };
		if (receipt?.state === "denied") return { state: "denied" };
		return { state: "pending" };
	}

	/** The same gate, with one turn's approval mode applied to every call. */
	under(holds: TurnHolds): ComplianceAdapter {
		return {
			check: (call) => this.check(call, holds),
			record: (call, decision, outcome) => this.record(call, decision, outcome),
		};
	}

	async check(
		call: CallDescription,
		holds?: TurnHolds,
	): Promise<ComplianceDecision> {
		const approval = await this.approvalState(call, holds);
		return evaluateCall({
			riskTier: call.riskTier,
			blastRadius: call.blastRadius,
			destructive: call.destructive,
			approval: approval.state,
			...(approval.reason ? { approvalReason: approval.reason } : {}),
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
