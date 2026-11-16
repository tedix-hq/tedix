import type { SkillRunSummary } from "@tedix/api-contract/schemas/cognitive";
import { normalizeD1Timestamp } from "@/lib/time";

export const METRIC_RANGES = ["24h", "7d", "30d"] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export const METRIC_RANGE_LABELS: Record<MetricRange, string> = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
};

const HOUR_MS = 3_600_000;
const RANGE_HOURS: Record<MetricRange, number> = {
	"24h": 24,
	"7d": 24 * 7,
	"30d": 24 * 30,
};

/** Runs read per range; the metrics say so when a skill ran more often. */
export const METRIC_RUN_LIMIT = 200;

/** The earliest start a range admits, cut to the hour so reads are stable. */
export function metricRangeStart(
	range: MetricRange,
	now: Date = new Date(),
): string {
	const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
	return new Date(hour - RANGE_HOURS[range] * HOUR_MS).toISOString();
}

export type MetricBucket = {
	/** Start of the bucket, ISO. */
	start: string;
	completed: number;
	failed: number;
};

export type SkillRunMetrics = {
	runs: number;
	completed: number;
	failed: number;
	/** Completed over completed plus failed; null until a run has finished. */
	successRate: number | null;
	medianDurationMs: number | null;
	buckets: MetricBucket[];
};

function time(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(normalizeD1Timestamp(value));
	return Number.isNaN(parsed) ? null : parsed;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Counts for one range, with a bar per hour (24 hours) or per local day
 * (7 and 30 days). Runs that never started count in no bar.
 */
export function skillRunMetrics(
	runs: readonly Pick<
		SkillRunSummary,
		"status" | "startedAt" | "completedAt" | "trigger"
	>[],
	range: MetricRange,
	now: Date = new Date(),
): SkillRunMetrics {
	const from = Date.parse(metricRangeStart(range, now));
	const hourly = range === "24h";
	const buckets: MetricBucket[] = [];
	const step = hourly ? HOUR_MS : 0;
	if (hourly) {
		const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
		for (let at = from + HOUR_MS; at <= end; at += step)
			buckets.push({
				start: new Date(at).toISOString(),
				completed: 0,
				failed: 0,
			});
	} else {
		const days = RANGE_HOURS[range] / 24;
		const today = new Date(now);
		today.setHours(0, 0, 0, 0);
		for (let offset = days - 1; offset >= 0; offset -= 1) {
			const day = new Date(today);
			day.setDate(today.getDate() - offset);
			buckets.push({ start: day.toISOString(), completed: 0, failed: 0 });
		}
	}
	const starts = buckets.map((bucket) => Date.parse(bucket.start));
	let total = 0;
	let completed = 0;
	let failed = 0;
	const durations: number[] = [];
	for (const run of runs) {
		const started = time(run.startedAt);
		if (started == null || started < from || started > now.getTime()) continue;
		total += 1;
		let index = -1;
		for (let i = starts.length - 1; i >= 0; i -= 1)
			if (starts[i]! <= started) {
				index = i;
				break;
			}
		if (run.status === "completed") {
			completed += 1;
			if (index >= 0) buckets[index]!.completed += 1;
			const end = time(run.completedAt);
			if (end != null && end >= started) durations.push(end - started);
		} else if (run.status === "failed") {
			failed += 1;
			if (index >= 0) buckets[index]!.failed += 1;
		}
	}
	return {
		runs: total,
		completed,
		failed,
		successRate:
			completed + failed > 0 ? completed / (completed + failed) : null,
		medianDurationMs: median(durations),
		buckets,
	};
}
