import type { LocalDispatcherHealth } from "./dispatcher-health";
import { localExecutors, type LocalExecutor } from "./lane-routing";

export type UnavailableRunner = {
	since: number;
	reason: "unreachable";
};

/**
 * A donor is unavailable while none of its runners in this scope is running.
 * A running runner takes every ready item it may, so it is never full.
 */
export function observeUnavailableRunners(
	reports: LocalDispatcherHealth[],
	previous: Map<LocalExecutor, UnavailableRunner>,
	scope: { workspace: string; organization: string },
	now = Date.now(),
) {
	const next = new Map<LocalExecutor, UnavailableRunner>();
	for (const executor of localExecutors) {
		const matching = reports.filter(
			(row) =>
				row.executor === executor &&
				row.workspace === scope.workspace &&
				row.organization === scope.organization &&
				row.duty?.kind !== "task",
		);
		if (!matching.length || matching.some((row) => row.running)) continue;
		next.set(executor, {
			since: previous.get(executor)?.since ?? now,
			reason: "unreachable",
		});
	}
	return next;
}

export function idleReason(
	reason: string,
): "held" | "waitingOnPerson" | "noCoordinator" | "other" {
	if (/held after|execution.held|retained receipt.*held/i.test(reason))
		return "held";
	if (/human|person|Interaction|delegation|consent|MFA/i.test(reason))
		return "waitingOnPerson";
	if (/no ready coordinator/i.test(reason)) return "noCoordinator";
	return "other";
}
