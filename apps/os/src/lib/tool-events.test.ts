import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { describe, expect, it } from "vite-plus/test";
import {
	deriveToolBreakdown,
	filterToolEvents,
	mapRuntimeToolEvent,
	medianLatencyMs,
	mergeToolEvents,
	summarizeToolEvents,
	type TediToolEvent,
	TOOL_EVENTS_LIMIT,
	toolLabel,
	toolWindowTruncated,
	UNNAMED_TOOL,
} from "./tool-events";

const event = (
	id: string,
	kind: TediRuntimeEvent["kind"],
	createdAt: string,
	payload: Record<string, unknown> | undefined = undefined,
): TediRuntimeEvent => ({
	id,
	tediId: "tedi-1",
	kind,
	createdAt,
	...(payload === undefined ? {} : { payload }),
});

const row = (
	id: string,
	overrides: Partial<TediToolEvent> = {},
): TediToolEvent => ({
	id,
	kind: "tool.completed",
	toolName: "list_orders",
	success: true,
	latencyMs: 100,
	error: null,
	createdAt: "2026-08-12T00:00:00.000Z",
	runId: null,
	conversationId: null,
	toolCallId: null,
	...overrides,
});

describe("mapRuntimeToolEvent", () => {
	it("lifts name, latency, and error out of the untyped payload bag", () => {
		const mapped = mapRuntimeToolEvent(
			event("e1", "tool.failed", "2026-08-12T00:00:00.000Z", {
				name: "list_accounts",
				latencyMs: 15_020,
				error: "timeout",
			}),
		);
		expect(mapped.toolName).toBe("list_accounts");
		expect(mapped.latencyMs).toBe(15_020);
		expect(mapped.error).toBe("timeout");
		expect(mapped.success).toBe(false);
	});

	it("derives success from the KIND, never from the payload", () => {
		expect(
			mapRuntimeToolEvent(
				event("e1", "tool.completed", "t", { success: false }),
			).success,
		).toBe(true);
		expect(
			mapRuntimeToolEvent(event("e2", "tool.failed", "t", { success: true }))
				.success,
		).toBe(false);
	});

	it("leaves success unknown for a kind that has not settled", () => {
		expect(mapRuntimeToolEvent(event("e1", "tool.started", "t")).success).toBe(
			null,
		);
	});

	// The compact `summary: true` projection drops payload entirely. A telemetry
	// read must never request it, and the mapper must not invent values when it
	// is absent anyway.
	it("survives a payload-less event without inventing a name or latency", () => {
		const mapped = mapRuntimeToolEvent(event("e1", "tool.completed", "t"));
		expect(mapped.toolName).toBe(null);
		expect(mapped.latencyMs).toBe(null);
		expect(mapped.error).toBe(null);
	});
});

describe("mergeToolEvents", () => {
	it("interleaves the two per-kind reads newest-first", () => {
		const merged = mergeToolEvents(
			[
				event("c1", "tool.completed", "2026-08-12T03:00:00.000Z"),
				event("c2", "tool.completed", "2026-08-12T01:00:00.000Z"),
			],
			[event("f1", "tool.failed", "2026-08-12T02:00:00.000Z")],
		);
		expect(merged.map((e) => e.id)).toEqual(["c1", "f1", "c2"]);
	});

	it("caps at the merged window and breaks ties on id so renders are stable", () => {
		const same = "2026-08-12T00:00:00.000Z";
		const merged = mergeToolEvents(
			[event("b", "tool.completed", same), event("a", "tool.completed", same)],
			[event("c", "tool.failed", same)],
			2,
		);
		expect(merged.map((e) => e.id)).toEqual(["a", "b"]);
	});
});

describe("toolWindowTruncated", () => {
	it("is true when EITHER kind came back full", () => {
		expect(toolWindowTruncated(TOOL_EVENTS_LIMIT, 0)).toBe(true);
		expect(toolWindowTruncated(0, TOOL_EVENTS_LIMIT)).toBe(true);
		expect(toolWindowTruncated(5, 3)).toBe(false);
	});
});

describe("filterToolEvents", () => {
	const events = [
		row("a", { success: true, toolName: "list_orders" }),
		row("b", { success: false, toolName: "list_orders", kind: "tool.failed" }),
		row("c", { success: true, toolName: null }),
	];

	it("defaults to every event", () => {
		expect(filterToolEvents(events)).toHaveLength(3);
	});

	it("narrows by outcome", () => {
		expect(filterToolEvents(events, { outcome: "failure" })).toHaveLength(1);
		expect(filterToolEvents(events, { outcome: "success" })).toHaveLength(2);
	});

	it("narrows by tool, matching unnamed events by their displayed label", () => {
		expect(
			filterToolEvents(events, { toolName: "list_orders" }).map((e) => e.id),
		).toEqual(["a", "b"]);
		expect(
			filterToolEvents(events, { toolName: UNNAMED_TOOL }).map((e) => e.id),
		).toEqual(["c"]);
	});

	it("combines outcome and tool", () => {
		expect(
			filterToolEvents(events, { outcome: "failure", toolName: "list_orders" }),
		).toHaveLength(1);
	});
});

describe("medianLatencyMs", () => {
	it("returns the middle value for an odd count", () => {
		expect(
			medianLatencyMs([
				row("a", { latencyMs: 300 }),
				row("b", { latencyMs: 100 }),
				row("c", { latencyMs: 200 }),
			]),
		).toBe(200);
	});

	it("averages the two middles for an even count", () => {
		expect(
			medianLatencyMs([
				row("a", { latencyMs: 100 }),
				row("b", { latencyMs: 300 }),
			]),
		).toBe(200);
	});

	it("ignores events with no recorded latency, and is null when none have one", () => {
		expect(
			medianLatencyMs([
				row("a", { latencyMs: null }),
				row("b", { latencyMs: 50 }),
			]),
		).toBe(50);
		expect(medianLatencyMs([row("a", { latencyMs: null })])).toBe(null);
	});
});

describe("deriveToolBreakdown", () => {
	const events = [
		row("a", { toolName: "list_orders", latencyMs: 100 }),
		row("b", { toolName: "list_orders", latencyMs: 300 }),
		row("c", {
			toolName: "list_orders",
			success: false,
			kind: "tool.failed",
			latencyMs: 200,
		}),
		row("d", { toolName: "publish_report", latencyMs: 900 }),
		row("e", { toolName: "send_credit", success: false, kind: "tool.failed" }),
	];

	it("rolls calls, failures, rate, and median up per tool", () => {
		const [busiest] = deriveToolBreakdown(events);
		expect(busiest?.toolName).toBe("list_orders");
		expect(busiest?.calls).toBe(3);
		expect(busiest?.failures).toBe(1);
		expect(busiest?.successRate).toBeCloseTo(2 / 3);
		expect(busiest?.medianLatencyMs).toBe(200);
	});

	it("ranks a failing tool above a clean one at equal volume", () => {
		const rows = deriveToolBreakdown(events);
		const names = rows.map((r) => r.toolName);
		expect(names.indexOf("send_credit")).toBeLessThan(
			names.indexOf("publish_report"),
		);
	});

	it("buckets unnamed tools under one honest label", () => {
		const rows = deriveToolBreakdown([row("x", { toolName: null })]);
		expect(rows[0]?.toolName).toBe(toolLabel(null));
	});

	// topN truncates the LIST; it must never change the counts of the rows kept.
	it("topN truncates the list without changing the kept rows' counts", () => {
		const rows = deriveToolBreakdown(events, 1);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.calls).toBe(3);
	});
});

describe("summarizeToolEvents", () => {
	it("summarizes the window without extrapolating past it", () => {
		const summary = summarizeToolEvents([
			row("a", { createdAt: "2026-08-12T01:00:00.000Z" }),
			row("b", {
				success: false,
				kind: "tool.failed",
				createdAt: "2026-08-12T03:00:00.000Z",
			}),
			row("c", { toolName: "other", createdAt: "2026-08-12T02:00:00.000Z" }),
		]);
		expect(summary.calls).toBe(3);
		expect(summary.failures).toBe(1);
		expect(summary.successRate).toBeCloseTo(2 / 3);
		expect(summary.distinctTools).toBe(2);
		expect(summary.oldestAt).toBe("2026-08-12T01:00:00.000Z");
		expect(summary.newestAt).toBe("2026-08-12T03:00:00.000Z");
	});

	// A 100% success rate over zero calls is a lie an operator would act on.
	it("reports a null rate for an empty window rather than a perfect one", () => {
		const summary = summarizeToolEvents([]);
		expect(summary.calls).toBe(0);
		expect(summary.successRate).toBe(null);
		expect(summary.medianLatencyMs).toBe(null);
		expect(summary.oldestAt).toBe(null);
	});
});
