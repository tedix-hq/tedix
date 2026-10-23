import { DelegationBudgetSchema } from "@tedix/api-contract/schemas/kernel-runtime";

export interface DelegatedTurnBudget {
	maxToolCalls?: number;
	maxTokens?: number;
	maxUsd?: number;
	deadlineAt?: number;
}
type BudgetRecord = DelegatedTurnBudget & {
	calls: string[];
	inference?: Record<string, number>;
};
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

const TOOL_CALL_BUDGET_STOP = "delegated tool-call budget reached";

/** Only the tool-call cap leaves room for a tool-free closing answer. */
export function isDelegatedToolCallBudgetStop(
	reason: string | null | undefined,
): boolean {
	return reason?.startsWith(TOOL_CALL_BUDGET_STOP) === true;
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
		...(budget.maxTokens === undefined ? {} : { maxTokens: budget.maxTokens }),
		...(budget.maxUsd === undefined ? {} : { maxUsd: budget.maxUsd }),
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
		if (!budget) {
			if (await this.inspect(runId))
				throw new Error("Delegated budget removed from an existing run");
			return;
		}
		await this.storage.transaction(async (tx) => {
			const key = this.key(runId);
			const previous = await tx.get<BudgetRecord>(key);
			if (previous) {
				if (
					previous.maxToolCalls !== budget.maxToolCalls ||
					previous.maxTokens !== budget.maxTokens ||
					previous.maxUsd !== budget.maxUsd
				)
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
		const inferenceStop = this.inferenceStop(budget);
		if (inferenceStop) return inferenceStop;
		if (budget?.deadlineAt !== undefined && this.now() >= budget.deadlineAt)
			return "delegated wall-clock deadline reached";
		if (
			budget?.maxToolCalls !== undefined &&
			budget.calls.length >= budget.maxToolCalls
		)
			return `${TOOL_CALL_BUDGET_STOP} (${budget.calls.length}/${budget.maxToolCalls})`;
		return null;
	}
	private inferenceStop(budget: BudgetRecord | undefined): string | null {
		if (budget?.maxUsd !== undefined)
			return "delegated USD budget requires authoritative cost accounting; inference is withheld";
		if (
			budget?.maxTokens !== undefined &&
			Object.values(budget.inference ?? {}).reduce(
				(sum, tokens) => sum + tokens,
				0,
			) >= budget.maxTokens
		)
			return "delegated token budget reached";
		return null;
	}
	/** Keep reservations across interruption; unknown usage never replenishes capacity. */
	async reserveInference(
		runId: string,
		stepId: string,
		tokens: number,
	): Promise<void> {
		await this.storage.transaction(async (tx) => {
			const key = this.key(runId);
			const budget = await tx.get<BudgetRecord>(key);
			if (!budget) return;
			if (budget.maxUsd !== undefined)
				throw new Error(this.inferenceStop(budget)!);
			if (budget.maxTokens === undefined) return;
			if (!Number.isSafeInteger(tokens) || tokens <= 0)
				throw new Error("Invalid delegated inference reservation");
			const inference = budget.inference ?? {};
			if (stepId in inference) {
				if (inference[stepId] !== tokens)
					throw new Error("Delegated inference reservation changed");
				return;
			}
			if (
				Object.values(inference).reduce((sum, value) => sum + value, 0) +
					tokens >
				budget.maxTokens
			)
				throw new Error("delegated token budget would be exceeded");
			await tx.put(key, {
				...budget,
				inference: { ...inference, [stepId]: tokens },
			});
		});
	}

	async recordInferenceUsage(
		runId: string,
		stepId: string,
		tokens: number | null,
	): Promise<void> {
		if (tokens === null) return;
		if (!Number.isSafeInteger(tokens) || tokens < 0)
			throw new Error("Invalid delegated inference usage");
		await this.storage.transaction(async (tx) => {
			const key = this.key(runId);
			const budget = await tx.get<BudgetRecord>(key);
			if (budget?.maxTokens === undefined) return;
			const inference = budget.inference ?? {};
			if (!(stepId in inference))
				throw new Error("Delegated inference usage has no reservation");
			if (tokens <= inference[stepId]!) return;
			await tx.put(key, {
				...budget,
				inference: { ...inference, [stepId]: tokens },
			});
		});
	}

	async claim(runId: string, callId: string): Promise<string | null> {
		return this.storage.transaction(async (tx) => {
			const key = this.key(runId);
			const budget = await tx.get<BudgetRecord>(key);
			if (!budget) return null;
			const inferenceStop = this.inferenceStop(budget);
			if (inferenceStop) return inferenceStop;
			if (budget.deadlineAt !== undefined && this.now() >= budget.deadlineAt)
				return "delegated wall-clock deadline reached";
			if (budget.calls.includes(callId))
				return "delegated tool call already admitted; replay is fenced";
			if (
				budget.maxToolCalls !== undefined &&
				budget.calls.length >= budget.maxToolCalls
			)
				return `${TOOL_CALL_BUDGET_STOP} (${budget.calls.length}/${budget.maxToolCalls})`;
			await tx.put(key, { ...budget, calls: [...budget.calls, callId] });
			return null;
		});
	}
}
