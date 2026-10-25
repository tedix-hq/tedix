import { describe, expect, it } from "vite-plus/test";
import {
	lastRunLine,
	nextRunLine,
	scheduleWhen,
} from "@/lib/workspace-schedules";

const BERLIN = { locale: "en-GB", timeZone: "Europe/Berlin" };
const NOW = new Date("2026-07-01T12:00:00Z");

describe("scheduleWhen", () => {
	it("lists the daily times in the viewer's clock, earliest first", () => {
		expect(
			scheduleWhen(
				{
					enabled: true,
					dailyTimes: [
						"2026-07-01T16:17:00.000Z",
						"2026-07-02T06:17:00.000Z",
						"2026-07-01T11:17:00.000Z",
					],
					nextRunAt: "2026-07-01T16:17:00.000Z",
				},
				BERLIN,
			),
		).toBe("Every day at 8:17, 13:17 and 18:17");
		expect(
			scheduleWhen(
				{
					enabled: true,
					dailyTimes: ["2026-07-02T05:43:00.000Z"],
					nextRunAt: "2026-07-02T05:43:00.000Z",
				},
				{ locale: "en-US", timeZone: "America/New_York" },
			),
		).toBe("Every day at 1:43 AM");
	});

	it("says when a schedule is paused, custom or has no run coming", () => {
		expect(
			scheduleWhen({ enabled: false, dailyTimes: [], nextRunAt: null }),
		).toBe("Paused");
		expect(
			scheduleWhen({
				enabled: false,
				cron: "0 8 * * *",
				dailyTimes: [],
				nextRunAt: null,
			}),
		).toBe("Paused");
		expect(
			scheduleWhen({
				enabled: false,
				cron: null,
				dailyTimes: [],
				nextRunAt: null,
			}),
		).toBe("Runs when asked");
		expect(
			scheduleWhen({
				enabled: true,
				dailyTimes: [],
				nextRunAt: "2026-07-06T09:00:00.000Z",
			}),
		).toBe("On a custom schedule");
		expect(
			scheduleWhen({ enabled: true, dailyTimes: [], nextRunAt: null }),
		).toBe("No run time is coming up");
	});
});

describe("lastRunLine", () => {
	const run = {
		runId: "run-1",
		status: "completed" as const,
		startedAt: "2026-07-01T11:17:00.000Z",
		completedAt: "2026-07-01T11:19:00.000Z",
		cards: 4,
		summary: null,
		error: null,
	};

	it("reports the time and what the run made", () => {
		expect(lastRunLine(run, NOW, BERLIN)).toBe("Last run 13:17: made 4 cards");
		expect(lastRunLine({ ...run, cards: 0 }, NOW, BERLIN)).toBe(
			"Last run 13:17: no new cards",
		);
		expect(
			lastRunLine(
				{ ...run, cards: null, summary: "Posted the digest" },
				NOW,
				BERLIN,
			),
		).toBe("Last run 13:17: Posted the digest");
		expect(
			lastRunLine(
				{ ...run, startedAt: "2026-06-30T16:17:00.000Z" },
				NOW,
				BERLIN,
			),
		).toBe("Last run yesterday 18:17: made 4 cards");
	});

	it("reports a failure with its reason, and a skill that never ran", () => {
		expect(
			lastRunLine(
				{ ...run, status: "failed", error: "Gmail search failed" },
				NOW,
				BERLIN,
			),
		).toBe("Last run failed: Gmail search failed");
		expect(lastRunLine(null, NOW, BERLIN)).toBe("Has not run yet");
	});
});

describe("nextRunLine", () => {
	it("names today's or tomorrow's run time", () => {
		expect(nextRunLine("2026-07-01T16:17:00.000Z", NOW, BERLIN)).toBe(
			"Next run 18:17",
		);
		expect(nextRunLine("2026-07-02T06:17:00.000Z", NOW, BERLIN)).toBe(
			"Next run tomorrow 8:17",
		);
		expect(nextRunLine(null, NOW, BERLIN)).toBeNull();
	});
});
