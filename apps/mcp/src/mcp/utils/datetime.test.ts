import { describe, expect, it } from "vite-plus/test";
import { toMcpDateTime } from "./datetime";

describe("toMcpDateTime", () => {
	it("keeps valid ISO datetimes valid", () => {
		expect(toMcpDateTime("2026-05-09T18:11:25.000Z")).toBe(
			"2026-05-09T18:11:25.000Z",
		);
	});

	it("normalizes SQLite UTC timestamps", () => {
		expect(toMcpDateTime("2026-05-09 18:11:25")).toBe(
			"2026-05-09T18:11:25.000Z",
		);
	});

	it("adds UTC zone to ISO-like timestamps without a zone", () => {
		expect(toMcpDateTime("2026-05-09T18:11:25")).toBe(
			"2026-05-09T18:11:25.000Z",
		);
	});

	it("falls back when input is absent or invalid", () => {
		const fallback = new Date("2026-05-09T20:00:00.000Z");
		expect(toMcpDateTime(null, fallback)).toBe("2026-05-09T20:00:00.000Z");
		expect(toMcpDateTime("not a date", fallback)).toBe(
			"2026-05-09T20:00:00.000Z",
		);
	});
});
