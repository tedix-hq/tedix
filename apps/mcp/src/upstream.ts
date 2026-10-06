/**
 * MCP Worker — upstream (apps/api) availability handling.
 *
 * The gateway resolves apps and tools from apps/api over a Cloudflare service
 * binding. Two transient failure modes are expected and self-healing:
 *
 *   1. apps/api warming / replacing → oRPC `ORPCError` with `code:
 *      "SERVICE_UNAVAILABLE"` / `status: 503` (and the sibling 5xx classes).
 *   2. The `remote: true` service-binding RPC connection drops → a plain
 *      `Error` with `message: "Network connection lost."` and `retryable: true`
 *      (no code/status).
 *
 * Both should be absorbed by a short bounded retry, and — if still failing —
 * surfaced to the MCP client as `503 Service Unavailable` + `Retry-After`
 * (transient, please retry) rather than a bare `502 Bad Gateway` or an uncaught
 * Worker 500 (which read as "permanently broken"). Genuine 4xx (bad request,
 * not-found, forbidden) and app-not-found results must never be retried or
 * mapped to 503.
 */

/** Seconds advertised in `Retry-After` on a transient upstream-unavailable. */
export const UPSTREAM_RETRY_AFTER_SECONDS = 2;

/**
 * Deadline for one apps/api service-binding attempt.
 *
 * A request with no deadline can remain pending indefinitely. Because app
 * resolution and app-context loading deduplicate concurrent reads through
 * isolate-wide in-flight promises, one wedged service-binding call would then
 * pin every later request for that app until the Worker isolate recycled.
 *
 * Sized to survive an apps/api cold start, not just a warm call: a cold isolate
 * pays full module init (seconds of CPU), so a ~3s deadline makes both attempts
 * time out and the gateway answers 503 "Upstream unavailable" on every request.
 *
 * Reassess this timeout against measured API latency, not bundle bytes. Bring it
 * back down once cold start is cheap: a long deadline masks upstream slowness.
 */
export const UPSTREAM_ATTEMPT_TIMEOUT_MS = 12_000;

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 150;

interface UpstreamRetryOptions {
	operation?: string;
	resource?: string;
	timeoutMs?: number;
}

class UpstreamTimeoutError extends Error {
	readonly code = "GATEWAY_TIMEOUT";
	readonly status = 504;
	readonly retryable = true;

	constructor(timeoutMs: number) {
		super(`Upstream service binding timed out after ${timeoutMs}ms`);
		this.name = "UpstreamTimeoutError";
	}
}

function withUpstreamAttemptTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new UpstreamTimeoutError(timeoutMs));
		}, timeoutMs);
	});

	// Promise.race attaches a rejection handler to both contestants, but keep an
	// explicit handler on the service-binding promise too: it can settle after
	// the timeout winner and must never surface as an unhandled rejection.
	promise.catch(() => {});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * True only for transient apps/api unavailability — a 5xx oRPC error or a
 * dropped remote service-binding RPC. Returns false for every genuine client
 * outcome (4xx ORPCError, `App not found` Error, validation errors), so callers
 * can safely use it to gate both retries and 503 mapping.
 *
 * Duck-typed (no `instanceof ORPCError`) so it is robust across module-instance
 * boundaries and does not couple to the oRPC client's value export.
 */
export function isRetryableUpstreamError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const e = error as {
		code?: unknown;
		status?: unknown;
		retryable?: unknown;
		message?: unknown;
		cause?: unknown;
	};

	// Shape A: ORPCError-like (carries numeric `status` and/or string `code`).
	// Gate on 5xx only. A 4xx (400/401/403/404/409/422/429) is a genuine
	// outcome — stop immediately so it is never retried or 503'd.
	if (typeof e.status === "number") {
		if (e.status >= 500) return true;
		if (e.status >= 400) return false;
	}
	if (typeof e.code === "string") {
		// A proxy/edge 5xx may not carry an oRPC envelope. RPCLink wraps it as
		// MALFORMED_ORPC_RESPONSE and leaves the HTTP status on its cause.
		if (e.code === "MALFORMED_ORPC_RESPONSE") {
			const cause = e.cause;
			const response =
				cause && typeof cause === "object"
					? (cause as { response?: unknown }).response
					: null;
			const status =
				response && typeof response === "object"
					? (response as { status?: unknown }).status
					: null;
			if (typeof status === "number") return status >= 500;
		}
		if (
			e.code === "SERVICE_UNAVAILABLE" ||
			e.code === "BAD_GATEWAY" ||
			e.code === "GATEWAY_TIMEOUT" ||
			e.code === "INTERNAL_ERROR" ||
			e.code === "INTERNAL_SERVER_ERROR"
		) {
			return true;
		}
	}

	// Shape B: Cloudflare remote-RPC drop — plain Error, no code/status. The
	// runtime attaches `retryable: true`; fall back to the message because that
	// flag is non-standard and not guaranteed on every transport variant.
	if (e.retryable === true) return true;
	const message =
		typeof e.message === "string"
			? e.message
			: error instanceof Error
				? error.message
				: "";
	return /network connection lost/i.test(message);
}

/**
 * Run a READ-ONLY upstream call with a short bounded retry on transient
 * unavailability. Only ever wrap idempotent (GET) calls — a dropped connection
 * on a mutating call may have already committed server-side.
 *
 * Note: the oRPC client link already carries a one-shot retry plugin, so this
 * compounds to at most ~4 upstream attempts in the worst persistent case. Kept
 * to 2 attempts / 150ms precisely because the link absorbs one transient.
 */
export async function withUpstreamRetry<T>(
	fn: () => Promise<T>,
	options: UpstreamRetryOptions = {},
): Promise<T> {
	let lastError: unknown;
	const timeoutMs = options.timeoutMs ?? UPSTREAM_ATTEMPT_TIMEOUT_MS;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			return await withUpstreamAttemptTimeout(
				Promise.resolve().then(fn),
				timeoutMs,
			);
		} catch (error) {
			lastError = error;
			if (error instanceof UpstreamTimeoutError) {
				console.warn(
					JSON.stringify({
						_mcp: "upstream",
						event: "attempt_timeout",
						operation: options.operation ?? "unknown",
						resource: options.resource ?? "unknown",
						attempt,
						timeoutMs,
					}),
				);
			}
			if (attempt >= MAX_ATTEMPTS || !isRetryableUpstreamError(error)) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
		}
	}
	// Unreachable (the loop always returns or throws), but satisfies TS.
	throw lastError;
}

/**
 * `503 Service Unavailable` + `Retry-After` JSON response for a transient
 * upstream-unavailable condition. Use in place of a bare `502`/uncaught-500 so
 * MCP clients treat it as retryable rather than permanently broken.
 */
export function upstreamUnavailableResponse(): Response {
	return new Response(
		JSON.stringify({
			error: "Upstream unavailable",
			message: "The API is temporarily unavailable. Please retry shortly.",
			retryAfter: UPSTREAM_RETRY_AFTER_SECONDS,
		}),
		{
			status: 503,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(UPSTREAM_RETRY_AFTER_SECONDS),
				// Never cacheable: a transient outage must not freeze a 503 behind
				// the Workers Cache tier (wrangler.jsonc `cache.enabled`) past the
				// moment apps/api recovers.
				"Cache-Control": "private, no-store",
			},
		},
	);
}
