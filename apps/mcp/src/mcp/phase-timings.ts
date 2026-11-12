type Phase =
	| "auth"
	| "policy"
	| "catalogResolution"
	| "handler"
	| "persistence";

/** Server-owned request state; never read timing values from caller headers. */
const requests = new WeakMap<object, PhaseTimings>();

/** Handler time includes upstream storage. Persistence measures gateway payment
 * settlement; detached waitUntil work is excluded. Unobserved phases are null. */
class PhaseTimings {
	readonly startedAt = performance.now();
	readonly phases: Record<Phase, number | null> = {
		auth: null,
		policy: null,
		catalogResolution: null,
		handler: null,
		persistence: null,
	};
	add(phase: Phase, startedAt: number): void {
		this.phases[phase] =
			(this.phases[phase] ?? 0) + Math.max(0, performance.now() - startedAt);
	}
	async measure<T>(phase: Phase, operation: () => Promise<T>): Promise<T> {
		const startedAt = performance.now();
		try {
			return await operation();
		} finally {
			this.add(phase, startedAt);
		}
	}
	snapshot() {
		return {
			unit: "ms",
			...this.phases,
			total: Math.max(0, performance.now() - this.startedAt),
		};
	}
}

export function requestPhaseTimings(context: object): PhaseTimings {
	let timings = requests.get(context);
	if (!timings) {
		timings = new PhaseTimings();
		requests.set(context, timings);
	}
	return timings;
}
