import {
	serializeException,
	type SerializedException,
} from "@tedix/worker-kit/logger";
import { createMcpLogger } from "../log";

const log = createMcpLogger("mcp.rate_limit");

type RedactedException = {
	name: string;
	message?: string;
	stack?: string;
	cause?: RedactedException;
	errors?: RedactedException[];
};

export function redactRateLimitKey(
	error: SerializedException,
	key: string,
): RedactedException {
	const scrub = (value: string) =>
		key ? value.replaceAll(key, "[redacted rate-limit key]") : value;
	return {
		name: scrub(error.type),
		...(error.message && { message: scrub(error.message) }),
		...(error.stack && { stack: scrub(error.stack) }),
		...(error.cause && { cause: redactRateLimitKey(error.cause, key) }),
		...(error.errors && {
			errors: error.errors.map((nested) => redactRateLimitKey(nested, key)),
		}),
	};
}

/**
 * Cloudflare Rate Limiter Binding interface
 */
export interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Check rate limit for a specific operation (non-middleware usage)
 *
 * Use this for rate limiting within MCP agent tools or other non-Hono contexts.
 *
 * @example
 * ```ts
 * const { allowed, remaining } = await checkRateLimit(
 *   env.MCP_HIGH_RISK_RATE_LIMITER,
 *   `high-risk:${appId}`
 * );
 * if (!allowed) {
 *   return { error: "Rate limit exceeded" };
 * }
 * ```
 */
export async function checkRateLimit(
	limiter: RateLimiter | undefined,
	key: string,
): Promise<{ allowed: boolean; error?: string }> {
	if (!limiter) {
		// No limiter configured, allow by default
		return { allowed: true };
	}

	try {
		const { success } = await limiter.limit({ key });
		if (!success) {
			log.warn("Rate limit exceeded", {
				event: "rate_limit.denied",
				outcome: "denied",
			});
			return { allowed: false, error: "Rate limit exceeded" };
		}
		return { allowed: true };
	} catch (error) {
		log.error("Rate limiter failed; allowing request", {
			event: "rate_limit.unavailable",
			error: redactRateLimitKey(serializeException(error), key),
			outcome: "unavailable",
		});
		// Fail open on errors
		return { allowed: true };
	}
}
