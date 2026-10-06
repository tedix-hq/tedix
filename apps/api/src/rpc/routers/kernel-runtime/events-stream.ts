/**
 * Per-conversation kernel event stream (SSE).
 *
 * Push-delivery twin of `readRunEvents`: the same `kernel_runtime_events`
 * rows in the same `(created_at, id)` order, conversation-scoped so one
 * stream multiplexes every run the conversation interleaves. Contract in
 * `@tedix/api-contract/schemas/kernel-events-stream` — no new MCP verb;
 * `readRunEvents` remains the canonical projected replay for headless
 * callers, and this stream is a delivery hint over the identical log.
 *
 * Resume model: `Last-Event-ID` (or `?last_event_id=`) carries
 * `{conversationId}:{offset}`; the server replays everything after that
 * array-index offset from D1, then keeps polling the same query — replay and
 * live are one code path, so a dropped connection can never observe different
 * events than an unbroken one. Sessions rotate with a clean close after
 * `maxSessionMs`; EventSource reconnects with its own resume token.
 *
 * This module lives inside the `lint:authz --strict` tenant-scope scanned root on
 * purpose: every read binds `organizationId` into the query predicate, and
 * access requires `resolveKernelConversationAccess` (grant rows or org-wide
 * policy) before a single frame is written.
 */

import {
	formatKernelEventsStreamId,
	KERNEL_EVENTS_STREAM_HEARTBEAT_MS,
	KERNEL_EVENTS_STREAM_MAX_SESSION_MS,
	KERNEL_EVENTS_STREAM_PAGE,
	KERNEL_EVENTS_STREAM_POLL_MS,
	type KernelEventsStreamFrame,
	parseKernelEventsStreamLastEventId,
} from "@tedix/api-contract/schemas/kernel-events-stream";
import type { DbClient } from "@tedix/db/client";
import {
	type KernelRuntimeEvent,
	listKernelRuntimeEvents,
} from "@tedix/db/queries/kernel-runtime-events";
import { resolveKernelConversationAccess } from "../../../kernel/conversation-access";
import { sleep } from "@tedix/worker-kit/sleep";

export interface ConversationEventsStreamTiming {
	pollMs: number;
	heartbeatMs: number;
	maxSessionMs: number;
}

export interface ConversationEventsStreamParams {
	db: DbClient;
	organizationId: string;
	descopeUserId: string | null | undefined;
	conversationId: string;
	/** Raw Last-Event-ID header or `?last_event_id=` value; null starts at 0. */
	lastEventId: string | null;
	signal?: AbortSignal;
	timing?: Partial<ConversationEventsStreamTiming>;
}

const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-store",
	Connection: "keep-alive",
	"X-Accel-Buffering": "no",
} as const;

function toFrame(row: KernelRuntimeEvent): KernelEventsStreamFrame {
	return {
		id: row.id,
		kind: row.kind,
		conversationId: row.conversationId ?? undefined,
		runId: row.runId ?? undefined,
		messageId: row.messageId ?? undefined,
		sequence: row.sequence ?? undefined,
		delta: row.delta ?? undefined,
		payload: (row.payload ?? undefined) as KernelEventsStreamFrame["payload"],
		createdAt: row.createdAt,
	};
}

function encodeFrame(
	conversationId: string,
	offset: number,
	frame: KernelEventsStreamFrame,
): string {
	return `id: ${formatKernelEventsStreamId(conversationId, offset)}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Open the stream. Returns 403 before any SSE handshake when the caller may
 * not read the conversation; otherwise an SSE Response whose body replays
 * from the resume offset and then follows the log live.
 */
export async function openConversationEventsStream(
	params: ConversationEventsStreamParams,
): Promise<Response> {
	const {
		db,
		organizationId,
		descopeUserId,
		conversationId,
		lastEventId,
		signal,
	} = params;
	const timing: ConversationEventsStreamTiming = {
		pollMs: params.timing?.pollMs ?? KERNEL_EVENTS_STREAM_POLL_MS,
		heartbeatMs:
			params.timing?.heartbeatMs ?? KERNEL_EVENTS_STREAM_HEARTBEAT_MS,
		maxSessionMs:
			params.timing?.maxSessionMs ?? KERNEL_EVENTS_STREAM_MAX_SESSION_MS,
	};

	const access = await resolveKernelConversationAccess(db, {
		conversationId,
		descopeUserId,
		organizationId,
		required: "read",
	});
	if (!access.allowed) {
		return new Response("Access denied to Home conversation\n", {
			status: 403,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}

	// Offset of the last event the client saw; replay starts after it.
	const resumeOffset = parseKernelEventsStreamLastEventId(
		lastEventId,
		conversationId,
	);
	let offset = resumeOffset === null ? 0 : resumeOffset + 1;

	const encoder = new TextEncoder();
	const startedAt = Date.now();

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			let aborted = signal?.aborted ?? false;
			signal?.addEventListener("abort", () => {
				aborted = true;
			});
			let lastWriteAt = Date.now();

			const write = (text: string) => {
				controller.enqueue(encoder.encode(text));
				lastWriteAt = Date.now();
			};

			try {
				// Flush the SSE handshake immediately even when the conversation has no
				// replay rows. Proxies and EventSource otherwise remain "connecting" until
				// the first heartbeat, which makes a healthy empty stream look broken.
				write(": connected\n\n");
				// Replay and live tail are the same loop over the same query: read a
				// page after `offset`, emit, advance; when a page comes back short we
				// are at the head and switch to poll cadence.
				while (!aborted && Date.now() - startedAt < timing.maxSessionMs) {
					const rows = await listKernelRuntimeEvents(db, {
						organizationId,
						conversationId,
						order: "asc",
						limit: KERNEL_EVENTS_STREAM_PAGE,
						offset,
					});
					for (const row of rows) {
						write(encodeFrame(conversationId, offset, toFrame(row)));
						offset += 1;
					}
					if (rows.length === KERNEL_EVENTS_STREAM_PAGE) continue;
					if (aborted) break;
					if (Date.now() - lastWriteAt >= timing.heartbeatMs) {
						write(": hb\n\n");
					}
					await sleep(timing.pollMs);
				}
			} catch (error) {
				// A stream cannot carry an HTTP error anymore; emit a terminal error
				// frame so the client reports instead of silently reconnect-looping.
				console.error(
					`kernel events stream failed for conversation ${conversationId}: ${(error as Error).message}`,
				);
				try {
					write(
						`event: stream.error\ndata: ${JSON.stringify({ recoverable: true })}\n\n`,
					);
				} catch {
					// controller already closed — nothing left to signal
				}
			} finally {
				try {
					controller.close();
				} catch {
					// already closed by cancel
				}
			}
		},
	});

	return new Response(stream, { headers: SSE_HEADERS });
}
