import { describe, expect, it } from "vite-plus/test";
import {
	buildStrategyMapValidation,
	type DailyRateSeries,
	evaluateStrategyMapHypothesis,
	laggedCorrelations,
	STRATEGY_MAP_MIN_PAIRED_BUCKETS,
	STRATEGY_MAP_SUPPORT_THRESHOLD,
	strategyMapNoiseFloor,
} from "./strategy-map";

// Deterministic pseudo-random rates (multiples of 0.05 so integer-count rows
// reproduce them exactly). 28 values = one default window. Chosen for low
// autocorrelation (max |r| ≈ 0.1 at lags 1..7) so an injected causal lag is
// the ONLY strong structure and cannot be confused with periodicity.
const BASE_RATES = [
	0.1, 0.2, 0.3, 0.05, 0.6, 0.4, 0.45, 0.25, 0.65, 0.3, 0.75, 0.15, 0.55, 0.25,
	0.35, 0.8, 0.7, 0.85, 0.35, 0.15, 0.95, 0.5, 0.2, 0.9, 0.4, 0.05, 0.1, 0.45,
];

function shiftedBy(lag: number): DailyRateSeries {
	// lagging[t] = leading[t - lag]; first `lag` buckets have no signal.
	return BASE_RATES.map((_, index) =>
		index < lag ? null : BASE_RATES[index - lag],
	);
}

describe("laggedCorrelations", () => {
	it("recovers a known lag k=2 with a perfect correlation", () => {
		const points = laggedCorrelations(BASE_RATES, shiftedBy(2), 7);
		const atLag2 = points.find((point) => point.lag === 2);
		expect(atLag2?.correlation).toBe(1);
		expect(atLag2?.n).toBe(26);
		// No other lag matches the injected causal structure.
		for (const point of points) {
			if (point.lag === 2) continue;
			expect(point.correlation ?? 0).toBeLessThan(1);
		}
	});

	it("excludes null buckets pairwise from n", () => {
		const leading: DailyRateSeries = [...BASE_RATES];
		leading[5] = null;
		leading[6] = null;
		const points = laggedCorrelations(leading, shiftedBy(0), 0);
		expect(points[0]?.n).toBe(26);
	});

	it("returns null correlation for a constant series", () => {
		const constant: DailyRateSeries = BASE_RATES.map(() => 0.5);
		const points = laggedCorrelations(constant, BASE_RATES, 3);
		for (const point of points) {
			expect(point.correlation).toBeNull();
		}
	});
});

describe("evaluateStrategyMapHypothesis", () => {
	const hypothesisShape = {
		key: "skill_reuse_to_decision_success" as const,
		leading: "skill_reuse_rate",
		lagging: "decision_success_rate",
		chain: "process → outcome",
		maxLag: 7,
	};

	it("supports a hypothesis when the injected lag is recovered", () => {
		const result = evaluateStrategyMapHypothesis({
			...hypothesisShape,
			leadingSeries: BASE_RATES,
			laggingSeries: shiftedBy(2),
		});
		expect(result.verdict).toBe("supported");
		expect(result.bestLag).toBe(2);
		expect(result.correlation).toBe(1);
		expect(result.n).toBe(26);
		// Selection-bias transparency ships in the payload.
		expect(result.lagsTested).toBe(8);
		expect(result.supportFloor).toBe(
			Math.round(
				Math.max(STRATEGY_MAP_SUPPORT_THRESHOLD, strategyMapNoiseFloor(26, 8)) *
					1000,
			) / 1000,
		);
		expect(result.selectionBiasNote).toContain("best of 8 tested lags");
	});

	it("reports unsupported for an anti-correlated outcome", () => {
		const inverted: DailyRateSeries = BASE_RATES.map((value) => 1 - value);
		const result = evaluateStrategyMapHypothesis({
			...hypothesisShape,
			leadingSeries: BASE_RATES,
			laggingSeries: inverted,
		});
		expect(result.verdict).toBe("unsupported");
		expect(result.correlation).not.toBeNull();
		expect(result.correlation ?? 0).toBeLessThan(
			STRATEGY_MAP_SUPPORT_THRESHOLD,
		);
		expect(result.n).toBeGreaterThanOrEqual(STRATEGY_MAP_MIN_PAIRED_BUCKETS);
	});

	it("reports insufficient_data below the paired-bucket floor", () => {
		const short = BASE_RATES.slice(0, 10);
		const result = evaluateStrategyMapHypothesis({
			...hypothesisShape,
			leadingSeries: short,
			laggingSeries: short,
		});
		expect(result.verdict).toBe("insufficient_data");
		expect(result.bestLag).toBeNull();
		expect(result.correlation).toBeNull();
		expect(result.n).toBeLessThan(STRATEGY_MAP_MIN_PAIRED_BUCKETS);
	});

	it("reports insufficient_data for constant (zero-variance) series", () => {
		const constant: DailyRateSeries = BASE_RATES.map(() => 0.5);
		const result = evaluateStrategyMapHypothesis({
			...hypothesisShape,
			leadingSeries: constant,
			laggingSeries: BASE_RATES,
		});
		expect(result.verdict).toBe("insufficient_data");
		expect(result.supportFloor).toBeNull();
		expect(result.lagsTested).toBe(8);
	});
});

describe("white-noise false-support (best-of-lags selection bias)", () => {
	// Deterministic PRNG so the fixture set never drifts between runs.
	function mulberry32(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function whiteNoisePair(seed: number): {
		leading: DailyRateSeries;
		lagging: DailyRateSeries;
	} {
		const rng = mulberry32(seed);
		return {
			leading: Array.from({ length: 28 }, () => rng()),
			lagging: Array.from({ length: 28 }, () => rng()),
		};
	}

	const hypothesisShape = {
		key: "skill_reuse_to_decision_success" as const,
		leading: "skill_reuse_rate",
		lagging: "decision_success_rate",
		chain: "process → outcome",
		maxLag: 7,
	};

	it("does not stamp supported on white noise in at least 19/20 seeded windows", () => {
		// Pre-fix (flat 0.3 floor) white noise came out `supported` in roughly
		// half of these windows — best-of-8-lag selection turned the moderate-r
		// bar into a coin flip. The n- and multiplicity-scaled floor holds the
		// measured false-support rate to ~1% (0.9% over 1,000 seeds).
		const verdicts = Array.from({ length: 20 }, (_, index) => {
			const { leading, lagging } = whiteNoisePair(index + 1);
			return evaluateStrategyMapHypothesis({
				...hypothesisShape,
				leadingSeries: leading,
				laggingSeries: lagging,
			});
		});
		const notSupported = verdicts.filter(
			(result) =>
				result.verdict === "unsupported" ||
				result.verdict === "insufficient_data",
		);
		expect(notSupported.length).toBeGreaterThanOrEqual(19);
		// Every verdict remains recomputable from its own payload: r vs floor.
		for (const result of verdicts) {
			if (result.verdict === "supported") {
				expect(result.correlation ?? 0).toBeGreaterThanOrEqual(
					result.supportFloor ?? Number.POSITIVE_INFINITY,
				);
			}
		}
	});

	it("noise floor reduces to the classic 2/sqrt(n) bound for a single lag", () => {
		expect(strategyMapNoiseFloor(25, 1)).toBeCloseTo(2 / Math.sqrt(25), 12);
		// And scales up with the number of lags swept.
		expect(strategyMapNoiseFloor(25, 8)).toBeGreaterThan(
			strategyMapNoiseFloor(25, 1),
		);
	});
});

describe("buildStrategyMapValidation", () => {
	const access = { tediId: "tedi-1", orgId: "org-1" };
	const since = new Date("2026-06-01T00:00:00.000Z");

	function dayKey(index: number): string {
		return new Date(since.getTime() + index * 24 * 60 * 60 * 1000)
			.toISOString()
			.slice(0, 10);
	}

	it("recovers the injected skill-reuse → success lag from daily rows", () => {
		// Leading: reuse rate = BASE_RATES (denominator 20 keeps rates exact).
		const skillUsageDaily = BASE_RATES.map((rateValue, index) => ({
			day: dayKey(index),
			total: 20,
			reused: Math.round(rateValue * 20),
		}));
		// Lagging: success rate two days later equals the reuse rate.
		const decisionCompletedDaily = BASE_RATES.flatMap((_, index) =>
			index < 2
				? []
				: [
						{
							day: dayKey(index),
							completed: 20,
							successes: Math.round(BASE_RATES[index - 2] * 20),
							partials: 0,
							unverified: 0,
						},
					],
		);

		const report = buildStrategyMapValidation({
			access,
			windowDays: 28,
			maxLagDays: 7,
			since,
			generatedAt: "2026-06-29T00:00:00.000Z",
			skillUsageDaily,
			decisionCreatedDaily: [],
			decisionCompletedDaily,
			factDaily: [],
		});

		expect(report.bucketCount).toBe(28);
		const reuse = report.hypotheses.find(
			(h) => h.key === "skill_reuse_to_decision_success",
		);
		expect(reuse?.verdict).toBe("supported");
		expect(reuse?.bestLag).toBe(2);
		expect(reuse?.correlation).toBe(1);
		expect(reuse?.n).toBe(26);

		// The other chains have no rows → honest insufficient_data, never 0s.
		const linked = report.hypotheses.find(
			(h) => h.key === "linked_episodes_to_completion_quality",
		);
		const consolidation = report.hypotheses.find(
			(h) => h.key === "consolidation_to_citation",
		);
		expect(linked?.verdict).toBe("insufficient_data");
		expect(consolidation?.verdict).toBe("insufficient_data");
		expect(report.summary).toEqual({
			supported: 1,
			unsupported: 0,
			insufficientData: 2,
		});
	});

	it("treats zero-denominator days as missing signal, not 0 rates", () => {
		const skillUsageDaily = BASE_RATES.map((rateValue, index) => ({
			day: dayKey(index),
			// Every third day has no executions — must become null, not 0.
			total: index % 3 === 0 ? 0 : 20,
			reused: index % 3 === 0 ? 0 : Math.round(rateValue * 20),
		}));
		const decisionCompletedDaily = BASE_RATES.map((rateValue, index) => ({
			day: dayKey(index),
			completed: 20,
			successes: Math.round(rateValue * 20),
			partials: 0,
			unverified: 0,
		}));
		const report = buildStrategyMapValidation({
			access,
			windowDays: 28,
			maxLagDays: 7,
			since,
			generatedAt: "2026-06-29T00:00:00.000Z",
			skillUsageDaily,
			decisionCreatedDaily: [],
			decisionCompletedDaily,
			factDaily: [],
		});
		const reuse = report.hypotheses.find(
			(h) => h.key === "skill_reuse_to_decision_success",
		);
		const atLag0 = reuse?.lags.find((point) => point.lag === 0);
		// 28 days minus the 10 zero-denominator days.
		expect(atLag0?.n).toBe(18);
	});
});
