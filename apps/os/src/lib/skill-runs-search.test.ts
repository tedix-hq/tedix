import { describe, expect, it } from "vite-plus/test";
import {
	SKILL_RUN_PAGE_SIZE,
	hasSkillRunFilter,
	isStuckSkillRun,
	skillRunLogFilter,
	skillRunRangeStart,
	skillRunResultLine,
	skillRunsSearchSchema,
} from "./skill-runs-search";

const NOW = new Date("2026-11-16T10:30:42.500Z");

describe("skill run log search", () => {
	it("drops filter values it does not know and keeps the rest", () => {
		expect(
			skillRunsSearchSchema.parse({
				status: "exploded",
				trigger: "test",
				revision: "4",
				range: "decade",
				page: "3",
			}),
		).toEqual({ trigger: "test", revision: 4, page: 3 });
		expect(skillRunsSearchSchema.parse({ page: 1, revision: 0 })).toEqual({});
	});

	it("reads the unfiltered first page with no extra input", () => {
		expect(skillRunLogFilter({}, NOW)).toEqual({});
		expect(hasSkillRunFilter({})).toBe(false);
		expect(hasSkillRunFilter({ page: 2 })).toBe(false);
	});

	it("turns each filter into the read's input", () => {
		expect(
			skillRunLogFilter(
				{
					status: "failed",
					trigger: "scheduled",
					revision: 7,
					range: "day",
					page: 3,
				},
				NOW,
			),
		).toEqual({
			status: "failed",
			trigger: "scheduled",
			skillRevision: 7,
			startedAfter: "2026-11-15T10:30:00.000Z",
			offset: 2 * SKILL_RUN_PAGE_SIZE,
		});
		expect(hasSkillRunFilter({ range: "week" })).toBe(true);
	});

	it("cuts the range start to the minute so two reads in a minute agree", () => {
		expect(skillRunRangeStart(undefined, NOW)).toBeUndefined();
		expect(skillRunRangeStart("week", NOW)).toBe("2026-11-09T10:30:00.000Z");
		expect(skillRunRangeStart("month", NOW)).toBe("2026-10-17T10:30:00.000Z");
		expect(
			skillRunRangeStart("day", new Date("2026-11-16T10:30:59.999Z")),
		).toBe(skillRunRangeStart("day", NOW));
	});
});

describe("stuck runs", () => {
	it("flags a run still queued or running six hours after it started", () => {
		const started = "2026-11-16T04:30:00.000Z";
		expect(
			isStuckSkillRun({ status: "running", startedAt: started }, NOW),
		).toBe(true);
		expect(isStuckSkillRun({ status: "queued", startedAt: started }, NOW)).toBe(
			true,
		);
		// The database's own timestamp shape is read as UTC.
		expect(
			isStuckSkillRun(
				{ status: "running", startedAt: "2026-11-15 08:00:00" },
				NOW,
			),
		).toBe(true);
	});

	it("leaves recent, paused, finished and unstarted runs alone", () => {
		const old = "2026-11-10T00:00:00.000Z";
		expect(
			isStuckSkillRun(
				{ status: "running", startedAt: "2026-11-16T05:00:00.000Z" },
				NOW,
			),
		).toBe(false);
		expect(isStuckSkillRun({ status: "paused", startedAt: old }, NOW)).toBe(
			false,
		);
		expect(isStuckSkillRun({ status: "completed", startedAt: old }, NOW)).toBe(
			false,
		);
		expect(isStuckSkillRun({ status: "running", startedAt: null }, NOW)).toBe(
			false,
		);
	});
});

describe("the result line of a run", () => {
	const base = {
		startedAt: "2026-11-16T10:00:00.000Z",
		trigger: "scheduled" as const,
		errorPreview: null,
		resultSummary: null,
		outcome: null,
	};

	it("shows a failed run's error as one plain line", () => {
		expect(
			skillRunResultLine(
				{
					...base,
					status: "failed",
					errorPreview:
						"Error: Tool crm.list_accounts timed out\n    at step (workflow.js:10)",
				},
				NOW,
			),
		).toEqual({ text: "Tool crm.list_accounts timed out", tone: "error" });
		expect(skillRunResultLine({ ...base, status: "failed" }, NOW)).toEqual({
			text: "No error reason was recorded.",
			tone: "error",
		});
	});

	it("shows a completed run's summary, else its outcome, else nothing", () => {
		expect(
			skillRunResultLine(
				{
					...base,
					status: "completed",
					resultSummary: "31 threads queued\nfor browser check",
					outcome: "delivered",
				},
				NOW,
			),
		).toEqual({
			text: "31 threads queued for browser check",
			tone: "default",
		});
		expect(
			skillRunResultLine(
				{ ...base, status: "completed", outcome: "no_action" },
				NOW,
			)?.text,
		).toBe("Nothing to do");
		expect(
			skillRunResultLine({ ...base, status: "completed" }, NOW),
		).toBeNull();
	});

	it("says whether a test passed", () => {
		const test = { ...base, trigger: "test" as const };
		expect(
			skillRunResultLine({ ...test, status: "completed" }, NOW)?.text,
		).toBe("Test passed");
		expect(
			skillRunResultLine(
				{ ...test, status: "completed", resultSummary: "2 rows written" },
				NOW,
			)?.text,
		).toBe("Test passed: 2 rows written");
		expect(
			skillRunResultLine(
				{ ...test, status: "failed", errorPreview: "Error: no access" },
				NOW,
			),
		).toEqual({ text: "Test not passed: no access", tone: "error" });
		expect(skillRunResultLine({ ...test, status: "running" }, NOW)?.text).toBe(
			"Test in progress",
		);
	});

	it("explains a stuck run and a paused run", () => {
		expect(
			skillRunResultLine(
				{ ...base, status: "running", startedAt: "2026-11-15T10:00:00.000Z" },
				NOW,
			),
		).toEqual({
			text: "Started more than 6 hours ago and has not finished.",
			tone: "warning",
		});
		expect(skillRunResultLine({ ...base, status: "paused" }, NOW)?.text).toBe(
			"Waiting for a person or an event.",
		);
		expect(skillRunResultLine({ ...base, status: "running" }, NOW)).toBeNull();
	});
});
