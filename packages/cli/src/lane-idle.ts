import type { LocalDispatcherHealth } from "./dispatcher-health";
import { localExecutors, type LocalExecutor } from "./lane-routing";

export type UnavailableRunner = {
	since: number;
	reason: "busy" | "unreachable";
};

/** Every runner for the donor must lack capacity continuously, in this scope. */
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
		if (
			!matching.length ||
			matching.some((row) => row.running && row.slotsInUse < row.slotsTotal)
		)
			continue;
		const reason = matching.every((row) => !row.running)
			? "unreachable"
			: "busy";
		const prior = previous.get(executor);
		next.set(executor, {
			since: prior?.reason === reason ? prior.since : now,
			reason,
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
