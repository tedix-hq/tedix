/**
 * SSE resumability contract for the Tedix OS per-conversation chat transport.
 *
 * This is the runtime+edge half of the WS→SSE rip-and-replace: it makes the
 * facet-served `{kind:"delta"|"done"|"error"}` stream resumable to the same bar
 * the multiplexed WebSocket island was built for — a mid-turn drop reconnects
 * and continues with NO lost or duplicated deltas — using the browser-native
 * `EventSource` mechanism (`id:` lines → automatic `Last-Event-ID` on reconnect)
 * instead of the former WebSocket client's hand-rolled
 * resume/ack/passive-sink protocol.
 *
 * Why this replaces the WS `resumeAck` handshake entirely: the old client replayed
 * buffered chunks "from chunk 0" and needs a client ack to reset the accumulator
 * before replay. `Last-Event-ID` carries the client's exact last-seen seq, so the
 * server replays ONLY frames AFTER it — no reset, no ack, no duplex signal. The
 * only mid-stream client→server sends the old client made are `resumeRequest`
 * (now the `Last-Event-ID` header), `resumeAck` (obviated), and `cancel` (a
 * separate fetch POST). None is a true duplex requirement, so SSE is sufficient.
 *
 * Pure and transport-agnostic so the replay contract is unit-testable without a
 * live DO: `do.ts` owns one `SseRunBuffer` per in-flight `sseRunId`, appends
 * every frame as it is emitted, and on reconnect resolves the `Last-Event-ID`
 * against it.
 */

export type SseFrame = Record<string, unknown> & {
	// `chunk` carries raw AI SDK parts; `phase` is runtime-owned progress and
	// `tool_input` a display-only measure of tool arguments still streaming. All
	// are buffered so reconnects preserve the same visible turn lifecycle.
	kind: "delta" | "done" | "error" | "chunk" | "phase" | "tool_input";
};

/** A buffered frame with its monotonic per-run sequence number. */
export interface SeqFrame {
	seq: number;
	frame: SseFrame;
}

/** Parsed `Last-Event-ID` header value (`{runId}:{seq}`). */
export interface LastEventId {
	runId: string;
	seq: number;
}

/**
 * Format one SSE event with a resumable id line. `EventSource` records the `id:`
 * as `Last-Event-ID` and re-sends it as a request header on auto-reconnect. The
 * runId is embedded so a reconnect that lands on a DIFFERENT run (a new turn
 * started meanwhile) is detected as a mismatch and handled as a fresh stream
 * rather than a bogus replay.
 */
export function formatSseFrame(
	runId: string,
	seq: number,
	frame: SseFrame,
): string {
	return `id: ${runId}:${seq}\ndata: ${JSON.stringify(frame)}\n\n`;
}

/**
 * Parse a `Last-Event-ID` header (or `?lastEventId=` fallback for clients that
 * cannot set the header). Returns null for absent/malformed values — the caller
 * treats null as "no resume, stream fresh". The runId may itself contain colons
 * (`{tediId}:chat:{clientRequestId}`), so split on the LAST colon only.
 */
export function parseLastEventId(
	value: string | null | undefined,
): LastEventId | null {
	if (!value) return null;
	const lastColon = value.lastIndexOf(":");
	if (lastColon <= 0 || lastColon === value.length - 1) return null;
	const runId = value.slice(0, lastColon);
	const seqRaw = value.slice(lastColon + 1);
	if (!/^\d+$/.test(seqRaw)) return null;
	const seq = Number.parseInt(seqRaw, 10);
	if (!Number.isSafeInteger(seq) || seq < 0) return null;
	return { runId, seq };
}

/** Default cap on buffered frames per run (delta-heavy turns are bounded). */
export const SSE_BUFFER_MAX_FRAMES = 4096;
/**
 * How long a TERMINATED run's buffer is retained for late reconnects (the SSE
 * analog of the WS island's resume grace window). A client that dropped just
 * before the `done` frame can still reconnect and receive the tail.
 */
export const SSE_TERMINAL_GRACE_MS = 30_000;

export type ResumeResolution =
	| { mode: "replay"; frames: SeqFrame[]; terminated: boolean }
	| { mode: "fresh"; reason: "no-buffer" | "runid-mismatch" | "no-header" };

/**
 * Bounded, monotonic per-run frame buffer. One instance per in-flight
 * `sseRunId`. Appending assigns the next seq (starting at 0) and returns it for
 * the `id:` line. Replay returns exactly the frames after a given seq — the
 * no-loss/no-duplicate contract across a reconnect boundary.
 *
 * Overflow policy: if a pathological turn exceeds `maxFrames`, the OLDEST
 * deltas are dropped (a reconnect that far behind loses head text, never tail),
 * and `truncated` is set so the caller can force a fresh stream rather than
 * silently deliver a gap. `seq` keeps counting monotonically regardless, so ids
 * never repeat.
 */
export class SseRunBuffer {
	readonly runId: string;
	private readonly maxFrames: number;
	private frames: SeqFrame[] = [];
	private nextSeq = 0;
	private truncated = false;
	private terminatedAt: number | null = null;

	constructor(runId: string, maxFrames: number = SSE_BUFFER_MAX_FRAMES) {
		this.runId = runId;
		this.maxFrames = Math.max(1, maxFrames);
	}

	/**
	 * Append a frame, return its assigned seq (for the `id:` line). `now` is
	 * injectable so the terminal-grace clock is deterministic under test.
	 */
	append(frame: SseFrame, now: number = Date.now()): number {
		const seq = this.nextSeq++;
		this.frames.push({ seq, frame });
		if (frame.kind === "done" || frame.kind === "error") {
			this.terminatedAt = this.terminatedAt ?? now;
		}
		if (this.frames.length > this.maxFrames) {
			this.frames.shift();
			this.truncated = true;
		}
		return seq;
	}

	get isTerminated(): boolean {
		return this.terminatedAt !== null;
	}

	/** True once the terminal-grace window has elapsed — safe to evict. */
	isExpired(now: number, graceMs: number = SSE_TERMINAL_GRACE_MS): boolean {
		return this.terminatedAt !== null && now - this.terminatedAt >= graceMs;
	}

	/** The lowest seq still retained (0 unless the buffer overflowed). */
	get earliestSeq(): number {
		const head = this.frames[0];
		return head ? head.seq : this.nextSeq;
	}

	/**
	 * Resolve a reconnect. `fresh` means the client must restart the stream
	 * (wrong run, no buffer, or the client is so far behind that head frames were
	 * dropped — delivering a gap would violate the no-loss contract). `replay`
	 * returns the frames strictly after the client's last-seen seq, in order.
	 */
	resolve(lastEventId: LastEventId | null): ResumeResolution {
		if (!lastEventId) return { mode: "fresh", reason: "no-header" };
		if (lastEventId.runId !== this.runId) {
			return { mode: "fresh", reason: "runid-mismatch" };
		}
		// The client is behind the retained head → a replay would skip frames
		// between (lastSeq, earliestSeq]. Force fresh rather than lose deltas.
		if (this.truncated && lastEventId.seq < this.earliestSeq - 1) {
			return { mode: "fresh", reason: "no-buffer" };
		}
		const frames = this.frames.filter((f) => f.seq > lastEventId.seq);
		return { mode: "replay", frames, terminated: this.isTerminated };
	}
}
