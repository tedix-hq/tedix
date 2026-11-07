import { describe, expect, it } from "vite-plus/test";
import {
	ReportDispatcherHealthInputSchema,
	SupervisorDutyHealthSchema,
	DispatcherReliabilitySchema,
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

it("requires bounded counts and a real 24-hour reliability window", () => {
	const value = {
		coverageStartedAt: "2026-10-29T10:00:00.000Z",
		windowStartedAt: "2026-10-29T10:00:00.000Z",
		observedAt: valid.observedAt,
		runners: [{ runner: "codex", held: 2, supervisorKills: 1 }],
	};
	expect(DispatcherReliabilitySchema.parse(value)).toEqual(value);
	expect(
		DispatcherReliabilitySchema.safeParse({
			...value,
			windowStartedAt: valid.observedAt,
		}).success,
	).toBe(false);
	expect(
		DispatcherReliabilitySchema.safeParse({
			...value,
			coverageStartedAt: "2026-10-31T10:00:00.000Z",
		}).success,
	).toBe(false);
	expect(
		DispatcherReliabilitySchema.safeParse({
			...value,
			runners: [{ runner: "codex", held: -1, supervisorKills: 0 }],
		}).success,
	).toBe(false);
});

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

it("accepts arbitrary executor activity while bounding task references", () => {
	const schema = SupervisorDutyHealthSchema;
	const duty = {
		id: "configured-worker",
		kind: "service",
		state: "running",
		observedAt: valid.observedAt,
		lastRunAt: null,
		lastExitAt: null,
		lastExitCode: null,
		lastExecutor: "custom.builder",
		restartsLastHour: 0,
		retryAt: null,
		lastProblem: null,
		activity: {
			current: [
				{ id: "11111111-1111-4111-8111-111111111111", phase: "working" },
			],
			currentCount: 1,
			waiting: [],
			nextCheckAt: null,
			lastCompleted: null,
		},
	};
	expect(schema.safeParse(duty).success).toBe(true);
	expect(
		schema.safeParse({
			...duty,
			activity: {
				...duty.activity,
				current: Array(4).fill(duty.activity.current[0]),
			},
		}).success,
	).toBe(false);
	expect(
		schema.safeParse({
			...duty,
			activity: {
				...duty.activity,
				waiting: [{ id: "not-a-work-id", reason: "retry", retryAt: null }],
			},
		}).success,
	).toBe(false);
});
