import {
	WorkAttemptSettlementSchema,
	workSettlementCommits,
} from "@tedix/api-contract/schemas/work-items";
import type * as z from "zod";
import type {
	GetAgentScorecardResultSchema,
	WorkAttemptProjectionSchema,
} from "@tedix/api-contract/schemas/work-items";

import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";

export type ScorecardAttempt = z.infer<typeof WorkAttemptProjectionSchema>;
export type ScorecardMetrics = z.infer<typeof GetAgentScorecardResultSchema>;
export const SCORECARD_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ScorecardRow = {
	id?: string;
	runner: string;
	started: number;
	done: number;
	failed: number;
	commits: number | null;
	durationMs: number | null;
	costUsd: number | null;
	tokens: number | null;
};

/**
 * One row per runner that started an Attempt in the last 24 hours,
 * deduplicated across pages and overlapping project scopes. Tedi execution
 * totals come from their own records, without recounting their Work Attempts.
 */
export function aggregateHarnessScorecard(
	attempts: readonly ScorecardAttempt[],
	now: number,
	metrics?: ScorecardMetrics,
): ScorecardRow[] {
	const runners = new Map<string, ScorecardRow & { shas: Set<string> }>();
	const seen = new Set<string>();
	const localMetrics = new Map(
		metrics?.localMetrics.map((metric) => [metric.attemptId, metric]),
	);
	for (const { attempt } of attempts) {
		if (metrics && attempt.executorType === "tedi") continue;
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
		const stampedName =
			attempt.executorType === "tedi"
				? "tedi"
				: (attempt.externalSessionKey?.includes(":") &&
						attempt.externalSessionKey.split(":")[0]) ||
					"other";
		const name = stampedName === "claude" ? "claude-code" : stampedName;
		let row = runners.get(name);
		if (!row) {
			row = {
				runner: name,
				started: 0,
				done: 0,
				failed: 0,
				commits: 0,
				durationMs: 0,
				costUsd: 0,
				tokens: 0,
				shas: new Set(),
			};
			runners.set(name, row);
		}
		row.started++;
		const duration =
			(attempt.finishedAt ? Date.parse(attempt.finishedAt) : now) - at;
		row.durationMs =
			row.durationMs !== null && Number.isFinite(duration) && duration >= 0
				? row.durationMs + duration
				: null;
		const metric = localMetrics.get(attempt.id);
		// A reused host session may have telemetry for a different Attempt.
		const metricAt = metric?.telemetryStartedAt
			? Date.parse(metric.telemetryStartedAt)
			: NaN;
		const matched =
			metric &&
			metricAt >= at &&
			metricAt <= (attempt.finishedAt ? Date.parse(attempt.finishedAt) : now);
		row.costUsd =
			row.costUsd !== null && matched && metric.costUsd !== null
				? row.costUsd + metric.costUsd
				: null;
		row.tokens =
			row.tokens !== null &&
			matched &&
			metric.inputTokens !== null &&
			metric.outputTokens !== null
				? row.tokens + metric.inputTokens + metric.outputTokens
				: null;
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
	if (metrics)
		for (const name of ["codex", "claude-code", "opencode", "devin"]) {
			if (!runners.has(name))
				runners.set(name, {
					runner: name,
					started: 0,
					done: 0,
					failed: 0,
					commits: 0,
					durationMs: 0,
					costUsd: null,
					tokens: null,
					shas: new Set(),
				});
		}
	return [
		...[...runners.values()].map(({ shas, ...row }) => ({
			...row,
			commits: shas.size,
		})),
		...(metrics?.tedis.map((row) => ({
			...row,
			runner: `${row.runner} (tedi)`,
			commits: null,
		})) ?? []),
	].sort((a, b) => b.started - a.started || a.runner.localeCompare(b.runner));
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
