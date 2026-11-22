import {
	WorkAttemptSettlementSchema,
	workSettlementCommits,
} from "@tedix/api-contract/schemas/work-items";
import type * as z from "zod";
import type { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";

import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";

export type ScorecardAttempt = z.infer<typeof WorkAttemptProjectionSchema>;
export const SCORECARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ScorecardRow = {
	runner: string;
	started: number;
	done: number;
	failed: number;
	commits: number;
};

/**
 * One row per runner that started an Attempt in the last 24 hours,
 * deduplicated across pages and overlapping project scopes. Runner lanes
 * that only report health (the supervisor, the shared any-local lane) have
 * no Attempts of their own, so they never get a row.
 */
export function aggregateHarnessScorecard(
	attempts: readonly ScorecardAttempt[],
	now: number,
): ScorecardRow[] {
	const runners = new Map<string, ScorecardRow & { shas: Set<string> }>();
	const seen = new Set<string>();
	for (const { attempt } of attempts) {
		const at = Date.parse(attempt.startedAt);
		if (
			seen.has(attempt.id) ||
			!Number.isFinite(at) ||
			at < now - SCORECARD_WINDOW_MS ||
			at > now
		)
			continue;
		seen.add(attempt.id);
		// Only the server-stamped key attributes a harness; executor IDs name principals.
		const name =
			attempt.executorType === "tedi"
				? "tedi"
				: (attempt.externalSessionKey?.includes(":") &&
						attempt.externalSessionKey.split(":")[0]) ||
					"other";
		let row = runners.get(name);
		if (!row) {
			row = {
				runner: name,
				started: 0,
				done: 0,
				failed: 0,
				commits: 0,
				shas: new Set(),
			};
			runners.set(name, row);
		}
		row.started++;
		if (
			attempt.outcome === "succeeded" ||
			attempt.outcome === "landed_unverified"
		)
			row.done++;
		if (
			attempt.outcome === "failed" ||
			attempt.outcome === "rejected" ||
			attempt.outcome === "expired"
		)
			row.failed++;
		// A declared laneResult SHA is not a landed-commit receipt. Existing-fix
		// receipts also must not credit an old commit to a new Attempt.
		const settlement = WorkAttemptSettlementSchema.safeParse(
			attempt.metadata.settlement,
		).data;
		if (attempt.metadata.lane === true && settlement?.mode === "commit") {
			for (const sha of workSettlementCommits(settlement))
				row.shas.add(sha.toLowerCase());
		}
	}
	return [...runners.values()]
		.map(({ shas, ...row }) => ({ ...row, commits: shas.size }))
		.sort((a, b) => b.started - a.started || a.runner.localeCompare(b.runner));
}

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
