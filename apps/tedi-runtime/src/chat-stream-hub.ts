/**
 * Per-conversation chat stream hub for Tedix OS SSE chat.
 *
 * Holds, per in-flight `sseRunId`, a bounded {@link SseRunBuffer} plus the set
 * of live SSE sinks currently attached to that run. Emitting a frame appends it
 * to the buffer (assigning the monotonic seq → `id:` line) AND fans it out to
 * every attached sink. A reconnect `attach()`es a new sink carrying its
 * `Last-Event-ID`: the hub replays exactly the frames it missed, then — if the
 * run is still live — keeps the sink subscribed for the continuation. This is
 * the browser-native replacement for the WS island's buffer + resumeAck + reset
 * dance: the same "drop mid-turn, reconnect, no lost/dup deltas" guarantee, with
 * the replay boundary carried by the header instead of a duplex handshake.
 *
 * Transport-agnostic (sinks are a tiny interface) so the fan-out + replay logic
 * is unit-testable without a live ReadableStream.
 */

import {
	formatSseFrame,
	type LastEventId,
	SSE_TERMINAL_GRACE_MS,
	type SseFrame,
	SseRunBuffer,
} from "./sse-resume";

/** A live SSE consumer. `do.ts` adapts a ReadableStream controller to this. */
export interface FrameSink {
	/** Write a formatted SSE event (`id:` + `data:` lines). Must not throw. */
	write(chunk: string): void;
	/** Close the underlying stream. Idempotent, must not throw. */
	close(): void;
}

export type AttachResult =
	| { outcome: "attached-live" }
	| { outcome: "replayed-terminated" }
	| { outcome: "fresh"; reason: string };

interface RunEntry {
	buffer: SseRunBuffer;
	sinks: Set<FrameSink>;
}

export class ChatStreamHub {
	private readonly runs = new Map<string, RunEntry>();
	private readonly maxFrames: number | undefined;
	private readonly graceMs: number;

	constructor(opts?: { maxFrames?: number; graceMs?: number }) {
		this.maxFrames = opts?.maxFrames;
		this.graceMs = opts?.graceMs ?? SSE_TERMINAL_GRACE_MS;
	}

	/** Begin a run and register its primary sink (the new-turn stream). */
	openRun(runId: string, primary: FrameSink): void {
		const entry: RunEntry = this.runs.get(runId) ?? {
			buffer: this.maxFrames
				? new SseRunBuffer(runId, this.maxFrames)
				: new SseRunBuffer(runId),
			sinks: new Set(),
		};
		entry.sinks.add(primary);
		this.runs.set(runId, entry);
	}

	/** Append + fan-out a frame. A sink that throws is dropped, not propagated. */
	emit(runId: string, frame: SseFrame, now: number = Date.now()): void {
		const entry = this.runs.get(runId);
		if (!entry) return;
		const seq = entry.buffer.append(frame, now);
		const wire = formatSseFrame(runId, seq, frame);
		for (const sink of entry.sinks) {
			try {
				sink.write(wire);
			} catch {
				entry.sinks.delete(sink);
			}
		}
	}

	/**
	 * Close every sink of a run (called after the terminal frame is emitted).
	 * The buffer is RETAINED for the grace window so a client that dropped just
	 * before `done` can still reconnect and receive the tail.
	 */
	closeRun(runId: string): void {
		const entry = this.runs.get(runId);
		if (!entry) return;
		for (const sink of entry.sinks) {
			try {
				sink.close();
			} catch {
				/* idempotent */
			}
		}
		entry.sinks.clear();
	}

	/**
	 * Reconnect. Replays the frames after `lastEventId` to the sink, then either
	 * keeps it subscribed for the live continuation (run still in flight) or
	 * closes it (run already terminated). Returns `fresh` when the client must
	 * restart the stream (unknown run, wrong run, or too far behind the window).
	 */
	attach(
		runId: string,
		sink: FrameSink,
		lastEventId: LastEventId | null,
	): AttachResult {
		const entry = this.runs.get(runId);
		if (!entry) return { outcome: "fresh", reason: "no-run" };
		const res = entry.buffer.resolve(lastEventId);
		if (res.mode === "fresh") return { outcome: "fresh", reason: res.reason };
		for (const { seq, frame } of res.frames) {
			try {
				sink.write(formatSseFrame(runId, seq, frame));
			} catch {
				return { outcome: "fresh", reason: "sink-write-failed" };
			}
		}
		if (res.terminated) {
			try {
				sink.close();
			} catch {
				/* idempotent */
			}
			return { outcome: "replayed-terminated" };
		}
		entry.sinks.add(sink);
		return { outcome: "attached-live" };
	}

	/** Drop a sink (client disconnected mid-stream). */
	detach(runId: string, sink: FrameSink): void {
		this.runs.get(runId)?.sinks.delete(sink);
	}

	/** Evict terminated runs past their grace window. Call opportunistically. */
	prune(now: number = Date.now()): void {
		for (const [runId, entry] of this.runs) {
			if (entry.sinks.size === 0 && entry.buffer.isExpired(now, this.graceMs)) {
				this.runs.delete(runId);
			}
		}
	}

	/** Test/introspection: number of tracked runs. */
	get size(): number {
		return this.runs.size;
	}
}
