import type * as z from "zod";
import type { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";
import type { DispatcherHealthReport } from "@tedix/api-contract/schemas/dispatcher-health";
import { asRecord } from "@tedix/api-contract/utils/is-record";

export type ScorecardAttempt = z.infer<typeof WorkAttemptProjectionSchema>;
export const SCORECARD_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A start-time cohort, deduplicated across pages and overlapping project scopes. */
export function aggregateHarnessScorecard(
	attempts: readonly ScorecardAttempt[],
	reports: readonly DispatcherHealthReport[],
	now: number,
) {
	const runners = new Map<
		string,
		{
			runner: string;
			started: number;
			succeeded: number;
			failed: number;
			orphaned: number;
			commits: Set<string>;
		}
	>();
	const runner = (name: string) => {
		let row = runners.get(name);
		if (!row) {
			row = {
				runner: name,
				started: 0,
				succeeded: 0,
				failed: 0,
				orphaned: 0,
				commits: new Set(),
			};
			runners.set(name, row);
		}
		return row;
	};
	for (const report of reports) {
		const at = Date.parse(report.duty?.observedAt ?? report.observedAt);
		if (
			report.duty?.kind !== "task" &&
			report.lane !== "supervisor-lead" &&
			at >= now - SCORECARD_WINDOW_MS &&
			at <= now
		)
			runner(report.executor);
	}
	const seen = new Set<string>();
	for (const { attempt } of attempts) {
		const at = Date.parse(attempt.startedAt);
		if (
			seen.has(attempt.id) ||
			at < now - SCORECARD_WINDOW_MS ||
			at > now ||
			!Number.isFinite(at)
		)
			continue;
		seen.add(attempt.id);
		// Only the server-stamped key attributes a harness; executor IDs name principals.
		const name =
			attempt.executorType === "tedi"
				? "tedi"
				: (attempt.externalSessionKey?.includes(":") &&
						attempt.externalSessionKey.split(":")[0]) ||
					"Unknown runner";
		const row = runner(name);
		row.started++;
		if (attempt.outcome === "succeeded") row.succeeded++;
		if (attempt.outcome === "failed") row.failed++;
		if (
			attempt.outcome === "expired" ||
			(attempt.outcome === null &&
				attempt.expiresAt !== null &&
				Date.parse(attempt.expiresAt) <= now)
		)
			row.orphaned++;
		// A declared laneResult SHA is not a landed-commit receipt. Existing-fix
		// receipts also must not credit an old commit to a new Attempt.
		const settlement = asRecord(attempt.metadata.settlement);
		if (attempt.metadata.lane === true && settlement?.mode === "commit") {
			const shas = Array.isArray(settlement.commitShas)
				? settlement.commitShas
				: [settlement.commitSha];
			for (const sha of shas)
				if (typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha))
					row.commits.add(sha);
		}
	}
	return [...runners.values()]
		.sort((a, b) => a.runner.localeCompare(b.runner))
		.map(({ commits, ...row }) => ({ ...row, commits: commits.size }));
}
