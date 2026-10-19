import { DelegationBudgetSchema } from "@tedix/api-contract/schemas/kernel-runtime";

export interface DelegatedTurnBudget {
	maxToolCalls?: number;
	deadlineAt?: number;
}
type BudgetRecord = DelegatedTurnBudget & { calls: string[] };
type Storage = Pick<DurableObjectStorage, "get" | "put" | "transaction">;

/** Abort upstream transport and stop awaiting signal-unaware tools at the same deadline. */
export async function runWithDelegationDeadline<T>(
	deadlineAt: number | undefined,
	execute: (signal?: AbortSignal) => Promise<T>,
): Promise<T> {
	if (deadlineAt === undefined) return execute();
	const controller = new AbortController();
	const error = new Error("delegated wall-clock deadline reached");
	if (deadlineAt <= Date.now()) throw error;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort(error);
			reject(error);
		}, deadlineAt - Date.now());
	});
	try {
		return await Promise.race([execute(controller.signal), expired]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export function delegationBudgetForMetadata(
	metadata: Record<string, unknown> | null,
	startedAt: number,
): DelegatedTurnBudget | undefined {
	const order = metadata?.delegationWorkOrder;
	const nested =
		order && typeof order === "object"
			? (order as Record<string, unknown>).budget
			: undefined;
	const value = nested ?? metadata?.delegationBudget;
	if (value === undefined) return undefined;
	const budget = DelegationBudgetSchema.parse(value);
	return {
		...(budget.maxToolCalls === undefined
			? {}
			: { maxToolCalls: budget.maxToolCalls }),
		...(budget.deadlineMs === undefined
			? {}
			: { deadlineAt: startedAt + budget.deadlineMs }),
	};
}

/** Durable, atomic admission before effects. Reconfiguration never replenishes a run. */
export class DelegationBudgetGate {
	constructor(
		private readonly storage: Storage,
		private readonly now = Date.now,
	) {}
	private key(runId: string) {
		return `delegation-budget:${runId}`;
	}
	async enroll(
		runId: string,
		budget: DelegatedTurnBudget | undefined,
	): Promise<void> {
		if (!budget) return;
		await this.storage.transaction(async (tx) => {
			const key = this.key(runId);
			const previous = await tx.get<BudgetRecord>(key);
			if (previous) {
				if (previous.maxToolCalls !== budget.maxToolCalls)
					throw new Error("Delegated tool budget changed for an existing run");
				return;
			}
			await tx.put(key, { ...budget, calls: [] });
		});
	}
	async inspect(runId: string): Promise<BudgetRecord | undefined> {
		return this.storage.get<BudgetRecord>(this.key(runId));
	}
	async stopReason(runId: string): Promise<string | null> {
		const budget = await this.inspect(runId);
		if (budget?.deadlineAt !== undefined && this.now() >= budget.deadlineAt)
			return "delegated wall-clock deadline reached";
		if (
			budget?.maxToolCalls !== undefined &&
			budget.calls.length >= budget.maxToolCalls
		)
			return `delegated tool-call budget reached (${budget.calls.length}/${budget.maxToolCalls})`;
		return null;
	}
	async claim(runId: string, callId: string): Promise<string | null> {
		return this.storage.transaction(async (tx) => {
			const key = this.key(runId);
			const budget = await tx.get<BudgetRecord>(key);
			if (!budget) return null;
			if (budget.deadlineAt !== undefined && this.now() >= budget.deadlineAt)
				return "delegated wall-clock deadline reached";
			if (budget.calls.includes(callId))
				return "delegated tool call already admitted; replay is fenced";
			if (
				budget.maxToolCalls !== undefined &&
				budget.calls.length >= budget.maxToolCalls
			)
				return `delegated tool-call budget reached (${budget.calls.length}/${budget.maxToolCalls})`;
			await tx.put(key, { ...budget, calls: [...budget.calls, callId] });
			return null;
		});
	}
}
