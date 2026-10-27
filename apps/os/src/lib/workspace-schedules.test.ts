import { describe, expect, it } from "vite-plus/test";
import {
	lastRunFailure,
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

describe("lastRunFailure", () => {
	const refused = {
		runId: "run-2",
		status: "failed" as const,
		startedAt: "2026-07-01T11:17:00.000Z",
		completedAt: "2026-07-01T11:19:00.000Z",
		cards: null,
		summary: null,
		error:
			"Error: WorkflowToolsRefused: WORKFLOW_TOOLS_REFUSED: a tool capability in step gather was wholly refused",
	};
	const sessionRead = {
		providerId: "tedix-session-activity",
		providerName: "session activity",
		toolIds: ["list_agent_session_activity"],
		level: "none" as const,
	};

	it("says in plain words what a refused read needed and who can allow it", () => {
		expect(
			lastRunFailure(refused, {
				personalRead: { ...sessionRead, grantId: null, canAllow: true },
			}),
		).toEqual({
			reason:
				"The run could not read session activity because access was refused. " +
				"You can allow it below.",
			details: refused.error,
		});
		expect(
			lastRunFailure(refused, {
				personalRead: { ...sessionRead, grantId: null, canAllow: false },
			}).reason,
		).toBe(
			"The run could not read session activity because access was refused. " +
				"The workspace's owner can allow it.",
		);
	});

	it("keeps a refusal with no personal read generic, and plain errors as recorded", () => {
		expect(lastRunFailure(refused)).toEqual({
			reason:
				"The run stopped because access to a tool it needs was refused. " +
				"It will try again on its next run.",
			details: refused.error,
		});
		expect(
			lastRunFailure(refused, {
				personalRead: {
					...sessionRead,
					grantId: "33333333-3333-4333-8333-333333333333",
					canAllow: true,
				},
			}).reason,
		).toBe(
			"The run stopped because access to a tool it needs was refused. " +
				"It will try again on its next run.",
		);
		expect(
			lastRunFailure({ ...refused, error: "Gmail search failed" }),
		).toEqual({ reason: "Gmail search failed", details: null });
		expect(lastRunFailure({ ...refused, error: null })).toEqual({
			reason: "no reason was recorded",
			details: null,
		});
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
