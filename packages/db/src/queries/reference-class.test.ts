import { describe, expect, it } from "vite-plus/test";
import {
	computeReferenceClassEstimate,
	medianOf,
	percentileOf,
	type ReferenceClassEpisode,
} from "./reference-class";

function episode(
	overrides: Partial<ReferenceClassEpisode> = {},
): ReferenceClassEpisode {
	return {
		outcomeStatus: "success",
		durationMs: 1000,
		toolCallCount: 4,
		...overrides,
	};
}

describe("medianOf / percentileOf", () => {
	it("returns null on empty samples", () => {
		expect(medianOf([])).toBeNull();
		expect(percentileOf([], 0.8)).toBeNull();
	});

	it("computes an odd-length median without mutation", () => {
		const values = [5, 1, 3];
		expect(medianOf(values)).toBe(3);
		expect(values).toEqual([5, 1, 3]);
	});

	it("interpolates an even-length median", () => {
		expect(medianOf([1, 2, 3, 10])).toBe(2.5);
	});

	it("computes p80 by nearest rank", () => {
		// n=10 → rank ceil(0.8*10)=8 → 8th smallest value.
		expect(percentileOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8)).toBe(8);
		// n=3 → rank ceil(2.4)=3 → max.
		expect(percentileOf([100, 300, 200], 0.8)).toBe(300);
		// n=1 → the only sample.
		expect(percentileOf([42], 0.8)).toBe(42);
	});
});

describe("computeReferenceClassEstimate", () => {
	const base = { taskType: "skill:demo", windowDays: 30, since: "2026-06-16" };

	it("summarizes the distribution of synthetic episodes", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [
				episode({ durationMs: 1000, toolCallCount: 3 }),
				episode({ durationMs: 2000, toolCallCount: 4 }),
				episode({ durationMs: 3000, toolCallCount: 5 }),
				episode({
					durationMs: 10000,
					toolCallCount: 12,
					outcomeStatus: "failure",
				}),
			],
		});
		expect(estimate.taskType).toBe("skill:demo");
		expect(estimate.episodeCount).toBe(4);
		expect(estimate.successRate).toBe(0.75);
		expect(estimate.durationMs).toEqual({
			median: 2500,
			p80: 10000,
			samples: 4,
		});
		expect(estimate.toolCallCount).toEqual({
			median: 4.5,
			p80: 12,
			samples: 4,
		});
		expect(estimate.verdict).toBe("reference_class");
	});

	it("excludes null durations from the duration metric but not the class", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [
				episode({ durationMs: null }),
				episode({ durationMs: 4000 }),
				episode({ durationMs: 6000 }),
			],
		});
		expect(estimate.episodeCount).toBe(3);
		expect(estimate.durationMs).toEqual({
			median: 5000,
			p80: 6000,
			samples: 2,
		});
		expect(estimate.toolCallCount.samples).toBe(3);
	});

	it("returns insufficient_data verdict below the episode floor", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [episode(), episode()],
		});
		expect(estimate.verdict).toBe("insufficient_data");
		expect(estimate.trend).toBe("insufficient_data");
		// The partial distribution is still reported for transparency.
		expect(estimate.episodeCount).toBe(2);
		expect(estimate.durationMs.median).toBe(1000);
	});

	it("handles an empty reference class", () => {
		const estimate = computeReferenceClassEstimate({ ...base, episodes: [] });
		expect(estimate.episodeCount).toBe(0);
		expect(estimate.successRate).toBe(0);
		expect(estimate.durationMs).toEqual({
			median: null,
			p80: null,
			samples: 0,
		});
		expect(estimate.toolCallCount).toEqual({
			median: null,
			p80: null,
			samples: 0,
		});
		expect(estimate.verdict).toBe("insufficient_data");
	});

	it("flags a regressing trend when recent durations blow past baseline", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [
				episode({ durationMs: 1000 }),
				episode({ durationMs: 1100 }),
				episode({ durationMs: 2000 }),
				episode({ durationMs: 2200 }),
			],
		});
		expect(estimate.trend).toBe("regressing");
	});

	it("flags a regressing trend on a success-rate drop", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [
				episode(),
				episode(),
				episode({ outcomeStatus: "failure" }),
				episode({ outcomeStatus: "failure" }),
			],
		});
		expect(estimate.trend).toBe("regressing");
	});

	it("flags an improving trend when recent durations shrink", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [
				episode({ durationMs: 2000 }),
				episode({ durationMs: 2200 }),
				episode({ durationMs: 1000 }),
				episode({ durationMs: 1100 }),
			],
		});
		expect(estimate.trend).toBe("improving");
	});

	it("reports flat when neither threshold fires", () => {
		const estimate = computeReferenceClassEstimate({
			...base,
			episodes: [
				episode({ durationMs: 1000 }),
				episode({ durationMs: 1050 }),
				episode({ durationMs: 1000 }),
				episode({ durationMs: 1080 }),
			],
		});
		expect(estimate.trend).toBe("flat");
	});
});
