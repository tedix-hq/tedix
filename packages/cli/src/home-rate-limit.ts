const RATE_LIMIT_ERROR_RE = /\b429\b|rate limit exceeded|too many requests/i;
const RETRY_AFTER_RE = /["']?retryAfter["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i;
const DEFAULT_RATE_LIMIT_RETRY_MS = 5_000;
const MAX_RATE_LIMIT_RETRY_MS = 120_000;

/** True when the gateway explicitly rejected a call for request-rate pressure. */
export function isRateLimitError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return RATE_LIMIT_ERROR_RE.test(message);
}

/**
 * Read the gateway's `retryAfter` seconds from its error payload. Rate-limit
 * errors without a hint get a short bounded cooldown; unrelated errors return
 * null. Exported so pollers/tests share one interpretation.
 */
export function rateLimitRetryAfterMs(error: unknown): number | null {
	const message = error instanceof Error ? error.message : String(error);
	if (!RATE_LIMIT_ERROR_RE.test(message)) return null;
	const rawSeconds = RETRY_AFTER_RE.exec(message)?.[1];
	const seconds = rawSeconds === undefined ? Number.NaN : Number(rawSeconds);
	if (!Number.isFinite(seconds)) return DEFAULT_RATE_LIMIT_RETRY_MS;
	return Math.min(
		MAX_RATE_LIMIT_RETRY_MS,
		Math.max(0, Math.round(seconds * 1_000)),
	);
}
