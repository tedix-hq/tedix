import { describe, expect, it } from "vite-plus/test";
import {
	cronAtLocalTime,
	scheduleInWords,
	scheduleLocalTime,
	zoneOffsetMinutes,
} from "./skill-schedule-words";

// Berlin is UTC+1 in winter and UTC+2 in summer.
const winter = new Date("2026-11-16T12:00:00Z");
const summer = new Date("2026-07-01T12:00:00Z");
const words = (cron: string, zone: string, reference = winter) =>
	scheduleInWords(cron, zone, { reference, locale: "en-US" });

describe("zoneOffsetMinutes", () => {
	it("reads the offset on the given day, so clock changes are followed", () => {
		expect(zoneOffsetMinutes(winter, "Europe/Berlin")).toBe(60);
		expect(zoneOffsetMinutes(summer, "Europe/Berlin")).toBe(120);
		expect(zoneOffsetMinutes(winter, "Asia/Kolkata")).toBe(330);
		expect(zoneOffsetMinutes(winter, "America/Los_Angeles")).toBe(-480);
		expect(zoneOffsetMinutes(winter, "UTC")).toBe(0);
	});
	it("falls back to UTC for a zone it does not know", () => {
		expect(zoneOffsetMinutes(winter, "Not/AZone")).toBe(0);
	});
});

describe("scheduleInWords", () => {
	it("puts a daily time in the person's zone", () => {
		expect(words("0 8 * * *", "Europe/Berlin")).toEqual({
			text: "Every day at 9:00 AM",
			zone: "local",
		});
		expect(words("0 8 * * *", "Europe/Berlin", summer).text).toBe(
			"Every day at 10:00 AM",
		);
		expect(words("30 21 * * *", "UTC").text).toBe("Every day at 9:30 PM");
	});
	it("uses the person's locale for the clock", () => {
		expect(
			scheduleInWords("0 14 * * *", "Europe/Berlin", {
				reference: winter,
				locale: "de-DE",
			}).text,
		).toBe("Every day at 15:00");
	});
	it("names weekdays, and moves them when local time is on another day", () => {
		expect(words("0 13 * * 1", "Europe/Berlin").text).toBe(
			"Every Monday at 2:00 PM",
		);
		expect(words("0 9 * * 1-5", "UTC").text).toBe("Every weekday at 9:00 AM");
		expect(words("0 9 * * 0,6", "UTC").text).toBe(
			"Every Saturday and Sunday at 9:00 AM",
		);
		expect(words("0 9 * * 1,3,5", "UTC").text).toBe(
			"Every Monday, Wednesday and Friday at 9:00 AM",
		);
		// 23:30 UTC on Monday is 00:30 on Tuesday in Berlin.
		expect(words("30 23 * * 1", "Europe/Berlin").text).toBe(
			"Every Tuesday at 12:30 AM",
		);
		// 02:00 UTC on Monday is 18:00 on Sunday in Los Angeles.
		expect(words("0 2 * * mon", "America/Los_Angeles").text).toBe(
			"Every Sunday at 6:00 PM",
		);
	});
	it("keeps a day of the month in UTC when local time is on another day", () => {
		expect(words("0 9 15 * *", "Europe/Berlin")).toEqual({
			text: "Every month on the 15th at 10:00 AM",
			zone: "local",
		});
		expect(words("30 23 1 * *", "Europe/Berlin")).toEqual({
			text: "Every month on the 1st at 11:30 PM UTC",
			zone: "utc",
		});
	});
	it("says a repeating cadence without a time of day", () => {
		expect(words("*/30 * * * *", "Europe/Berlin")).toEqual({
			text: "Every 30 minutes",
			zone: "none",
		});
		expect(words("* * * * *", "UTC").text).toBe("Every minute");
		expect(words("0 */6 * * *", "UTC").text).toBe("Every 6 hours");
		expect(words("0 * * * *", "UTC").text).toBe("Every hour, on the hour");
		expect(words("15 * * * *", "Asia/Kolkata").text).toBe(
			"Every hour, 45 minutes past the hour",
		);
	});
	it("does not paraphrase a shape it does not understand", () => {
		for (const cron of [
			"0 9,17 * * *",
			"0 9 * 6 *",
			"0 9 1,15 * *",
			"0 9 1 * 1",
			"0 9 * * */2",
			"0 9 * *",
			"99 9 * * *",
		])
			expect(words(cron, "UTC").text, cron).toBeNull();
	});
});

describe("changing the time as a local time", () => {
	it("offers a local time for daily and weekday schedules only", () => {
		expect(scheduleLocalTime("0 8 * * *", "Europe/Berlin", winter)).toBe(
			"09:00",
		);
		expect(scheduleLocalTime("30 23 * * 1-5", "Europe/Berlin", winter)).toBe(
			"00:30",
		);
		expect(scheduleLocalTime("0 9 1 * *", "Europe/Berlin", winter)).toBeNull();
		expect(
			scheduleLocalTime("*/30 * * * *", "Europe/Berlin", winter),
		).toBeNull();
	});
	it("stores a local time back in UTC", () => {
		expect(cronAtLocalTime("0 8 * * *", "10:30", "Europe/Berlin", winter)).toBe(
			"30 9 * * *",
		);
		expect(cronAtLocalTime("0 8 * * *", "10:30", "Europe/Berlin", summer)).toBe(
			"30 8 * * *",
		);
		expect(cronAtLocalTime("0 9 * * 1-5", "07:15", "UTC", winter)).toBe(
			"15 7 * * 1-5",
		);
	});
	it("keeps the local weekdays when the stored day changes", () => {
		// Monday 00:30 in Berlin is Sunday 23:30 UTC.
		expect(
			cronAtLocalTime("0 13 * * 1", "00:30", "Europe/Berlin", winter),
		).toBe("30 23 * * 0");
		// Stored Monday 23:30 UTC reads as Tuesday in Berlin; noon stays Tuesday.
		expect(
			cronAtLocalTime("30 23 * * 1", "12:00", "Europe/Berlin", winter),
		).toBe("0 11 * * 2");
		// Local weekdays at 20:00 in Los Angeles are Tuesday to Saturday in UTC.
		expect(
			cronAtLocalTime("0 17 * * 1-5", "20:00", "America/Los_Angeles", winter),
		).toBe("0 4 * * 2,3,4,5,6");
	});
	it("round-trips: the saved schedule reads as the time that was typed", () => {
		for (const zone of ["Europe/Berlin", "Asia/Kolkata", "America/Los_Angeles"])
			for (const time of ["00:05", "07:45", "23:55"]) {
				const saved = cronAtLocalTime("0 13 * * 1", time, zone, winter)!;
				expect(scheduleLocalTime(saved, zone, winter), `${zone} ${time}`).toBe(
					time,
				);
				expect(words(saved, zone).text).toMatch(/^Every Monday at /);
			}
	});
	it("refuses a time it cannot read or a schedule it cannot retime", () => {
		expect(cronAtLocalTime("0 8 * * *", "", "UTC", winter)).toBeNull();
		expect(cronAtLocalTime("0 8 * * *", "25:00", "UTC", winter)).toBeNull();
		expect(cronAtLocalTime("0 9 1 * *", "10:00", "UTC", winter)).toBeNull();
	});
});
