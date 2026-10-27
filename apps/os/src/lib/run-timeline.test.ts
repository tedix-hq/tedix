import { describe, expect, it } from "vite-plus/test";
import { runTimelineFixture } from "../../dev/run-timeline-fixture";
import {
	layoutRunTimeline,
	outputSample,
	parseRunReceipt,
	RUN_OUTPUT_SAMPLE_LIMIT,
} from "./run-timeline";

const start = Date.parse("2026-10-27T12:00:00Z");
function fixture() {
	return runTimelineFixture({
		id: "sample-run",
		status: "completed",
		startedAt: new Date(start).toISOString(),
		completedAt: new Date(start + 125000).toISOString(),
		executionEpoch: 0,
	});
}

describe("run timeline geometry", () => {
	it("uses a shared scale for all 251 receipts and separates overlapping calls", () => {
		const timeline = fixture();
		const layout = layoutRunTimeline(timeline, start + 900000);
		expect(layout.span).toBe(125000);
		expect(layout.lanes.flatMap((lane) => lane.entries)).toHaveLength(251);
		const lane = layout.lanes[0]!;
		expect(lane.tracks).toBe(2);
		expect(lane.entries[0]!.width).toBeCloseTo(1.6);
		expect(lane.entries[1]!.left).toBeCloseTo(0.8);
		expect(lane.entries[1]!.track).toBe(1);
	});
	it("keeps missing timestamps off the scale and never extends terminal pending calls to now", () => {
		const timeline = fixture();
		timeline.events[0] = {
			...timeline.events[0]!,
			startedAt: null,
			endedAt: null,
			durationMs: null,
		};
		timeline.events[1] = {
			...timeline.events[1]!,
			endedAt: null,
			durationMs: null,
			outcome: "pending",
		};
		const layout = layoutRunTimeline(timeline, start + 900000);
		expect(layout.untimed).toHaveLength(1);
		expect(layout.span).toBe(125000);
		expect(layout.lanes[1]!.entries[0]!.width).toBe(0);
	});
	it("extends a live wait to the current observation while preserving unknown duration", () => {
		const timeline = fixture();
		timeline.run.status = "paused";
		timeline.run.completedAt = null;
		timeline.events = [
			{
				...timeline.events.at(-1)!,
				endedAt: null,
				durationMs: null,
				outcome: "pending",
			},
		];
		const layout = layoutRunTimeline(timeline, start + 60000);
		expect(layout.span).toBe(60000);
		expect(layout.lanes[2]!.entries[0]!.end).toBe(start + 60000);
		expect(timeline.events[0]!.durationMs).toBeNull();
	});
});

describe("receipt samples", () => {
	it("bounds long output and keeps untrusted markup as text", () => {
		const sample = outputSample("<script>bad()</script>" + "x".repeat(9000))!;
		expect(sample).toContain("<script>bad()</script>");
		expect(sample).toContain("Sample truncated");
		expect(sample.length).toBeLessThan(RUN_OUTPUT_SAMPLE_LIMIT + 100);
	});
	it("handles text artifacts, empty content and JSON receipts", () => {
		expect(parseRunReceipt("plain text")).toEqual({ value: "plain text" });
		expect(parseRunReceipt('{"error":"failed"}')).toEqual({ error: "failed" });
		expect(parseRunReceipt(null)).toEqual({});
		expect(outputSample(undefined)).toBeNull();
	});
});
