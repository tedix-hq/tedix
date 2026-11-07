import { expect, it } from "vite-plus/test";
import { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";
import { DispatcherHealthReportSchema } from "@tedix/api-contract/schemas/dispatcher-health";
import {
	aggregateHarnessScorecard,
	SCORECARD_WINDOW_MS,
} from "./harness-scorecard";

const now = Date.parse("2026-11-07T12:00:00.000Z");
it("sums fully covered fleet observations and withholds stale, warming or legacy totals", () => {
	const at = new Date(now).toISOString();
	const start = new Date(now - SCORECARD_WINDOW_MS).toISOString();
	const report = DispatcherHealthReportSchema.parse({
		reporterId: "cedar",
		executor: "codex",
		lane: "runner",
		running: true,
		observedAt: at,
		reportedAt: at,
		lastAdmissionAt: null,
		slotsInUse: 0,
		slotsTotal: 1,
		topReason: null,
		ageSeconds: 0,
		staleAfterSeconds: 60,
		stale: false,
		duty: {
			id: "runner",
			kind: "service",
			state: "running",
			observedAt: at,
			lastRunAt: at,
			lastExitAt: null,
			lastExitCode: null,
			lastExecutor: "codex",
			restartsLastHour: 0,
			retryAt: null,
			lastProblem: null,
			reliability: {
				coverageStartedAt: start,
				windowStartedAt: start,
				observedAt: at,
				runners: [{ runner: "codex", held: 2, supervisorKills: 3 }],
			},
		},
	});
	const second = { ...report, reporterId: "other-machine" };
	expect(aggregateHarnessScorecard([], [report, report, second], now)).toEqual([
		{
			runner: "codex",
			started: 0,
			succeeded: 0,
			failed: 0,
			orphaned: 0,
			commits: 0,
			held: 4,
			supervisorKills: 6,
		},
	]);
	const warming = {
		...second,
		duty: {
			...second.duty!,
			reliability: { ...second.duty!.reliability!, coverageStartedAt: at },
		},
	};
	for (const unavailable of [
		warming,
		{ ...second, stale: true },
		{ ...second, duty: undefined },
	]) {
		const result = aggregateHarnessScorecard(
			[],
			[report, unavailable],
			now,
		)[0]!;
		expect(result.held).toBeNull();
		expect(result.supervisorKills).toBeNull();
	}
	const coordinated = {
		...report,
		executor: "any-local",
		duty: {
			...report.duty!,
			reliability: { ...report.duty!.reliability!, runners: [] },
		},
	};
	expect(
		aggregateHarnessScorecard([row(1)], [coordinated], now).find(
			(row) => row.runner === "codex",
		)?.held,
	).toBe(0);
});
function row(id: number, overrides: Record<string, unknown> = {}) {
	return WorkAttemptProjectionSchema.parse({
		attempt: {
			id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
			orgId: "11111111-1111-4111-8111-111111111111",
			workItemId: "22222222-2222-4222-8222-222222222222",
			executorType: "external_agent",
			executorId: "cedar",
			executorSessionId: null,
			externalSessionKey: "codex:session",
			runtimeState: "running",
			outcome: null,
			runId: null,
			admissionId: null,
			attemptNumber: 1,
			startedAt: new Date(now).toISOString(),
			heartbeatAt: new Date(now).toISOString(),
			expiresAt: new Date(now + 60_000).toISOString(),
			finishedAt: null,
			summary: null,
			metadata: {},
			...overrides,
		},
		workItem: {
			id: "22222222-2222-4222-8222-222222222222",
			title: "Cedar task",
			disposition: "accepted",
			workKind: "coding",
			riskLevel: "low",
			priority: "medium",
			projectId: null,
			accountableOwnerType: null,
			accountableOwnerId: null,
		},
	});
}

it("uses a bounded start-time cohort and deduplicates Attempts across scopes", () => {
	const success = row(1, { outcome: "succeeded" });
	const rows = aggregateHarnessScorecard(
		[
			success,
			success,
			row(2, { outcome: "failed" }),
			row(3, { outcome: "expired" }),
			row(4, { expiresAt: new Date(now).toISOString() }),
			row(5, {
				outcome: "cancelled",
				expiresAt: new Date(now - 1).toISOString(),
			}),
			row(6, { startedAt: new Date(now - SCORECARD_WINDOW_MS).toISOString() }),
			row(7, {
				startedAt: new Date(now - SCORECARD_WINDOW_MS - 1).toISOString(),
			}),
			row(8, { startedAt: new Date(now + 1).toISOString() }),
		],
		[],
		now,
	);
	expect(rows).toEqual([
		{
			runner: "codex",
			started: 6,
			succeeded: 1,
			failed: 1,
			orphaned: 2,
			commits: 0,
			held: null,
			supervisorKills: null,
		},
	]);
	expect(
		aggregateHarnessScorecard([success], [], now + SCORECARD_WINDOW_MS + 1),
	).toEqual([]);
});

it("attributes harnesses by stamped session key and retains unattributed and tedi Attempts", () => {
	const rows = aggregateHarnessScorecard(
		[
			row(1, {
				externalSessionKey: "claude:session",
				metadata: { executor: "codex" },
			}),
			row(2, {
				externalSessionKey: null,
				executorSessionId: "codex:unverified",
			}),
			row(3, { executorType: "tedi", externalSessionKey: null }),
			row(4, { externalSessionKey: "bare-session-key" }),
		],
		[],
		now,
	);
	expect(rows.map((row) => row.runner)).toEqual([
		"claude",
		"tedi",
		"Unknown runner",
	]);
});

it("counts unique dispatcher commit receipts, excluding declared or recovered existing fixes", () => {
	const sha = "a".repeat(40);
	const receipt = {
		lane: true,
		settlement: {
			mode: "commit",
			commitSha: sha,
			commitShas: [sha, sha, "b".repeat(40), "bad"],
		},
	};
	const rows = aggregateHarnessScorecard(
		[
			row(1, { metadata: receipt }),
			row(2, { metadata: receipt }),
			row(3, {
				metadata: { lane: true, laneResult: { commitSha: "c".repeat(40) } },
			}),
			row(4, {
				metadata: {
					lane: true,
					settlement: { mode: "verified_existing", commitSha: "d".repeat(40) },
				},
			}),
			row(5, {
				metadata: { settlement: { mode: "commit", commitSha: "e".repeat(40) } },
			}),
			row(6, { metadata: { lane: true, settlement: [sha] } }),
		],
		[],
		now,
	);
	expect(rows[0]?.commits).toBe(2);
});

it("includes recently reported idle runners without treating supervisor duties as runners", () => {
	const report = DispatcherHealthReportSchema.parse({
		reporterId: "cedar",
		executor: "claude",
		lane: "runner",
		running: true,
		observedAt: new Date(now).toISOString(),
		reportedAt: new Date(now).toISOString(),
		lastAdmissionAt: null,
		slotsInUse: 0,
		slotsTotal: 1,
		topReason: null,
		ageSeconds: 0,
		staleAfterSeconds: 60,
		stale: false,
	});
	expect(
		aggregateHarnessScorecard(
			[],
			[
				report,
				report,
				{ ...report, executor: "supervisor", lane: "supervisor-lead" },
				{
					...report,
					executor: "old",
					observedAt: new Date(now - SCORECARD_WINDOW_MS - 1).toISOString(),
				},
			],
			now,
		),
	).toEqual([
		{
			runner: "claude",
			started: 0,
			succeeded: 0,
			failed: 0,
			orphaned: 0,
			commits: 0,
			held: null,
			supervisorKills: null,
		},
	]);
});
