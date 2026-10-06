/**
 * `withTimeout` — bound a promise so a HANG becomes a throw.
 *
 * The cold-tedi turn-START stall is a startup await (MCP sync / identity read)
 * that never settles on a just-woken DO, so `prepareChatContext` hangs and the
 * turn sits at `run.started` with no first model step (~10min+ until the
 * recovery circuit's absolute fail). Most of those awaits already fail-soft on a
 * thrown error — they just don't bound a HANG. This helper converts a hang into
 * a `TimeoutError` so the caller's existing catch/fail-soft (or the durable
 * workflow step's retry) re-drives the turn instead of wedging it.
 *
 * Contract:
 *  - If `promise` settles first, its result/rejection propagates and the timer
 *    is cleared (no lingering handle keeping the runtime alive).
 *  - If the timeout fires first, the returned promise REJECTS with `TimeoutError`
 *    and `promise` is allowed to settle later WITHOUT surfacing an unhandled
 *    rejection (a no-op `.catch` is attached up front).
 */

export class TimeoutError extends Error {
	readonly timeoutMs: number;
	constructor(label: string, timeoutMs: number) {
		super(`${label} timed out after ${timeoutMs}ms`);
		this.name = "TimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	// Swallow a late settlement from the (possibly already-timed-out) promise so
	// it cannot surface as an unhandled rejection after we have moved on.
	promise.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new TimeoutError(label, timeoutMs)),
			timeoutMs,
		);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}
