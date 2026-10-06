/**
 * The ONE resume-watermark store for chat transports.
 *
 * A connection machine already resumes across a SOCKET death: it holds the
 * last cursor the server issued and re-subscribes from it. What no machine can
 * do on its own is survive its own teardown — the OS connection manager evicts
 * a conversation entry under LRU pressure and closes it on navigation, and the
 * next acquire constructs a NEW machine whose cursor is null. The server then
 * honestly re-serves the current run from offset 0 (one whole
 * `RUN_EVENT_STREAM_PAGE`), and every one of those frames is fanned out to
 * subscribers as live. That is the cold re-page this module removes.
 *
 * ---------------------------------------------------------------------------
 * THE SETTLE RULE (the load-bearing part)
 * ---------------------------------------------------------------------------
 * A watermark may be parked ONLY by a session that settled CLEANLY:
 *
 *   1. its replay pages were drained,
 *   2. the subscribe call resolved, and
 *   3. no delivery listener threw.
 *
 * Reaching a "ready"/"open" status is NOT sufficient on its own, because a
 * status can be published before replay records have actually been delivered —
 * parking there advertises a position the next session will skip past, and the
 * gap is silently unrecoverable. So the rule is encoded here, once, rather
 * than restated at each call site: {@link ResumeWatermarkSession.settle} is the
 * only thing that arms parking, ANY unclean event disarms it again, and
 * {@link ResumeWatermarkSession.close} parks only while it is armed. An
 * unsettled or errored session parks nothing and its successor opens cold,
 * which is slower but always correct.
 *
 * The cursor type is a parameter because the two surfaces disagree about what
 * a position IS — the OS `/capn` lane resumes on a `(runId, offset)` pair, the
 * embedded lane on an opaque frame id string — and this module deliberately
 * never interprets one. It only decides WHEN a position may be trusted.
 */

/** Default number of keys retained. Bounded so a long-lived tab cannot grow. */
export const RESUME_WATERMARK_CAPACITY = 32;

export type ResumeWatermarkSession<TCursor> = {
	/**
	 * The parked watermark this session may resume from, read at open time.
	 * `null` is a cold open: the server starts from the beginning of whatever
	 * is current, which is exactly what a first connection asks for.
	 */
	readonly seed: TCursor | null;
	/**
	 * Record the position this session has now reached. Callers pass values the
	 * SERVER issued; this module never computes or compares positions, so a
	 * caller that advances from a locally invented offset gets exactly the
	 * garbage it supplied.
	 */
	advance(cursor: TCursor | null): void;
	/** Pages drained, subscribe resolved, nothing threw. Arms parking. */
	settle(): void;
	/**
	 * Anything unclean — a failed establish, a dead socket, a proven stall, a
	 * listener that threw. Disarms parking until the next clean settle.
	 */
	unsettle(): void;
	/**
	 * The parked watermark is unusable (its run stopped resolving). Drops it and
	 * this session's position so nothing can reseed the poison value.
	 */
	reset(): void;
	/**
	 * End the session, parking its position iff it is currently settled and
	 * holds one. Returns whether a watermark was parked. Idempotent.
	 */
	close(): boolean;
};

export type ResumeWatermarkStore<TCursor> = {
	/** Begin a session for `key`, carrying whatever a clean predecessor parked. */
	open(key: string): ResumeWatermarkSession<TCursor>;
	/** The parked watermark for `key` without opening a session (tests, probes). */
	peek(key: string): TCursor | null;
	forget(key: string): void;
	clear(): void;
	size(): number;
};

export function createResumeWatermarkStore<TCursor>(
	options: { capacity?: number } = {},
): ResumeWatermarkStore<TCursor> {
	const capacity = Math.max(1, options.capacity ?? RESUME_WATERMARK_CAPACITY);
	/** Insertion-ordered, so the first key is the least recently parked. */
	const parked = new Map<string, TCursor>();

	const park = (key: string, cursor: TCursor) => {
		// Re-insert so a refreshed key becomes the most recent, then evict.
		parked.delete(key);
		parked.set(key, cursor);
		while (parked.size > capacity) {
			const oldest = parked.keys().next();
			if (oldest.done === true) break;
			parked.delete(oldest.value);
		}
	};

	return {
		open(key) {
			const seed = parked.get(key) ?? null;
			let position: TCursor | null = seed;
			let settled = false;
			let closed = false;
			return {
				seed,
				advance(cursor) {
					position = cursor;
				},
				settle() {
					if (!closed) settled = true;
				},
				unsettle() {
					settled = false;
				},
				reset() {
					settled = false;
					position = null;
					parked.delete(key);
				},
				close() {
					if (closed) return false;
					closed = true;
					if (!settled || position === null) return false;
					park(key, position);
					return true;
				},
			};
		},
		peek(key) {
			return parked.get(key) ?? null;
		},
		forget(key) {
			parked.delete(key);
		},
		clear() {
			parked.clear();
		},
		size() {
			return parked.size;
		},
	};
}
