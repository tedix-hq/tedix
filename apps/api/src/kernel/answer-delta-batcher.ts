/**
 * Batched durable answer-delta flusher for kernel turn streaming.
 *
 * Flushes the first `answerDelta` immediately, then accumulates later chunks
 * and flushes them to a caller-supplied `persist` function on a configurable
 * cadence (default 1s). The immediate first flush makes short answers visible
 * without a batching delay; one persist call per later window, not per token,
 * continues to bound D1 writes.
 *
 * `flush()` persists the trailing partial synchronously. The turn body calls it
 * once the streamed pass has returned and before the terminal timestamps are
 * read, so the last delta row sorts ahead of `message.completed`. Without it
 * the window can fire after `message.completed`, and every reader — which
 * latches on the terminal row — drops the bulk of the answer as a straggler.
 *
 * `end()` does not flush: it runs post-commit (the DO's `finally`), so a
 * flush there would land after `message.completed` and mis-order the stream.
 * After a `flush()` nothing is pending; `end()` only cancels a timer that a
 * post-flush push may have re-armed.
 *
 * Pure module: no agents-SDK / `cloudflare:workers` imports; clock and timers
 * are injectable so the batcher is unit-testable under plain vitest.
 */

export interface AnswerDeltaBatcherOptions {
	/** Called with the batched incremental delta chunk + incrementing sequence. */
	persist: (chunk: string, sequence: number) => void;
	/** ms between automatic flushes. Default {@link DEFAULT_ANSWER_DELTA_FLUSH_INTERVAL_MS}. */
	flushIntervalMs?: number;
	/** Injectable clock (tests). Default `Date.now`. */
	now?: () => number;
	/** Injectable timer (tests). Default `setTimeout`. */
	setTimer?: (fn: () => void, delayMs: number) => unknown;
	/** Injectable timer cancel (tests). Default `clearTimeout`. */
	clearTimer?: (handle: unknown) => void;
}

export interface AnswerDeltaBatcher {
	/** Flush the first delta immediately; batch later chunks on the configured cadence. */
	push(delta: string): void;
	/**
	 * Persist the pending partial NOW (one row, next sequence) and cancel the
	 * timer that was going to carry it. No-op with nothing pending or after
	 * `end()`. Call it before the terminal row is stamped so the flushed row
	 * sorts ahead of `message.completed`.
	 */
	flush(): void;
	/** Cancel the pending timer and mark the batcher done. Does NOT flush — a
	 * post-commit flush would land after the terminal `message.completed`. */
	end(): void;
}

export const DEFAULT_ANSWER_DELTA_FLUSH_INTERVAL_MS = 1_000;

export function createAnswerDeltaBatcher(
	options: AnswerDeltaBatcherOptions,
): AnswerDeltaBatcher {
	const flushIntervalMs =
		options.flushIntervalMs ?? DEFAULT_ANSWER_DELTA_FLUSH_INTERVAL_MS;
	const setTimer =
		options.setTimer ??
		((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
	const clearTimer =
		options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));

	let pending = "";
	let sequence = 0;
	let timer: unknown = null;
	let ended = false;
	let firstDeltaFlushed = false;

	const flush = (): void => {
		if (pending.length === 0) return;
		const chunk = pending;
		const seq = sequence;
		pending = "";
		sequence += 1;
		try {
			options.persist(chunk, seq);
		} catch {
			// fail-soft: persist errors must never propagate to the turn
		}
	};

	const cancelTimer = (): void => {
		if (timer !== null) {
			try {
				clearTimer(timer);
			} catch {
				// best-effort
			}
			timer = null;
		}
	};

	return {
		push(delta: string): void {
			if (ended || delta.length === 0) return;
			pending += delta;
			if (!firstDeltaFlushed) {
				firstDeltaFlushed = true;
				flush();
				return;
			}
			if (timer === null) {
				timer = setTimer(() => {
					timer = null;
					flush();
				}, flushIntervalMs);
			}
		},
		flush(): void {
			if (ended) return;
			cancelTimer();
			flush();
		},
		end(): void {
			if (ended) return;
			ended = true;
			cancelTimer();
			// No final flush — see module docstring: end() runs post-commit, and a
			// flush here would sort after message.completed. Drop the partial.
			pending = "";
		},
	};
}
