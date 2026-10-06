import { describe, expect, it } from "vite-plus/test";
import {
	absoluteTime,
	formatDurationBetween,
	formatDurationMs,
	relativeTime,
} from "./time";

const NOW = new Date("2026-08-13T12:00:00.000Z");

describe("relativeTime", () => {
	it("buckets by recency", () => {
		expect(relativeTime("2026-08-13T11:59:50.000Z", NOW)).toBe("just now");
		expect(relativeTime("2026-08-13T11:55:00.000Z", NOW)).toBe("5m ago");
		expect(relativeTime("2026-08-13T09:00:00.000Z", NOW)).toBe("3h ago");
		expect(relativeTime("2026-08-11T12:00:00.000Z", NOW)).toBe("2d ago");
	});

	it("uses a month-day date past a week, never a numeric locale date", () => {
		// Midday UTC keeps the rendered local date stable across timezones.
		const sameYear = relativeTime("2026-08-05T12:00:00.000Z", NOW);
		expect(sameYear).toBe("Aug 5");
		expect(sameYear).not.toMatch(/\d+\/\d+/);
	});

	it("adds the year across a year boundary", () => {
		expect(relativeTime("2025-08-06T12:00:00.000Z", NOW)).toBe("Aug 6, 2025");
	});

	it("clamps sub-minute and future instants to a sane label", () => {
		// 50s ago rounds to the minute bucket, never "0m ago".
		expect(relativeTime("2026-08-13T11:59:10.000Z", NOW)).toBe("1m ago");
		// small clock skew reads as "just now"
		expect(relativeTime("2026-08-13T12:00:20.000Z", NOW)).toBe("just now");
	});

	it("is empty on garbage input", () => {
		expect(relativeTime("not-a-date", NOW)).toBe("");
	});
});

describe("absoluteTime", () => {
	it("renders a readable month-day-year instant", () => {
		expect(absoluteTime("2026-08-02T22:47:00.000Z")).toMatch(
			/^[A-Z][a-z]{2} \d{1,2}, 2026, \d{1,2}:\d{2}\s?[AP]M$/,
		);
	});

	it("echoes unparseable input verbatim", () => {
		expect(absoluteTime("garbage")).toBe("garbage");
	});
});

describe("formatDurationMs", () => {
	it("formats across magnitudes with one dialect", () => {
		expect(formatDurationMs(250)).toBe("250ms");
		expect(formatDurationMs(420)).toBe("420ms");
		expect(formatDurationMs(1500)).toBe("1.5s");
		expect(formatDurationMs(3200)).toBe("3.2s");
		expect(formatDurationMs(4000)).toBe("4s");
		expect(formatDurationMs(64_000)).toBe("1m 04s");
		expect(formatDurationMs(65_000)).toBe("1m 05s");
		expect(formatDurationMs(120_000)).toBe("2m");
		expect(formatDurationMs(3_780_000)).toBe("1h 3m");
		expect(formatDurationMs(3_600_000)).toBe("1h");
	});

	it("handles rounding at the minute boundary", () => {
		expect(formatDurationMs(59_999)).toBe("1m");
	});

	it("returns null for absent input", () => {
		expect(formatDurationMs(null)).toBeNull();
		expect(formatDurationMs(undefined)).toBeNull();
		expect(formatDurationMs(Number.NaN)).toBeNull();
	});
});

describe("formatDurationBetween", () => {
	it("returns null without both timestamps", () => {
		expect(formatDurationBetween("2026-08-13T10:00:00Z", null)).toBeNull();
		expect(formatDurationBetween(null, "2026-08-13T10:00:00Z")).toBeNull();
	});

	it("formats seconds, minutes, and hours", () => {
		expect(
			formatDurationBetween("2026-08-13T10:00:00Z", "2026-08-13T10:00:04Z"),
		).toBe("4s");
		expect(
			formatDurationBetween("2026-08-13T10:00:00Z", "2026-08-13T10:02:05Z"),
		).toBe("2m 05s");
		expect(
			formatDurationBetween("2026-08-13T10:00:00Z", "2026-08-13T11:03:00Z"),
		).toBe("1h 3m");
	});

	it("rejects negative or unparseable ranges", () => {
		expect(
			formatDurationBetween("2026-08-13T10:00:00Z", "2026-08-13T09:00:00Z"),
		).toBeNull();
		expect(
			formatDurationBetween("not-a-date", "2026-08-13T10:00:00Z"),
		).toBeNull();
	});
});
