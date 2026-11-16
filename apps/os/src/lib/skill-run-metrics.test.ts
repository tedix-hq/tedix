import { describe, expect, it } from "vite-plus/test";
import { metricRangeStart, skillRunMetrics } from "./skill-run-metrics";

const now = new Date("2026-11-16T12:30:00.000Z");
const run = (
	status: "completed" | "failed" | "running",
	startedAt: string,
	seconds = 10,
) => ({
	status,
	trigger: null,
	startedAt,
	completedAt: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
});

describe("skillRunMetrics", () => {
	it("counts runs, success rate and median duration inside the range", () => {
		const metrics = skillRunMetrics(
			[
				run("completed", "2026-11-16T11:00:00.000Z", 10),
				run("completed", "2026-11-16T10:00:00.000Z", 30),
				run("failed", "2026-11-16T09:00:00.000Z", 5),
				run("running", "2026-11-16T12:10:00.000Z"),
				run("completed", "2026-11-10T09:00:00.000Z"),
			],
			"24h",
			now,
		);
		expect(metrics.runs).toBe(4);
		expect(metrics.completed).toBe(2);
		expect(metrics.failed).toBe(1);
		expect(metrics.successRate).toBeCloseTo(2 / 3);
		expect(metrics.medianDurationMs).toBe(20_000);
		expect(metrics.buckets).toHaveLength(24);
		expect(
			metrics.buckets.reduce((n, b) => n + b.completed + b.failed, 0),
		).toBe(3);
	});

	it("has no rate or median before a run finishes", () => {
		const metrics = skillRunMetrics([], "7d", now);
		expect(metrics.runs).toBe(0);
		expect(metrics.successRate).toBeNull();
		expect(metrics.medianDurationMs).toBeNull();
		expect(metrics.buckets).toHaveLength(7);
	});

	it("buckets 30 days by local day", () => {
		const metrics = skillRunMetrics(
			[run("failed", "2026-11-15T08:00:00.000Z")],
			"30d",
			now,
		);
		expect(metrics.buckets).toHaveLength(30);
		expect(metrics.failed).toBe(1);
		expect(metrics.buckets.some((bucket) => bucket.failed === 1)).toBe(true);
	});

	it("cuts the range start to the hour", () => {
		expect(metricRangeStart("24h", now)).toBe("2026-11-15T12:00:00.000Z");
	});
});
