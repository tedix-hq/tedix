import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";

function isSupervisor(report: DispatcherHealthReport) {
	return (
		report.executor === "supervisor" ||
		report.lane === "supervisor" ||
		report.lane === "supervisor-lead" ||
		report.duty?.kind === "task"
	);
}

/** Problems worth showing from the latest runner reports; empty when all is well. */
export function runnerHealthProblems(
	reports: readonly DispatcherHealthReport[],
	now: number,
) {
	const fresh = reports.filter(
		(report) =>
			!report.stale &&
			now - Date.parse(report.duty?.observedAt ?? report.observedAt) <=
				report.staleAfterSeconds * 1000,
	);
	// One machine can report the same runner from several lanes; a runner is
	// down only when none of its fresh lanes is running.
	const up = new Map<string, boolean>();
	for (const report of fresh) {
		if (isSupervisor(report)) continue;
		const running =
			report.running && (!report.duty || report.duty.state === "running");
		up.set(report.executor, (up.get(report.executor) ?? false) || running);
	}
	const lastReport = reports
		.map((report) => report.observedAt)
		.sort()
		.at(-1);
	return {
		notRunning: [...up]
			.filter(([, running]) => !running)
			.map(([runner]) => runner)
			.sort(),
		supervisorSilent: reports.length > 0 && !fresh.some(isSupervisor),
		/** Set only when no runner has reported recently. */
		silentSince: up.size === 0 ? (lastReport ?? null) : null,
	};
}
