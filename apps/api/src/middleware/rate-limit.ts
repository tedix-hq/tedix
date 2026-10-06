/**
 * Rate Limiting Middleware
 * Cloudflare Workers Rate Limiting Binding integration
 *
 * Supports:
 * - Per-app rate limiting for MCP endpoints
 * - Per-operation rate limiting for expensive APIs (Firecrawl, AI Search)
 * - Configurable key strategies (app, IP, API key)
 */

import { DESCOPE_SESSION_COOKIE, readCookieHeader } from "@tedix/auth/web";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import type { Context, Next } from "hono";
import { safeExceptionTopology } from "../lib/safe-log-metadata";

/**
 * Cloudflare Rate Limiter Binding interface
 */
export interface RateLimiter {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Rate limiting key function type
 */
export type RateLimitKeyFn = (
	c: Context<{ Bindings: CloudflareEnv }>,
) => string | Promise<string>;

/**
 * Key function: Rate limit by IP address
 */
export const byIp: RateLimitKeyFn = (c) => {
	return c.req.header("CF-Connecting-IP") || "unknown";
};

async function hashRateLimitKey(value: string): Promise<string> {
	const data = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.slice(0, 12)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Key function: Rate limit authenticated RPC callers by credential, otherwise by IP.
 *
 * Server-side clients such as Tedix OS call the public API from Worker egress, so
 * pure IP keying collapses many authenticated users into one bucket. Credential
 * keying keeps user/API-key traffic isolated while preserving IP limits for
 * anonymous requests.
 */
export const byCredentialOrIp: RateLimitKeyFn = async (c) => {
	const tediId = c.req.header("X-Tedix-Tedi-Id");
	if (tediId) return `tedi:${tediId}`;

	const apiKey = c.req.header("X-API-Key");
	if (apiKey) return `api-key:${await hashRateLimitKey(apiKey)}`;

	const authorization = c.req.header("Authorization");
	if (authorization) {
		return `auth:${await hashRateLimitKey(authorization.trim())}`;
	}

	const session = readCookieHeader(
		c.req.header("Cookie"),
		DESCOPE_SESSION_COOKIE,
	);
	if (session) return `session:${await hashRateLimitKey(session)}`;

	return byIp(c);
};

/**
 * Rate limiting middleware options
 */
export interface RateLimitOptions {
	/** Custom error message */
	errorMessage?: string;
	/** Skip rate limiting if binding unavailable (default: false — fail closed) */
	skipOnError?: boolean;
	/** Limit value for headers (informational) */
	limit?: number;
	/** Seconds to wait before retrying (default: 60) */
	retryAfterSeconds?: number;
}

/**
 * Create rate limiting middleware for Hono routes
 *
 * @param getLimiter - Function to get rate limiter from env
 * @param keyFn - Function to generate rate limit key
 * @param options - Configuration options
 *
 * @example
 * ```ts
 * app.use("/api/*", rateLimit(
 *   (env) => env.MCP_RATE_LIMITER,
 *   byAppAndIp,
 *   { errorMessage: "API rate limit exceeded" }
 * ));
 * ```
 */
export function rateLimit(
	getLimiter: (env: CloudflareEnv) => RateLimiter | undefined,
	keyFn: RateLimitKeyFn,
	options: RateLimitOptions = {},
) {
	const {
		errorMessage,
		skipOnError = false,
		limit = 100,
		retryAfterSeconds = 60,
	} = options;

	return async (c: Context<{ Bindings: CloudflareEnv }>, next: Next) => {
		if (isServiceBinding(c.req.raw.headers)) {
			return next();
		}

		const limiter = getLimiter(c.env);

		if (!limiter) {
			// Rate limiter not configured
			if (skipOnError) {
				console.warn({
					component: "api-rate-limit",
					event: "rate_limit.binding_unavailable",
					outcome: "skipped",
				});
				return next();
			}
			return c.json(
				{
					error: "Rate limiting unavailable",
					message: "Service temporarily unavailable",
				},
				503,
			);
		}

		try {
			const key = await keyFn(c);
			const { success } = await limiter.limit({ key });

			if (!success) {
				console.warn({
					component: "api-rate-limit",
					event: "rate_limit.denied",
					outcome: "denied",
				});
				return c.json(
					{
						error: "Rate limit exceeded",
						message:
							errorMessage || "Too many requests. Please try again later.",
						retryAfter: retryAfterSeconds,
					},
					429,
					{
						"Retry-After": String(retryAfterSeconds),
						"X-RateLimit-Limit": String(limit),
						"X-RateLimit-Remaining": "0",
					},
				);
			}
		} catch (error) {
			console.error({
				component: "api-rate-limit",
				event: "rate_limit.check_failed",
				exception: safeExceptionTopology(error),
				outcome: skipOnError ? "allowed" : "unavailable",
			});
			if (skipOnError) {
				// Fail open: allow request if rate limiting fails
				return next();
			}
			return c.json(
				{
					error: "Rate limiting error",
					message: "Service temporarily unavailable",
				},
				503,
			);
		}

		return next();
	};
}
