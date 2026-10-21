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
 * Buckets for one request to the per-app request limiter (`MCP_RATE_LIMITER`).
 *
 * Authenticated callers are keyed by their verified principal, so one budget
 * follows one accountable actor: a registered external agent, a tedi, or a
 * user. Every lane on one machine no longer shares a single NAT address, and a
 * caller cannot widen its budget by rotating addresses. Only anonymous callers
 * fall back to the client address.
 *
 * A verified external-agent session gets its own request bucket, because one
 * principal runs many concurrent lanes, each with its own session. Its
 * principal key becomes the `ceiling`, which bounds the principal's total load
 * across sessions. The session part comes only from the session the gateway
 * bound to the verified credential: the identity headers read here are set
 * after authentication, and inbound copies are stripped at ingress.
 */
export function mcpRateLimitBuckets(
	appId: string,
	headers: Headers,
	clientIp: string,
): { request: string; ceiling?: string } {
	const header = (name: string) => headers.get(name)?.trim() || undefined;
	const externalPrincipal = header("x-tedix-auth-external-principal-id");
	if (externalPrincipal) {
		const principalKey = `${appId}:agent:${externalPrincipal}`;
		const session = header("x-tedix-auth-external-session-id");
		if (session && header("x-tedix-auth-type") === "external_agent") {
			return {
				request: `${principalKey}:session:${session}`,
				ceiling: principalKey,
			};
		}
		return { request: principalKey };
	}
	const tedi = header("x-tedix-auth-tedi-id");
	if (tedi) return { request: `${appId}:tedi:${tedi}` };
	const user = header("x-tedix-auth-user-id");
	if (user) return { request: `${appId}:user:${user}` };
	return { request: `${appId}:ip:${clientIp}` };
}

/**
 * Admit one gateway request against the per-request limiter and, for a
 * verified external-agent session, the principal ceiling.
 *
 * The ceiling is `MCP_PRINCIPAL_RATE_LIMITER`, which allows more than one
 * session's budget. Until that binding is deployed, a session request is
 * charged to its principal key on `MCP_RATE_LIMITER`, exactly as before.
 */
export async function checkMcpRequestRateLimit(
	env: {
		MCP_RATE_LIMITER?: RateLimiter;
		MCP_PRINCIPAL_RATE_LIMITER?: RateLimiter;
	},
	appId: string,
	headers: Headers,
	clientIp: string,
): Promise<{ allowed: boolean }> {
	const { request, ceiling } = mcpRateLimitBuckets(appId, headers, clientIp);
	if (!ceiling) return checkRateLimit(env.MCP_RATE_LIMITER, request);
	if (!env.MCP_PRINCIPAL_RATE_LIMITER) {
		return checkRateLimit(env.MCP_RATE_LIMITER, ceiling);
	}
	const session = await checkRateLimit(env.MCP_RATE_LIMITER, request);
	if (!session.allowed) return session;
	return checkRateLimit(env.MCP_PRINCIPAL_RATE_LIMITER, ceiling);
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
