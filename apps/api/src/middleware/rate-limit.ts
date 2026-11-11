/**
 * Rate Limiting Middleware
 * Cloudflare Workers Rate Limiting Binding integration
 *
 * Supports:
 * - Per-app rate limiting for MCP endpoints
 * - Per-operation rate limiting for expensive APIs (AI Search)
 * - Configurable key strategies (app, IP, API key)
 */

import { DESCOPE_SESSION_COOKIE, readCookieHeader } from "@tedix/auth/web";
import { OIDC_SESSION_COOKIE } from "@tedix/auth/oidc-cookies";
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
	// No `X-Tedix-Tedi-Id` bucket: service-binding calls skip this limiter, so
	// here that header is only ever caller-typed. Keying on it let anyone
	// rotate buckets or drain a named tedi's.
	const apiKey = c.req.header("X-API-Key");
	if (apiKey) return `api-key:${await hashRateLimitKey(apiKey)}`;

	const authorization = c.req.header("Authorization");
	if (authorization) {
		return `auth:${await hashRateLimitKey(authorization.trim())}`;
	}

	const session =
		readCookieHeader(c.req.header("Cookie"), DESCOPE_SESSION_COOKIE) ??
		readCookieHeader(c.req.header("Cookie"), OIDC_SESSION_COOKIE);
	if (session) return `session:${await hashRateLimitKey(session)}`;

	return byIp(c);
};

/**
 * Addresses whose failed sign-ins used up their allowance, with the time the
 * mark lapses. Per isolate: the shared limiter holds the count, so a fresh
 * isolate relearns the mark on that address's next failed sign-in.
 */
const untrustedCredentialAddresses = new Map<string, number>();
const UNTRUSTED_ADDRESS_MS = 60_000;
const UNTRUSTED_ADDRESS_CAP = 10_000;

function isUntrustedCredentialAddress(ip: string, now: number): boolean {
	const until = untrustedCredentialAddresses.get(ip);
	if (until === undefined) return false;
	if (until > now) return true;
	untrustedCredentialAddresses.delete(ip);
	return false;
}

function markUntrustedCredentialAddress(ip: string, now: number): void {
	if (untrustedCredentialAddresses.size >= UNTRUSTED_ADDRESS_CAP)
		untrustedCredentialAddresses.clear();
	untrustedCredentialAddresses.set(ip, now + UNTRUSTED_ADDRESS_MS);
}

/** Test seam: forget every marked address. */
export function resetUntrustedCredentialAddresses(): void {
	untrustedCredentialAddresses.clear();
}

/**
 * Calls an open file editor makes while someone works: saving a change and
 * storing or reading a picture. An editor saves a fraction of a second after
 * each pause in typing, so several open tabs can make hundreds of these a
 * minute. They draw on their own allowance, so a busy editing session cannot
 * use up the allowance the rest of the product needs, and the other way round.
 */
const FILE_EDITING_PATHS = new Set([
	"/rpc/osWorkspaces/outputs/revise",
	"/rpc/osWorkspaces/outputs/patch",
	"/rpc/osWorkspaces/outputs/changes",
	"/rpc/osWorkspaces/outputs/uploadImage",
	"/rpc/osWorkspaces/outputs/image",
]);

/** `byCredentialOrIp`, with a separate bucket for file-editing calls. */
export const byCredentialOrIpWithFileEditing: RateLimitKeyFn = async (c) => {
	const key = await byCredentialOrIp(c);
	return FILE_EDITING_PATHS.has(c.req.path) ? `files:${key}` : key;
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
	/**
	 * For credential-keyed limits. The credential is not verified when the
	 * bucket is chosen, so a caller could send a new made-up value each time
	 * and never share a bucket. With this on, every 401 is also counted against
	 * the caller's address; once that allowance is spent, the address is
	 * limited by address alone for a minute, whatever credential it sends.
	 */
	countFailedAuthByIp?: boolean;
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
		countFailedAuthByIp = false,
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
			const ip = c.req.header("CF-Connecting-IP");
			const byAddressOnly =
				countFailedAuthByIp &&
				Boolean(ip) &&
				isUntrustedCredentialAddress(ip!, Date.now());
			const key = byAddressOnly ? ip! : await keyFn(c);
			const { success } = await limiter.limit({ key });

			if (!success) {
				console.warn({
					component: "api-rate-limit",
					event: "rate_limit.denied",
					outcome: "denied",
				});
				return c.json(
					c.req.path.startsWith("/rpc/")
						? {
								json: {
									defined: false,
									code: "TOO_MANY_REQUESTS",
									message:
										errorMessage ||
										"Too many requests. Please try again later.",
								},
							}
						: {
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

		await next();

		const ip = c.req.header("CF-Connecting-IP");
		if (countFailedAuthByIp && ip && c.res.status === 401) {
			try {
				const { success } = await limiter.limit({ key: `unauth:${ip}` });
				if (!success) markUntrustedCredentialAddress(ip, Date.now());
			} catch {
				// Counting failed sign-ins is best effort; the request already ran.
			}
		}
	};
}
