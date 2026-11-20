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

/** A waiting person's turn asks again this often. */
export const PERSON_TURN_RETRY_SECONDS = 10;
/** A person's turn that stopped asking no longer holds a slot back. */
const PERSON_WAIT_FRESH_MS = 45_000;

/** Never queue a promise in the DO: the caller must release its Workflow step. */
export class FacetTurnAdmission {
	private readonly active = new Set<string>();
	/** Deferred turns a signed-in person started, by the time they last asked. */
	private readonly waitingPeople = new Map<string, number>();

	constructor(
		private readonly limit = MAX_ACTIVE_DURABLE_TURNS,
		private readonly now: () => number = Date.now,
	) {
		if (!Number.isSafeInteger(limit) || limit < 1)
			throw new Error("Invalid active turn limit");
	}

	/**
	 * `person` marks a turn a signed-in person started from the chat. While one
	 * waits, a freed slot is kept for it: scheduled and other background turns
	 * stay deferred until it has been admitted or has stopped asking.
	 */
	async run<T>(
		runId: string,
		turn: () => Promise<T>,
		options: { person?: boolean } = {},
	): Promise<T | DeferredFacetTurn> {
		const person = options.person === true;
		if (
			this.active.has(runId) ||
			this.active.size >= this.limit ||
			(!person && this.personWaiting())
		) {
			if (person && !this.active.has(runId))
				this.waitingPeople.set(runId, this.now());
			return {
				text: "",
				stopReason: "turn_deferred",
				toolCalls: [],
				retryAfterSeconds: person
					? PERSON_TURN_RETRY_SECONDS
					: turnRetryDelaySeconds(runId),
			};
		}
		// Claim synchronously before context, tool or facet allocation. Work lease
		// renewal is outside this gate so queued delegated turns retain authority.
		this.active.add(runId);
		this.waitingPeople.delete(runId);
		try {
			return await turn();
		} finally {
			this.active.delete(runId);
		}
	}

	private personWaiting(): boolean {
		const staleBefore = this.now() - PERSON_WAIT_FRESH_MS;
		for (const [runId, askedAt] of this.waitingPeople)
			if (askedAt < staleBefore) this.waitingPeople.delete(runId);
		return this.waitingPeople.size > 0;
	}
}
