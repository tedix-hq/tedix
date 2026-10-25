/** Safety bound for durable root turns, including context assembly and settlement. */
export const MAX_ACTIVE_DURABLE_TURNS = 2;

export function turnRetryDelaySeconds(runId: string): number {
	let hash = 2166136261;
	for (let i = 0; i < runId.length; i++)
		hash = Math.imul(hash ^ runId.charCodeAt(i), 16777619);
	return 15 + ((hash >>> 0) % 16);
}

export interface DeferredFacetTurn {
	text: "";
	stopReason: "turn_deferred";
	toolCalls: [];
	retryAfterSeconds: number;
}

/** Never queue a promise in the DO: the caller must release its Workflow step. */
export class FacetTurnAdmission {
	private readonly active = new Set<string>();

	constructor(private readonly limit = MAX_ACTIVE_DURABLE_TURNS) {
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("Invalid active turn limit");
	}

	async run<T>(
		runId: string,
		turn: () => Promise<T>,
	): Promise<T | DeferredFacetTurn> {
		if (this.active.has(runId) || this.active.size >= this.limit)
			return {
				text: "",
				stopReason: "turn_deferred",
				toolCalls: [],
				retryAfterSeconds: turnRetryDelaySeconds(runId),
			};
		// Claim synchronously before context, tool or facet allocation. Work lease
		// renewal is outside this gate so queued delegated turns retain authority.
		this.active.add(runId);
		try {
			return await turn();
		} finally {
			this.active.delete(runId);
		}
	}
}
