import {
	type TediBudgets,
	TediBudgetsSchema,
} from "@tedix/api-contract/schemas/tedi";

/** Resolve stored overrides; missing individual ceilings use organization capacity. */
export function resolveTediBudgets(stored: unknown): TediBudgets {
	const record =
		stored && typeof stored === "object" && !Array.isArray(stored)
			? (stored as Record<string, unknown>)
			: {};
	return TediBudgetsSchema.parse(record);
}

/**
 * Resolve the D1-governed per-turn step ceiling, or `null` when no step count
 * ends the turn.
 *
 * Step caps are opt-in: a positive `maxIterationsPerTask` (an explicit
 * per-tedi budget) is a ceiling, bounded by the runtime's own
 * `hardMaxSteps` backstop. A negative entitlement means "unlimited" and an
 * absent one means "not governed"; both leave the turn bounded only by wall
 * clock and the daily budget. The harness version keeps the loop-policy
 * descriptor for audit only; it never supplies a ceiling of its own.
 */
export function resolveGovernedStepCeiling(input: {
	maxIterationsPerTask: number | null | undefined;
	hardMaxSteps: number;
}): number | null {
	const { maxIterationsPerTask, hardMaxSteps } = input;
	if (
		typeof maxIterationsPerTask !== "number" ||
		!Number.isInteger(maxIterationsPerTask) ||
		maxIterationsPerTask < 1
	) {
		return null;
	}
	return Math.max(1, Math.min(hardMaxSteps, maxIterationsPerTask));
}
