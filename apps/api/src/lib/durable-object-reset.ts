/**
 * Flag-based classification for Durable Object reset rejections.
 *
 * workerd attaches these flags natively in the calling Worker, so no message
 * matching is needed (`decodeTunneledException`). They live on two independent
 * axes, which is the part that is easy to get wrong:
 *
 * - `retryable` and `overloaded` come from the kj exception TYPE
 *   (DISCONNECTED / OVERLOADED) and describe THIS CALL. One type per hop, so at
 *   most one of them per hop.
 * - `durableObjectReset` is parsed from the tunneled description and describes
 *   THE OBJECT: its incarnation died, which poisons every stub pointing at it.
 *
 * Production storage-timeout resets therefore arrive as
 * `{ remote, overloaded, durableObjectReset }` with NO `retryable` — the object
 * was shedding load AND it died. The public error-handling guidance says never
 * retry `overloaded`; we deliberately diverge when `durableObjectReset` is set,
 * because the queue that overloaded that incarnation died with the incarnation.
 * This looks wrong against the docs alone, which cover `retryable`/`overloaded`/
 * `remote` but not `durableObjectReset`:
 * https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */

interface DurableObjectErrorFlags {
	durableObjectReset?: unknown;
	retryable?: unknown;
	overloaded?: unknown;
}

function readFlags(error: unknown): DurableObjectErrorFlags | null {
	if (typeof error !== "object" || error === null) {
		return null;
	}
	return error as DurableObjectErrorFlags;
}

/**
 * True for rejections caused by a Durable Object reset or a lost connection to
 * one. A bare `overloaded` is excluded because a live object shedding load
 * has not reset.
 */
export function isDurableObjectResetError(error: unknown): boolean {
	const flags = readFlags(error);
	if (flags === null) {
		return false;
	}
	return flags.durableObjectReset === true || flags.retryable === true;
}
