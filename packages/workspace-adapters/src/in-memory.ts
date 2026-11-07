/**
 * In-memory implementations of the three adapters. They exist for tests and
 * for a workspace object before it has storage; the decision logic is the
 * shared `evaluateCall`, not something private to this file.
 */
import { evaluateCall, budgetForTier, type ApprovalState } from "./compliance";
import { hashValue } from "./hash";
import type {
	AccountabilityAdapter,
	Actor,
	BlastRadius,
	CallDescription,
	CallOutcome,
	ChangeRecord,
	ChangeRecordInput,
	ComplianceAdapter,
	ComplianceDecision,
	LedgerQuery,
	MemoryAdapter,
	MemoryEntry,
	MemoryProvenance,
	MemoryRevision,
	MemoryWriteInput,
	PolicyDisposition,
	RiskTier,
} from "./types";

export interface InMemoryToolPolicy {
	riskTier?: RiskTier;
	blastRadius?: BlastRadius;
	disposition?: PolicyDisposition;
	destructive?: boolean;
	/** Scopes the caller must hold; checked against `callerScopes`. */
	requiredScopes?: string[];
}

export interface InMemoryComplianceOptions {
	/** Policy per `resource` (e.g. `tool:delete_app`). */
	policies?: Record<string, InMemoryToolPolicy>;
	/** Scopes the calling identity holds. */
	callerScopes?: string[];
	/** Approval receipts that are valid, by request id. */
	approvedRequestIds?: Set<string>;
	/** Request ids an approver refused. */
	deniedRequestIds?: Set<string>;
	/** Rate-limit window key -> calls made; shared across actors in tests. */
	now?: () => number;
}

export class InMemoryComplianceAdapter implements ComplianceAdapter {
	readonly outcomes: Array<{
		call: CallDescription;
		decision: ComplianceDecision;
		outcome: CallOutcome;
	}> = [];
	private readonly windows = new Map<string, number[]>();
	constructor(private readonly options: InMemoryComplianceOptions = {}) {}

	private approvalFor(
		call: CallDescription,
		policy: InMemoryToolPolicy,
	): ApprovalState {
		const asks =
			policy.disposition === "ask" || policy.destructive || call.destructive;
		if (!asks) return "not_required";
		if (call.approvalRequestId) {
			if (this.options.deniedRequestIds?.has(call.approvalRequestId))
				return "denied";
			if (this.options.approvedRequestIds?.has(call.approvalRequestId))
				return "granted";
		}
		return "pending";
	}

	async check(call: CallDescription): Promise<ComplianceDecision> {
		const policy = this.options.policies?.[call.resource] ?? {};
		const riskTier = call.riskTier ?? policy.riskTier;
		const scopeDenied =
			!!policy.requiredScopes?.length &&
			!policy.requiredScopes.every((s) =>
				this.options.callerScopes?.includes(s),
			);
		const budget = budgetForTier(riskTier);
		let rate: ComplianceDecision["rate"] | undefined;
		if (budget) {
			const key = [
				call.actor.organizationId ?? "",
				call.actor.id,
				call.resource,
			].join(":");
			const now = (this.options.now ?? Date.now)();
			const window = (this.windows.get(key) ?? []).filter(
				(t) => now - t < budget.windowSeconds * 1000,
			);
			const limited = window.length >= budget.limit;
			if (!limited) window.push(now);
			this.windows.set(key, window);
			rate = {
				limited,
				scope: "organization_caller_app_tool",
				...(limited ? { retryAfterSeconds: budget.windowSeconds } : {}),
			};
		}
		return evaluateCall({
			riskTier,
			blastRadius: call.blastRadius ?? policy.blastRadius,
			disposition: policy.disposition,
			destructive: call.destructive ?? policy.destructive,
			scopeDenied,
			rate,
			approval: this.approvalFor(call, policy),
		});
	}

	async record(
		call: CallDescription,
		decision: ComplianceDecision,
		outcome: CallOutcome,
	): Promise<void> {
		this.outcomes.push({ call, decision, outcome });
	}
}

export class InMemoryAccountabilityAdapter implements AccountabilityAdapter {
	private readonly records: ChangeRecord[] = [];
	constructor(private readonly now: () => Date = () => new Date()) {}

	async append(input: ChangeRecordInput): Promise<ChangeRecord> {
		const sequence = this.records.length + 1;
		const record: ChangeRecord = Object.freeze({
			...structuredClone(input),
			id: `chg_${sequence.toString().padStart(8, "0")}`,
			sequence,
			recordedAt: this.now().toISOString(),
		});
		this.records.push(record);
		return record;
	}
	async list(query: LedgerQuery = {}): Promise<ChangeRecord[]> {
		return this.records
			.filter(
				(r) =>
					(!query.resource || r.resource === query.resource) &&
					(!query.actorId || r.actor.id === query.actorId) &&
					(query.afterSequence === undefined ||
						r.sequence > query.afterSequence),
			)
			.slice(0, query.limit ?? this.records.length);
	}
	async get(id: string): Promise<ChangeRecord | null> {
		return this.records.find((r) => r.id === id) ?? null;
	}
	async export(): Promise<{ exportedAt: string; records: ChangeRecord[] }> {
		return { exportedAt: this.now().toISOString(), records: [...this.records] };
	}
}

export class InMemoryMemoryAdapter implements MemoryAdapter {
	private readonly revisions = new Map<string, MemoryRevision[]>();
	private counter = 0;
	constructor(private readonly now: () => Date = () => new Date()) {}

	private async push(
		key: string,
		value: unknown,
		provenance: MemoryProvenance,
		review: MemoryReviewState,
		rolledBackFrom?: string,
	): Promise<MemoryRevision> {
		const history = this.revisions.get(key) ?? [];
		const revision: MemoryRevision = {
			revisionId: `mem_${(++this.counter).toString().padStart(8, "0")}`,
			key,
			revision: history.length + 1,
			value: structuredClone(value),
			hash: await hashValue(value),
			writtenAt: this.now().toISOString(),
			provenance: structuredClone(provenance),
			review,
			...(rolledBackFrom ? { rolledBackFrom } : {}),
		};
		history.push(revision);
		this.revisions.set(key, history);
		return revision;
	}

	write(input: MemoryWriteInput): Promise<MemoryRevision> {
		return this.push(
			input.key,
			input.value,
			input.provenance,
			input.review ?? "pending",
		);
	}
	private entry(key: string): MemoryEntry | null {
		const history = this.revisions.get(key);
		if (!history?.length) return null;
		const current = history[history.length - 1]!;
		const approved = [...history]
			.reverse()
			.find((r) => r.review === "approved");
		return { key, current, ...(approved ? { approved } : {}) };
	}
	async read(key: string): Promise<MemoryEntry | null> {
		return this.entry(key);
	}
	async list(prefix = ""): Promise<MemoryEntry[]> {
		return [...this.revisions.keys()]
			.filter((k) => k.startsWith(prefix))
			.sort()
			.map((k) => this.entry(k)!)
			.filter(Boolean);
	}
	async history(key: string): Promise<MemoryRevision[]> {
		return [...(this.revisions.get(key) ?? [])];
	}
	private find(revisionId: string): MemoryRevision | undefined {
		for (const history of this.revisions.values()) {
			const hit = history.find((r) => r.revisionId === revisionId);
			if (hit) return hit;
		}
		return undefined;
	}
	async review(
		revisionId: string,
		decision: "approve" | "reject",
		reviewer: Actor,
		note?: string,
	): Promise<MemoryRevision> {
		const revision = this.find(revisionId);
		if (!revision) throw new Error(`Unknown memory revision ${revisionId}`);
		if (revision.review !== "pending") {
			throw new Error(`Revision ${revisionId} was already ${revision.review}`);
		}
		revision.review = decision === "approve" ? "approved" : "rejected";
		revision.reviewedBy = reviewer.id;
		revision.reviewedAt = this.now().toISOString();
		if (note) revision.reviewNote = note;
		return revision;
	}
	async rollback(
		key: string,
		toRevisionId: string,
		provenance: MemoryProvenance,
	): Promise<MemoryRevision> {
		const target = (this.revisions.get(key) ?? []).find(
			(r) => r.revisionId === toRevisionId,
		);
		if (!target)
			throw new Error(`Revision ${toRevisionId} is not a revision of ${key}`);
		return this.push(
			key,
			target.value,
			provenance,
			target.review === "approved" ? "approved" : "pending",
			toRevisionId,
		);
	}
}

type MemoryReviewState = MemoryRevision["review"];

export function createInMemoryAdapters(
	options: InMemoryComplianceOptions = {},
) {
	return {
		memory: new InMemoryMemoryAdapter(),
		accountability: new InMemoryAccountabilityAdapter(),
		compliance: new InMemoryComplianceAdapter(options),
	};
}
