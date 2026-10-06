/**
 * Throttled trailing-write applier for advisory mid-turn progress pushes
 * (`KernelDO.activeTurn` state — see kernel-state.ts).
 *
 * Pure module on purpose (same rule as kernel-state.ts): no agents-SDK /
 * `cloudflare:workers` imports, clock and timers are injectable, so the
 * throttle is unit-testable under plain vitest with no real sleeps.
 *
 * Semantics:
 *
 *   - `push(value)` applies immediately when ≥ `minIntervalMs` (default 1s)
 *     has passed since the last applied push (first push always applies).
 *   - Pushes inside the interval are coalesced into ONE trailing write — the
 *     LAST pushed value always lands when the trailing timer fires, so the
 *     final stage of a burst is never lost.
 *   - `end()` cancels any pending trailing write and applies `null`
 *     immediately (clear-on-end: a finished turn never leaves a stale stage
 *     in state). After `end()` the throttle is dead — further pushes are
 *     ignored, so a straggler emission can never resurrect a cleared stage.
 *   - `apply` is invoked fail-soft (try/catch): progress is advisory and an
 *     applier error (setState failure etc.) must never propagate to the turn.
 *
 * Lifecycle: ONE throttle per turn (created when the turn starts, `end()`ed
 * in a `finally` when it completes). The ≥1s timestamp lives on the throttle
 * instance, so pushes WITHIN a turn are spaced; a new turn's first push
 * applies immediately (the operator sees "Planning route" without a 1s lag).
 * Two concurrent turns on one DO write last-writer-wins into the single
 * `activeTurn` field — acceptable v1 (the field is advisory; D1 run rows
 * remain the truth for per-run status).
 */

export interface ProgressThrottleOptions<T> {
	/** Applies the throttled value (`null` = clear). Invoked fail-soft. */
	apply: (value: T | null) => void;
	/** Minimum ms between applied pushes. Default {@link DEFAULT_PROGRESS_MIN_INTERVAL_MS}. */
	minIntervalMs?: number;
	/** Injectable clock (tests). Default `Date.now`. */
	now?: () => number;
	/** Injectable timer (tests). Default `setTimeout`. */
	setTimer?: (fn: () => void, delayMs: number) => unknown;
	/** Injectable timer cancel (tests). Default `clearTimeout`. */
	clearTimer?: (handle: unknown) => void;
}

export interface ProgressThrottle<T> {
	/** Apply now if outside the interval, else coalesce into the trailing write. */
	push(value: T): void;
	/** Cancel pending work, apply `null`, and ignore all further pushes. */
	end(): void;
}

export const DEFAULT_PROGRESS_MIN_INTERVAL_MS = 1_000;

export function createProgressThrottle<T>(
	options: ProgressThrottleOptions<T>,
): ProgressThrottle<T> {
	const minIntervalMs =
		options.minIntervalMs ?? DEFAULT_PROGRESS_MIN_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const setTimer =
		options.setTimer ??
		((fn: () => void, delayMs: number) => setTimeout(fn, delayMs));
	const clearTimer =
		options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));

	let lastAppliedAt: number | null = null;
	let pending: T | null = null;
	let timer: unknown = null;
	let ended = false;

	const applySafe = (value: T | null): void => {
		try {
			options.apply(value);
		} catch {
			// Advisory only — an applier error must never reach the turn.
		}
	};

	const cancelTimer = (): void => {
		if (timer !== null) {
			try {
				clearTimer(timer);
			} catch {
				// Timer cancel is best-effort; the fired callback re-checks `ended`.
			}
			timer = null;
		}
	};

	return {
		push(value: T): void {
			if (ended) return;
			const at = now();
			if (lastAppliedAt === null || at - lastAppliedAt >= minIntervalMs) {
				cancelTimer();
				pending = null;
				lastAppliedAt = at;
				applySafe(value);
				return;
			}
			// Inside the interval: coalesce — the trailing timer (one at a time)
			// fires at lastAppliedAt + minIntervalMs and applies the LATEST value.
			pending = value;
			if (timer === null) {
				const delay = Math.max(0, lastAppliedAt + minIntervalMs - at);
				timer = setTimer(() => {
					timer = null;
					if (ended || pending === null) return;
					const trailing = pending;
					pending = null;
					lastAppliedAt = now();
					applySafe(trailing);
				}, delay);
			}
		},
		end(): void {
			if (ended) return;
			ended = true;
			cancelTimer();
			pending = null;
			applySafe(null);
		},
	};
}
