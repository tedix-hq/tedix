/**
 * Self-healing wrapper around `@cloudflare/voice` `Transcriber` sessions.
 *
 * ============================ PROBLEM ============================
 * Two proven failure modes in production:
 *
 * (a) cloudflare/workerd#6774 — the runtime tears down outbound DO WebSockets
 *     with close 1005 "Network connection lost" while the session is live.
 *
 * (b) The SDK's `FluxSession` handles `close` by ONLY setting `#connected=false`
 *     — NO reconnect, NO consumer-visible error, and `feed()` then buffers into
 *     `#pendingChunks` forever. Net: transcription silently dies mid-session
 *     while feed counters keep climbing.
 *
 * ============================ SOLUTION ============================
 * `createSelfHealingTranscriber(base, opts)` returns a `Transcriber` whose
 * `createSession` produces a supervising session that:
 *
 * 1. Holds the REAL inner session from `base.createSession(options)`.
 * 2. Proxies `onInterim`/`onSpeechStart`/`onUtterance` through and resets a
 *    watchdog timer on every event.
 * 3. Keeps a ROLLING AUDIO BUFFER of recent fed chunks, capped at
 *    `maxBufferBytes` (default 320_000 ≈ 10 s of PCM16 @ 16 kHz), evicting
 *    oldest whole chunks when adding a new one would exceed the cap.
 * 4. WATCHDOG: if ≥1 chunk has been fed since the last STT event AND no STT
 *    event arrives within `stallMs` (default 4000 ms), the session is declared
 *    stalled: the inner session is closed, a fresh one is created from `base`,
 *    the rolling buffer is replayed in order, and the event is logged via the
 *    injected `log` callback as `stt.heal`.
 * 5. Heals are capped at `maxHeals` (default 3). After exhaustion `stt.heal.exhausted`
 *    is logged and feeding continues on the last (stalled) session — degrading to
 *    status-quo behaviour rather than failing hard.
 * 6. DUPLICATE UTTERANCE SUPPRESSION: after a heal, Flux re-transcribes the
 *    replayed audio and may re-emit the last utterance. If the new session emits
 *    an utterance string EXACTLY equal to the last emitted utterance within
 *    `dupWindowMs` (default 15_000 ms), it is dropped and `stt.heal.dup_suppressed`
 *    is logged.
 *
 * This module has NO DO imports — it is fully unit-testable in plain Node.
 */

import type {
	Transcriber,
	TranscriberSession,
	TranscriberSessionOptions,
} from "@cloudflare/voice";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export interface SelfHealingOptions {
	/**
	 * Milliseconds without any STT event (onInterim/onSpeechStart/onUtterance)
	 * after at least one audio chunk has been fed before the session is
	 * considered stalled and a heal is attempted.
	 * @default 4000
	 */
	stallMs?: number;

	/**
	 * Maximum total bytes of recent audio chunks kept in the rolling buffer.
	 * Oldest whole chunks are evicted when adding a new chunk would exceed the
	 * cap. Approximation: 320_000 bytes ≈ 10 s of PCM16 @ 16 kHz mono.
	 * @default 320_000
	 */
	maxBufferBytes?: number;

	/**
	 * Maximum number of heal attempts before giving up and continuing on the
	 * last session.
	 * @default 3
	 */
	maxHeals?: number;

	/**
	 * Window in milliseconds within which a duplicate utterance (exact string
	 * match) after a heal is suppressed.
	 * @default 15_000
	 */
	dupWindowMs?: number;

	/**
	 * Optional structured logger. Receives event names and a fields object.
	 * Called for: `stt.heal`, `stt.heal.exhausted`, `stt.heal.dup_suppressed`.
	 */
	log?: (event: string, fields: Record<string, unknown>) => void;

	/**
	 * Watchdog polling interval in milliseconds. Controls how often the
	 * supervisor checks for a stalled session. Defaults to 1000 ms which is
	 * appropriate for Durable Objects. Override only in tests.
	 * @default 1000
	 * @internal
	 */
	_watchTickMs?: number;
}

// ---------------------------------------------------------------------------
// Rolling audio buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-byte-cap ring buffer for audio chunks.
 * Evicts oldest WHOLE chunks until adding `chunk` stays within `maxBytes`.
 */
class RollingBuffer {
	#chunks: ArrayBuffer[] = [];
	#totalBytes = 0;
	readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	push(chunk: ArrayBuffer): void {
		// Evict oldest chunks until adding this one fits.
		while (
			this.#chunks.length > 0 &&
			this.#totalBytes + chunk.byteLength > this.maxBytes
		) {
			const evicted = this.#chunks.shift()!;
			this.#totalBytes -= evicted.byteLength;
		}
		this.#chunks.push(chunk);
		this.#totalBytes += chunk.byteLength;
	}

	snapshot(): ArrayBuffer[] {
		return this.#chunks.slice();
	}

	get totalBytes(): number {
		return this.#totalBytes;
	}

	get length(): number {
		return this.#chunks.length;
	}
}

// ---------------------------------------------------------------------------
// Supervising session
// ---------------------------------------------------------------------------

class SelfHealingSession implements TranscriberSession {
	// Construction-time references
	readonly #base: Transcriber;
	readonly #options: TranscriberSessionOptions | undefined;
	readonly #stallMs: number;
	readonly #maxHeals: number;
	readonly #dupWindowMs: number;
	readonly #log: (event: string, fields: Record<string, unknown>) => void;
	readonly #buffer: RollingBuffer;
	readonly #watchTickMs: number;

	// Mutable state
	#inner: TranscriberSession;
	#closed = false;
	#generation = 0; // incremented on each heal
	#healsUsed = 0;
	#exhausted = false;

	// Watchdog state
	#chunksFedsInWatch = 0; // chunks fed since last STT event or heal
	#lastEventAt: number = Date.now();
	#watchInterval: ReturnType<typeof setInterval> | null = null;

	// Duplicate suppression
	#lastUtterance: string | null = null;
	#lastUtteranceAt = 0;

	constructor(
		base: Transcriber,
		options: TranscriberSessionOptions | undefined,
		opts: Required<SelfHealingOptions>,
	) {
		this.#base = base;
		this.#options = options;
		this.#stallMs = opts.stallMs;
		this.#maxHeals = opts.maxHeals;
		this.#dupWindowMs = opts.dupWindowMs;
		this.#log = opts.log;
		this.#buffer = new RollingBuffer(opts.maxBufferBytes);
		this.#watchTickMs = opts._watchTickMs;

		this.#inner = this.#openSession(options);
		this.#startWatchdog();
	}

	// ---- TranscriberSession interface ----------------------------------------

	feed(chunk: ArrayBuffer): void {
		if (this.#closed) return;
		this.#buffer.push(chunk);
		this.#chunksFedsInWatch++;
		this.#inner.feed(chunk);
	}

	waitUntilReady(): Promise<void> {
		return this.#inner.waitUntilReady?.() ?? Promise.resolve();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#stopWatchdog();
		this.#inner.close();
	}

	// ---- Private helpers -----------------------------------------------------

	/**
	 * Open a fresh inner session, wiring the callbacks so every event:
	 * - resets the watchdog state
	 * - is forwarded to the consumer's original callbacks
	 * - is guarded so events from a superseded generation are discarded
	 */
	#openSession(
		options: TranscriberSessionOptions | undefined,
	): TranscriberSession {
		const gen = this.#generation; // capture for staleness check
		return this.#base.createSession({
			...options,
			onInterim: (text) => {
				if (this.#closed || gen !== this.#generation) return;
				this.#resetWatchdog();
				options?.onInterim?.(text);
			},
			onSpeechStart: (text) => {
				if (this.#closed || gen !== this.#generation) return;
				this.#resetWatchdog();
				options?.onSpeechStart?.(text);
			},
			onUtterance: (transcript) => {
				if (this.#closed || gen !== this.#generation) return;
				this.#resetWatchdog();

				// Duplicate suppression after a heal
				const now = Date.now();
				if (
					this.#generation > 0 &&
					transcript === this.#lastUtterance &&
					now - this.#lastUtteranceAt < this.#dupWindowMs
				) {
					this.#log("stt.heal.dup_suppressed", {
						generation: this.#generation,
						chars: transcript.length,
					});
					return;
				}

				this.#lastUtterance = transcript;
				this.#lastUtteranceAt = now;
				options?.onUtterance?.(transcript);
			},
		});
	}

	#resetWatchdog(): void {
		this.#lastEventAt = Date.now();
		this.#chunksFedsInWatch = 0;
	}

	#startWatchdog(): void {
		if (this.#watchInterval !== null) return;
		this.#watchInterval = setInterval(() => {
			this.#checkStall();
		}, this.#watchTickMs);
	}

	#stopWatchdog(): void {
		if (this.#watchInterval !== null) {
			clearInterval(this.#watchInterval);
			this.#watchInterval = null;
		}
	}

	#checkStall(): void {
		if (this.#closed) return;
		if (this.#chunksFedsInWatch === 0) return; // no audio in flight — not stalled
		const silenceMs = Date.now() - this.#lastEventAt;
		if (silenceMs < this.#stallMs) return;

		// Stall detected.
		if (this.#exhausted) return; // already gave up — keep feeding last session

		if (this.#healsUsed >= this.#maxHeals) {
			this.#exhausted = true;
			this.#log("stt.heal.exhausted", {
				generation: this.#generation,
				healsUsed: this.#healsUsed,
				sinceLastEventMs: silenceMs,
			});
			return;
		}

		this.#heal(silenceMs);
	}

	#heal(sinceLastEventMs: number): void {
		const prevGen = this.#generation;
		this.#healsUsed++;
		this.#generation++;

		// Close the stale inner session (best-effort — workerd close may throw).
		try {
			this.#inner.close();
		} catch {
			// ignore
		}

		// Snapshot the replay buffer BEFORE opening the new session so replay
		// chunks are not double-counted.
		const replayChunks = this.#buffer.snapshot();
		const replayedBytes = replayChunks.reduce((s, c) => s + c.byteLength, 0);

		// Open new session and replay audio.
		this.#inner = this.#openSession(this.#options);
		// Reset the event timer — the heal itself is the "last activity" point.
		// Keep chunksFedsInWatch > 0 (replayed audio counts as fed) so the
		// watchdog will still trigger another heal if the new session also stalls.
		this.#lastEventAt = Date.now();
		this.#chunksFedsInWatch = replayChunks.length;

		for (const chunk of replayChunks) {
			this.#inner.feed(chunk);
		}

		this.#log("stt.heal", {
			generation: this.#generation,
			prevGeneration: prevGen,
			healsUsed: this.#healsUsed,
			maxHeals: this.#maxHeals,
			replayedChunks: replayChunks.length,
			replayedBytes,
			sinceLastEventMs,
		});
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap a `Transcriber` with a self-healing supervisor.
 *
 * `createSelfHealingTranscriber(base, opts)` returns a `Transcriber` whose
 * `createSession` returns a `SelfHealingSession`.  Every other aspect of the
 * `Transcriber` interface is a pass-through; the wrapper adds no state outside
 * of sessions.
 *
 * @param base - The underlying transcriber (e.g. `WorkersAIFluxSTT`).
 * @param opts - Optional tuning overrides (stallMs, maxBufferBytes, maxHeals,
 *   dupWindowMs, log).
 */
export function createSelfHealingTranscriber(
	base: Transcriber,
	opts: SelfHealingOptions = {},
): Transcriber {
	const resolved: Required<SelfHealingOptions> = {
		stallMs: opts.stallMs ?? 4000,
		maxBufferBytes: opts.maxBufferBytes ?? 320_000,
		maxHeals: opts.maxHeals ?? 3,
		dupWindowMs: opts.dupWindowMs ?? 15_000,
		log: opts.log ?? (() => {}),
		_watchTickMs: opts._watchTickMs ?? 1000,
	};

	return {
		createSession(options?: TranscriberSessionOptions): TranscriberSession {
			return new SelfHealingSession(base, options, resolved);
		},
	};
}
