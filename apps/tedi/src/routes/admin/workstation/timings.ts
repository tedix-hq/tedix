import { tracing } from "cloudflare:workers";
import type { WorkstationRequestPhases } from "./types";

export function workstationRequestPhases(diagnostic?: {
	processId: string;
	leaseId?: string;
}): WorkstationRequestPhases {
	const enteredAt = Date.now();
	const phases: Record<string, number> = {};
	const add = (name: string, startedAt: number): void => {
		phases[name] = (phases[name] ?? 0) + (Date.now() - startedAt);
	};
	return {
		mark: add,
		async time<T>(name: string, run: () => Promise<T>): Promise<T> {
			const startedAt = Date.now();
			// Emit while a phase is stalled: a canceled request cannot return timings.
			const slowTimer = diagnostic
				? setTimeout(() => {
						console.warn("[workstation] slow process status phase", {
							...diagnostic,
							phase: name,
							elapsedMs: Date.now() - startedAt,
							completedPhases: { ...phases },
							totalMs: Date.now() - enteredAt,
						});
					}, 10_000)
				: undefined;
			try {
				return await tracing.enterSpan(`workstation.${name}`, run);
			} finally {
				if (slowTimer !== undefined) clearTimeout(slowTimer);
				add(name, startedAt);
			}
		},
		timings: () => ({ ...phases, totalMs: Date.now() - enteredAt }),
	};
}
