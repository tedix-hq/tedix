import { describe, expect, it } from "vite-plus/test";
import {
	oneLine,
	readRunsAt,
	reportedLastRun,
	schedulePurpose,
	scheduleRunTimes,
} from "./workspace-schedules";

const BERLIN_THREE_A_DAY = {
	timeZone: "Europe/Berlin",
	times: ["08:17", "13:17", "18:17"],
};

describe("scheduleRunTimes", () => {
	it("keeps only the local times a daylight-saving workflow runs at", () => {
		// Summer time (UTC+2): 06:17, 11:17 and 16:17 UTC are the kept fires.
		const summer = scheduleRunTimes(
			"17 5,6,10,11,15,16 * * *",
			BERLIN_THREE_A_DAY,
			new Date("2026-07-01T09:00:00Z"),
		);
		expect(summer).toEqual({
			dailyTimes: [
				"2026-07-01T11:17:00.000Z",
				"2026-07-01T16:17:00.000Z",
				"2026-07-02T06:17:00.000Z",
			],
			nextRunAt: "2026-07-01T11:17:00.000Z",
		});
		// Winter time (UTC+1): the kept fires move one UTC hour later.
		const winter = scheduleRunTimes(
			"17 6,7,11,12,16,17 * * *",
			BERLIN_THREE_A_DAY,
			new Date("2026-12-01T09:00:00Z"),
		);
		expect(winter.nextRunAt).toBe("2026-12-01T12:17:00.000Z");
		expect(winter.dailyTimes).toHaveLength(3);
	});

	it("reports no run when the cron never reaches a kept local time", () => {
		expect(
			scheduleRunTimes(
				"17 5,6,10,11,15,16 * * *",
				BERLIN_THREE_A_DAY,
				new Date("2026-12-01T09:00:00Z"),
			),
		).toEqual({ dailyTimes: [], nextRunAt: null });
	});

	it("lists every fire of a plain daily cron and only the next run otherwise", () => {
		expect(
			scheduleRunTimes("43 5 * * *", null, new Date("2026-07-01T09:00:00Z")),
		).toEqual({
			dailyTimes: ["2026-07-02T05:43:00.000Z"],
			nextRunAt: "2026-07-02T05:43:00.000Z",
		});
		expect(
			scheduleRunTimes("0 9 * * 1", null, new Date("2026-07-01T09:00:00Z")),
		).toEqual({ dailyTimes: [], nextRunAt: "2026-07-06T09:00:00.000Z" });
		expect(scheduleRunTimes("not a cron", null, new Date())).toEqual({
			dailyTimes: [],
			nextRunAt: null,
		});
	});
});

describe("readRunsAt", () => {
	it("accepts valid local times and rejects an unknown time zone", () => {
		expect(readRunsAt({ runsAt: BERLIN_THREE_A_DAY })).toEqual(
			BERLIN_THREE_A_DAY,
		);
		expect(
			readRunsAt({ runsAt: { timeZone: "Mars/Olympus", times: ["08:17"] } }),
		).toBeNull();
		expect(readRunsAt({ runsAt: { timeZone: "UTC", times: ["8:17"] } })).toBe(
			null,
		);
		expect(readRunsAt({})).toBeNull();
	});
});

describe("schedule text", () => {
	it("takes the declared purpose, then the summary, then the first sentence", () => {
		const skill = {
			summary: null,
			description: "Reads the shared inbox. Then writes cards.",
		};
		expect(schedulePurpose({ purpose: "Turns mail into cards" }, skill)).toBe(
			"Turns mail into cards",
		);
		expect(schedulePurpose({}, { ...skill, summary: "Inbox cards" })).toBe(
			"Inbox cards",
		);
		expect(schedulePurpose({}, skill)).toBe("Reads the shared inbox.");
	});

	it("cuts text to its first line", () => {
		expect(oneLine("  \nGmail failed\n  at step 3")).toBe("Gmail failed");
		expect(oneLine("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
		expect(oneLine(null)).toBeNull();
	});

	it("reports a failed run with its first error line and a finished run with its counts", () => {
		const base = {
			id: "run-1",
			startedAt: "2026-07-01T11:17:00.000Z",
			completedAt: "2026-07-01T11:19:00.000Z",
			cards: null,
			summary: null,
			error: null,
		};
		expect(
			reportedLastRun({
				...base,
				status: "failed",
				error: "Gmail search failed\nstack",
			}),
		).toMatchObject({ status: "failed", error: "Gmail search failed" });
		expect(
			reportedLastRun({ ...base, status: "completed", cards: 4 }),
		).toMatchObject({ status: "completed", cards: 4, error: null });
		expect(reportedLastRun({ ...base, status: "running" })).toBeNull();
		expect(reportedLastRun(undefined)).toBeNull();
	});
});
