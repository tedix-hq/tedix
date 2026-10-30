import { describe, expect, it } from "vite-plus/test";
import { ReportDispatcherHealthInputSchema } from "./dispatcher-health";

const valid = {
	reporterId: "mac-studio",
	executor: "codex",
	lane: "primary",
	running: true,
	observedAt: "2026-10-30T10:00:00.000Z",
	lastAdmissionAt: null,
	slotsInUse: 1,
	slotsTotal: 2,
	topReason: { reason: "session label clash", count: 3 },
};

describe("dispatcher health report input", () => {
	it("accepts a bounded sanitized report", () => {
		expect(ReportDispatcherHealthInputSchema.parse(valid)).toEqual(valid);
	});

	it.each([
		{ ...valid, reporterId: "x".repeat(129) },
		{ ...valid, slotsInUse: 3 },
		{ ...valid, slotsTotal: 10_001 },
		{ ...valid, topReason: { reason: "", count: 1 } },
		{ ...valid, topReason: { reason: "blocked", count: 0 } },
		{ ...valid, observedAt: "not-a-timestamp" },
	])("rejects an invalid or unbounded report", (input) => {
		expect(() => ReportDispatcherHealthInputSchema.parse(input)).toThrow();
	});
});
