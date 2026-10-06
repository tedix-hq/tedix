/**
 * Pure conversation-stream primitives for the Cap'n Web chat transport.
 *
 * Kept free of the DOM, React, and any API origin so the Cap'n Web connection
 * machine can be loaded in a workerd isolate for the real-socket roundtrip
 * test (`@/lib/api` reads `window` at module scope and must stay out).
 */

import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import {
	createResumeWatermarkStore,
	type ResumeWatermarkStore,
} from "@tedix/chat-transport/resume-watermark";
import type { CapnStreamCursor } from "@/capnweb/contract";

// ---------------------------------------------------------------------------
// Wire helpers (pure, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Reconnect backoff: 1s doubling to a 30s ceiling. `attempt` is the number of
 * consecutive failures since the last received event — any delivered event
 * resets it.
 */
export const STREAM_BACKOFF_MIN_MS = 1_000;
export const STREAM_BACKOFF_MAX_MS = 30_000;

/**
 * Jitter band applied to every backoff step: `base * [0.85, 1.15)`.
 *
 * Without it the ladder is deterministic, so every OS tab that lost the socket
 * to the SAME event — a deploy, a Worker restart, a middlebox blip — re-dials
 * on the SAME millisecond and keeps doing so at every rung. The band is
 * centered on the nominal step (mean 1.0) so the ladder's shape is unchanged;
 * only the alignment between tabs is broken.
 */
export const STREAM_BACKOFF_JITTER_FLOOR = 0.85;
export const STREAM_BACKOFF_JITTER_SPREAD = 0.3;

/**
 * The jittered delay before retry number `attempt`.
 *
 * `random` is injected so the band is testable deterministically; production
 * passes nothing and gets `Math.random`. A value outside `[0, 1)` is clamped
 * rather than trusted — the seam is a test seam, not an escape hatch past the
 * {@link STREAM_BACKOFF_MAX_MS} ceiling, which still bounds the RESULT.
 */
export function nextBackoffDelayMs(
	attempt: number,
	random: () => number = Math.random,
): number {
	const exponent = Math.min(Math.max(attempt, 0), 31);
	const base = Math.min(
		STREAM_BACKOFF_MIN_MS * 2 ** exponent,
		STREAM_BACKOFF_MAX_MS,
	);
	const roll = Math.min(Math.max(random(), 0), 1);
	const jittered =
		base * (STREAM_BACKOFF_JITTER_FLOOR + roll * STREAM_BACKOFF_JITTER_SPREAD);
	return Math.round(Math.min(jittered, STREAM_BACKOFF_MAX_MS));
}

export type ConversationStreamFrame = {
	/** Run-local durable offset from `readRunEvents` — restarts at 0 per run. */
	offset: number;
	/** The Cap'n frame id (`{conversationId}:{runId}:{offset}`) — the dedupe key. */
	eventId: string;
	event: RuntimeStreamEvent;
};

/**
 * Idempotent frame reducer keyed by `frame.eventId`, so a re-delivered frame
 * (a reconnect's snapshot overlap) is a plain overwrite. Returns whether the
 * id was previously unseen — only unseen frames are dispatched to subscribers.
 *
 * The key is the ID, not the raw offset: Cap'n Web ids are
 * `{conversationId}:{runId}:{offset}` over RUN-LOCAL offsets that restart at 0
 * for every run. Keying by offset made run 2's first event a "duplicate" of
 * run 1's and dropped it.
 */
export function recordStreamFrame(
	frames: Map<string, ConversationStreamFrame>,
	frame: ConversationStreamFrame,
): boolean {
	const unseen = !frames.has(frame.eventId);
	frames.set(frame.eventId, frame);
	return unseen;
}

// ---------------------------------------------------------------------------
// Resume watermarks across machine lifetimes
// ---------------------------------------------------------------------------

/**
 * The tab's resume watermarks, keyed by conversation id.
 *
 * `capn-chat-machine.ts` already resumes across a SOCKET death — it holds the
 * last `(runId, offset)` the server issued and re-subscribes from it. What it
 * cannot do alone is survive its own teardown: `realtime-connection.ts` closes
 * the machine on navigation and evicts it under the client-side entry cap, so
 * the next acquire built a machine with a null cursor and the server re-served
 * the current run from offset 0 — up to a full 200-row page, fanned out as
 * LIVE frames. Parking the cursor here makes that reconnect a gap replay.
 *
 * The store itself is the shared `@tedix/chat-transport` seam (the embedded
 * lane's cursor discipline, generalized), not a second implementation: the
 * clean-settle rule that decides when a position may be trusted lives there,
 * once. This module only fixes the cursor TYPE and the process-wide instance.
 */
export type ConversationResumeWatermarks =
	ResumeWatermarkStore<CapnStreamCursor>;

let resumeWatermarks: ConversationResumeWatermarks | null = null;

/** Created on first use so a tab that never streams never allocates one. */
export function getConversationResumeWatermarks(): ConversationResumeWatermarks {
	resumeWatermarks ??= createResumeWatermarkStore<CapnStreamCursor>();
	return resumeWatermarks;
}

/**
 * Drop every parked watermark. Module state is process-wide by design, so a
 * suite that streams must call this or it inherits the previous one's resume
 * positions and "cold open" assertions pass for the wrong reason.
 */
export function resetConversationResumeWatermarks(): void {
	resumeWatermarks?.clear();
	resumeWatermarks = null;
}

export type ConversationStreamStatus =
	| "idle"
	| "connecting"
	| "open"
	| "reconnecting";

// ---------------------------------------------------------------------------
// rAF-coalesced flush (pure factory, exported for tests)
// ---------------------------------------------------------------------------

export type FrameScheduler = (callback: () => void) => void;

/** rAF when the browser provides it; a 16ms timeout outside (tests, SSR). */
export const defaultFrameScheduler: FrameScheduler = (callback) => {
	if (typeof requestAnimationFrame === "function") {
		requestAnimationFrame(() => callback());
	} else {
		setTimeout(callback, 16);
	}
};

export type FrameCoalescer = {
	/** Marks work pending; at most one flush runs per scheduled frame. */
	schedule(): void;
	dispose(): void;
};

/**
 * The ONE burst coalescer in this app. Lives here rather than beside a hook so
 * the streaming hooks, the Cap'n lane, and `projection-store.ts` share a single
 * scheduler — a second implementation would drift on the disposal rule that
 * keeps a flush from running after its owner unmounted.
 */
export function createFrameCoalescer(
	flush: () => void,
	schedule: FrameScheduler = defaultFrameScheduler,
): FrameCoalescer {
	let pending = false;
	let disposed = false;
	return {
		schedule() {
			if (pending || disposed) return;
			pending = true;
			schedule(() => {
				pending = false;
				if (!disposed) flush();
			});
		},
		dispose() {
			disposed = true;
		},
	};
}
