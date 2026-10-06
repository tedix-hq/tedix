/**
 * Kernel hot-path LLM abort / idle-timeout guards.
 *
 * The kernel's per-turn LLM passes (route planner, answer stream, tool-call
 * planner, write proposal, goal-loop judge) had NO `AbortSignal`. When Azure
 * A reasoning model via AI Gateway can stall without erroring — it opens a connection
 * or a stream and then emits no bytes / hangs mid-stream (the half-open class) —
 * the `await` / `for await` never settled AND never threw, so it BYPASSED every
 * throw-only fail-soft catch and `runKernel` wedged in `running` until the
 * 15-min reconciliation sweep (10x the operator's 90s client ceiling). This is
 * the SAME unguarded-Azure-fetch class already fixed for the durable tedi
 * runtime in `apps/tedi-runtime/src/do.ts` (`runLlmRound`).
 *
 * These guards turn a stall into a THROW so the EXISTING fail-soft catch settles
 * the turn (heuristic responder / planner draft / null). Purely additive — the
 * catches already settle; this only stops a stall from never reaching them.
 *
 *   - {@link withIdleAbort} for STREAMING passes — an idle-resetting
 *     `AbortController` mirroring `runLlmRound`: armed up front, `reset()` on
 *     EACH chunk, so a legitimately-slow but PROGRESSING stream never aborts;
 *     only a STALLED stream aborts at the idle bound. `timedOut` lets the caller
 *     distinguish an idle-abort from a content/parse error (so a stream that
 *     idle-aborted does not fall through to ANOTHER stalling pass and stack
 *     latency past the client ceiling).
 *   - {@link flatAbortSignal} for NON-STREAMING passes — a flat
 *     `AbortSignal.timeout` (an idle reset cannot apply to a single awaited
 *     call), optionally composed with an overall read-loop deadline so several
 *     planner passes in series cannot stack past the client ceiling.
 *
 * Timeouts are GENEROUS on purpose: GPT-5 reasoning models have hidden
 * reasoning tokens, so a legitimately-slow route/tool decision must not be
 * clipped. The signal reaches the HTTP request via `kernelGatewayFetch`
 * (`llm.ts`), which does `fetch(rewritten, { ...init })`, so `init.signal`
 * propagates to the underlying fetch and a real Azure stall is aborted.
 */

/**
 * Flat per-pass bound for a single awaited (non-streaming) reasoning call.
 * A single stalled pass settles well under the operator's 90s client ceiling.
 */
export const KERNEL_LLM_FLAT_TIMEOUT_MS = 70_000;

/**
 * Idle bound for a streaming pass — RESET on every chunk, so it bounds a
 * never-arriving response and a connected-but-stalled stream while never
 * tripping mid-stream on a healthy (progressing) round.
 */
export const KERNEL_STREAM_IDLE_TIMEOUT_MS = 50_000;

/** Idle-abort handle for a streaming LLM pass. */
export interface IdleAbort {
	/** The signal to hand to `streamObject` / `streamText` as `abortSignal`. */
	readonly signal: AbortSignal;
	/** Re-arm the idle deadline — call on each stream chunk (progress). */
	reset(): void;
	/** Cancel the idle timer — call once the pass finishes (always, in `finally`). */
	clear(): void;
	/**
	 * True once the idle timer tripped. Distinguishes an idle-abort (the stall
	 * class) from a content/parse error, so the caller can skip falling through
	 * to another stalling pass.
	 */
	readonly timedOut: boolean;
}

/**
 * Build an idle-resetting AbortController for a streaming pass. The timer is
 * armed immediately (bounding a never-arriving first chunk) and re-armed by
 * `reset()` on every chunk; on trip it aborts the underlying fetch with a
 * descriptive error and flips `timedOut`. Always `clear()` in a `finally`.
 */
export function withIdleAbort(idleMs: number, label: string): IdleAbort {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const clear = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};
	const reset = (): void => {
		clear();
		timer = setTimeout(() => {
			timedOut = true;
			controller.abort(
				new Error(`${label} stalled — no stream progress within ${idleMs}ms`),
			);
		}, idleMs);
	};
	reset(); // arm immediately — bounds a never-arriving first chunk too
	return {
		signal: controller.signal,
		reset,
		clear,
		get timedOut() {
			return timedOut;
		},
	};
}

/**
 * Flat abort signal for a single non-streaming pass: an `AbortSignal.timeout`
 * for the per-call bound, composed (via `AbortSignal.any`) with an optional
 * overall deadline so a pass inside a bounded loop aborts at whichever fires
 * first. Absent deadline → the bare per-call timeout.
 */
export function flatAbortSignal(
	timeoutMs: number,
	deadlineSignal?: AbortSignal | null,
): AbortSignal {
	const own = AbortSignal.timeout(timeoutMs);
	return deadlineSignal ? AbortSignal.any([own, deadlineSignal]) : own;
}
