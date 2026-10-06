/**
 * Tedix API Worker — application module (lazily loaded)
 *
 * This module owns the Hono app, oRPC handlers, and cron/queue handlers. It is
 * dynamically imported from src/index.ts on the first event so the full
 * router/contract/schema graph is evaluated at request time, not at script
 * startup (Cloudflare deploy validation enforces a 1-second startup CPU limit,
 * error 10021).
 */
/**
 * Tedix API Worker
 * Multi-tenant AI app platform API with dual RPC/REST support
 *
 * oRPC API - Type-safe RPC with OpenAPI/REST support
 *
 * Endpoints:
 * - /rpc/*        - Internal RPC (Tedix OS, MCP service calls) - RPCHandler
 * - /v1/*         - Curated external REST API - OpenAPIHandler
 * - /openapi.json - OpenAPI 3.1 specification
 * - /docs         - API reference documentation (Scalar)
 * - /health       - Health check
 */

import { ORPCError } from "@orpc/client";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import {
	RequestLimitHandlerPlugin,
	RethrowHandlerPlugin,
} from "@orpc/server/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { D1_BOOKMARK_HEADER } from "@tedix/db/client";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { logger } from "hono/logger";
import {
	getApiDiscoveryLinkHeader,
	getApiDiscoveryUrls,
	renderApiReferenceHtml,
} from "./api-discovery";
import { byCredentialOrIp, byIp, rateLimit } from "./middleware/rate-limit";
import { scheduled } from "./jobs/scheduled-dispatch";
import { resolveCorsOrigin } from "./lib/cors-origins";
import {
	safeErrorMetadata,
	safeExceptionTopology,
} from "./lib/safe-log-metadata";
import { handleOutboundMcpClientMetadata } from "./oauth-client-metadata";
import {
	isAgentAuthoredBytePath,
	isUntrustedContentPath,
	isUntrustedContentRequest,
	resolveUntrustedContentOrigin,
} from "./lib/untrusted-origin";
import {
	createPublicOpenApiGenerateOptions,
	OPENAPI_SECURITY_EXTENSIONS,
	stripPublicRestMarker,
} from "./openapi-document";
import { enrichInputValidationError } from "./rpc/input-validation-error";
import { isPublicProcedure } from "./rpc/openapi-filter";
import { type BaseContext, createContext, logProcedureCall } from "./rpc/orpc";
import { type ApiRouter, apiRouter } from "./rpc/routers/index";
import { redactRequestLogMessage } from "./request-log-redaction";

// =============================================================================
// ORPC HANDLERS (Dual: RPC + OpenAPI)
// =============================================================================

/**
 * RPC handler for internal oRPC calls
 * Works with RPCLink client - uses oRPC's custom wire protocol for type preservation
 * Used by: Tedix OS, MCP service, internal workflows
 */

const handlerPlugins = [
	new RequestLimitHandlerPlugin({ maxBodySize: 10 * 1024 * 1024 }),
	new RethrowHandlerPlugin({
		filter: (error: unknown) => !(error instanceof ORPCError),
	}),
];

/**
 * Lift the failing field name(s) out of oRPC's generic "Input validation failed"
 * rejection into the error message (see ./rpc/input-validation-error). Runs as a
 * client interceptor because those wrap the procedure client — and input-schema
 * validation runs inside it, so the throw is catchable here. `data.issues` is
 * preserved, so structured consumers are unchanged.
 */
const clientInterceptors = [
	// Outermost: covers every procedure uniformly, including the input-validation
	// rejections enriched below. Replaces the former per-procedure
	// `.use(withLogging)` (725 call sites, and ordering-dependent — see
	// ./rpc/orpc's logProcedureCall).
	(options: {
		context: BaseContext;
		path: readonly string[];
		next: () => Promise<unknown>;
	}) => logProcedureCall(options),
	async (options: { next: () => Promise<unknown> }) => {
		try {
			return await options.next();
		} catch (error) {
			throw enrichInputValidationError(error);
		}
	},
];

const rpcHandler = new RPCHandler(apiRouter, {
	plugins: handlerPlugins,
	clientInterceptors,
});

/**
 * OpenAPI handler for external REST API
 * Works with any HTTP client - standard REST/JSON format
 * Used by: external developers and public API consumers
 *
 * Uses the explicit operation manifest; backend procedures are private by default.
 *
 * LAZY. Constructing this walks the whole ~600-procedure router to build its
 * REST route table, and it is only ever needed by the `/v1/*` REST surface.
 * The dominant traffic here is `/rpc/*` (apps/mcp, the Tedix OS, the CLI), which
 * never touches it.
 *
 * Why that matters more than it looks: this module is itself loaded lazily on
 * the first request of each isolate (see index.ts — the entrypoint stays thin
 * to survive the 1s script-startup CPU limit). So everything at module scope
 * here is paid per isolate, on a request, and cold isolates are common. Work
 * that most isolates never use must not be in that path.
 */
let openApiHandlerInstance: OpenAPIHandler<BaseContext> | undefined;
function getOpenApiHandler(): OpenAPIHandler<BaseContext> {
	openApiHandlerInstance ??= new OpenAPIHandler(apiRouter, {
		plugins: handlerPlugins,
		clientInterceptors,
		filter: isPublicProcedure,
	});
	return openApiHandlerInstance;
}

/**
 * OpenAPI specification generator — also LAZY, same reasoning.
 * Note: Uses Zod v4 converter for schema transformation.
 * Only `/openapi.json` needs it, and the generated spec is cached below.
 */
let openAPIGeneratorInstance: OpenAPIGenerator | undefined;
function getOpenAPIGenerator(): OpenAPIGenerator {
	openAPIGeneratorInstance ??= new OpenAPIGenerator({
		converters: [new ZodToJsonSchemaConverter()],
	});
	return openAPIGeneratorInstance;
}

// Cached OpenAPI spec (generated lazily on first request)
let cachedOpenApiSpec: object | null = null;
let specGeneratedAt: number = 0;
const SPEC_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// HONO APP
// =============================================================================

const app = new Hono<{ Bindings: CloudflareEnv }>();

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
 * Untrusted-content origin gate (see ./lib/untrusted-origin.ts).
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
		errorMessage: "Share request rate limit exceeded. Please try again later.",
		limit: 100,
	}),
);

// =============================================================================
// ORPC ROUTES
// =============================================================================

/**
 * Echo this request's D1 session bookmark so a caller can chain sequential
 * consistency into its next request.
 *
 * Reads are served `first-unconstrained`, so a caller that wrote in a previous
 * request and sends no bookmark can observe a value up to the replication lag
 * stale. Sending this value back in `x-d1-bookmark` removes that window. It is
 * also the only way to confirm from outside the Worker that sessions are live:
 * a null header means the request never opened one.
 */
/**
 * Resolve the org a media/artifact request addresses from its Descope token,
 * honoring the `X-Tedix-Tenant-Id` override ONLY when the caller actually
 * belongs to the target org. A bare tenant id is an identifier, not a
 * credential: without this membership gate any valid Descope subject could
 * address another org and read its artifacts by id. Same-tenant requests (the
 * common case) skip the membership lookup. Returns undefined to fail closed.
 */
async function resolveMediaRouteOrgId(
	db: import("@tedix/db/client").DbClient,
	payload: import("@tedix/auth/types").JWTPayload,
	headerTenantId: string | undefined,
): Promise<string | undefined> {
	const { resolveTenantOverride } = await import("@tedix/auth/types");
	const { tenantId, isCrossTenantOverride } = resolveTenantOverride(
		payload,
		headerTenantId,
	);
	if (!tenantId) return undefined;
	const { getOrganizationByDescopeId } =
		await import("@tedix/db/queries/organizations");
	const org = await getOrganizationByDescopeId(db, tenantId);
	if (!org) return undefined;
	if (isCrossTenantOverride) {
		if (!payload.sub) return undefined;
		const { getMemberByUserId } =
			await import("@tedix/db/queries/organization-members");
		const member = await getMemberByUserId(db, org.id, payload.sub);
		if (!member) return undefined;
	}
	return org.id;
}

function withDbBookmark(response: Response, context: BaseContext): Response {
	const bookmark = context.dbBookmark?.();
	if (!bookmark) return response;
	const headers = new Headers(response.headers);
	headers.set(D1_BOOKMARK_HEADER, bookmark);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/**
 * oRPC handler - serves type-safe procedures through the oRPC RPC protocol
 *
 * Examples (RPCLink sends POST for every procedure):
 * - POST /rpc/apps/list
 * - POST /rpc/apps/get
 * - POST /rpc/appAdapters/list
 * - POST /rpc/appAdapters/update
 * - POST /rpc/listings/search
 */
app.all("/rpc/*", async (c) => {
	// Create base context. Authentication/authorization is procedure-specific.
	const context = createContext(
		c.req.raw,
		c.env,
		c.executionCtx.waitUntil.bind(c.executionCtx),
	);

	// Development-only body logging (redacted) — never log request bodies in prod.
	// oRPC payloads can contain secrets (API keys, tokens, encrypted values, etc.).
	if (
		c.env.ENVIRONMENT === "development" &&
		(c.req.method === "POST" ||
			c.req.method === "PUT" ||
			c.req.method === "PATCH")
	) {
		const clonedRequest = c.req.raw.clone();

		const redact = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(redact);
			if (value && typeof value === "object") {
				const out: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
					const key = k.toLowerCase();
					if (
						key.includes("token") ||
						key.includes("secret") ||
						key.includes("credential") ||
						key.includes("password") ||
						key.includes("key") ||
						key.includes("apikey") ||
						key === "value" ||
						key.includes("encrypted") ||
						key.includes("authorization")
					) {
						out[k] = "[REDACTED]";
					} else {
						out[k] = redact(v);
					}
				}
				return out;
			}
			return value;
		};

		try {
			const raw = await clonedRequest.text();
			let printable = raw.slice(0, 5_000);
			try {
				printable = JSON.stringify(redact(JSON.parse(raw)), null, 2).slice(
					0,
					5_000,
				);
			} catch {
				// Not JSON (or invalid JSON) — keep truncated raw body
			}
			console.log(
				`[oRPC Request] ${c.req.method} ${c.req.path} - Body (redacted):`,
				printable,
			);
		} catch {
			console.log(
				`[oRPC Request] ${c.req.method} ${c.req.path} - Could not read body`,
			);
		}
	}

	const { matched, response } = await rpcHandler.handle(c.req.raw, {
		prefix: "/rpc",
		context,
	});

	if (!matched) {
		return c.notFound();
	}

	if (response && response.status >= 400) {
		// Always log full error body in non-dev too — needed to diagnose
		// service-binding callers (skill workflows etc.) that don't see
		// detailed errors back through the chain. Body is from oRPC and
		// already gets sensitive data redacted by the handler.
		try {
			const body = await response.clone().json();
			console.error(
				`[oRPC Error] ${c.req.method} ${c.req.path} ${response.status}:`,
				JSON.stringify(body),
			);
		} catch {
			console.error(
				`[oRPC Error] ${c.req.method} ${c.req.path} ${response.status} (no JSON body)`,
			);
		}
	}

	return withDbBookmark(response, context);
});

// =============================================================================
// REST API ROUTES (External - /v1/*)
// =============================================================================

/**
 * External REST API handler - serves OpenAPI-compliant endpoints
 *
 * Examples:
 * - GET  /v1/apps              → List apps
 * - GET  /v1/apps/{id}         → Get app by ID
 * - POST /v1/apps              → Create app
 * - GET  /v1/listings/search   → Search listings
 *
 * Only procedures accepted by `isPublicProcedure` are reachable here.
 */
app.all("/v1/*", async (c) => {
	// Create base context. Authentication/authorization is procedure-specific.
	const context = createContext(
		c.req.raw,
		c.env,
		c.executionCtx.waitUntil.bind(c.executionCtx),
	);

	// Log request for debugging (only in development)
	if (c.env.ENVIRONMENT === "development") {
		console.log(`[REST API] ${c.req.method} ${c.req.path}`);
	}

	const { matched, response } = await getOpenApiHandler().handle(c.req.raw, {
		prefix: "/v1",
		context,
	});

	if (!matched) {
		return c.json(
			{
				error: "Not Found",
				message: `No matching endpoint for ${c.req.method} ${c.req.path}`,
				docs: "/docs",
			},
			404,
		);
	}

	if (response && response.status >= 400) {
		if (c.env.ENVIRONMENT === "development") {
			try {
				const body = await response.clone().json();
				console.error(
					`[REST API Error] ${c.req.method} ${c.req.path} ${response.status}:`,
					JSON.stringify(body, null, 2),
				);
			} catch {
				console.error(
					`[REST API Error] ${c.req.method} ${c.req.path} ${response.status}`,
				);
			}
		} else {
			console.error(
				`[REST API Error] ${c.req.method} ${c.req.path} ${response.status}`,
			);
		}
	}

	return withDbBookmark(response, context);
});

// =============================================================================
// OPENAPI SPECIFICATION & DOCUMENTATION
// =============================================================================

// authz: public — API metadata landing response; contains no tenant or principal data.
app.get("/", (c) => {
	const urls = getApiDiscoveryUrls(c.env.API_URL);
	return c.json({
		name: "Tedix API",
		openapi: urls.openapi,
		documentation: urls.documentation,
	});
});

/**
 * OpenAPI specification endpoint (JSON)
 * Returns the complete OpenAPI 3.1 spec for the public REST API
 * Cached for performance (spec generation is expensive)
 */
// authz: public — machine-readable public API contract and security scheme metadata.
app.get("/openapi.json", async (c) => {
	try {
		const now = Date.now();

		// Return cached spec if still valid
		if (cachedOpenApiSpec && now - specGeneratedAt < SPEC_CACHE_TTL_MS) {
			return c.json(cachedOpenApiSpec);
		}

		// Generate fresh spec (excluding internal procedures)
		const generatedSpec = await getOpenAPIGenerator().generate(
			apiRouter,
			createPublicOpenApiGenerateOptions(),
		);
		stripPublicRestMarker(generatedSpec);

		// Merge security schemes into generated spec
		// oRPC doesn't support securitySchemes natively, so we inject them
		const spec = {
			...generatedSpec,
			security: OPENAPI_SECURITY_EXTENSIONS.security,
			components: {
				...((generatedSpec as unknown as Record<string, unknown>).components as
					| Record<string, unknown>
					| undefined),
				...OPENAPI_SECURITY_EXTENSIONS.components,
			},
		};

		// Cache it
		cachedOpenApiSpec = spec;
		specGeneratedAt = now;

		return c.json(spec);
	} catch (err) {
		console.error(
			JSON.stringify({
				event: "api.openapi_spec_generation_failed",
				exception: safeExceptionTopology(err),
			}),
		);
		return c.json({ error: "Internal server error" }, 500);
	}
});

/**
 * API documentation endpoint (Scalar UI)
 * Provides interactive API reference powered by Scalar
 */
// authz: public — interactive renderer for the same public OpenAPI contract.
app.get("/docs", (c) => {
	const faviconHref = (() => {
		try {
			const url = new URL(c.env.API_URL);
			const hostParts = url.hostname.split(".");
			if (hostParts.length > 2) {
				const rootDomain = hostParts.slice(-2).join(".");
				return `${url.protocol}//${rootDomain}/favicon.ico`;
			}
			return `${url.protocol}//${url.hostname}/favicon.ico`;
		} catch {
			return "https://tedix.dev/favicon.ico";
		}
	})();

	const html = renderApiReferenceHtml({
		apiUrl: c.env.API_URL,
		faviconHref,
	});

	return c.html(html);
});

// Health check. Mirrors the eager handler in index.ts, including deployedSha —
// the two must not disagree about which release is live.
// authz: public — liveness and deployed-sha provenance only; no tenant state.
app.get("/health", (c) =>
	c.json({
		status: "ok",
		service: "api",
		deployedSha: String(c.env.GIT_SHA || "unknown"),
		timestamp: new Date().toISOString(),
	}),
);

// authz: public OAuth authorization servers must reach this callback; the
// authenticated, encrypted state binds tenant, operator, issuer, PKCE verifier,
// resource, and expiry before any authorization code is redeemed.
app.get("/oauth/mcp/callback", async (c) => {
	const [{ createDbClient }, { handleOutboundMcpOAuthCallback }] =
		await Promise.all([
			import("@tedix/db/client"),
			import("./oauth-cimd-callback"),
		]);
	return handleOutboundMcpOAuthCallback(
		c.req.raw,
		c.env,
		createDbClient(c.env.DB),
	);
});

/**
 * Read back the exact skill-runtime version visible through API's service
 * binding. The deploy lane compares this response with the runtime's direct
 * health endpoint so a stale binding cannot silently admit workflows.
 */
// authz: public — deployment binding provenance only; no runtime or tenant state.
app.get("/health/skill-runtime", async (c) => {
	try {
		const response = await c.env.SKILL_RUNTIME.fetch(
			"https://skill-runtime/health",
		);
		const skillRuntime = await response.json();
		if (!response.ok) {
			return c.json(
				{
					status: "error",
					service: "api-skill-runtime-binding",
					upstreamStatus: response.status,
					skillRuntime,
				},
				502,
			);
		}

		return c.json({
			status: "ok",
			service: "api-skill-runtime-binding",
			apiVersion: {
				id: c.env.CF_VERSION_METADATA.id,
				tag: c.env.CF_VERSION_METADATA.tag,
				timestamp: c.env.CF_VERSION_METADATA.timestamp,
			},
			skillRuntime,
		});
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "api.skill_runtime_binding_health_failed",
				exception: safeExceptionTopology(error),
			}),
		);
		return c.json(
			{
				status: "error",
				service: "api-skill-runtime-binding",
				error: "skill_runtime_binding_unavailable",
			},
			502,
		);
	}
});

/** Mint a short-lived voice token using validated user-session organization scope. */
app.get("/kernel/ws-token", async (c) => {
	const { handleKernelWsToken } = await import("./kernel/ws-token-route");
	return handleKernelWsToken(c.req.raw, c.env);
});

/**
 * Kernel voice call WebSocket upgrade — connects the browser's voice client to
 * `KernelVoiceDO`, keyed `${organizationId}:${conversation}`. The DO runs live
 * STT (Flux) → kernel turn (startKernelTurn + runKernelTurnWork, same persist-
 * first pipeline as Home turns) → TTS (Aura) on every utterance.
 *
 * Auth: shared kernel edge policy (scoped kernel WS token primary, Descope
 * session JWT fallback — see edge-auth.ts for the auth contract).
 *
 * Query params:
 *   ?organization=<D1 org UUID>  — resolved/verified by auth; matches token scope
 *   ?conversation=<key>          — defaults to "home:main"
 *
 * Tedix OS client:
 *   wss://{apiHost}/kernel/voice/call?organization={orgId}&conversation=home:main
 *   Sec-WebSocket-Protocol: bearer-<token>
 *
 * Deliberately OUTSIDE the /rpc/* and /v1/* rate-limiter scopes — long-lived WS
 * upgrades must not consume the per-credential request budget.
 */
app.get("/kernel/voice/call", async (c) => {
	const { handleKernelVoiceCall } = await import("./kernel/voice-route");
	return handleKernelVoiceCall(c.req.raw, c.env);
});

// authz: public plain GET is a capability probe; WebSocket upgrades authenticate in the handler
app.get("/kernel/voice/input", async (c) => {
	const { handleKernelVoiceInput } = await import("./kernel/voice-input-route");
	return handleKernelVoiceInput(c.req.raw, c.env);
});

app.post("/kernel/voice/transcribe", async (c) => {
	const { handleKernelVoiceTranscription } =
		await import("./kernel/voice-transcription-route");
	return handleKernelVoiceTranscription(c.req.raw, c.env);
});

/**
 * Per-conversation kernel event stream (SSE) — the push twin of
 * `kernelRuntime.readRunEvents`, contract in
 * `@tedix/api-contract/schemas/kernel-events-stream`. Auth mirrors the
 * skill-run media route: Bearer JWT or browser session cookie (DS/id_token),
 * because EventSource cannot set headers; membership is enforced by
 * `resolveKernelConversationAccess` inside the stream module before any frame.
 * Deliberately OUTSIDE the /rpc and /v1 rate-limiter scopes — one long-lived
 * stream must not consume the per-credential request budget.
 */
app.get(
	"/kernel/runtime/conversations/:conversationId/events/stream",
	async (c) => {
		const conversationId = c.req.param("conversationId");
		const { extractRequestToken } = await import("./lib/request-token");
		const { validateToken } = await import("@tedix/auth/jwt");
		const { resolveLocalDemoUser } = await import("@tedix/auth/local-demo");
		const token = extractRequestToken((name) => c.req.header(name));
		if (!token) return c.text("Unauthorized", 401);
		let payload: Awaited<ReturnType<typeof validateToken>>;
		try {
			payload =
				resolveLocalDemoUser({
					environment: c.env.ENVIRONMENT,
					projectId: c.env.DESCOPE_PROJECT_ID,
					token,
					url: c.req.url,
					hostname: c.req.header("Host")?.replace(/:\d+$/, ""),
					enabled:
						(
							c.env as CloudflareEnv & {
								TEDIX_LOCAL_DEMO_ENABLED?: string;
							}
						).TEDIX_LOCAL_DEMO_ENABLED === "true",
				}) ??
				(await validateToken(token, {
					projectId: c.env.DESCOPE_PROJECT_ID,
					baseUrl: c.env.DESCOPE_BASE_URL,
				}));
		} catch {
			return c.text("Unauthorized", 401);
		}
		const { createDbClient } = await import("@tedix/db/client");
		const db = createDbClient(c.env.DB);
		const organizationId = await resolveMediaRouteOrgId(
			db,
			payload,
			c.req.header("X-Tedix-Tenant-Id") ?? undefined,
		);
		if (!organizationId) return c.text("Forbidden", 403);
		const { openConversationEventsStream } =
			await import("./rpc/routers/kernel-runtime/events-stream");
		return openConversationEventsStream({
			db,
			organizationId,
			descopeUserId: payload.sub ?? null,
			conversationId,
			lastEventId:
				c.req.header("Last-Event-ID") ?? c.req.query("last_event_id") ?? null,
			signal: c.req.raw.signal,
		});
	},
);

/**
 * TTL for a signed URL minted purely to bounce a session-authed byte request
 * onto the untrusted-content origin. The browser follows immediately; short
 * because it is a hop, not a share link.
 */
const SESSION_BYTE_REDIRECT_TTL_SECONDS = 300;

/**
 * Move an ALREADY-SIGNED byte request onto the untrusted-content origin.
 *
 * The signature covers only the resource identity and expiry, never the host
 * (`lib/artifact-url.ts:tokenMessage`, `lib/skill-media-url.ts:tokenMessage`),
 * so path + query transplant verbatim. Returns null when the origin is unset
 * (status quo: serve here) or when the request already arrived on it.
 */
function untrustedContentRedirect(
	env: CloudflareEnv,
	requestUrl: string,
): Response | null {
	const resolution = resolveUntrustedContentOrigin(env);
	if (resolution.state !== "configured") return null;
	const url = new URL(requestUrl);
	if (url.origin === resolution.origin) return null;
	return new Response(null, {
		status: 302,
		headers: {
			Location: new URL(url.pathname + url.search, resolution.origin).href,
			"Cache-Control": "private, no-store",
		},
	});
}

/** 302 to a freshly minted signed URL on the untrusted-content origin. */
function signedByteRedirect(signedUrl: string): Response {
	return new Response(null, {
		status: 302,
		headers: { Location: signedUrl, "Cache-Control": "private, no-store" },
	});
}

/**
 * Skill-run media: serve decoded bytes from a base64-in-JSON artifact, browser-
 * viewable. No JWT — gated by a short-lived HMAC token (exp + sig) minted by
 * `skills.getRunArtifact({ mediaUrl: true })`. The base64 decode runs in this
 * plain handler (no workflow/durable-step/bridge context), so the in-step
 * large-decode stall does not apply.
 */
app.get("/skill-media/:runId/:path{.+}", async (c) => {
	const bounce = untrustedContentRedirect(c.env, c.req.url);
	if (bounce) return bounce;
	const runId = c.req.param("runId");
	const path = c.req.param("path");
	const exp = Number(c.req.query("exp"));
	const sig = c.req.query("sig") ?? "";
	const downloadName = c.req.query("download") || undefined;
	const { verifyMediaToken, extractMediaBytes } =
		await import("./lib/skill-media-url");
	const ok = await verifyMediaToken({
		secret: c.env.SECRETS_MASTER_KEY,
		runId,
		path,
		exp,
		sig,
		nowMs: Date.now(),
		downloadName,
	});
	if (!ok) return c.text("Invalid or expired media token", 403);

	const { getRunArtifact } =
		await import("@tedix/db/queries/skill-run-artifacts");
	const { createDbClient } = await import("@tedix/db/client");
	const artifact = await getRunArtifact(createDbClient(c.env.DB), runId, path);
	if (!artifact) return c.text("Artifact not found", 404);

	let content: string | null = artifact.contentInline;
	if (content == null && artifact.contentR2Key) {
		const obj = await (
			c.env as unknown as { SKILL_ARTIFACTS?: R2Bucket }
		).SKILL_ARTIFACTS?.get(artifact.contentR2Key);
		content = obj ? await obj.text() : null;
	}
	if (content == null) return c.text("Artifact content unavailable", 404);

	const media = extractMediaBytes(content);
	if (!media) return c.text("Artifact is not decodable media", 415);

	return new Response(media.bytes, {
		headers: {
			"Content-Type": media.mimeType,
			"Content-Length": String(media.bytes.byteLength),
			"Cache-Control": "private, max-age=900",
			"Content-Disposition": downloadName
				? `attachment; filename="${downloadName}"`
				: "inline",
		},
	});
});

/**
 * Session-authed media read — the foundation for Tedix OS inline rendering
 * of generated media in durable transcripts. Same decoded-media streaming as
 * /skill-media, but gated by the user's Descope SESSION (Bearer JWT *or* the
 * `DS`/`id_token` cookie) + org-ownership of the run — NOT a bearer token.
 *
 * Because it accepts the session cookie, a browser `<img>`/`<video>` tag can
 * point straight at this stable path and render it on every scrollback without
 * embedding a short-lived signed URL in the transcript (which would 404 after
 * its TTL). Stable path shape, bound by Tedix OS + the "list my media" view:
 *   GET /skill-runs/:runId/media/:path
 */
app.get("/skill-runs/:runId/media/:path{.+}", async (c) => {
	const runId = c.req.param("runId");
	const path = c.req.param("path");

	// --- Session auth: Bearer JWT or browser session cookie (DS / id_token) ---
	const { extractRequestToken } = await import("./lib/request-token");
	const { validateToken } = await import("@tedix/auth/jwt");
	const token = extractRequestToken((name) => c.req.header(name));
	if (!token) return c.text("Unauthorized", 401);
	// Accept any valid Descope token (human user session OR tedi) — the real
	// security gate is org-ownership of the run below, which is org-scoped
	// regardless of subject. Tedix OS passes the human's session cookie; a tedi can
	// also read its own org's media with its token.
	let payload: Awaited<ReturnType<typeof validateToken>>;
	try {
		payload = await validateToken(token, {
			projectId: c.env.DESCOPE_PROJECT_ID,
			baseUrl: c.env.DESCOPE_BASE_URL,
		});
	} catch {
		return c.text("Unauthorized", 401);
	}

	// --- Resolve org from the Descope tenant claim, then check run ownership ---
	const { createDbClient } = await import("@tedix/db/client");
	const db = createDbClient(c.env.DB);
	const orgId = await resolveMediaRouteOrgId(
		db,
		payload,
		c.req.header("X-Tedix-Tenant-Id") ?? undefined,
	);
	if (!orgId) return c.text("No organization context", 403);

	const { getSkillRun } = await import("@tedix/db/queries/skill-runs");
	const run = await getSkillRun(db, runId, orgId, c.env.ENVIRONMENT);
	if (!run) return c.text("Not found", 404); // ownership enforced by getSkillRun(orgId)

	// Origin switch: org-ownership has just been proven from the session, so
	// convert that proof into a short-lived signed URL and hand the bytes off to
	// the untrusted-content origin. The redirect crosses a site boundary, so the
	// session cookie does not follow it — which is the point; the token carries
	// the capability instead.
	const mediaOrigin = resolveUntrustedContentOrigin(c.env);
	if (mediaOrigin.state === "configured") {
		const { signMediaUrl } = await import("./lib/skill-media-url");
		const signed = await signMediaUrl({
			baseUrl: mediaOrigin.origin,
			secret: c.env.SECRETS_MASTER_KEY,
			runId,
			path,
			nowMs: Date.now(),
			ttlSeconds: SESSION_BYTE_REDIRECT_TTL_SECONDS,
		});
		return signedByteRedirect(signed.url);
	}

	const { getRunArtifact } =
		await import("@tedix/db/queries/skill-run-artifacts");
	const artifact = await getRunArtifact(db, runId, path);
	if (!artifact) return c.text("Artifact not found", 404);

	let content: string | null = artifact.contentInline;
	if (content == null && artifact.contentR2Key) {
		const obj = await (
			c.env as unknown as { SKILL_ARTIFACTS?: R2Bucket }
		).SKILL_ARTIFACTS?.get(artifact.contentR2Key);
		content = obj ? await obj.text() : null;
	}
	if (content == null) return c.text("Artifact content unavailable", 404);

	const { extractMediaBytes } = await import("./lib/skill-media-url");
	const media = extractMediaBytes(content);
	if (!media) return c.text("Artifact is not decodable media", 415);

	return new Response(media.bytes, {
		headers: {
			"Content-Type": media.mimeType,
			"Content-Length": String(media.bytes.byteLength),
			"Cache-Control": "private, max-age=300",
			"Content-Disposition": "inline",
		},
	});
});

/**
 * Tedix OS output exports: stream a governed PDF/PNG produced by
 * `osWorkspaces.outputs.export` from R2. Auth mirrors /skill-runs media above:
 * Bearer JWT or browser session cookie (DS / id_token), org resolved through
 * the membership-gated `resolveMediaRouteOrgId`, and the output must belong to
 * the caller's org — a foreign output id is indistinguishable from "not
 * found". The R2 key embeds the resolved org id, so a caller can never address
 * another tenant's bytes even with a guessed output id.
 */
// The public viewer keeps the one-time capability in the URL fragment, which
// never reaches an HTTP request, proxy log, or referrer. Its same-origin POST
// exchanges that in-memory token for the current read-only output. The legacy
// path-token redemption remains for already-minted links.
// authz: public — published launcher/panel branding for one tenant slug, which
// the host already exposes in its script tag. The widget needs it before any
// signed session exists, so it is an allowlisted read with no tenant data.
app.get("/widget/branding/:tenant", async (c) => {
	const { handleWidgetBranding } = await import("./lib/widget-branding");
	return handleWidgetBranding(
		c.req.param("tenant"),
		c.env.DB,
		c.req.query("locale"),
		{
			request: c.req.raw,
			waitUntil: (work) => c.executionCtx.waitUntil(work),
		},
	);
});

// authz: public — inert viewer shell; the capability remains in the URL fragment.
app.get("/os-shared", async (_c) => {
	const { handleOsShareViewer } = await import("./lib/os-share-viewer");
	return handleOsShareViewer();
});

// authz: public — static share-viewer asset with no embedded capability or tenant data.
app.get("/os-shared/viewer.js", async (_c) => {
	const { handleOsShareViewerScript } = await import("./lib/os-share-viewer");
	return handleOsShareViewerScript();
});

// authz: public — static share-viewer asset with no embedded capability or tenant data.
app.get("/os-shared/viewer.css", async (_c) => {
	const { handleOsShareViewerStyles } = await import("./lib/os-share-viewer");
	return handleOsShareViewerStyles();
});

// authz: public — one-time capability redemption accepts no ambient browser authority.
app.post("/os-shared/redeem", async (c) => {
	const [
		{ handleOsShareRedemption },
		{ createDbQueryClient },
		{ authorizeOsShareRecipient },
	] = await Promise.all([
		import("./lib/os-share-redemption"),
		import("@tedix/db/query-client"),
		import("./rpc/orpc"),
	]);
	const body = await c.req.json().catch(() => null);
	const token =
		typeof body === "object" && body !== null && "token" in body
			? (body as { token?: unknown }).token
			: null;
	return handleOsShareRedemption(
		createDbQueryClient(c.env.DB),
		typeof token === "string" ? token : "",
		(link, role, accessEnvelope) =>
			authorizeOsShareRecipient(c.req.raw, c.env, {
				organizationId: link.organizationId,
				role,
				accessEnvelope,
			}),
	);
});

app.post("/os-shared/session", async (c) => {
	const [
		{ handleOsShareSessionRead },
		{ createDbQueryClient },
		{ authorizeOsShareRecipient },
	] = await Promise.all([
		import("./lib/os-share-redemption"),
		import("@tedix/db/query-client"),
		import("./rpc/orpc"),
	]);
	const body = await c.req.json().catch(() => null);
	const sessionToken =
		typeof body === "object" && body !== null && "sessionToken" in body
			? (body as { sessionToken?: unknown }).sessionToken
			: null;
	return handleOsShareSessionRead(
		createDbQueryClient(c.env.DB),
		typeof sessionToken === "string" ? sessionToken : "",
		(link, role, accessEnvelope) =>
			authorizeOsShareRecipient(c.req.raw, c.env, {
				organizationId: link.organizationId,
				role,
				accessEnvelope,
			}),
	);
});

// Unknown, revoked, and expired tokens are indistinguishable 404s.
app.get("/os-shared/:token", async (c) => {
	const [
		{ handleOsShareRedemption },
		{ createDbQueryClient },
		{ authorizeOsShareRecipient },
	] = await Promise.all([
		import("./lib/os-share-redemption"),
		import("@tedix/db/query-client"),
		import("./rpc/orpc"),
	]);
	return handleOsShareRedemption(
		createDbQueryClient(c.env.DB),
		c.req.param("token"),
		(link, role, accessEnvelope) =>
			authorizeOsShareRecipient(c.req.raw, c.env, {
				organizationId: link.organizationId,
				role,
				accessEnvelope,
			}),
	);
});

app.get("/video-renders/:renderId/media", async (c) => {
	const renderId = c.req.param("renderId");
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			renderId,
		)
	) {
		return c.text("Not found", 404);
	}
	const { extractRequestToken } = await import("./lib/request-token");
	const { validateToken } = await import("@tedix/auth/jwt");
	const token = extractRequestToken((name) => c.req.header(name));
	if (!token) return c.text("Unauthorized", 401);
	let payload: Awaited<ReturnType<typeof validateToken>>;
	try {
		payload = await validateToken(token, {
			projectId: c.env.DESCOPE_PROJECT_ID,
			baseUrl: c.env.DESCOPE_BASE_URL,
		});
	} catch {
		return c.text("Unauthorized", 401);
	}
	const { createDbClient } = await import("@tedix/db/client");
	const orgId = await resolveMediaRouteOrgId(
		createDbClient(c.env.DB),
		payload,
		c.req.header("X-Tedix-Tenant-Id") ?? undefined,
	);
	if (!orgId) return c.text("No organization context", 403);

	// Historical renders from the retired video-renderer Worker. The MP4 was
	// written once, on completion, under the organization's own prefix.
	const object = await c.env.TEDI_R2_BUCKET.get(
		`video-renders/${orgId}/${renderId}/output.mp4`,
		{ range: c.req.raw.headers },
	);
	if (!object) return c.text("Not found", 404);
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Cache-Control": "private, max-age=300",
		"Content-Disposition": "inline",
		"Content-Type": "video/mp4",
	});
	const range = c.req.header("Range") ? object.range : undefined;
	if (!range) {
		headers.set("Content-Length", String(object.size));
		return new Response(object.body, { headers });
	}
	const offset =
		"suffix" in range ? object.size - range.suffix : (range.offset ?? 0);
	const length =
		"suffix" in range ? range.suffix : (range.length ?? object.size - offset);
	headers.set("Content-Length", String(length));
	headers.set(
		"Content-Range",
		`bytes ${offset}-${offset + length - 1}/${object.size}`,
	);
	return new Response(object.body, { status: 206, headers });
});

// Bulk portable snapshots use a scoped bearer minted by the governed oRPC
// procedure. The byte path stays outside Code Mode's bounded result envelope.
app.get("/portable/tedis/:tediId/snapshot/:section", async (c) => {
	const authorization = c.req.header("Authorization");
	if (!authorization?.startsWith("Bearer ")) {
		return c.text("Unauthorized", 401);
	}
	const { verifyPortableSnapshotTicket } =
		await import("./lib/portable-snapshot-ticket");
	const ticket = await verifyPortableSnapshotTicket({
		secret: c.env.SECRETS_MASTER_KEY,
		token: authorization.slice("Bearer ".length),
		nowMs: Date.now(),
	});
	if (!ticket || ticket.tediId !== c.req.param("tediId")) {
		return c.text("Unauthorized", 401);
	}
	const { PortableTediSnapshotSectionSchema } =
		await import("@tedix/api-contract/schemas/portable-tedi");
	const section = PortableTediSnapshotSectionSchema.safeParse(
		c.req.param("section"),
	);
	const limitText = c.req.query("limit") ?? "500";
	const limit = Number(limitText);
	const afterId = c.req.query("afterId");
	if (
		!section.success ||
		!/^\d{1,3}$/.test(limitText) ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 500 ||
		(afterId !== undefined && (afterId.length < 1 || afterId.length > 200))
	) {
		return c.text("Invalid portable snapshot page", 400);
	}
	const { createDbClient } = await import("@tedix/db/client");
	const { readPortableSnapshotPageForOrganization } =
		await import("./rpc/routers/tedis/portable-snapshot");
	try {
		const page = await readPortableSnapshotPageForOrganization(
			createDbClient(c.env.DB),
			ticket.organizationId,
			{ tediId: ticket.tediId, section: section.data, limit, afterId },
		);
		c.header("Cache-Control", "no-store");
		return c.json(page);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === "NOT_FOUND"
		) {
			return c.text("Not found", 404);
		}
		throw error;
	}
});

// Import pages use a different HMAC purpose from export reads. The token is
// issued only to an interactive org user and the target stays paused.
app.post("/portable/tedis/:tediId/import/:section", async (c) => {
	const authorization = c.req.header("Authorization");
	if (!authorization?.startsWith("Bearer ")) {
		return c.text("Unauthorized", 401);
	}
	const { verifyPortableImportTicket } =
		await import("./lib/portable-import-ticket");
	const ticket = await verifyPortableImportTicket({
		secret: c.env.SECRETS_MASTER_KEY,
		token: authorization.slice("Bearer ".length),
		nowMs: Date.now(),
	});
	if (
		!ticket ||
		ticket.tediId !== c.req.param("tediId") ||
		c.req.header("X-Tedix-Portable-Manifest") !== ticket.manifestSha256
	) {
		return c.text("Unauthorized", 401);
	}
	const maxBytes = 32 * 1024 * 1024;
	const declaredBytes = Number(c.req.header("Content-Length") ?? "0");
	if (declaredBytes > maxBytes) return c.text("Import page too large", 413);
	const stream = c.req.raw.body;
	if (!stream) return c.text("Missing portable import page", 400);
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		byteLength += value.byteLength;
		if (byteLength > maxBytes) {
			await reader.cancel();
			return c.text("Import page too large", 413);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return c.text("Invalid portable import JSON", 400);
	}
	const { PortableTediImportPageSchema } =
		await import("@tedix/api-contract/schemas/portable-tedi");
	const page = PortableTediImportPageSchema.safeParse(raw);
	if (!page.success || page.data.section !== c.req.param("section")) {
		return c.text("Invalid portable import page", 400);
	}
	const { createDbClient } = await import("@tedix/db/client");
	const { writePortableImportPage } =
		await import("./rpc/routers/tedis/portable-import");
	try {
		const acceptedRows = await writePortableImportPage(
			createDbClient(c.env.DB),
			ticket,
			page.data,
		);
		c.header("Cache-Control", "no-store");
		return c.json({ acceptedRows });
	} catch (error) {
		if (error instanceof Error && "code" in error) {
			if (error.code === "NOT_FOUND") return c.text("Not found", 404);
			if (error.code === "CONFLICT") return c.text(error.message, 409);
		}
		throw error;
	}
});

app.get("/os-exports/:outputId/:file", async (c) => {
	const outputId = c.req.param("outputId");
	const file = c.req.param("file");
	const match = /^rev-(\d+)\.(pdf|png|xlsx|docx|pptx)$/.exec(file);
	if (!match) return c.text("Not found", 404);

	const { extractRequestToken } = await import("./lib/request-token");
	const { validateToken } = await import("@tedix/auth/jwt");
	const { resolveLocalDemoUser } = await import("@tedix/auth/local-demo");
	const token = extractRequestToken((name) => c.req.header(name));
	if (!token) return c.text("Unauthorized", 401);
	let payload: Awaited<ReturnType<typeof validateToken>>;
	try {
		payload =
			resolveLocalDemoUser({
				environment: c.env.ENVIRONMENT,
				projectId: c.env.DESCOPE_PROJECT_ID,
				token,
				url: c.req.url,
				enabled:
					(c.env as CloudflareEnv & { TEDIX_LOCAL_DEMO_ENABLED?: string })
						.TEDIX_LOCAL_DEMO_ENABLED === "true",
			}) ??
			(await validateToken(token, {
				projectId: c.env.DESCOPE_PROJECT_ID,
				baseUrl: c.env.DESCOPE_BASE_URL,
			}));
	} catch {
		return c.text("Unauthorized", 401);
	}

	const { createDbClient } = await import("@tedix/db/client");
	const orgId = await resolveMediaRouteOrgId(
		createDbClient(c.env.DB),
		payload,
		c.req.header("X-Tedix-Tenant-Id") ?? undefined,
	);
	if (!orgId) return c.text("No organization context", 403);

	const { createDbQueryClient } = await import("@tedix/db/query-client");
	const { getOsOutput, getOsOutputRevisionByNumber } =
		await import("@tedix/db/queries/os-workspaces/outputs");
	const db = createDbQueryClient(c.env.DB);
	const output = await getOsOutput(db, {
		organizationId: orgId,
		outputId,
	});
	if (!output) return c.text("Not found", 404);
	const revision = await getOsOutputRevisionByNumber(db, {
		organizationId: orgId,
		outputId,
		revision: Number(match[1]),
	});
	if (!revision) return c.text("Export not found", 404);
	const { parseDerivedAccessEnvelope } =
		await import("./services/os-derived-resource-access");
	const accessEnvelope = parseDerivedAccessEnvelope(revision.accessEnvelope);
	if (!accessEnvelope) return c.text("Forbidden", 403);
	const { authorizeOsOutputExportRecipient } = await import("./rpc/orpc");
	if (
		!(await authorizeOsOutputExportRecipient(c.req.raw, c.env, {
			organizationId: orgId,
			accessEnvelope,
		}))
	) {
		return c.text("Forbidden", 403);
	}

	const object = await c.env.R2_BUCKET.get(
		`os-exports/${orgId}/${outputId}/${file}`,
	);
	if (!object) return c.text("Export not found", 404);
	const extension = match[2] as "pdf" | "png" | "xlsx" | "docx" | "pptx";
	const fallbackTypes = {
		pdf: "application/pdf",
		png: "image/png",
		xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	} as const;
	// A PDF or an image is viewable in place. An Office file is not, and
	// serving it as an attachment is also what keeps this route inert on the
	// trusted origin — see isAgentAuthoredBytePath in lib/untrusted-origin.ts.
	const disposition =
		extension === "pdf" || extension === "png"
			? "inline"
			: // The filename is built only from values this route has already
				// constrained: the revision digits from the regex and the literal
				// extension. `outputId` is an unvalidated path param, and
				// interpolating it here would let a quote break out of the quoted
				// filename. It is not needed to name the file usefully.
				`attachment; filename="rev-${match[1]}.${extension}"`;
	return new Response(object.body, {
		headers: {
			"Content-Type":
				object.httpMetadata?.contentType ?? fallbackTypes[extension],
			"Content-Length": String(object.size),
			"Cache-Control": "private, no-store",
			"Content-Disposition": disposition,
		},
	});
});

// =============================================================================
// ARTIFACT SERVING
// =============================================================================
// Open a durable tedi deliverable (`record_artifact` → `tedi_artifacts`) in the
// browser. Two access modes mirror the skill-media routes above:
//   - Signed share token (public; the URL IS the capability, org-checked at mint):
//       GET /artifacts/s/:tediId/:artifactId?exp=&sig=
//   - Operator session (DS cookie / Bearer JWT, org-scoped ownership):
//       GET /artifacts/:tediId/:artifactId
// Both stream the raw R2 object via streamArtifactObject() — HTML renders,
// PDF/image open inline, CSV/blob download, video Range-scrubs.
// BUNDLE artifacts (`metadata.bundle === true`, uri = r2 prefix) additionally
// serve subpaths — `/artifacts[/s]/:tediId/:artifactId/js/app.js` — so a
// multi-file interactive dashboard resolves its own subresources relative to
// the artifact URL. The signed token covers (tediId, artifactId); subpaths
// ride the same capability.

/** Resolve the streamable target for an artifact row + optional bundle subpath. */
async function streamArtifactRow(
	env: CloudflareEnv,
	artifact: {
		organizationId: string;
		tediId: string;
		uri: string | null;
		mimeType: string | null;
		metadata: unknown;
	},
	subpath: string,
	rangeHeader: string | null,
	requestUrl: string,
): Promise<Response> {
	const { isBundleArtifact, resolveBundleObject, streamArtifactObject } =
		await import("./lib/artifact-serve");
	const { isOwnedArtifactR2Uri } = await import("./lib/artifact-uri-ownership");
	const ownsUri = (uri: string | null) =>
		isOwnedArtifactR2Uri({
			uri,
			organizationId: artifact.organizationId,
			tediId: artifact.tediId,
		});
	if (!ownsUri(artifact.uri)) {
		return new Response("Not found", { status: 404 });
	}
	if (isBundleArtifact(artifact.metadata)) {
		// Browser base-URL correctness: the entrypoint must be served from a
		// trailing-slash URL, else relative refs (`js/app.js`, `data.json`)
		// resolve one level above the bundle. Relative Location is legal
		// (RFC 9110) and survives the Tedix OS proxy unchanged.
		const url = new URL(requestUrl);
		if (subpath === "" && !url.pathname.endsWith("/")) {
			return new Response(null, {
				status: 302,
				headers: { Location: `${url.pathname}/${url.search}` },
			});
		}
		const target = resolveBundleObject(artifact, subpath);
		if (!target || !ownsUri(target.uri)) {
			return new Response("Not found", { status: 404 });
		}
		return streamArtifactObject(env, target, rangeHeader);
	}
	if (subpath) {
		// Subpaths only exist on bundles; a single-file artifact has none.
		return new Response("Not found", { status: 404 });
	}
	return streamArtifactObject(
		env,
		{ uri: artifact.uri, mimeType: artifact.mimeType },
		rangeHeader,
	);
}

/**
 * Bundle subpath from the RAW pathname by position: segment 0 is "" (leading
 * slash); `skip` names how many known segments precede the subpath. Positional
 * split sidesteps how the artifactId segment was percent-encoded by the
 * caller; `resolveBundleObject` decodes the remaining segments itself.
 */
function artifactSubpath(url: string, skip: number): string {
	return new URL(url).pathname.split("/").slice(skip).join("/");
}

const handleSignedArtifact = async (c: {
	env: CloudflareEnv;
	req: {
		param: (k: string) => string;
		query: (k: string) => string | undefined;
		header: (k: string) => string | undefined;
		url: string;
	};
	text: (body: string, status: 403 | 404) => Response;
}) => {
	const bounce = untrustedContentRedirect(c.env, c.req.url);
	if (bounce) return bounce;
	const tediId = c.req.param("tediId");
	const artifactId = c.req.param("artifactId");
	const exp = Number(c.req.query("exp"));
	const sig = c.req.query("sig") ?? "";
	const version = c.req.query("v");
	// Only reviewed-release (v=2) links exist; an unversioned bearer URL is dead.
	if (version === undefined) return c.text("Not found", 404);
	const approvalId = c.req.query("approval") ?? "";
	const contentDigest = c.req.query("digest") ?? "";
	const { verifyArtifactReleaseToken } = await import("./lib/artifact-url");
	const ok =
		version === "2" &&
		(await verifyArtifactReleaseToken({
			secret: c.env.SECRETS_MASTER_KEY,
			tediId,
			artifactId,
			approvalId,
			contentDigest,
			exp,
			sig,
			nowMs: Date.now(),
		}));
	if (!ok) return c.text("Invalid or expired artifact token", 403);

	const { createDbClient } = await import("@tedix/db/client");
	const { getTediArtifactById } =
		await import("@tedix/db/queries/kernel-runtime-events");
	const db = createDbClient(c.env.DB);
	const artifact = await getTediArtifactById(db, { tediId, artifactId });
	if (!artifact) return c.text("Artifact not found", 404);
	if (artifactSubpath(c.req.url, 5) || c.req.header("Range"))
		return c.text("Artifact not found", 404);
	const { getActiveArtifactReleaseApproval } =
		await import("@tedix/db/queries/artifact-policy/releases");
	const active = await getActiveArtifactReleaseApproval(db, {
		organizationId: artifact.organizationId,
		childArtifactId: artifact.id,
		approvalId,
		childContentDigest: contentDigest,
	});
	if (
		!active ||
		artifact.contentDigest !== contentDigest ||
		active.candidate.organizationId !== artifact.organizationId ||
		active.candidate.tediId !== artifact.tediId ||
		active.candidate.childArtifactId !== artifact.id
	)
		return c.text("Artifact not found", 404);
	const { readVerifiedPrivateTextArtifact } =
		await import("./services/artifact-immutable-publication");
	let body;
	try {
		body = await readVerifiedPrivateTextArtifact(
			c.env.TEDI_R2_BUCKET,
			artifact,
		);
	} catch {
		return c.text("Artifact not found", 404);
	}
	const stillActive = await getActiveArtifactReleaseApproval(db, {
		organizationId: artifact.organizationId,
		childArtifactId: artifact.id,
		approvalId,
		childContentDigest: contentDigest,
	});
	const stillValid = await verifyArtifactReleaseToken({
		secret: c.env.SECRETS_MASTER_KEY,
		tediId,
		artifactId,
		approvalId,
		contentDigest,
		exp,
		sig,
		nowMs: Date.now(),
	});
	if (!stillActive || !stillValid) return c.text("Artifact not found", 404);
	return new Response(body.bytes, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Length": String(body.bytes.byteLength),
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy": "default-src 'none'; sandbox",
		},
	});
};

app.get("/artifacts/s/:tediId/:artifactId/*", handleSignedArtifact);
app.get("/artifacts/s/:tediId/:artifactId", handleSignedArtifact);

const handleSessionArtifact = async (c: {
	env: CloudflareEnv;
	req: {
		param: (k: string) => string;
		header: (k: string) => string | undefined;
		url: string;
		raw: Request;
	};
	text: (body: string, status: 401 | 403 | 404) => Response;
}) => {
	const tediId = c.req.param("tediId");
	const artifactId = c.req.param("artifactId");

	const { extractRequestToken } = await import("./lib/request-token");
	const { validateToken } = await import("@tedix/auth/jwt");
	const token = extractRequestToken((name) => c.req.header(name));
	if (!token) return c.text("Unauthorized", 401);
	let payload: Awaited<ReturnType<typeof validateToken>>;
	try {
		payload = await validateToken(token, {
			projectId: c.env.DESCOPE_PROJECT_ID,
			baseUrl: c.env.DESCOPE_BASE_URL,
		});
	} catch {
		return c.text("Unauthorized", 401);
	}

	const { createDbClient } = await import("@tedix/db/client");
	const db = createDbClient(c.env.DB);
	const orgId = await resolveMediaRouteOrgId(
		db,
		payload,
		c.req.header("X-Tedix-Tenant-Id") ?? undefined,
	);
	if (!orgId) return c.text("No organization context", 403);

	const { getTediArtifactById } =
		await import("@tedix/db/queries/kernel-runtime-events");
	const artifact = await getTediArtifactById(db, {
		organizationId: orgId,
		tediId,
		artifactId,
	});
	// Org-ownership is the real gate (any valid Descope subject in the owning org
	// may open it); a row from another org is indistinguishable from "not found".
	if (!artifact) {
		return c.text("Not found", 404);
	}
	if (artifact.accessClassification !== null) {
		const { createContext } = await import("./rpc/orpc");
		const { authorizeAuthenticatedArtifactBytes } =
			await import("./lib/artifact-access");
		const artifactContext = createContext(c.req.raw, c.env);
		artifactContext.organizationId = orgId;
		artifactContext.authType = "user";
		artifactContext.user = payload;
		artifactContext.descopeUserId = payload.sub;
		if (
			!(await authorizeAuthenticatedArtifactBytes(artifactContext, artifact))
				.allowed
		) {
			return c.text("Not found", 404);
		}
	}
	const { isOwnedArtifactR2Uri } = await import("./lib/artifact-uri-ownership");
	if (
		!isOwnedArtifactR2Uri({
			uri: artifact.uri,
			organizationId: artifact.organizationId,
			tediId: artifact.tediId,
		})
	) {
		return c.text("Not found", 404);
	}

	// The cookie-isolated untrusted-content origin serves only reviewed-release
	// links, so a configured origin never streams session bytes here.
	if (resolveUntrustedContentOrigin(c.env).state === "configured")
		return c.text("Not found", 404);

	return streamArtifactRow(
		c.env,
		artifact,
		// ["", "artifacts", tediId, artifactId, ...subpath] → skip 4.
		artifactSubpath(c.req.url, 4),
		c.req.header("Range") ?? null,
		c.req.url,
	);
};

app.get("/artifacts/:tediId/:artifactId/*", handleSessionArtifact);
app.get("/artifacts/:tediId/:artifactId", handleSessionArtifact);

// =============================================================================
// WEBHOOK ENDPOINTS
// =============================================================================

/**
 * Firecrawl webhook endpoint
 * Receives agent events and wakes Cloudflare Workflows
 * No auth required - secured via HMAC signature verification
 *
 * All three webhook handlers below are LAZY, like the kernel/media/artifact
 * routes above: they only fire on inbound provider callbacks, so their
 * implementation graphs (audit + billing queries, stripe-billing helpers,
 * fleet-authority) must not be evaluated on every isolate's first request.
 */
app.post("/webhooks/firecrawl", async (c) => {
	const { handleFirecrawlWebhook } = await import("./webhooks/firecrawl");
	return handleFirecrawlWebhook(c);
});

/**
 * Descope Audit webhook endpoint
 * Receives audit events from Descope Webhook Connector and writes to audit_events D1
 * No auth required - secured via HMAC-SHA256 signature verification (x-descope-webhook-s256)
 */
app.post("/webhooks/descope/audit", async (c) => {
	const { handleDescopeAuditWebhook } =
		await import("./webhooks/descope-audit");
	return handleDescopeAuditWebhook(c);
});

/**
 * Stripe webhook endpoint
 * Processes subscription lifecycle events (checkout, updates, cancellation, payment failures)
 * No auth required - secured via Stripe signature verification
 */
app.post("/webhooks/stripe", async (c) => {
	const { handleStripeWebhook } = await import("./webhooks/stripe");
	return handleStripeWebhook(c, "live");
});

app.post("/webhooks/stripe/test", async (c) => {
	const { handleStripeWebhook } = await import("./webhooks/stripe");
	return handleStripeWebhook(c, "test");
});

// =============================================================================
// SCHEDULED HANDLER (Cron Triggers)
// =============================================================================
// The thin cron dispatcher lives in ./jobs/scheduled-dispatch so its
// fleet-authority gating is testable without evaluating this module graph.

// =============================================================================
// EXPORTS
// =============================================================================

export default {
	fetch: app.fetch,
	scheduled,
	// tedix-automation-events consumer: generic push-based workflow triggers.
	// The message is the config (org + tedi + skill-workflow-or-turn); the
	// handler holds zero tenant-specific logic. See jobs/automation-events.ts.
	async queue(
		batch: { queue: string; messages: readonly unknown[] },
		env: CloudflareEnv,
		ctx: { waitUntil: (p: Promise<unknown>) => void },
	) {
		const { consumeAutomationEvents } =
			await import("./jobs/automation-events");
		await consumeAutomationEvents(
			env,
			batch.messages as readonly import("./jobs/automation-events").AutomationQueueMessage[],
			{ waitUntil: ctx.waitUntil.bind(ctx) },
		);
	},
};

// Durable Object and Workflow classes are exported from src/index.ts (the
// Worker entrypoint). This module is dynamically imported from that entrypoint
// so the router/contract graph stays off the script-startup path (Cloudflare's
// 1-second startup CPU validation limit, error 10021).
// Export router type for typed client generation
export type { ApiRouter };
