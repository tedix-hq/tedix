/**
 * Strategy-Map Causal-Lag Validation (P5 scorecard discipline)
 *
 * Benchmark v2 (`buildBrainBenchmarkReport` in ./flywheel/brain-benchmark.ts) is a de-facto
 * Balanced Scorecard: its stage→score chain asserts that leading learning
 * indicators drive lagging outcome measures. Kaplan/Norton call that chain a
 * strategy map; Nørreklit's critique is that the causal claims are usually
 * assumed, never tested — cause and effect need a time lag, and the lag must
 * be validated against the org's own data.
 *
 * This module tests the chain empirically: for each declared hypothesis it
 * computes lagged cross-correlations between a leading daily rate and a
 * lagging daily rate over UTC calendar-day buckets (lag k = 0..maxLagDays).
 * It is deliberately honest about statistical power: it reports effect size
 * (Pearson r) + sample size (paired buckets) and returns
 * `insufficient_data` below a floor — no p-value theater.
 *
 * The hypotheses map onto benchmark v2's causal chain
 * (documented in docs/engineering/cognition/brain.md § Strategy Map):
 *   learning stage  →  process stage  →  outcome stage
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { skillReusePriorEventSql } from "./flywheel/compounding-signals";
import type { FlywheelAccess } from "./flywheel/learning-curves";
import { evidenceReferencesFactsSql } from "./flywheel/evidence-references-facts";

// ============================================================================
// Constants — thresholds are part of the published method, not tunables
// ============================================================================

/** Minimum paired daily buckets before a correlation verdict is issued. */
export const STRATEGY_MAP_MIN_PAIRED_BUCKETS = 14;

/** Effect-size floor for a `supported` verdict (moderate positive Pearson r). */
export const STRATEGY_MAP_SUPPORT_THRESHOLD = 0.3;

export const STRATEGY_MAP_DEFAULT_WINDOW_DAYS = 28;
export const STRATEGY_MAP_DEFAULT_MAX_LAG_DAYS = 7;

/**
 * Selection-aware white-noise floor for the `supported` verdict.
 *
 * Picking the BEST of `lagsTested` lags is a multiple-comparison: with the
 * flat 0.3 threshold, pure white noise cleared it in ~50% of simulated
 * windows (28 daily buckets, 8 lags), and even the classic single-test
 * 2/√n bound still passed ~17% — best-of-8 selection inflates the maximum
 * observed r far above any single draw. This floor is that same 2/√n rule
 * Bonferroni-scaled for the sweep via the Gaussian tail bound
 * z(m)² ≈ z(1)² + 2·ln(m):
 *
 *   floor(n, m) = sqrt(4 + 2·ln(m)) / sqrt(n)
 *
 * It reduces to exactly 2/√n when one lag is tested and measured 0.9%
 * white-noise false-support over 1,000 seeded 28-day windows at m = 8.
 * Still no p-value theater: the verdict remains an effect-size floor over a
 * reported r and n — the floor itself ships in the payload (`supportFloor`)
 * so every verdict is recomputable by hand.
 */
export function strategyMapNoiseFloor(n: number, lagsTested: number): number {
	if (n <= 0) return Number.POSITIVE_INFINITY;
	return Math.sqrt(4 + 2 * Math.log(Math.max(1, lagsTested))) / Math.sqrt(n);
}

// ============================================================================
// Types
// ============================================================================

export type StrategyMapVerdict =
	| "supported"
	| "unsupported"
	| "insufficient_data";

export type StrategyMapHypothesisKey =
	| "skill_reuse_to_decision_success"
	| "linked_episodes_to_completion_quality"
	| "consolidation_to_citation";

export interface StrategyMapLagPoint {
	/** Lag in days: leading(t) vs lagging(t + lag). */
	lag: number;
	/** Pearson r, null when undefined (constant series or <2 pairs). */
	correlation: number | null;
	/** Paired daily buckets (both rates defined) at this lag. */
	n: number;
}

export interface StrategyMapHypothesis {
	key: StrategyMapHypothesisKey;
	/** Leading indicator (daily rate series). */
	leading: string;
	/** Lagging outcome (daily rate series). */
	lagging: string;
	/** Which strategy-map stage transition this hypothesis tests. */
	chain: string;
	/** Lag (days) with the strongest qualifying positive correlation. */
	bestLag: number | null;
	/** Pearson r at bestLag. */
	correlation: number | null;
	/** Paired buckets at bestLag (max available n when insufficient). */
	n: number;
	/** Lags swept for this hypothesis (bestLag is a best-of-`lagsTested` pick). */
	lagsTested: number;
	/**
	 * Effect-size floor r had to clear at the selected lag:
	 * max(supportThreshold, strategyMapNoiseFloor(n, lagsTested)).
	 * Null when no lag qualified (insufficient data).
	 */
	supportFloor: number | null;
	/** Why the floor exceeds the flat threshold — best-of-N selection bias. */
	selectionBiasNote: string;
	verdict: StrategyMapVerdict;
	/** Full lag sweep for operator inspection. */
	lags: StrategyMapLagPoint[];
}

export interface StrategyMapValidation {
	tediId: string;
	orgId: string;
	windowDays: number;
	maxLagDays: number;
	since: string;
	generatedAt: string;
	/** Daily buckets in the window (windowDays UTC calendar days). */
	bucketCount: number;
	minPairedBuckets: number;
	supportThreshold: number;
	hypotheses: StrategyMapHypothesis[];
	summary: {
		supported: number;
		unsupported: number;
		insufficientData: number;
	};
}

/** A daily rate observation: null = no signal that day (zero denominator). */
export type DailyRateSeries = Array<number | null>;

// ============================================================================
// Pure analysis
// ============================================================================

function pearson(pairs: Array<[number, number]>): number | null {
	const n = pairs.length;
	if (n < 2) return null;
	let sumX = 0;
	let sumY = 0;
	for (const [x, y] of pairs) {
		sumX += x;
		sumY += y;
	}
	const meanX = sumX / n;
	const meanY = sumY / n;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const [x, y] of pairs) {
		const dx = x - meanX;
		const dy = y - meanY;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	// A constant series carries no correlational signal — undefined, not 0.
	if (sxx <= 0 || syy <= 0) return null;
	return sxy / Math.sqrt(sxx * syy);
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Lagged cross-correlation sweep: for each k in 0..maxLag, correlate
 * leading[t] with lagging[t + k] over every t where both are defined.
 */
export function laggedCorrelations(
	leading: DailyRateSeries,
	lagging: DailyRateSeries,
	maxLag: number,
): StrategyMapLagPoint[] {
	const points: StrategyMapLagPoint[] = [];
	const length = Math.min(leading.length, lagging.length);
	for (let lag = 0; lag <= maxLag; lag++) {
		const pairs: Array<[number, number]> = [];
		for (let t = 0; t + lag < length; t++) {
			const lead = leading[t];
			const lagValue = lagging[t + lag];
			if (
				lead !== null &&
				lead !== undefined &&
				lagValue !== null &&
				lagValue !== undefined
			) {
				pairs.push([lead, lagValue]);
			}
		}
		const correlation = pearson(pairs);
		points.push({
			lag,
			correlation: correlation === null ? null : round3(correlation),
			n: pairs.length,
		});
	}
	return points;
}

function selectionBiasNote(lagsTested: number): string {
	return (
		`bestLag is the best of ${lagsTested} tested lags, so the supported ` +
		"floor is max(supportThreshold, sqrt(4 + 2*ln(lagsTested))/sqrt(n)) — " +
		"the 2/sqrt(n) white-noise bound scaled for best-of-N selection bias."
	);
}

/**
 * Evaluate one hypothesis from its lag sweep. Verdict rules:
 * - `insufficient_data`: no lag has a defined correlation over at least
 *   `minPairedBuckets` paired buckets.
 * - `supported`: best qualifying (signed) correlation ≥
 *   max(`supportThreshold`, {@link strategyMapNoiseFloor}) at the selected
 *   lag — the hypotheses are directional, so only positive association
 *   supports, and because the selected lag is a best-of-`lagsTested` pick the
 *   floor scales with both n and the number of lags swept.
 * - `unsupported`: enough data, but the best correlation falls short.
 */
export function evaluateStrategyMapHypothesis(input: {
	key: StrategyMapHypothesisKey;
	leading: string;
	lagging: string;
	chain: string;
	leadingSeries: DailyRateSeries;
	laggingSeries: DailyRateSeries;
	maxLag: number;
	minPairedBuckets?: number;
	supportThreshold?: number;
}): StrategyMapHypothesis {
	const minPairedBuckets =
		input.minPairedBuckets ?? STRATEGY_MAP_MIN_PAIRED_BUCKETS;
	const supportThreshold =
		input.supportThreshold ?? STRATEGY_MAP_SUPPORT_THRESHOLD;
	const lags = laggedCorrelations(
		input.leadingSeries,
		input.laggingSeries,
		input.maxLag,
	);
	const lagsTested = lags.length;
	const qualifying = lags.filter(
		(point) => point.correlation !== null && point.n >= minPairedBuckets,
	);
	if (qualifying.length === 0) {
		return {
			key: input.key,
			leading: input.leading,
			lagging: input.lagging,
			chain: input.chain,
			bestLag: null,
			correlation: null,
			n: Math.max(0, ...lags.map((point) => point.n)),
			lagsTested,
			supportFloor: null,
			selectionBiasNote: selectionBiasNote(lagsTested),
			verdict: "insufficient_data",
			lags,
		};
	}
	const best = qualifying.reduce((acc, point) =>
		(point.correlation ?? Number.NEGATIVE_INFINITY) >
		(acc.correlation ?? Number.NEGATIVE_INFINITY)
			? point
			: acc,
	);
	const supportFloor = round3(
		Math.max(supportThreshold, strategyMapNoiseFloor(best.n, lagsTested)),
	);
	return {
		key: input.key,
		leading: input.leading,
		lagging: input.lagging,
		chain: input.chain,
		bestLag: best.lag,
		correlation: best.correlation,
		n: best.n,
		lagsTested,
		supportFloor,
		selectionBiasNote: selectionBiasNote(lagsTested),
		verdict:
			(best.correlation ?? 0) >= supportFloor ? "supported" : "unsupported",
		lags,
	};
}

// ============================================================================
// Daily-series assembly from aggregate rows
// ============================================================================

export interface SkillUsageDailyRow {
	day: string;
	total: number;
	reused: number;
}

export interface DecisionCreatedDailyRow {
	day: string;
	decisions: number;
	linked: number;
	cited: number;
}

export interface DecisionCompletedDailyRow {
	day: string;
	completed: number;
	successes: number;
	partials: number;
	unverified: number;
}

export interface FactDailyRow {
	day: string;
	created: number;
	consolidated: number;
}

function utcDayKeys(since: Date, dayCount: number): string[] {
	const keys: string[] = [];
	for (let index = 0; index < dayCount; index++) {
		keys.push(
			new Date(since.getTime() + index * 24 * 60 * 60 * 1000)
				.toISOString()
				.slice(0, 10),
		);
	}
	return keys;
}

function toSeries<Row extends { day: string }>(
	rows: Row[],
	dayKeys: string[],
	toRate: (row: Row) => number | null,
): DailyRateSeries {
	const byDay = new Map(rows.map((row) => [row.day, row]));
	return dayKeys.map((day) => {
		const row = byDay.get(day);
		if (!row) return null;
		return toRate(row);
	});
}

function ratio(numerator: number, denominator: number): number | null {
	if (denominator <= 0) return null;
	return Math.min(1, numerator / denominator);
}

/**
 * Pure builder: assemble the daily series and evaluate every hypothesis.
 * Split from `getStrategyMapValidation` so the analysis is unit-testable
 * with synthetic rows.
 */
export function buildStrategyMapValidation(input: {
	access: FlywheelAccess;
	windowDays: number;
	maxLagDays: number;
	since: Date;
	generatedAt: string;
	skillUsageDaily: SkillUsageDailyRow[];
	decisionCreatedDaily: DecisionCreatedDailyRow[];
	decisionCompletedDaily: DecisionCompletedDailyRow[];
	factDaily: FactDailyRow[];
}): StrategyMapValidation {
	const dayKeys = utcDayKeys(input.since, input.windowDays);

	// Leading indicators (learning/process discipline).
	const skillReuseRate = toSeries(input.skillUsageDaily, dayKeys, (row) =>
		ratio(Number(row.reused), Number(row.total)),
	);
	const linkedEpisodeRate = toSeries(
		input.decisionCreatedDaily,
		dayKeys,
		(row) => ratio(Number(row.linked), Number(row.decisions)),
	);
	const consolidationRate = toSeries(input.factDaily, dayKeys, (row) =>
		ratio(Number(row.consolidated), Number(row.created)),
	);

	// Lagging outcomes.
	const decisionSuccessRate = toSeries(
		input.decisionCompletedDaily,
		dayKeys,
		(row) =>
			ratio(
				Number(row.successes) + 0.5 * Number(row.partials),
				Number(row.completed),
			),
	);
	// Completion quality = proof-verified terminal share (WS1: a success claim
	// without a proof ref settles as `unverified`).
	const completionQualityRate = toSeries(
		input.decisionCompletedDaily,
		dayKeys,
		(row) =>
			ratio(
				Number(row.completed) - Number(row.unverified),
				Number(row.completed),
			),
	);
	// Citation rate is the day-bucketable member of the retrieval/citation
	// pair: per-day retrieval cannot be reconstructed from `access_count` +
	// `last_accessed_at` (a single latest-access timestamp, not a ledger).
	const citationRate = toSeries(input.decisionCreatedDaily, dayKeys, (row) =>
		ratio(Number(row.cited), Number(row.decisions)),
	);

	const hypotheses: StrategyMapHypothesis[] = [
		evaluateStrategyMapHypothesis({
			key: "skill_reuse_to_decision_success",
			leading: "skill_reuse_rate",
			lagging: "decision_success_rate",
			chain: "process → outcome",
			leadingSeries: skillReuseRate,
			laggingSeries: decisionSuccessRate,
			maxLag: input.maxLagDays,
		}),
		evaluateStrategyMapHypothesis({
			key: "linked_episodes_to_completion_quality",
			leading: "linked_episode_rate",
			lagging: "completion_quality_rate",
			chain: "learning → process",
			leadingSeries: linkedEpisodeRate,
			laggingSeries: completionQualityRate,
			maxLag: input.maxLagDays,
		}),
		evaluateStrategyMapHypothesis({
			key: "consolidation_to_citation",
			leading: "consolidation_rate",
			lagging: "citation_rate",
			chain: "learning → process",
			leadingSeries: consolidationRate,
			laggingSeries: citationRate,
			maxLag: input.maxLagDays,
		}),
	];

	return {
		tediId: input.access.tediId,
		orgId: input.access.orgId,
		windowDays: input.windowDays,
		maxLagDays: input.maxLagDays,
		since: input.since.toISOString(),
		generatedAt: input.generatedAt,
		bucketCount: dayKeys.length,
		minPairedBuckets: STRATEGY_MAP_MIN_PAIRED_BUCKETS,
		supportThreshold: STRATEGY_MAP_SUPPORT_THRESHOLD,
		hypotheses,
		summary: {
			supported: hypotheses.filter((h) => h.verdict === "supported").length,
			unsupported: hypotheses.filter((h) => h.verdict === "unsupported").length,
			insufficientData: hypotheses.filter(
				(h) => h.verdict === "insufficient_data",
			).length,
		},
	};
}

// ============================================================================
// Queries
// ============================================================================

export async function getStrategyMapValidation(
	db: DbClient,
	access: FlywheelAccess,
	options: { windowDays?: number; maxLagDays?: number } = {},
): Promise<StrategyMapValidation> {
	const windowDays = Math.min(
		Math.max(options.windowDays ?? STRATEGY_MAP_DEFAULT_WINDOW_DAYS, 14),
		90,
	);
	const maxLagDays = Math.min(
		Math.max(options.maxLagDays ?? STRATEGY_MAP_DEFAULT_MAX_LAG_DAYS, 1),
		14,
	);
	// Window = the last `windowDays` UTC calendar days, inclusive of today.
	const todayUtc = new Date(
		`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
	);
	const since = new Date(
		todayUtc.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000,
	);
	const sinceIso = since.toISOString();

	const [
		skillUsageDaily,
		decisionCreatedDaily,
		decisionCompletedDaily,
		factDaily,
	] = await Promise.all([
		db.all<SkillUsageDailyRow>(
			sql`SELECT date(usage.created_at) AS day,
					count(*) AS total,
					sum(CASE WHEN ${skillReusePriorEventSql("usage")} THEN 1 ELSE 0 END) AS reused
				FROM skill_usage_events usage
				WHERE usage.tedi_id = ${access.tediId}
					AND usage.organization_id = ${access.orgId}
					AND usage.created_at >= ${sinceIso}
				GROUP BY date(usage.created_at)`,
		),
		db.all<DecisionCreatedDailyRow>(
			sql`SELECT date(created_at) AS day,
					count(*) AS decisions,
					sum(CASE WHEN run_id IS NOT NULL
						OR work_item_id IS NOT NULL
						OR (tool_call_refs IS NOT NULL AND json_valid(tool_call_refs)
							AND json_array_length(tool_call_refs) > 0)
						THEN 1 ELSE 0 END) AS linked,
					sum(CASE WHEN ${evidenceReferencesFactsSql()} THEN 1 ELSE 0 END) AS cited
				FROM tedi_rationale_records
				WHERE tedi_id = ${access.tediId}
					AND org_id = ${access.orgId}
					AND created_at >= ${sinceIso}
				GROUP BY date(created_at)`,
		),
		db.all<DecisionCompletedDailyRow>(
			sql`SELECT date(completed_at) AS day,
					count(*) AS completed,
					sum(CASE WHEN outcome_status = 'success' THEN 1 ELSE 0 END) AS successes,
					sum(CASE WHEN outcome_status = 'partial' THEN 1 ELSE 0 END) AS partials,
					sum(CASE WHEN outcome_status = 'unverified' THEN 1 ELSE 0 END) AS unverified
				FROM tedi_rationale_records
				WHERE tedi_id = ${access.tediId}
					AND org_id = ${access.orgId}
					AND outcome_status != 'pending'
					AND completed_at IS NOT NULL
					AND completed_at >= ${sinceIso}
				GROUP BY date(completed_at)`,
		),
		db.all<FactDailyRow>(
			sql`SELECT day, sum(created) AS created, sum(consolidated) AS consolidated FROM (
					SELECT date(created_at) AS day, count(*) AS created, 0 AS consolidated
					FROM memory_facts
					WHERE organization_id = ${access.orgId}
						AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
						AND created_at >= ${sinceIso}
					GROUP BY date(created_at)
					UNION ALL
					SELECT date(COALESCE(archived_at, valid_to)) AS day, 0 AS created, count(*) AS consolidated
					FROM memory_facts
					WHERE organization_id = ${access.orgId}
						AND (tedi_id = ${access.tediId} OR tedi_id IS NULL)
						AND COALESCE(archived_at, valid_to) >= ${sinceIso}
					GROUP BY date(COALESCE(archived_at, valid_to))
				) GROUP BY day`,
		),
	]);

	return buildStrategyMapValidation({
		access,
		windowDays,
		maxLagDays,
		since,
		generatedAt: new Date().toISOString(),
		skillUsageDaily,
		decisionCreatedDaily,
		decisionCompletedDaily,
		factDaily,
	});
}
