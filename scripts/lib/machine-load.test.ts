import { describe, expect, test } from "bun:test";
import {
	contentionAdvice,
	describeLoadPressure,
	OVERSUBSCRIBED_RATIO,
	readLoadPressure,
} from "./machine-load";

describe("machine load pressure", () => {
	test("a quiet machine is not oversubscribed and says nothing", () => {
		const pressure = readLoadPressure(() => ({ load1: 3, cores: 10 }));
		expect(pressure.ratio).toBeCloseTo(0.3);
		expect(pressure.oversubscribed).toBe(false);
		// Silence matters: a healthy machine must not hand the reader an
		// irrelevant fact to weigh against a real failure.
		expect(describeLoadPressure(pressure)).toBeNull();
		expect(contentionAdvice(pressure)).toBeNull();
	});

	test("high load per core is reported as oversubscribed", () => {
		const pressure = readLoadPressure(() => ({ load1: 271, cores: 10 }));
		expect(pressure.oversubscribed).toBe(true);
		expect(describeLoadPressure(pressure)).toContain("27.1x oversubscribed");
	});

	test("ratio is per-core, so the same load differs by machine", () => {
		const small = readLoadPressure(() => ({ load1: 8, cores: 2 }));
		const large = readLoadPressure(() => ({ load1: 8, cores: 32 }));
		expect(small.oversubscribed).toBe(true);
		expect(large.oversubscribed).toBe(false);
	});

	test("zero reported cores does not report infinite oversubscription", () => {
		// Containers and some runners report 0 cores; dividing by it would flag
		// every machine as contended and make the signal worthless.
		const pressure = readLoadPressure(() => ({ load1: 1, cores: 0 }));
		expect(pressure.cores).toBe(1);
		expect(Number.isFinite(pressure.ratio)).toBe(true);
	});

	test("the boundary is inclusive, and just below it stays quiet", () => {
		const at = readLoadPressure(() => ({
			load1: OVERSUBSCRIBED_RATIO * 4,
			cores: 4,
		}));
		const below = readLoadPressure(() => ({
			load1: OVERSUBSCRIBED_RATIO * 4 - 0.1,
			cores: 4,
		}));
		expect(at.oversubscribed).toBe(true);
		expect(below.oversubscribed).toBe(false);
	});

	test("advice names contention as a possibility, not a verdict", () => {
		const advice = contentionAdvice(
			readLoadPressure(() => ({ load1: 60, cores: 10 })),
		);
		// It must not tell anyone their change is fine — contention does not make
		// a genuine type error disappear.
		expect(advice).toContain("may be the machine rather than your");
		expect(advice).toContain("do not 'fix' a");
	});

	test("reads the real machine without throwing", () => {
		const pressure = readLoadPressure();
		expect(pressure.cores).toBeGreaterThanOrEqual(1);
		expect(pressure.load1).toBeGreaterThanOrEqual(0);
		expect(Number.isFinite(pressure.ratio)).toBe(true);
	});
});
