import { describe, expect, it } from "vite-plus/test";
import {
	ReportDispatcherHealthInputSchema,
	SupervisorDutyHealthSchema,
} from "./dispatcher-health";

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
	it("accepts bounded duty observations while preserving legacy report inputs", () => {
		const duty = {
			id: "fixture",
			kind: "service",
			state: "waiting",
			observedAt: valid.observedAt,
			lastRunAt: null,
			lastExitAt: valid.observedAt,
			lastExitCode: 7,
			lastExecutor: "codex",
			restartsLastHour: 2,
			retryAt: valid.observedAt,
			lastProblem: "Runner exited",
		};
		expect(
			ReportDispatcherHealthInputSchema.parse({ ...valid, duty }).duty,
		).toEqual(duty);
		expect(
			SupervisorDutyHealthSchema.safeParse({ ...duty, state: "healthy" })
				.success,
		).toBe(false);
		expect(
			SupervisorDutyHealthSchema.safeParse({ ...duty, restartsLastHour: -1 })
				.success,
		).toBe(false);
	});
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
