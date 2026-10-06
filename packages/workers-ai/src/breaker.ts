/**
 * Provider circuit breaker.
 *
 * Resilient-by-default provider fallback: a runtime tries its primary provider
 * (Azure OpenAI today) and falls back to Workers AI on failure. To avoid taxing
 * EVERY turn with a doomed round-trip during a sustained outage, the breaker
 * opens on a failure, skips the primary for a cooldown, then re-probes. A
 * success closes it immediately.
 *
 * STATE IS PER-ISOLATE, BY DESIGN. The returned closure holds its deadline in
 * ordinary module/closure scope, so it is shared by every call site inside ONE
 * Worker isolate and resets on eviction — which is exactly right for a breaker.
 * Two separate Workers can never share it: there is no module scope spanning
 * Workers, so a cross-Worker breaker would have to be a Durable Object, and a
 * DO round-trip on the hot path of every inference costs more than the doomed
 * probe it would save. Do not "fix" this into shared state.
 *
 * 5 minutes: long enough that a sustained outage re-probes the primary only
 * ~once per window per isolate. For a KNOWN prolonged outage prefer the app's
 * force-Workers-AI override, which skips the probe entirely.
 */

/** Default cooldown before a tripped breaker re-probes the primary provider. */
export const DEFAULT_BREAKER_COOLDOWN_MS = 300_000;

export interface ProviderBreaker {
	/** True while the primary provider should be skipped. */
	isOpen(): boolean;
	/** Open the breaker for one cooldown window (call on a primary failure). */
	trip(): void;
	/** Close the breaker immediately (call on a primary success, or in tests). */
	reset(): void;
}

/**
 * Create a breaker. Each call returns an INDEPENDENT breaker; share one by
 * exporting a single instance from an app module, so every call site in that
 * isolate skips the primary once any one of them has seen it fail.
 */
export function createProviderBreaker(
	cooldownMs: number = DEFAULT_BREAKER_COOLDOWN_MS,
): ProviderBreaker {
	let openUntil = 0;
	return {
		isOpen: () => Date.now() < openUntil,
		trip: () => {
			openUntil = Date.now() + cooldownMs;
		},
		reset: () => {
			openUntil = 0;
		},
	};
}
