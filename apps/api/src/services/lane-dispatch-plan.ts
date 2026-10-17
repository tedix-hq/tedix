import type { LaneDispatchPlan } from "@tedix/api-contract/schemas/work-items";

/** Coordinated queues start held; only their server coordinator selects a lane. */
export function initialLaneDispatch(
	executor: unknown,
	projectMetadata?: Record<string, unknown> | null,
	previousPlan?: unknown,
): LaneDispatchPlan | undefined {
	if (executor !== "codex" && executor !== "claude-code") return undefined;
	const labels = [projectMetadata?.labels, projectMetadata?.tags];
	const enabled =
		labels.some((v) => Array.isArray(v) && v.includes("night-shift")) ||
		(projectMetadata?.nightShift as { enabled?: unknown } | undefined)
			?.enabled === true;
	return enabled || previousPlan !== undefined ? { state: "held" } : undefined;
}
