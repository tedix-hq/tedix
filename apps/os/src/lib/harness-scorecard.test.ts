import { expect, it } from "vite-plus/test";
import { DispatcherHealthReportSchema } from "@tedix/api-contract/schemas/dispatcher-health";
import { runnerHealthProblems } from "./harness-scorecard";
const now = Date.parse("2026-11-07T12:00:00.000Z");

it("reports a runner down only when none of its fresh lanes runs, and ignores supervisor lanes", () => {
	const report = DispatcherHealthReportSchema.parse({
		reporterId: "cedar",
		executor: "codex",
		lane: "runner",
		running: true,
		observedAt: new Date(now).toISOString(),
		reportedAt: new Date(now).toISOString(),
		lastAdmissionAt: null,
		topReason: null,
		ageSeconds: 0,
		staleAfterSeconds: 60,
		stale: false,
	});
	expect(
		runnerHealthProblems(
			[
				report,
				{ ...report, reporterId: "other-machine", running: false },
				{ ...report, executor: "devin", running: false },
				{ ...report, executor: "opencode", running: false, stale: true },
				{ ...report, executor: "supervisor", lane: "supervisor" },
			],
			now,
		),
	).toEqual({
		notRunning: ["devin"],
		supervisorSilent: false,
		silentSince: null,
	});
	expect(runnerHealthProblems([report], now + 61_000)).toEqual({
		notRunning: [],
		supervisorSilent: true,
		silentSince: report.observedAt,
	});
});
