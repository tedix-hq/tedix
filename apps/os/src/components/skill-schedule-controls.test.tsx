import { describe, expect, it } from "vite-plus/test";
import {
	cronFixedTime,
	retimedCron,
	scheduleUpdateConfirmation,
} from "./skill-schedule-controls";

describe("cronFixedTime", () => {
	it("reads a pinned hour and minute", () => {
		expect(cronFixedTime("30 21 * * *")).toEqual({ hour: 21, minute: 30 });
		expect(cronFixedTime("0 9 * * 1-5")).toEqual({ hour: 9, minute: 0 });
	});
	it("returns null when there is no single time of day", () => {
		expect(cronFixedTime("*/30 * * * *")).toBeNull();
		expect(cronFixedTime("0 9,17 * * *")).toBeNull();
		expect(cronFixedTime("0 9 * *")).toBeNull();
		expect(cronFixedTime("99 9 * * *")).toBeNull();
	});
});

describe("retimedCron", () => {
	it("swaps only minute and hour, keeping the day pattern", () => {
		expect(retimedCron("0 9 * * *", 21, 30)).toBe("30 21 * * *");
		expect(retimedCron("0 9 * * 1-5", 6, 45)).toBe("45 6 * * 1-5");
		expect(retimedCron("15 8 1 * *", 0, 0)).toBe("0 0 1 * *");
	});
});

describe("scheduleUpdateConfirmation", () => {
	const base = {
		skillId: "skill-1",
		changed: true,
		cron: "30 21 * * *",
		scheduleEnabled: true,
		nextFireAt: "2026-10-22T21:30:00Z",
	};
	it("confirms a retime in plain words", () => {
		expect(scheduleUpdateConfirmation(base, "UTC")).toContain(
			"runs daily at 9:30 PM (UTC)",
		);
	});
	it("confirms a pause without promising a next run", () => {
		const text = scheduleUpdateConfirmation(
			{ ...base, scheduleEnabled: false, nextFireAt: null },
			"UTC",
		);
		expect(text).toBe("Off — it will not run again until you turn it back on.");
	});
	it("reports an unchanged policy honestly", () => {
		expect(
			scheduleUpdateConfirmation({ ...base, changed: false }, "UTC"),
		).toContain("Already set");
		expect(
			scheduleUpdateConfirmation(
				{ ...base, changed: false, scheduleEnabled: false },
				"UTC",
			),
		).toBe("Already off — it was not running.");
	});
});
