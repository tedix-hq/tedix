/**
 * Reference-Class Estimates (P5 Kahneman decision-hygiene pack)
 *
 * Outside-view forecasting operationalized: Kahneman & Tversky's 1977
 * "Intuitive Prediction: Biases and Corrective Procedures" and Lovallo &
 * Kahneman's 2003 "Delusions of Success" showed that estimates anchored on
 * the distribution of comparable past cases (the reference class) beat
 * inside-view estimates built from a plan's own particulars. This module
 * gives planners (tedis creating objectives/tasks) that distribution from
 * the tedi's OWN completed episode history instead of an LLM guess.
 *
 * Task identity is exactly the learning-curve identity
 * (`learningCurveRawEpisodesSql` in ./flywheel/learning-curves.ts): explicit
 * `evidence.taskType`, then `skill:{slug}` from `evidence.skillSlug`, then
 * rationale category. The SQL is reused, not duplicated, so the estimate is
 * computed over the same episode population the learning curves report on.
 *
 * The statistics are deliberately distributional (median/p80), not means:
 * reference-class forecasting corrects the planning fallacy by quoting where
 * comparable episodes actually landed, and p80 is the standard contingency
 * quantile for "plan to this, not to the median".
 */

import { sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type FlywheelAccess,
	LEARNING_TREND_THRESHOLDS,
	learningCurveRawEpisodesSql,
} from "./flywheel/learning-curves";

// ============================================================================
// Constants — part of the published method, not tunables
// ============================================================================

/** Episodes required before the estimate counts as a usable reference class. */
export const REFERENCE_CLASS_MIN_EPISODES = 3;

/** Episodes required (2 per half) before a trend verdict is issued. */
export const REFERENCE_CLASS_MIN_TREND_EPISODES = 4;

/** Hard cap on episodes pulled into one estimate. */
export const REFERENCE_CLASS_MAX_EPISODES = 500;

export const REFERENCE_CLASS_DEFAULT_WINDOW_DAYS = 30;

// ============================================================================
// Types
// ============================================================================

/** One completed episode, ordered oldest → newest when passed in arrays. */
export interface ReferenceClassEpisode {
	outcomeStatus: string;
	/** Wall-clock created→completed in ms; null when never completed-stamped. */
	durationMs: number | null;
	/** Mechanical tool-call/step count from execution links. */
	toolCallCount: number;
}

export interface ReferenceClassMetric {
	/** Interpolated median over available samples; null when no samples. */
	median: number | null;
	/** Nearest-rank 80th percentile; null when no samples. */
	p80: number | null;
	samples: number;
}

export type ReferenceClassTrend =
	| "improving"
	| "flat"
	| "regressing"
	| "insufficient_data";

export interface ReferenceClassEstimate {
	taskType: string;
	windowDays: number;
	since: string;
	generatedAt: string;
	episodeCount: number;
	successRate: number;
	durationMs: ReferenceClassMetric;
	toolCallCount: ReferenceClassMetric;
	/** First-half vs second-half comparison (learning-curve convention). */
	trend: ReferenceClassTrend;
	/** `reference_class` once REFERENCE_CLASS_MIN_EPISODES episodes exist. */
	verdict: "reference_class" | "insufficient_data";
}

// ============================================================================
// Pure math
// ============================================================================

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** Interpolated median (average of the two middle values for even n). */
export function medianOf(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]!
		: round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Nearest-rank percentile: value at ceil(q·n) in the sorted sample. */
export function percentileOf(values: number[], q: number): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(q * sorted.length) - 1),
	);
	return sorted[rank]!;
}

function summarizeMetric(values: number[]): ReferenceClassMetric {
	return {
		median: medianOf(values),
		p80: percentileOf(values, 0.8),
		samples: values.length,
	};
}

function successRateOf(episodes: ReferenceClassEpisode[]): number {
	if (episodes.length === 0) return 0;
	const successes = episodes.filter(
		(episode) => episode.outcomeStatus === "success",
	).length;
	return round3(successes / episodes.length);
}

/**
 * First-half (baseline) vs second-half (recent) comparison, applying the
 * shared learning-trend envelope (LEARNING_TREND_THRESHOLDS in ./flywheel/learning-curves.ts)
 * to success rate and median duration.
 */
function trendOf(episodes: ReferenceClassEpisode[]): ReferenceClassTrend {
	if (episodes.length < REFERENCE_CLASS_MIN_TREND_EPISODES) {
		return "insufficient_data";
	}
	const midpoint = Math.floor(episodes.length / 2);
	const baseline = episodes.slice(0, midpoint);
	const recent = episodes.slice(midpoint);
	const baselineSuccess = successRateOf(baseline);
	const recentSuccess = successRateOf(recent);
	const baselineDuration = medianOf(
		baseline
			.map((episode) => episode.durationMs)
			.filter((value): value is number => value !== null),
	);
	const recentDuration = medianOf(
		recent
			.map((episode) => episode.durationMs)
			.filter((value): value is number => value !== null),
	);
	const durationsComparable =
		baselineDuration !== null && recentDuration !== null;
	if (baselineSuccess - recentSuccess > LEARNING_TREND_THRESHOLDS.successDrop) {
		return "regressing";
	}
	if (
		durationsComparable &&
		recentDuration >
			baselineDuration * LEARNING_TREND_THRESHOLDS.durationGrowthFactor
	) {
		return "regressing";
	}
	if (
		recentSuccess >=
		baselineSuccess + LEARNING_TREND_THRESHOLDS.successGain
	) {
		return "improving";
	}
	if (
		durationsComparable &&
		recentDuration <=
			baselineDuration * LEARNING_TREND_THRESHOLDS.improvementShrinkFactor
	) {
		return "improving";
	}
	return "flat";
}

/**
 * Pure reference-class math over episodes ordered oldest → newest.
 * Exposed separately from the DB read so it is testable on synthetic data.
 */
export function computeReferenceClassEstimate(input: {
	taskType: string;
	windowDays: number;
	since: string;
	episodes: ReferenceClassEpisode[];
}): ReferenceClassEstimate {
	const { taskType, windowDays, since, episodes } = input;
	const durations = episodes
		.map((episode) => episode.durationMs)
		.filter((value): value is number => value !== null);
	const toolCallCounts = episodes.map((episode) => episode.toolCallCount);
	return {
		taskType,
		windowDays,
		since,
		generatedAt: new Date().toISOString(),
		episodeCount: episodes.length,
		successRate: successRateOf(episodes),
		durationMs: summarizeMetric(durations),
		toolCallCount: summarizeMetric(toolCallCounts),
		trend: trendOf(episodes),
		verdict:
			episodes.length >= REFERENCE_CLASS_MIN_EPISODES
				? "reference_class"
				: "insufficient_data",
	};
}

// ============================================================================
// DB read
// ============================================================================

type ReferenceClassEpisodeRow = {
	outcomeStatus: string;
	durationMs: number | null;
	steps: number | null;
};

/**
 * Reference-class estimate for one learning-curve task type, computed over
 * the same episode population as `getTaskTypeLearningCurves` (shared
 * `learningCurveRawEpisodesSql` CTE — do not fork the SQL).
 */
export async function getReferenceClassEstimate(
	db: DbClient,
	access: FlywheelAccess,
	options: { taskType: string; windowDays?: number },
): Promise<ReferenceClassEstimate> {
	const windowDays = Math.min(
		Math.max(options.windowDays ?? REFERENCE_CLASS_DEFAULT_WINDOW_DAYS, 7),
		180,
	);
	const since = new Date(
		Date.now() - windowDays * 24 * 60 * 60 * 1000,
	).toISOString();
	const rows = await db.all<ReferenceClassEpisodeRow>(
		sql`WITH raw_episodes AS (
			${learningCurveRawEpisodesSql(access, since)}
		)
		SELECT outcome_status AS outcomeStatus, durationMs, steps
		FROM raw_episodes
		WHERE taskType = ${options.taskType}
		ORDER BY created_at ASC, id ASC
		LIMIT ${REFERENCE_CLASS_MAX_EPISODES}`,
	);
	return computeReferenceClassEstimate({
		taskType: options.taskType,
		windowDays,
		since,
		episodes: rows.map((row) => ({
			outcomeStatus: row.outcomeStatus,
			durationMs: row.durationMs === null ? null : Number(row.durationMs),
			toolCallCount: Number(row.steps ?? 0),
		})),
	});
}
