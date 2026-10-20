import type { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import { correlatedErrorResponse } from "@tedix/worker-kit/request-correlation";
import { correlatedServiceRequest } from "../service-principal";
import { getApiDiscoveryLinkHeader } from "../api-discovery";
import { handleOutboundMcpClientMetadata } from "../oauth-client-metadata";
import { resolveCorsOrigin } from "../lib/cors-origins";
import { safeErrorMetadata } from "../lib/safe-log-metadata";
import {
	isAgentAuthoredBytePath,
	isUntrustedContentPath,
	isUntrustedContentRequest,
	resolveUntrustedContentOrigin,
} from "../lib/untrusted-origin";
import { byCredentialOrIp, byIp, rateLimit } from "../middleware/rate-limit";
import { redactRequestLogMessage } from "../request-log-redaction";

export function registerCorsAndLimits(app: Hono<{ Bindings: CloudflareEnv }>) {
	app.use("*", async (c, next) => {
		const { request, traceId } = correlatedServiceRequest(c.req.raw);
		c.req.raw = request;
		c.header("X-Tedix-Trace-Id", traceId);
		await next();
		c.res = await correlatedErrorResponse(c.res, traceId);
		if (c.res.status >= 400)
			console.warn("[API] request failed", {
				event: "tedix.api.error",
				traceId,
				httpStatus: c.res.status,
			});
	});

	app.use("*", async (c, next) => {
		const metadata = handleOutboundMcpClientMetadata(c.req.raw);
		if (metadata) return metadata;
		return next();
	});

	// Global error handler
	app.onError(async (err, c) => {
		console.error("[API Error]", await safeErrorMetadata(err));

		// Handle HTTPException (thrown intentionally)
		if (err instanceof HTTPException) {
			return c.json({ error: err.message, status: err.status }, err.status);
		}

		// Handle unexpected errors — don't expose internal details
		return c.json({ error: "Internal Server Error" }, 500);
	});

	// Custom 404 handler
	app.notFound((c) => {
		return c.json({ error: "Not Found", path: c.req.path }, 404);
	});

	// Logger middleware (request/response logging)
	app.use(
		"*",
		logger((message) => console.log(redactRequestLogMessage(message))),
	);

	/**
	 * Untrusted-content origin gate (see ../lib/untrusted-origin.ts).
	 *
	 * Registered BEFORE CORS so nothing credentialed can be emitted on that
	 * origin: in Hono the earlier middleware wraps the later one, so a refusal
	 * here never reaches the CORS layer.
	 *
	 * Two jobs:
	 *  - `invalid` config: refuse the byte routes loudly. A misconfigured origin
	 *    must not silently fall back to serving from the shared origin — that
	 *    would be a config claiming a boundary it does not have. The rest of the
	 *    API does not depend on it and is left alone.
	 *  - `configured` + request arrived ON that origin: serve ONLY the two signed
	 *    byte routes, GET/HEAD. Everything else is an ordinary 404, so the origin
	 *    can never act as a second authenticated API surface and never reads a
	 *    session cookie.
	 */
	app.use("*", async (c, next) => {
		const resolution = resolveUntrustedContentOrigin(c.env);
		if (resolution.state === "invalid") {
			const { pathname } = new URL(c.req.url);
			if (!isAgentAuthoredBytePath(pathname)) return next();
			console.error(
				JSON.stringify({
					signal: "untrusted_content_origin.misconfigured",
					reason: resolution.reason,
				}),
			);
			return c.text("Untrusted-content origin is misconfigured", 503);
		}
		if (resolution.state === "unset") return next();
		const url = new URL(c.req.url);
		if (url.origin !== resolution.origin) return next();
		// `c.notFound()` so a refusal here is byte-identical to any other 404 on
		// this Worker — the gate must not fingerprint which paths exist.
		if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.notFound();
		if (!isUntrustedContentPath(url.pathname)) return c.notFound();
		return next();
	});

	// CORS middleware — first-party domains plus this installation's own
	// configured surface origins (self-hosted UIs live on customer domains).
	const corsMiddleware = cors({
		origin: (requestOrigin, c) => resolveCorsOrigin(requestOrigin, c.env),
		credentials: true,
	});
	app.use("*", async (c, next) => {
		// The untrusted-content origin never gets credentialed CORS — granting it
		// would hand agent-authored script a read channel back into an authenticated
		// surface. `streamArtifactObject` sets its own `Access-Control-Allow-Origin:
		// *` (non-credentialed) for the sandboxed bundle's own `fetch("data.json")`.
		if (isUntrustedContentRequest(c.env, c.req.url)) return next();
		return corsMiddleware(c, next);
	});

	// RFC 8288 discovery for generic HTTP agents. The configured API_URL, rather
	// than the request Host header, owns the canonical public endpoints in each
	// environment.
	app.use("*", async (c, next) => {
		c.header("Link", getApiDiscoveryLinkHeader(c.env.API_URL));
		await next();
	});

	// Rate limiting for internal RPC routes (100 req/min). Authenticated callers
	// use credential buckets; anonymous callers fall back to IP buckets.
	app.use(
		"/rpc/*",
		rateLimit((env) => env.API_RATE_LIMITER, byCredentialOrIp, {
			errorMessage: "API rate limit exceeded. Please try again later.",
			limit: 100,
		}),
	);

	// Rate limiting for public REST API (100 req/min per IP - same as RPC, matches wrangler.jsonc binding)
	app.use(
		"/v1/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, {
			errorMessage: "API rate limit exceeded. Please try again later.",
			limit: 100,
		}),
	);

	// Rate limiting for public artifact serving — the signed-token route runs HMAC
	// verify + a D1 read on every unauthenticated request, so bound it per IP.
	app.use(
		"/artifacts/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, {
			errorMessage:
				"Artifact request rate limit exceeded. Please try again later.",
			limit: 100,
		}),
	);

	// Public output viewers and authenticated Gadget/workspace recipients exchange
	// high-entropy capabilities here. Bound duplicate redemption/session traffic so
	// a leaked link cannot be used to manufacture unbounded D1 session rows.
	app.use(
		"/os-shared/*",
		rateLimit((env) => env.API_RATE_LIMITER, byIp, {
			errorMessage:
				"Share request rate limit exceeded. Please try again later.",
			limit: 100,
		}),
	);
}
