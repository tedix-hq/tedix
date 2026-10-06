/**
 * Tedi tool telemetry, derived from the canonical D1 runtime-event ledger
 * (`tedi_runtime_events`) read through `cognitiveRuntime.listEvents`.
 *
 * There is no dedicated telemetry endpoint: the `mcpTelemetry.*` plane is dead
 * (zero live emitters), and the ledger's `tool.completed` / `tool.failed`
 * events carry the whole dimension set — name, latency, error, execution link.
 * The shaping below is therefore client-side over a BOUNDED window, and every
 * helper here reports what that window excluded rather than presenting a slice
 * as a total.
 */

import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";

/**
 * Events requested per kind. `ListRuntimeEventsInputSchema` caps `limit` at
 * 500; 200 per kind (400 rows total, merged down to the most recent 200) is
 * stays well clear of the cap. Do NOT reuse
 * this constant for `rationaleRecords.list` or `growthSnapshots.list` — those
 * inherit the shared `PaginationSchema` cap of 100 and would 400.
 */
export const TOOL_EVENTS_LIMIT = 200;

export interface TediToolEvent {
	id: string;
	kind: string;
	/** `payload.name` — null when the emitter recorded no tool name. */
	toolName: string | null;
	/** completed → true, failed → false, anything else → null (unknown). */
	success: boolean | null;
	latencyMs: number | null;
	error: string | null;
	createdAt: string;
	runId: string | null;
	conversationId: string | null;
	toolCallId: string | null;
}

/**
 * Project one ledger event into the telemetry row shape.
 *
 * `payload` is an untyped JSON bag, so every field is probed rather than
 * asserted — the compact `summary: true` projection DROPS payload entirely,
 * which is exactly why the telemetry reads must never request it.
 */
export function mapRuntimeToolEvent(event: TediRuntimeEvent): TediToolEvent {
	const payload = (event.payload ?? {}) as Record<string, unknown>;
	return {
		id: event.id,
		kind: event.kind,
		toolName: typeof payload.name === "string" ? payload.name : null,
		success:
			event.kind === "tool.completed"
				? true
				: event.kind === "tool.failed"
					? false
					: null,
		latencyMs: typeof payload.latencyMs === "number" ? payload.latencyMs : null,
		error: typeof payload.error === "string" ? payload.error : null,
		createdAt: event.createdAt,
		runId: event.runId ?? null,
		conversationId: event.conversationId ?? null,
		toolCallId: event.toolCallId ?? null,
	};
}

/**
 * Merge the two per-kind reads into the most-recent `limit` tool events.
 *
 * `listEvents` filters by a SINGLE kind, so the completed and failed windows
 * are fetched separately and unioned. That is exact for "the most recent N
 * tool events": every true top-N event is also within its own kind's top-N.
 * Fetching unfiltered would be wrong — a busy tedi's newest events are
 * dominated by `message.delta` and may contain no tool events at all.
 *
 * Ties break on id so two identical ledgers always render in the same order.
 */
export function mergeToolEvents(
	completed: readonly TediRuntimeEvent[],
	failed: readonly TediRuntimeEvent[],
	limit: number = TOOL_EVENTS_LIMIT,
): TediToolEvent[] {
	return [...completed, ...failed]
		.map(mapRuntimeToolEvent)
		.sort(
			(a, b) =>
				b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
		)
		.slice(0, limit);
}

/**
 * True when either per-kind read came back full, meaning older tool events
 * exist outside the merged window. Every count derived from that window is
 * then a floor, and the surface must say so.
 */
export function toolWindowTruncated(
	completedCount: number,
	failedCount: number,
	limit: number = TOOL_EVENTS_LIMIT,
): boolean {
	return completedCount >= limit || failedCount >= limit;
}

export type ToolOutcomeFilter = "all" | "success" | "failure";

export interface ToolEventFilter {
	outcome?: ToolOutcomeFilter;
	/** Exact tool name; null/undefined means every tool. */
	toolName?: string | null;
}

/** The tool-name bucket an unnamed event falls into, shown as-is in the UI. */
export const UNNAMED_TOOL = "(unnamed tool)";

export function toolLabel(toolName: string | null): string {
	return toolName ?? UNNAMED_TOOL;
}

export function filterToolEvents(
	events: readonly TediToolEvent[],
	filter: ToolEventFilter = {},
): TediToolEvent[] {
	const outcome = filter.outcome ?? "all";
	const toolName = filter.toolName ?? null;
	return events.filter((event) => {
		if (outcome === "success" && event.success !== true) return false;
		if (outcome === "failure" && event.success !== false) return false;
		if (toolName !== null && toolLabel(event.toolName) !== toolName) {
			return false;
		}
		return true;
	});
}

/** Exact median over the values present; null when nothing carried a latency. */
export function medianLatencyMs(
	events: readonly TediToolEvent[],
): number | null {
	const values = events
		.map((event) => event.latencyMs)
		.filter((value): value is number => value !== null)
		.sort((a, b) => a - b);
	if (values.length === 0) return null;
	const middle = Math.floor(values.length / 2);
	return values.length % 2 === 1
		? values[middle]!
		: Math.round(((values[middle - 1]! + values[middle]!) / 2) * 10) / 10;
}

export interface ToolBreakdownRow {
	toolName: string;
	calls: number;
	failures: number;
	/** 0..1 over the calls in the window; never extrapolated. */
	successRate: number;
	medianLatencyMs: number | null;
}

/**
 * Per-tool rollup over the loaded window, busiest first.
 *
 * Ordered by call count, then failures (a failing tool outranks a clean one at
 * equal volume — that is the row an operator is looking for), then name so the
 * ordering is total and stable. `topN` truncates the LIST, never the counts of
 * the rows it keeps.
 */
export function deriveToolBreakdown(
	events: readonly TediToolEvent[],
	topN?: number,
): ToolBreakdownRow[] {
	const buckets = new Map<string, TediToolEvent[]>();
	for (const event of events) {
		const key = toolLabel(event.toolName);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(event);
		else buckets.set(key, [event]);
	}
	const rows = [...buckets.entries()].map(([toolName, bucket]) => {
		const failures = bucket.filter((event) => event.success === false).length;
		return {
			toolName,
			calls: bucket.length,
			failures,
			successRate: (bucket.length - failures) / bucket.length,
			medianLatencyMs: medianLatencyMs(bucket),
		};
	});
	rows.sort(
		(a, b) =>
			b.calls - a.calls ||
			b.failures - a.failures ||
			a.toolName.localeCompare(b.toolName),
	);
	return topN === undefined ? rows : rows.slice(0, topN);
}

export interface ToolTelemetrySummary {
	calls: number;
	failures: number;
	/** Null rather than a fake 100% when the window holds no calls at all. */
	successRate: number | null;
	medianLatencyMs: number | null;
	distinctTools: number;
	/** Oldest/newest event instant in the window, or null when it is empty. */
	oldestAt: string | null;
	newestAt: string | null;
}

export function summarizeToolEvents(
	events: readonly TediToolEvent[],
): ToolTelemetrySummary {
	const failures = events.filter((event) => event.success === false).length;
	const instants = events.map((event) => event.createdAt).sort();
	return {
		calls: events.length,
		failures,
		successRate:
			events.length === 0 ? null : (events.length - failures) / events.length,
		medianLatencyMs: medianLatencyMs(events),
		distinctTools: new Set(events.map((event) => toolLabel(event.toolName)))
			.size,
		oldestAt: instants[0] ?? null,
		newestAt: instants[instants.length - 1] ?? null,
	};
}
