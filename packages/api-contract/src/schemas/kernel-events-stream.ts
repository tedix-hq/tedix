/**
 * Per-conversation kernel event stream — the SSE wire contract.
 *
 * This is the push-delivery twin of `kernelRuntime.readRunEvents`: the same
 * `kernel_runtime_events` rows, the same `RuntimeStreamEvent` wire shape, but
 * conversation-scoped and delivered as Server-Sent Events so a browser can
 * hold one stream per Home conversation across every run it multiplexes.
 * There is deliberately NO new MCP verb: streams are delivery hints, and
 * `readRunEvents` (offset/tail long-poll) remains the canonical, projected
 * replay path for CLI and headless callers.
 *
 * Wire contract:
 * - `GET /kernel/runtime/conversations/{conversationId}/events/stream`
 * - Each SSE frame: `id: {conversationId}:{offset}` + `data: <RuntimeStreamEvent JSON>`.
 *   `offset` is the conversation-scoped array index of the event in
 *   `(created_at, id)` order — the same array-index offset model
 *   `readRunEvents` uses per run, applied to the conversation's event list.
 * - Resume: `Last-Event-ID` header, or `?last_event_id=` for clients that
 *   cannot set headers. The server replays every event AFTER the given offset
 *   from D1, then continues live. Re-delivery is safe: event `id`s are
 *   deterministic and offsets are stable, so client caches must be idempotent.
 * - Idle keepalive is an SSE comment frame (`: hb`); sessions are rotated by a
 *   clean close after `KERNEL_EVENTS_STREAM_MAX_SESSION_MS` — EventSource
 *   auto-reconnects with its `Last-Event-ID`, making rotation invisible.
 * - Terminal semantics are carried by the events themselves (`run.completed`
 *   etc.) exactly as in `readRunEvents`; the conversation stream itself does
 *   not close on run terminals because a conversation outlives its runs.
 */

import * as z from "zod";
import { RuntimeStreamEventSchema } from "./runtime-submissions";

export const KERNEL_EVENTS_STREAM_PATH =
	"/kernel/runtime/conversations/{conversationId}/events/stream";

/** Query params accepted by the stream route. */
export const KernelEventsStreamQuerySchema = z.object({
	last_event_id: z
		.string()
		.optional()
		.describe(
			"Resume token fallback for clients that cannot set the Last-Event-ID header; same `{conversationId}:{offset}` format",
		),
});

/** One data frame on the wire — identical to the readRunEvents event shape. */
export const KernelEventsStreamFrameSchema = RuntimeStreamEventSchema;
export type KernelEventsStreamFrame = z.infer<
	typeof KernelEventsStreamFrameSchema
>;

/** Rotate long-lived sessions so a single Workers request never runs unbounded. */
export const KERNEL_EVENTS_STREAM_MAX_SESSION_MS = 5 * 60 * 1000;
export const KERNEL_EVENTS_STREAM_HEARTBEAT_MS = 15_000;
export const KERNEL_EVENTS_STREAM_POLL_MS = 1_000;
export const KERNEL_EVENTS_STREAM_PAGE = 200;

export function formatKernelEventsStreamId(
	conversationId: string,
	offset: number,
): string {
	return `${conversationId}:${offset}`;
}

/**
 * Parse a resume token. Splits on the LAST colon (conversation ids may carry
 * colons), mirroring the tedi hub's `parseLastEventId`. Returns the offset of
 * the last event the client saw, or null when absent/foreign/malformed —
 * callers treat null as "start from 0".
 */
export function parseKernelEventsStreamLastEventId(
	value: string | null | undefined,
	conversationId: string,
): number | null {
	if (!value) return null;
	const separator = value.lastIndexOf(":");
	if (separator <= 0) return null;
	if (value.slice(0, separator) !== conversationId) return null;
	const offset = Number(value.slice(separator + 1));
	if (!Number.isInteger(offset) || offset < 0) return null;
	return offset;
}
