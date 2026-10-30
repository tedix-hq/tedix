import { buildWwwAuthenticate } from "@tedix/mcp-shared/auth";
import { purgeAggregateSurfaceCaches } from "./aggregate-surface-cache";
/**
 * Tedix MCP Worker
 * Customer-facing stateless MCP server for Apps SDK integration
 *
 * Architecture: Stateless per-request McpServer built from cached D1 data.
 * No Durable Objects for MCP — tool data cached in Worker memory (60s TTL),
 * new McpServer + transport created per request via mountMcp() from
 * @tedix/mcp-shared/transport (server.connect() to a single-exchange
 * stateless transport).
 *
 * Routing Strategy (Hostname-Based Multi-Tenancy):
 *
 * all apps use subdomain routing - no special "aggregator" mode.
 * Tedix is equal to all other apps (tedix.mcp.tedix.dev).
 *
 * 1. Subdomain (App-scoped):
 *    - tedix.mcp.tedix.dev → Stateless MCP (app: tedix)
 *    - acme.mcp.tedix.dev → Stateless MCP (app: acme)
 *    - mobile-de.mcp.tedix.tech → Stateless MCP (app: mobile-de, local dev)
 *
 * 2. Custom Domain (App-scoped):
 *    - mcp.acme.example → Stateless MCP (lookup by custom domain)
 *
 * 3. Base Domain (Error):
 *    - mcp.tedix.dev (no subdomain) → Error, must use subdomain
 *    - localhost:3000 → Use X-Tedix-Host header to simulate subdomain
 *
 * .well-known Endpoints:
 * - /.well-known/openai-apps-challenge → App's challenge token from D1
 * - /.well-known/oauth-protected-resource → OAuth metadata JSON
 *
 * Map — sections below open with a `// ====` banner carrying these names:
 * Policy-based scope extraction, stateless MCP handler, rate limiting,
 * user -> TEDI resolution, HONO APP (non-MCP routes),
 * WORKFLOW exports, main fetch handler. Aggregation and its caches live in
 * aggregate-surface.ts.
 *
 * Design rationale behind the caching, aggregation and trust-header behaviour
 * in this file: `docs/engineering/mcp/runtime.md`. Scoped operating
 * rules: `apps/mcp/AGENTS.md`.
 */

import { extractTediJwtClaims } from "@tedix/auth/types";
import { MCP_PROTOCOL_VERSION_HEADER } from "@tedix/mcp-shared/protocol";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS } from "@tedix/mcp-shared/transport";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import {
	requestTraceId,
	correlatedErrorResponse,
} from "@tedix/worker-kit/request-correlation";
import {
	applyInboundTrustHeaderHygiene,
	isServiceBinding,
	stripServiceBindingMarker,
} from "@tedix/worker-kit/request-auth";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	humanMcpGrantFailureResponse,
	invalidateAihM2mClientScopeCache,
	isTrustedBrowserBridge,
	decideM2mAudiencePolicy,
	recordM2mTokenAudience,
	resolveAihM2mClientScopeContext,
	resolveAihM2mTediOrganizationId,
	resolveExternalAgentSessionAuth,
	resolveHumanMcpSelection,
	resolveMcpExpectedAudience,
	validateAuth,
	stripRedundantApiKeyHeader,
	type MultiOrgMcpSelection,
} from "./auth-helpers";
import { shouldBindHumanToTedi } from "./connect-organization";
import { deliverDueEventWebhooks } from "./event-webhooks";
// Import from split modules
import { extractAppFromHostname, resolveRequestHostname } from "./hostname";
import { getApiClient } from "./lib/api-client";
import { contentFreeMcpException, createMcpLogger } from "./log";
import { reassertTrustedWorkflowTediTaskId } from "./mcp/aggregate-task-handlers";
import {
	resolveTediProfileAuth,
	tediProfileFailureResponse,
	type TediProfileAuth,
} from "./tedi-profile-auth";
// Type-only static import: the value export `buildAggregateTediTools` is
// loaded dynamically at its single call site instead. That module tree
// (aggregate-tedis-*) materializes ~130 Zod→JSON-Schema conversions at module
// scope, and every one of them ran during Worker STARTUP — the deploy-time
// budget Cloudflare validates at 1s (error 10021). It is needed only when a
// request actually aggregates tedi surfaces, so it must not be on the startup
// path. Same reasoning as the `registerCodeModeTools` dynamic import.
import { handleExternalAgentSessionExchange } from "./external-agent-session";
import {
	externalAgentValidationFailureResponse,
	recordExternalAgentValidation,
} from "./external-agent-validation";
import {
	recordMcpAccessDenial,
	recordProtocolDenialIfPresent,
} from "./mcp/security-decision";
import { getAppsSDKCompatibleHtml } from "./mcp/utils/widget";
import {
	checkMcpRequestRateLimit,
	mcpRateLimitResponse,
} from "./middleware/rate-limit";
import { handlePreviewRequest } from "./preview";
import type { ResolvedApp } from "./resolution";
import {
	getCorsOrigins,
	purgeAppResolutionCacheKeys,
	resolveAppFromHostname,
} from "./resolution";
import {
	isRetryableUpstreamError,
	upstreamUnavailableResponse,
} from "./upstream";
import { handleFavicon, handleServerCard, handleWellKnown } from "./well-known";
import { unsupportedProtocolVersionResponse } from "./json-rpc-envelope";
import {
	handleInternalSubscriptionPublish,
	maybeHandleSubscriptionsListen,
} from "./mcp-events-routes";
import { validateMcpOrigin } from "./mcp-origin";
import { maybeHandleBootstrapFastMcp } from "./codemode-fast-paths";
import { enforceMcpAccess } from "./mcp-access";

import { handleMcpRequest, resolvePrimaryTedi } from "./mcp-request";
const log = createMcpLogger("mcp.router");

export { McpSubscriptionDurableObject } from "./subscriptions";

// =============================================================================
// HONO APP (non-MCP routes)
// =============================================================================

const honoApp = new Hono<{ Bindings: CloudflareEnv }>();

installHonoErrorHandlers(honoApp, { service: "mcp" });

honoApp.use("*", async (c, next) => {
	const origins = getCorsOrigins(c.env);
	const corsMiddleware = cors({
		origin: origins.length > 0 ? origins : "*",
		credentials: true,
	});
	return corsMiddleware(c, next);
});

// deployedSha is the release SHA this Worker is actually running, and the
// only unauthenticated way to see it. It is deliberately the same GIT_SHA var
// that keys the aggregate surface cache (see aggregateSurfaceCacheKey), so a
// deploy that fails to stamp it is visible here instead of silently keying the
// cache on a stale value.
// authz: public — unauthenticated liveness + deployed-sha probe; serves no tenant data.
honoApp.get("/health", (c) =>
	c.json(
		{
			status: "ok",
			service: "mcp",
			deployedSha: String(c.env.GIT_SHA || "unknown"),
			timestamp: new Date().toISOString(),
		},
		200,
		{ "Cache-Control": "no-store" },
	),
);

// Debug endpoints
// authz: public — development-only debug surface; returns 404 outside environment=development.
honoApp.get("/debug/hostname", (c) => {
	const debugEnv = c.env as CloudflareEnv;
	if (debugEnv.ENVIRONMENT !== "development") {
		return c.text("Not Found", 404);
	}
	const env = c.env as CloudflareEnv;
	const url = new URL(c.req.url);
	const xOriginalHost = c.req.header("x-original-host");
	const xForwardedHost = c.req.header("x-forwarded-host");
	const xTedixHost = c.req.header("x-tedix-host");
	const hostHeader = c.req.header("host");

	const hostname = resolveRequestHostname(c.req.raw.headers, url, env);

	const hostnameInfo = extractAppFromHostname(hostname, env);

	// Only include safe routing headers, never auth/cookie headers
	const safeHeaderKeys = new Set([
		"host",
		"x-original-host",
		"x-forwarded-host",
		"x-tedix-host",
		"x-forwarded-for",
		"x-forwarded-proto",
		"content-type",
		"accept",
		"user-agent",
		"cf-connecting-ip",
		"cf-ray",
	]);
	const safeHeaders: Record<string, string> = {};
	c.req.raw.headers.forEach((value, key) => {
		if (safeHeaderKeys.has(key)) {
			safeHeaders[key] = value;
		}
	});

	return c.json({
		urlHostname: url.hostname,
		xOriginalHost,
		xForwardedHost,
		xTedixHost,
		hostHeader,
		resolvedHostname: hostname,
		hostnameInfo,
		headers: safeHeaders,
	});
});

// authz: public — development-only debug surface; returns 404 outside environment=development.
honoApp.get("/debug/widget-html", async (c) => {
	const env = c.env as CloudflareEnv;
	if (env.ENVIRONMENT !== "development") {
		return c.text("Not Found", 404);
	}
	const route = c.req.query("route") || "/tedix/search-listings";
	const widgetUrl = env.MCP_UI_URL;
	const isDev = env.ENVIRONMENT === "development";

	try {
		const html = await getAppsSDKCompatibleHtml(widgetUrl, route);

		const preview = html.substring(0, 2000);
		const hasBaseHref = html.includes('<base href="');

		return c.json({
			success: true,
			widgetUrl,
			route,
			isDevelopment: isDev,
			validation: {
				hasBaseHref,
				totalLength: html.length,
			},
			preview: preview + (html.length > 2000 ? "\n... (truncated)" : ""),
		});
	} catch (error) {
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
				widgetUrl,
				route,
				isDevelopment: isDev,
			},
			500,
		);
	}
});

// =============================================================================
// WORKFLOW exports
// =============================================================================

// Generic server-side MCP Tasks executor — backs config-driven `_asyncTask`
// tools that opt into the io.modelcontextprotocol/tasks extension.
export { GenericTasksWorkflow } from "./workflows/generic-tasks-workflow";

// =============================================================================
// main fetch handler
// =============================================================================

const worker = {
	async fetch(
		request: Request,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/external-agents/session")
			request = stripRedundantApiKeyHeader(request);

		let hostname = resolveRequestHostname(request.headers, url, env);
		const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
		const baseMcpOrigin = env.MCP_URL;
		const isDev = env.ENVIRONMENT === "development";
		if (
			isDev &&
			(hostname === "host.docker.internal" ||
				hostname === "localhost" ||
				hostname === "127.0.0.1")
		) {
			const localAppSlug = url.searchParams.get("appSlug");
			if (localAppSlug && /^[a-z0-9-]+$/i.test(localAppSlug)) {
				hostname = `${localAppSlug}.mcp.tedix.tech`;
			}
		}

		// authz: public — health probe plus the dev-only /debug/* Hono surface.
		if (
			url.pathname === "/health" ||
			(isDev && url.pathname.startsWith("/debug/"))
		) {
			return honoApp.fetch(request, env, ctx);
		}

		if (url.pathname === "/external-agents/session") {
			return handleExternalAgentSessionExchange(request, env);
		}

		if (
			request.method === "POST" &&
			url.pathname === "/_internal/tenant-tool-policy/probe-machine"
		) {
			if (!isServiceBinding(request.headers))
				return Response.json({ error: "Forbidden" }, { status: 403 });
			try {
				const body = (await request.json()) as Record<string, unknown>;
				if (
					typeof body.organizationId !== "string" ||
					!body.organizationId ||
					typeof body.receiptId !== "string" ||
					!body.receiptId ||
					!body.exampleArgs ||
					typeof body.exampleArgs !== "object" ||
					Array.isArray(body.exampleArgs)
				)
					return Response.json(
						{ error: "Invalid probe request" },
						{ status: 400 },
					);
				const { redeemAndPrepareMachineProviderProof } =
					await import("./mcp/tenant-machine-probe");
				const result = await redeemAndPrepareMachineProviderProof({
					organizationId: body.organizationId,
					receiptId: body.receiptId,
					exampleArgs: body.exampleArgs as Record<string, unknown>,
					env,
				});
				return Response.json(result);
			} catch {
				return Response.json(
					{ error: "Identity proof unavailable" },
					{ status: 503 },
				);
			}
		}

		if (
			request.method === "POST" &&
			url.pathname === "/_internal/tenant-tool-policy/probe-profile"
		) {
			if (!isServiceBinding(request.headers))
				return Response.json({ error: "Forbidden" }, { status: 403 });
			try {
				const body = (await request.json()) as Record<string, unknown>;
				if (
					typeof body.organizationId !== "string" ||
					!body.organizationId ||
					typeof body.receiptId !== "string" ||
					!body.receiptId ||
					!body.exampleArgs ||
					typeof body.exampleArgs !== "object" ||
					Array.isArray(body.exampleArgs)
				)
					return Response.json(
						{ error: "Invalid probe request" },
						{ status: 400 },
					);
				const { probeReviewedProviderIdentity } =
					await import("./mcp/tenant-profile-probe");
				let credentialSummary:
					| { scope: "user" | "tenant"; connectionInstanceId?: string }
					| undefined;
				const digest = await probeReviewedProviderIdentity({
					onCredentialSummary: (summary) => {
						credentialSummary = summary;
					},
					organizationId: body.organizationId,
					receiptId: body.receiptId,
					exampleArgs: body.exampleArgs as Record<string, unknown>,
					env,
					ctx,
				});
				return digest
					? Response.json({
							accountRevisionDigest: digest,
							...(credentialSummary ? { credentialSummary } : {}),
						})
					: Response.json(
							{ error: "Identity proof unavailable" },
							{ status: 403 },
						);
			} catch {
				return Response.json(
					{ error: "Identity proof unavailable" },
					{ status: 503 },
				);
			}
		}

		// An owner-facing API asks the internal gateway to resolve a fresh mount.
		// The descriptor is evidence for a policy revision, never an approval itself.
		if (
			request.method === "POST" &&
			(url.pathname === "/_internal/tenant-tool-policy/prepare" ||
				url.pathname === "/_internal/tenant-tool-policy/prepare-profile" ||
				url.pathname === "/_internal/tenant-tool-policy/prepare-native")
		) {
			if (!isServiceBinding(request.headers))
				return Response.json({ error: "Forbidden" }, { status: 403 });
			try {
				const body = (await request.json()) as Record<string, unknown>;
				if (
					typeof body.organizationId !== "string" ||
					!body.organizationId ||
					typeof body.rootAppId !== "string" ||
					!body.rootAppId ||
					typeof body.mountedToolId !== "string" ||
					!body.mountedToolId
				)
					return Response.json(
						{ error: "Invalid mount selection" },
						{ status: 400 },
					);
				const {
					prepareTenantPolicyMount,
					prepareTenantIdentityProfileMount,
					prepareTenantNativePolicyMount,
				} = await import("./mcp/tenant-policy-mount");
				const prepare = url.pathname.endsWith("/prepare-native")
					? prepareTenantNativePolicyMount
					: url.pathname.endsWith("/prepare-profile")
						? prepareTenantIdentityProfileMount
						: prepareTenantPolicyMount;
				const result = await prepare({
					organizationId: body.organizationId,
					rootAppId: body.rootAppId,
					mountedToolId: body.mountedToolId,
					env,
					ctx,
				});
				return result
					? Response.json(result)
					: Response.json(
							{ error: "Mount cannot be verified" },
							{ status: 404 },
						);
			} catch {
				return Response.json(
					{ error: "Mount verification unavailable" },
					{ status: 503 },
				);
			}
		}

		// Internal service-binding-only route: best-effort scope cache invalidation.
		// Called by apps/api after syncTediAihClientForAssignment succeeds.
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/invalidate-scope-cache"
		) {
			if (!isServiceBinding(request.headers)) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const body = (await request.json()) as { mcpServerId?: string };
				const cleared = invalidateAihM2mClientScopeCache(
					body.mcpServerId ? { mcpServerId: body.mcpServerId } : undefined,
				);
				return new Response(JSON.stringify({ ok: true, cleared }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			} catch {
				return new Response(JSON.stringify({ ok: true, cleared: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		// Internal service-binding-only route: best-effort Workers Cache purge for
		// an app's `.well-known/*` discovery documents (see well-known.ts, which
		// stamps `Cache-Tag: app:{id}` on the two cacheable responses). Called by
		// apps/api after a mutation that can change discovery content: mcpConfig
		// (updateAppProcedure / updateByIdOrSlugProcedure) or the OpenAI challenge
		// token, once an endpoint writes that field.
		// Purge the durable aggregate-surface cache (L3/R2 globally, L1 for this
		// isolate). Called by the tool-schema-sync workflow after it applies
		// schema changes, because these layers otherwise have no invalidation
		// (see `docs/engineering/mcp/runtime.md`). Purge rolls the
		// global activation epoch before deleting snapshots; every aggregate
		// request reads that marker before addressing L1/L2 so notifications
		// never outrun it.
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/purge-aggregate-cache"
		) {
			if (!isServiceBinding(request.headers)) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const { deleted, l2Deleted, localEntries, activationEpoch } =
					await purgeAggregateSurfaceCaches(env);
				console.log(
					`[aggregate] purge-aggregate-cache: r2Deleted=${deleted} localEntriesCleared=${localEntries}`,
				);
				return new Response(
					JSON.stringify({
						ok: true,
						r2Deleted: deleted,
						l2Deleted,
						localEntries,
						activationEpoch,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			} catch (error) {
				return new Response(
					JSON.stringify({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/purge-discovery-cache"
		) {
			if (!isServiceBinding(request.headers)) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const body = (await request.json()) as {
					appId?: string;
					appResolutionKeys?: string[];
				};
				if (!body.appId) {
					return new Response(
						JSON.stringify({ ok: false, error: "appId required" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const result = await ctx.cache?.purge({
					tags: [`app:${body.appId}`],
				});
				const resolution = await purgeAppResolutionCacheKeys(
					env,
					body.appResolutionKeys ?? [],
				);
				return new Response(
					JSON.stringify({
						ok: result?.success !== false,
						discoveryPurged: result?.success ?? false,
						...resolution,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			} catch {
				return new Response(JSON.stringify({ ok: false }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		if (
			request.method === "POST" &&
			url.pathname === "/__internal/subscriptions/publish"
		) {
			return handleInternalSubscriptionPublish(request, env);
		}

		// The API's two-minute cron drives SEP-3415 webhook delivery here.
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/events/deliver"
		) {
			if (!isServiceBinding(request.headers))
				return Response.json({ error: "Forbidden" }, { status: 403 });
			return Response.json({
				ok: true,
				...(await deliverDueEventWebhooks(env)),
			});
		}

		// MCP CORS preflight must answer before auth — OPTIONS carries no
		// credentials, so browser-hosted modern clients otherwise get 401 and
		// cannot negotiate. Advertise the full modern header set.
		if (
			request.method === "OPTIONS" &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
		) {
			const requestedParamHeaders = (
				request.headers.get("Access-Control-Request-Headers") ?? ""
			)
				.split(",")
				.map((header) => header.trim())
				.filter((header) => /^mcp-param-/i.test(header));
			const allowedHeaders = [
				"Content-Type",
				"Accept",
				"Authorization",
				"MCP-Protocol-Version",
				"Mcp-Session-Id",
				"Mcp-Method",
				"Mcp-Name",
				"X-API-Key",
				...requestedParamHeaders,
			];
			return new Response(null, {
				status: 204,
				headers: {
					// Echoes any origin (bearer-authenticated MCP) and adds X-API-Key +
					// reflected Mcp-Param-* headers: not the worker-kit allowlist/constants.
					"Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
					"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": [...new Set(allowedHeaders)].join(
						", ",
					),
					"Access-Control-Max-Age": "86400",
				},
			});
		}

		// Legacy initialization has no version header. Explicit versions must
		// belong to the same compatibility ladder advertised by the transport.
		const protocolVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
		if (
			request.method === "POST" &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) &&
			protocolVersion !== null &&
			!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
		) {
			return unsupportedProtocolVersionResponse(request);
		}

		if (
			!baseMcpOrigin &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
		) {
			return new Response(
				JSON.stringify({
					error: "Server misconfiguration",
					message: "MCP_URL must be set for MCP routing.",
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// authz: public — the host's icon for directory listings.
		if (
			url.pathname === "/favicon.ico" &&
			(request.method === "GET" || request.method === "HEAD")
		) {
			return handleFavicon(hostname, env);
		}

		// authz: public — the MCP Server Card is a static, credential-free
		// description of this endpoint (SEP-2127).
		if (
			url.pathname === "/mcp/server-card" &&
			(request.method === "GET" || request.method === "HEAD")
		) {
			return handleServerCard(hostname, env);
		}

		// Step 1: Handle .well-known routes
		// authz: public — OAuth/MCP discovery documents are spec-mandated unauthenticated.
		if (url.pathname.startsWith("/.well-known/")) {
			const wellKnownResponse = await handleWellKnown(url, hostname, env);
			if (wellKnownResponse) {
				return wellKnownResponse;
			}
		}

		// Step 2: Validate OAuth/auth for MCP routes
		const hasAuthHeader = request.headers.get("Authorization");
		const hasApiKeyHeader =
			request.headers.get("X-API-Key") || request.headers.get("x-api-key");
		const hasServiceBinding = isServiceBinding(request.headers);
		const hasAnyAuth = hasAuthHeader || hasApiKeyHeader || hasServiceBinding;

		const isMcpPath =
			url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");

		// Skill-run provenance the skill-runtime bridge asserts. Captured before the
		// strip below and re-set only for validated service-binding callers, so an
		// external caller cannot spoof it — memory_learn trusts x-tedix-skill-run-id
		// as a fact-source URI (`skill://runs/<id>`).
		let inboundSkillRunId: string | null = null;
		let inboundSkillId: string | null = null;
		let inboundWorkflowStepId: string | null = null;
		let inboundWorkflowStepName: string | null = null;
		let inboundWorkflowStepCount: string | null = null;
		let inboundWorkflowStepAttempt: string | null = null;
		let inboundWorkflowExecutionEpoch: string | null = null;
		let inboundWorkflowCallId: string | null = null;
		let inboundWorkflowIdempotencyKey: string | null = null;
		let inboundWorkflowTediTaskId: string | null = null;

		if (isMcpPath) {
			// Security: Unconditionally strip all inbound trust-asserting x-tedix-*
			// headers from every incoming MCP request — authenticated or not. This
			// prevents external callers from spoofing identity / skill-run provenance
			// on public (unauthenticated) apps. They are only re-set below after
			// successful validation: x-tedix-auth-* from the verified principal, and
			// x-tedix-skill-run-id / -skill-id only for trusted service-binding callers.
			inboundSkillRunId = request.headers.get("x-tedix-skill-run-id");
			inboundSkillId = request.headers.get("x-tedix-skill-id");
			inboundWorkflowStepId = request.headers.get("x-tedix-workflow-step-id");
			inboundWorkflowStepName = request.headers.get(
				"x-tedix-workflow-step-name",
			);
			inboundWorkflowStepCount = request.headers.get(
				"x-tedix-workflow-step-count",
			);
			inboundWorkflowStepAttempt = request.headers.get(
				"x-tedix-workflow-step-attempt",
			);
			inboundWorkflowExecutionEpoch = request.headers.get(
				"x-tedix-workflow-execution-epoch",
			);
			inboundWorkflowCallId = request.headers.get("x-tedix-workflow-call-id");
			inboundWorkflowTediTaskId = request.headers.get(
				"x-tedix-workflow-tedi-task-id",
			);
			inboundWorkflowIdempotencyKey =
				request.headers.get("idempotency-key") ??
				request.headers.get("x-idempotency-key");
			const incomingTrustHeaders = [...request.headers.keys()].filter(
				(k) =>
					k.startsWith("x-tedix-auth-") ||
					k === "x-tedix-skill-run-id" ||
					k === "x-tedix-skill-id" ||
					k.startsWith("x-tedix-workflow-"),
			);
			if (incomingTrustHeaders.length > 0) {
				const stripped = new Headers(request.headers);
				for (const h of incomingTrustHeaders) stripped.delete(h);
				request = new Request(request, { headers: stripped });
			}
		}

		// Security: strip the shared trust-header deny-list on every route, not
		// just `/mcp`. The narrow strip above covers only `x-tedix-auth-*`,
		// skill-run and workflow markers; `X-Service-Binding`, `X-Tedix-Org-Id`,
		// `X-Tedix-Tedi-Id`, `X-Tedix-Tedi-Scopes`, `X-Tedix-Caller-Type`,
		// `x-tedix-external-agent-*` and the rest of INTERNAL_TRUST_HEADERS must
		// not stay forwardable anywhere. This is the invariant the
		// platform-operator cross-org grant in
		// `cognitive-runtime/events-policy.ts` rests on; why the gap was inert
		// but one refactor from a cross-tenant authority grant:
		// `docs/engineering/mcp/runtime.md`.
		//
		// Additive by construction: a genuine service-binding request is left
		// untouched (the helper returns early), preserving today's behavior for
		// internal hops, while every external request is stripped on every path.
		if (!hasServiceBinding) {
			const hygienic = new Headers(request.headers);
			const before = [...hygienic.keys()].length;
			applyInboundTrustHeaderHygiene(hygienic, false);
			if ([...hygienic.keys()].length !== before) {
				request = new Request(request, { headers: hygienic });
			}
		}

		// Extract app information from hostname (needed for early app resolution below)
		const hostnameInfo = extractAppFromHostname(hostname, env);

		// Resolve app early (Worker-level cache hit ~0ms) so proxy targets can
		// validate against the exact resource audience recorded on their app row.
		let earlyResolvedApp: ResolvedApp | null = null;
		let earlyAuthMode: string | undefined;
		let oauthJwtPayload: Record<string, unknown> | undefined;
		let multiOrgSelection: MultiOrgMcpSelection | null = null;
		// Content-free auth stage timing, logged once for a human principal:
		// fixed stage names and durations only.
		const authStages: Record<string, number> = {};
		let authLast = Date.now();
		const authStarted = authLast;
		const markAuth = (stage: string) => {
			const now = Date.now();
			authStages[`${stage}_ms`] = now - authLast;
			authLast = now;
		};
		if (
			isMcpPath &&
			hasAnyAuth &&
			(hostnameInfo.type === "subdomain" || hostnameInfo.type === "custom")
		) {
			try {
				earlyResolvedApp = await resolveAppFromHostname(hostnameInfo, env);
				markAuth("resolve");
				earlyAuthMode = earlyResolvedApp?.metadata?.mcpConfig?.authMode as
					| string
					| undefined;
			} catch {
				// Non-fatal — full resolution below will surface the error
			}
		}

		if (isMcpPath && hasAnyAuth) {
			const trustedBrowserBridge = isTrustedBrowserBridge(request.headers);
			if (!hasAuthHeader && hasApiKeyHeader) {
				const apiKey = hasApiKeyHeader;
				const headers = new Headers(request.headers);
				headers.set("Authorization", `Bearer ${apiKey}`);
				headers.delete("X-API-Key");
				request = new Request(request.url, {
					method: request.method,
					headers,
					body: request.body,
					// @ts-expect-error — duplex needed for streaming body in Workers
					duplex: "half",
				});
			}

			// The credential transport header cannot exempt a human OAuth grant
			// from its exact resource audience or live consent checks.
			const expectedAudience = trustedBrowserBridge
				? undefined
				: resolveMcpExpectedAudience({
						hostname,
						authMode: earlyAuthMode,
						configuredAudience:
							earlyResolvedApp?.metadata?.mcpConfig?.expectedAudience,
					});
			if (!trustedBrowserBridge && !expectedAudience) {
				if (earlyResolvedApp) {
					await recordMcpAccessDenial({
						request,
						resolvedApp: earlyResolvedApp,
						env,
						ctx,
						reason: "oauth_audience_not_configured",
						httpStatus: 503,
					});
				}
				return new Response(
					JSON.stringify({
						error: "oauth_audience_not_configured",
						message:
							"This proxy-target MCP server has no configured OAuth audience.",
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				);
			}
			const authResult = await validateAuth(request, env, {
				hostname,
				expectedAudience: expectedAudience ?? undefined,
				mcpServerId:
					typeof earlyResolvedApp?.metadata?.mcpConfig?.descopeResourceId ===
					"string"
						? earlyResolvedApp.metadata.mcpConfig.descopeResourceId
						: undefined,
			});
			markAuth("token");

			if (authResult instanceof Response) {
				if (earlyResolvedApp) {
					await recordMcpAccessDenial({
						request,
						resolvedApp: earlyResolvedApp,
						env,
						ctx,
						reason: "authentication_failed",
						httpStatus: authResult.status,
					});
				}
				return authResult;
			}

			if (authResult) {
				const headers = new Headers(request.headers);
				headers.set("x-tedix-auth-type", authResult.type);
				if (authResult.type === "delegated-mcp") {
					// The signed Home dispatch ceiling is the only scope source on this
					// request. Do not enter the AIH branch that rehydrates the full tedi
					// profile from D1, or accept inbound identity headers.
					const liveTedi = await resolveTediProfileAuth(
						env,
						authResult.claims.tediId,
					);
					if (liveTedi.status !== "active") {
						return tediProfileFailureResponse(liveTedi, "delegated-mcp");
					}
					if (liveTedi.orgId !== authResult.claims.organizationId) {
						return new Response(
							JSON.stringify({ error: "delegated_tenant_mismatch" }),
							{
								status: 403,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
					headers.set("x-tedix-auth-type", "tedi");
					headers.set("x-tedix-auth-credential-mode", "delegated-mcp");
					headers.set("x-tedix-auth-request-run-id", authResult.claims.runId);
					headers.set(
						"x-tedix-auth-request-root-run-id",
						authResult.claims.homeRunId,
					);
					headers.set(
						"x-tedix-auth-request-work-item-id",
						authResult.claims.workItemId,
					);
					if (liveTedi.mcpEndpoints !== undefined)
						headers.set(
							"x-tedix-auth-mcp-endpoints",
							JSON.stringify(liveTedi.mcpEndpoints),
						);
					headers.set("x-tedix-auth-tedi-id", authResult.claims.tediId);
					headers.set("x-tedix-auth-user-id", authResult.claims.tediId);
					headers.set("x-tedix-auth-org-id", authResult.claims.organizationId);
					headers.set(
						"x-tedix-auth-scopes",
						authResult.claims.scopes.join(" "),
					);
				} else if (authResult.type === "service-binding") {
					// Internal service-binding caller (skill-runtime, internal Workers).
					// Propagate identity from the X-Tedix-* headers the caller set,
					// and signal "service" auth-type to the McpServer factory so
					// callers like skill-runtime bypass Code Mode and get individual
					// tools instead of the collapsed `code` tool.
					headers.set("x-tedix-auth-type", "service");
					if (authResult.userId) {
						headers.set("x-tedix-auth-user-id", authResult.userId);
					}
					// Only an explicit X-Tedix-Tedi-Id makes the caller a tedi.
					// authResult.userId may instead be X-Tedix-Acting-User (Home
					// kernel direct reads); conflating it into tediId forced every
					// kernel call down the tedi credential path, where
					// fetchTediToken 400s on a non-tedi id and the user-credential
					// leg always failed. For tedi callers userId === X-Tedix-Tedi-Id
					// so this is behavior-identical for them.
					{
						const callerTediId = request.headers.get("X-Tedix-Tedi-Id");
						if (callerTediId) {
							headers.set("x-tedix-auth-tedi-id", callerTediId);
						}
					}
					// Kernel marker → kernel audit actor. Propagated the
					// same way as acting-user/tedi-id: the incoming x-tedix-auth-*
					// namespace is unconditionally stripped above, so this header can
					// only originate from validateAuth's authenticated service-binding
					// result (apps/api kernel sent X-Tedix-Kernel), never
					// from an external caller.
					if (authResult.kernel) {
						headers.set("x-tedix-auth-kernel", "true");
						if (authResult.approvedFactoryRequestId)
							headers.set(
								"x-tedix-auth-approved-factory-request",
								authResult.approvedFactoryRequestId,
							);
						if (authResult.approvedWorkResponderUserId)
							headers.set(
								"x-tedix-auth-approved-work-responder",
								authResult.approvedWorkResponderUserId,
							);
						if (authResult.approvedHomeUserId)
							headers.set(
								"x-tedix-auth-approved-home-user",
								authResult.approvedHomeUserId,
							);
					}
					if (authResult.organizationId)
						headers.set("x-tedix-auth-org-id", authResult.organizationId);
					if (authResult.scopes && authResult.scopes.length > 0)
						headers.set("x-tedix-auth-scopes", authResult.scopes.join(" "));
					// Skill-run provenance: re-assert only for trusted service-binding
					// callers (the skill-runtime bridge). Stripped from the inbound
					// request above, so an external caller cannot spoof a victim's
					// skill-run-id (which memory_learn trusts as a fact-source URI).
					if (inboundSkillRunId) {
						headers.set("x-tedix-skill-run-id", inboundSkillRunId);
					}
					if (inboundSkillId) {
						headers.set("x-tedix-skill-id", inboundSkillId);
					}
					if (inboundWorkflowStepId) {
						headers.set("x-tedix-workflow-step-id", inboundWorkflowStepId);
					}
					if (inboundWorkflowStepName) {
						headers.set("x-tedix-workflow-step-name", inboundWorkflowStepName);
					}
					if (inboundWorkflowStepCount) {
						headers.set(
							"x-tedix-workflow-step-count",
							inboundWorkflowStepCount,
						);
					}
					if (inboundWorkflowStepAttempt) {
						headers.set(
							"x-tedix-workflow-step-attempt",
							inboundWorkflowStepAttempt,
						);
					}
					if (inboundWorkflowExecutionEpoch) {
						headers.set(
							"x-tedix-workflow-execution-epoch",
							inboundWorkflowExecutionEpoch,
						);
					}
					if (inboundWorkflowCallId) {
						headers.set("x-tedix-workflow-call-id", inboundWorkflowCallId);
					}
					if (inboundWorkflowIdempotencyKey) {
						headers.set(
							"x-tedix-workflow-idempotency-key",
							inboundWorkflowIdempotencyKey,
						);
					}
				} else if (authResult.type === "oauth") {
					if (authResult.userId)
						headers.set("x-tedix-auth-user-id", authResult.userId);
					if (authResult.organizationId)
						headers.set("x-tedix-auth-org-id", authResult.organizationId);
					if (authResult.email)
						headers.set("x-tedix-auth-email", authResult.email);
					if (authResult.clientId)
						headers.set("x-tedix-auth-client-id", authResult.clientId);
					// Hoist JWT payload so tenant-match enforcement (below, outside this
					// block's scope) can access it without a ReferenceError.
					oauthJwtPayload = authResult.payload as Record<string, unknown>;
					const jwtPayload = authResult.payload as Record<string, unknown>;
					const mcpServerId = earlyResolvedApp?.metadata?.mcpConfig
						?.descopeResourceId as string | undefined;
					let aihM2mTediProfileAuth: TediProfileAuth | null = null;
					const aihM2mClient = mcpServerId
						? await resolveAihM2mClientScopeContext(
								env,
								jwtPayload,
								mcpServerId,
								{
									bearerToken:
										request.headers
											.get("Authorization")
											?.match(/^Bearer\s+(.+)$/i)?.[1] ??
										request.headers.get("X-API-Key") ??
										undefined,
									// Defense in depth (audit CC-2): bound a tedi client's
									// baked registration scopes to its current live D1
									// capability profile at request time, so a stale-broad
									// Descope client credential — e.g. a capability downgrade
									// that has not yet propagated to the client registration —
									// can never exceed the tedi's live profile. Resolved fresh
									// (uncached) and reused below for the scope header.
									resolveTediProfileScopes: async (tediId) => {
										aihM2mTediProfileAuth = await resolveTediProfileAuth(
											env,
											tediId,
										);
										// A tedi without live authority gets no scopes; the
										// request is answered with its failure response below.
										return aihM2mTediProfileAuth.status === "active"
											? aihM2mTediProfileAuth.scopes
											: [];
									},
								},
							)
						: null;
					if (authResult.m2mAudience) {
						const policy = decideM2mAudiencePolicy({
							policy: earlyResolvedApp?.metadata?.mcpConfig?.m2mAudiencePolicy,
							outcome: authResult.m2mAudience.outcome,
							resolvedClientId: aihM2mClient?.clientId,
							now: new Date(),
						});
						recordM2mTokenAudience(env, {
							audit: authResult.m2mAudience,
							payload: jwtPayload,
							clientResolved: aihM2mClient !== null,
							mcpServerId,
							appId: earlyResolvedApp?.app.id,
							appSlug: earlyResolvedApp?.app.slug,
							policy,
						});
						if (policy.reject) {
							if (earlyResolvedApp)
								await recordMcpAccessDenial({
									request,
									resolvedApp: earlyResolvedApp,
									env,
									ctx,
									reason: "authentication_failed",
									httpStatus: 401,
								});
							return new Response(
								JSON.stringify({
									error: "invalid_token",
									message: "Token audience does not name this MCP server.",
								}),
								{
									status: 401,
									headers: {
										"Content-Type": "application/json",
										"WWW-Authenticate": buildWwwAuthenticate(
											hostname,
											"invalid_token",
											"audience",
										),
									},
								},
							);
						}
					}
					markAuth("client");
					const { claims: tediClaims, error: tediClaimError } =
						extractTediJwtClaims(authResult.payload);

					if (tediClaimError) {
						console.warn(`[MCP Auth] ${tediClaimError}`);
					}

					if (
						!tediClaims &&
						!aihM2mClient &&
						!trustedBrowserBridge &&
						authResult.localDemo !== true
					) {
						const config = earlyResolvedApp?.metadata?.mcpConfig;
						if (!mcpServerId || !expectedAudience)
							return new Response(
								JSON.stringify({ error: "human_mcp_resource_not_configured" }),
								{
									status: 503,
									headers: { "Content-Type": "application/json" },
								},
							);
						const resolved = await resolveHumanMcpSelection(
							authResult.payload,
							env,
							{
								audience: expectedAudience,
								mcpServerId,
								multiOrganization: config?.multiOrgConsent === true,
							},
						);
						markAuth("grant");
						if (!resolved.ok) return humanMcpGrantFailureResponse(resolved);
						const selection = resolved.selection;
						// A refreshed provider token cannot exceed this installation's consent.
						if (selection.effectiveScopes !== undefined)
							authResult.scopes = selection.effectiveScopes;
						if (config?.multiOrgConsent === true) multiOrgSelection = selection;
						else if (
							selection.organizations.length !== 1 ||
							selection.organizations[0]?.organizationId !==
								earlyResolvedApp?.app.organizationId
						)
							return new Response(
								JSON.stringify({ error: "human_mcp_tenant_mismatch" }),
								{
									status: 403,
									headers: { "Content-Type": "application/json" },
								},
							);
					}
					if (tediClaims) {
						// First-class tedi identity: access key → JWT exchange.
						// Requires explicit top-level claims: tediId, entityType, descopeUserId.
						// Resolve capability profile + real org ID from D1 via API service binding.
						headers.set("x-tedix-auth-tedi-id", tediClaims.tediId);
						headers.set("x-tedix-auth-user-id", tediClaims.descopeUserId);
						headers.set("x-tedix-auth-type", "tedi");
						headers.set("x-tedix-auth-credential-mode", "direct-tedi-jwt");
						const directTediAuth = await resolveTediProfileAuth(
							env,
							tediClaims.tediId,
						);
						if (directTediAuth.status !== "active") {
							return tediProfileFailureResponse(
								directTediAuth,
								"direct-tedi-jwt",
							);
						}
						// Override Descope tenant ID (e.g. "org_tedix") with real D1 org
						// UUID. Without this, tedi-originated calls query the wrong org.
						if (directTediAuth.orgId) {
							headers.set("x-tedix-auth-org-id", directTediAuth.orgId);
						}
						headers.set("x-tedix-auth-scopes", directTediAuth.scopes.join(" "));
						if (directTediAuth.mcpEndpoints !== undefined)
							headers.set(
								"x-tedix-auth-mcp-endpoints",
								JSON.stringify(directTediAuth.mcpEndpoints),
							);
					} else if (aihM2mClient) {
						// Descope AIH client-credentials tokens identify the registered
						// MCP client but do not currently include its scopes as JWT
						// claims. The registered client remains the authority for tedi
						// M2M callers, so hydrate scopes from the verified AIH client.
						headers.set("x-tedix-auth-credential-mode", "aih-m2m");
						if (aihM2mClient.clientId) {
							headers.set("x-tedix-auth-client-id", aihM2mClient.clientId);
						}
						if (aihM2mClient.externalAgent) {
							const validationStartedAt = performance.now();
							let externalAgent: Awaited<
								ReturnType<typeof resolveExternalAgentSessionAuth>
							>;
							try {
								externalAgent = await resolveExternalAgentSessionAuth(
									env,
									aihM2mClient.externalAgent,
									aihM2mClient.clientRecordId,
									aihM2mClient.scopes,
								);
							} catch (error) {
								recordExternalAgentValidation({
									env,
									appId: earlyResolvedApp?.app.id,
									appSlug: earlyResolvedApp?.app.slug,
									organizationId: aihM2mClient.externalAgent.organizationId,
									durationMs: performance.now() - validationStartedAt,
									error,
								});
								return externalAgentValidationFailureResponse(error);
							}
							recordExternalAgentValidation({
								env,
								appId: earlyResolvedApp?.app.id,
								appSlug: earlyResolvedApp?.app.slug,
								organizationId: externalAgent.principal.organizationId,
								durationMs: performance.now() - validationStartedAt,
							});
							headers.delete("x-tedix-auth-user-id");
							headers.delete("x-tedix-auth-tedi-id");
							headers.set("x-tedix-auth-type", "external_agent");
							headers.set(
								"x-tedix-auth-org-id",
								externalAgent.principal.organizationId,
							);
							headers.set(
								"x-tedix-auth-external-principal-id",
								externalAgent.principal.id,
							);
							headers.set(
								"x-tedix-auth-external-session-id",
								externalAgent.session.id,
							);
							headers.set(
								"x-tedix-auth-external-client-record-id",
								aihM2mClient.clientRecordId,
							);
							if (jwtPayload.tedixWorkloadFederation !== true && mcpServerId) {
								headers.set("x-tedix-auth-external-mcp-server-id", mcpServerId);
							}
							headers.set(
								"x-tedix-auth-external-harness",
								externalAgent.session.harness,
							);
							headers.set(
								"x-tedix-auth-external-model",
								`${externalAgent.session.modelProvider}:${externalAgent.session.modelId}:${externalAgent.session.modelVersion}`,
							);
							headers.set(
								"x-tedix-auth-scopes",
								externalAgent.scopes.join(" "),
							);
						} else {
							headers.set("x-tedix-auth-type", "tedi");
							headers.set("x-tedix-auth-user-id", aihM2mClient.clientRecordId);
						}
						const tediTag = aihM2mClient.tags.find((tag) =>
							tag.startsWith("tedi:"),
						);
						const m2mTediId = tediTag ? tediTag.slice(5) : null;
						if (!aihM2mClient.externalAgent && m2mTediId) {
							const liveM2mTediAuth =
								aihM2mTediProfileAuth ??
								(await resolveTediProfileAuth(env, m2mTediId));
							if (liveM2mTediAuth.status !== "active") {
								return tediProfileFailureResponse(liveM2mTediAuth, "aih-m2m");
							}
							const organizationId = resolveAihM2mTediOrganizationId({
								liveOrganizationId: liveM2mTediAuth.orgId,
								servedAppOrganizationId: earlyResolvedApp?.app.organizationId,
							});
							if (organizationId) {
								headers.set("x-tedix-auth-org-id", organizationId);
							} else {
								// Never retain the platform Descope tenant from the M2M JWT as
								// customer data authority when neither trusted source resolved.
								headers.delete("x-tedix-auth-org-id");
							}
							headers.set("x-tedix-auth-tedi-id", m2mTediId);
							if (liveM2mTediAuth.mcpEndpoints !== undefined)
								headers.set(
									"x-tedix-auth-mcp-endpoints",
									JSON.stringify(liveM2mTediAuth.mcpEndpoints),
								);
						}
						// A tedi M2M grant is bound to this exact AIH server. Its effective
						// scopes are the intersection of the registered client's scopes
						// and the current D1 capability profile, resolved during hydration.
						// External agents already carry their live principal ceiling above.
						if (!aihM2mClient.externalAgent)
							headers.set("x-tedix-auth-scopes", aihM2mClient.scopes.join(" "));
					} else if (authResult.scopes) {
						// Human OAuth token — scopes come from AIH policy
						headers.set("x-tedix-auth-scopes", authResult.scopes.join(" "));
						const tediId =
							typeof jwtPayload?.tediId === "string"
								? jwtPayload.tediId
								: undefined;
						if (tediId) {
							headers.set("x-tedix-auth-tedi-id", tediId);
						}
					}
					// Note: human callers (no tediId in token) get resolved later
					// after app resolution provides the organizationId
				}
				reassertTrustedWorkflowTediTaskId(
					headers,
					inboundWorkflowTediTaskId,
					authResult.type,
				);
				request = new Request(request, { headers });
			}
		}

		// Step 3: Hostname-based routing
		if (isDev) {
			console.log(
				`[MCP Router] Hostname: ${hostname}, Type: ${hostnameInfo.type}, AppSlug: ${hostnameInfo.appSlug ?? "none"}`,
			);
		}

		// Both subdomain and custom domain routes share identical auth enforcement:
		// 1. authMode check (~line 411) — requires auth if mcpConfig.authMode === "authenticated"
		// 2. toolScopes / enforcePolicies (~line 442) — per-tool scope checking
		// 3. Rate limiting (~line 507)
		// Custom domains only differ in resolution path (two API calls vs one).
		if (hostnameInfo.type === "subdomain" || hostnameInfo.type === "custom") {
			if (isDev && request.method === "GET" && url.pathname === "/mcp") {
				const accept = request.headers.get("accept") ?? "none";
				console.log(`[MCP Router] GET /mcp headers: accept=${accept}`);
			}
			let resolvedApp: ResolvedApp | null;
			try {
				resolvedApp =
					earlyResolvedApp ?? (await resolveAppFromHostname(hostnameInfo, env));
				earlyResolvedApp = null; // allow GC
			} catch (error) {
				// Transient apps/api unavailability (warming 5xx / dropped service
				// binding) → 503 + Retry-After so clients retry, not a bare 502.
				if (isRetryableUpstreamError(error)) {
					log.warn("App resolution upstream unavailable", {
						event: "resolution.route_upstream_unavailable",
						outcome: "unavailable",
						error: contentFreeMcpException(error),
					});
					return upstreamUnavailableResponse();
				}
				log.error("App resolution failed", {
					event: "resolution.route_lookup_failed",
					outcome: "unavailable",
					error: contentFreeMcpException(error),
				});
				return new Response(
					JSON.stringify({
						error: "Upstream error",
						message: "Failed to resolve app.",
					}),
					{ status: 502, headers: { "Content-Type": "application/json" } },
				);
			}
			if (isDev) {
				console.log(
					`[MCP Router] Subdomain routing - App resolved: ${resolvedApp?.app?.slug ?? "NOT FOUND"}`,
				);
			}

			if (!resolvedApp) {
				return new Response(
					JSON.stringify({
						error: "App not found",
						message:
							hostnameInfo.type === "subdomain"
								? `No app found for subdomain: ${hostnameInfo.appSlug}`
								: `No app found for domain: ${hostnameInfo.customDomain}`,
					}),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			const { app } = resolvedApp;

			if (app.visibility === "disabled") {
				await recordMcpAccessDenial({
					request,
					resolvedApp,
					env,
					ctx,
					reason: "app_disabled",
					httpStatus: 404,
				});
				return new Response(
					JSON.stringify({
						error: "App disabled",
						message: "This MCP app is disabled.",
					}),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
			}

			// Rate limit
			const rateLimit = await checkMcpRequestRateLimit(
				env,
				app.id,
				request.headers,
				clientIp,
			);
			if (!rateLimit.allowed) {
				await recordMcpAccessDenial({
					request,
					resolvedApp,
					env,
					ctx,
					reason: "rate_limited",
					httpStatus: 429,
				});
				return mcpRateLimitResponse(rateLimit);
			}

			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				const accessError = await enforceMcpAccess({
					request,
					hostname,
					resolvedApp,
					env,
					oauthJwtPayload,
					multiOrgSelection,
					isDev,
				});
				if (accessError) {
					await recordMcpAccessDenial({
						request,
						resolvedApp,
						env,
						ctx,
						reason: accessError.reason,
						httpStatus: accessError.response.status,
					});
					return accessError.response;
				}
			}

			// Resolve tediId for human callers (no tediId in JWT, org known from app).
			//
			// By default a human OAuth caller is promoted to their org's primary (or
			// fallback org-scoped) tedi, so they act as that worker (delegationMode
			// "human_to_tedi", demoted to subjectUserId). Set mcpConfig.bindHumanToTedi
			// = false to keep the human as the principal instead: actorType stays
			// "user", scopes come from their own OAuth/FGA grant, and audit attributes
			// to the human — the conventional MCP-OAuth model. This only affects human
			// OAuth callers; autonomous tedi M2M callers already carry
			// x-tedix-auth-tedi-id and never enter this block.
			const appMcpConfig = app.metadata?.mcpConfig as
				| Record<string, unknown>
				| undefined;
			const bindHumanToTedi = shouldBindHumanToTedi(
				appMcpConfig,
				multiOrgSelection,
				{
					// Set only from validateAuth's service-binding result; the
					// inbound x-tedix-auth-* namespace is stripped above.
					kernel:
						request.headers.get("x-tedix-auth-type") === "service" &&
						request.headers.get("x-tedix-auth-kernel") === "true",
				},
			);
			if (
				bindHumanToTedi &&
				!request.headers.get("x-tedix-auth-tedi-id") &&
				request.headers.get("x-tedix-auth-user-id") &&
				app.organizationId &&
				env.API_SERVICE
			) {
				const resolvedTediId = await resolvePrimaryTedi(
					env,
					request.headers.get("x-tedix-auth-user-id")!,
					app.organizationId,
				);
				if (resolvedTediId) {
					const headers = new Headers(request.headers);
					headers.set("x-tedix-auth-tedi-id", resolvedTediId);
					request = new Request(request, { headers });
					console.log(`[MCP Auth] Resolved user→tedi: ${resolvedTediId}`);
				} else {
					console.warn(
						`[MCP Auth] Failed to resolve tediId for user=${request.headers.get("x-tedix-auth-user-id")} org=${app.organizationId}`,
					);
				}
			} else if (
				!bindHumanToTedi &&
				!request.headers.get("x-tedix-auth-tedi-id") &&
				request.headers.get("x-tedix-auth-user-id")
			) {
				console.log(
					`[MCP Auth] Human principal (bindHumanToTedi=false): user=${request.headers.get("x-tedix-auth-user-id")} acts as themselves on ${app.slug}`,
				);
				markAuth("access");
				console.log(
					JSON.stringify({
						_tr: "mcp_auth_timing",
						total_ms: Date.now() - authStarted,
						...authStages,
					}),
				);
			}

			// Headless widget preview (after auth + rate limiting)
			if (url.pathname === "/_preview") {
				return handlePreviewRequest(request, url, app, env);
			}

			// Streamable HTTP security: validate browser Origin on MCP endpoint requests.
			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				const originError = validateMcpOrigin(request, env, resolvedApp);
				if (originError) {
					await recordMcpAccessDenial({
						request,
						resolvedApp,
						env,
						ctx,
						reason: originError.reason,
						httpStatus: originError.response.status,
					});
					return originError.response;
				}
			}

			// Route to MCP
			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				if (isDev) {
					console.log(
						`[MCP Router] >>> Stateless MCP for app: ${app.slug} (${app.id})`,
					);
				}

				const subscriptionResponse = await maybeHandleSubscriptionsListen(
					request,
					resolvedApp,
					env,
				);
				if (subscriptionResponse) return subscriptionResponse;

				try {
					const bootstrapFastResponse = await maybeHandleBootstrapFastMcp(
						request,
						resolvedApp,
					);
					if (bootstrapFastResponse) {
						return recordProtocolDenialIfPresent({
							request,
							response: bootstrapFastResponse,
							resolvedApp,
							env,
							ctx,
						});
					}
					return recordProtocolDenialIfPresent({
						request,
						response: await handleMcpRequest(
							request,
							resolvedApp,
							env,
							ctx,
							multiOrgSelection,
						),
						resolvedApp,
						env,
						ctx,
					});
				} catch (error) {
					// handleMcpRequest → getAppContext / aggregate can throw on a
					// transient apps/api drop; without this guard it escapes as an
					// uncaught Worker 500. Map transient → 503 + Retry-After.
					if (isRetryableUpstreamError(error)) {
						log.warn("MCP request upstream unavailable", {
							event: "router.request_upstream_unavailable",
							outcome: "unavailable",
							error: contentFreeMcpException(error),
						});
						return upstreamUnavailableResponse();
					}
					throw error;
				}
			}

			return honoApp.fetch(request, env, ctx);
		}

		// Step 4: Base domain handling
		if (hostnameInfo.type === "base_domain") {
			const isMcpRoute =
				url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");

			if (!isMcpRoute) {
				return honoApp.fetch(request, env, ctx);
			}

			try {
				const client = getApiClient({
					serviceFetch: env.API_SERVICE,
				});
				const domainResult = await client.apps.getByDomain({
					domain: hostname,
				});

				if (domainResult.app) {
					if (isDev) {
						console.log(
							`[MCP Router] Base domain ${hostname} is registered as customMcpDomain for app: ${domainResult.app.slug}`,
						);
					}

					let fullResult: Awaited<
						ReturnType<typeof client.apps.getBySlugWithTools>
					>;
					try {
						fullResult = await client.apps.getBySlugWithTools({
							slug: domainResult.app.slug,
						});
					} catch (error) {
						log.error("Custom domain app metadata load failed", {
							event: "router.custom_domain_metadata_failed",
							serverHost: hostname,
							appSlug: domainResult.app.slug,
							outcome: "unavailable",
							error,
						});
						if (isRetryableUpstreamError(error)) {
							return upstreamUnavailableResponse();
						}
						return new Response(
							JSON.stringify({
								error: "Upstream error",
								message: "Failed to resolve custom MCP domain app metadata.",
							}),
							{ status: 502, headers: { "Content-Type": "application/json" } },
						);
					}
					const fullApp = fullResult.app;
					if (!fullApp) {
						log.error("Custom domain app metadata missing", {
							event: "router.custom_domain_metadata_missing",
							serverHost: hostname,
							appSlug: domainResult.app.slug,
							outcome: "misconfigured",
						});
						return new Response(
							JSON.stringify({
								error: "Upstream error",
								message: "Failed to resolve custom MCP domain app metadata.",
							}),
							{ status: 502, headers: { "Content-Type": "application/json" } },
						);
					}
					const metadata =
						(fullApp?.metadata as ResolvedApp["metadata"] | null) ?? null;

					const resolvedApp: ResolvedApp = {
						app: {
							id: fullApp.id,
							slug: fullApp.slug,
							name: fullApp.name,
							domain: fullApp.primaryDomain,
							organizationId: fullApp.organizationId,
							description: fullApp.description ?? null,
							logoUrl: fullApp.logoUrl ?? null,
							customMcpDomain: fullApp.customMcpDomain ?? null,
							openaiChallengeToken: fullApp.openaiChallengeToken ?? null,
							openaiAppId: fullApp.openaiAppId ?? null,
							appStoreStatus: fullApp.appStoreStatus ?? null,
							visibility: fullApp.visibility,
							discoveryStatus: fullApp.discoveryStatus ?? null,
							metadata,
						},
						metadata,
						tools: fullResult.tools ?? [],
						catalogMcp: fullResult.catalogMcp ?? null,
						catalogResources: fullResult.catalogResources ?? [],
						catalogResourceTemplates: fullResult.catalogResourceTemplates ?? [],
						catalogPrompts: fullResult.catalogPrompts ?? [],
					};

					const rateLimit = await checkMcpRequestRateLimit(
						env,
						resolvedApp.app.id,
						request.headers,
						clientIp,
					);
					if (!rateLimit.allowed) {
						await recordMcpAccessDenial({
							request,
							resolvedApp,
							env,
							ctx,
							reason: "rate_limited",
							httpStatus: 429,
						});
						return mcpRateLimitResponse(rateLimit);
					}

					const accessError = await enforceMcpAccess({
						request,
						hostname,
						resolvedApp,
						env,
						oauthJwtPayload,
						multiOrgSelection,
						isDev,
					});
					if (accessError) {
						await recordMcpAccessDenial({
							request,
							resolvedApp,
							env,
							ctx,
							reason: accessError.reason,
							httpStatus: accessError.response.status,
						});
						return accessError.response;
					}

					const originError = validateMcpOrigin(request, env, resolvedApp);
					if (originError) {
						await recordMcpAccessDenial({
							request,
							resolvedApp,
							env,
							ctx,
							reason: originError.reason,
							httpStatus: originError.response.status,
						});
						return originError.response;
					}
					return recordProtocolDenialIfPresent({
						request,
						response: await handleMcpRequest(
							request,
							resolvedApp,
							env,
							ctx,
							multiOrgSelection,
						),
						resolvedApp,
						env,
						ctx,
					});
				}
			} catch (error) {
				log.error("Custom domain lookup failed", {
					event: "router.custom_domain_lookup_failed",
					serverHost: hostname,
					outcome: "unavailable",
					error,
				});
				// A transient apps/api drop here would otherwise silently fall through
				// to the dev fallback; surface it honestly as 503 + Retry-After.
				if (isRetryableUpstreamError(error)) {
					return upstreamUnavailableResponse();
				}
			}

			// Local dev fallback
			const defaultAppSlug = env.DEFAULT_APP_SLUG;

			if (defaultAppSlug) {
				if (isDev) {
					console.log(
						`[MCP Router] Base domain with DEFAULT_APP_SLUG fallback: ${defaultAppSlug}`,
					);
				}

				try {
					const client = getApiClient({
						serviceFetch: env.API_SERVICE,
					});
					const result = await client.apps.getBySlugWithTools({
						slug: defaultAppSlug,
					});

					if (result.app) {
						if (isDev) {
							console.log(
								`[MCP Router] >>> Stateless MCP for default app: ${result.app.slug} (${result.app.id})`,
							);
						}

						const resolvedApp: ResolvedApp = {
							app: {
								id: result.app.id,
								slug: result.app.slug,
								name: result.app.name,
								domain: result.app.primaryDomain,
								organizationId: result.app.organizationId,
								visibility: result.app.visibility,
							},
							metadata: (result.app.metadata as any) ?? null,
							tools: result.tools ?? [],
						};

						const rateLimit = await checkMcpRequestRateLimit(
							env,
							result.app.id,
							request.headers,
							clientIp,
						);
						if (!rateLimit.allowed) {
							await recordMcpAccessDenial({
								request,
								resolvedApp,
								env,
								ctx,
								reason: "rate_limited",
								httpStatus: 429,
							});
							return mcpRateLimitResponse(rateLimit);
						}

						const accessError = await enforceMcpAccess({
							request,
							hostname,
							resolvedApp,
							env,
							oauthJwtPayload,
							multiOrgSelection,
							isDev,
						});
						if (accessError) {
							await recordMcpAccessDenial({
								request,
								resolvedApp,
								env,
								ctx,
								reason: accessError.reason,
								httpStatus: accessError.response.status,
							});
							return accessError.response;
						}

						const originError = validateMcpOrigin(request, env, resolvedApp);
						if (originError) {
							await recordMcpAccessDenial({
								request,
								resolvedApp,
								env,
								ctx,
								reason: originError.reason,
								httpStatus: originError.response.status,
							});
							return originError.response;
						}
						return recordProtocolDenialIfPresent({
							request,
							response: await handleMcpRequest(
								request,
								resolvedApp,
								env,
								ctx,
								multiOrgSelection,
							),
							resolvedApp,
							env,
							ctx,
						});
					}
				} catch (error) {
					log.error("Default app lookup failed", {
						event: "router.default_app_lookup_failed",
						appSlug: defaultAppSlug,
						outcome: "unavailable",
						error,
					});
					if (isRetryableUpstreamError(error)) {
						return upstreamUnavailableResponse();
					}
				}
				if (isDev) {
					console.log(
						`[MCP Router] DEFAULT_APP_SLUG '${defaultAppSlug}' not found in database`,
					);
				}
			}

			if (isDev) {
				console.log(
					`[MCP Router] Base domain access rejected - subdomain required`,
				);
			}

			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				return new Response(
					JSON.stringify({
						error: "App subdomain required",
						message:
							"All MCP access requires an app subdomain. Use {app}.mcp.tedix.dev format.",
						example: "tedix.mcp.tedix.dev/mcp",
						hint: "For local development, set DEFAULT_APP_SLUG=tedix in wrangler.jsonc vars or use X-Tedix-Host header",
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Step 5: All other requests
		return honoApp.fetch(request, env, ctx);
	},
};

/**
 * Service-binding ingress. Internal callers bind with
 * `"entrypoint": "InternalEntrypoint"`; the internet reaches only the default
 * export, which strips the `X-Service-Binding` marker, so binding trust is
 * unreachable from a public request.
 */
export class InternalEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
	override async fetch(request: Request): Promise<Response> {
		return fetchWithCorrelation(request, this.env, this.ctx);
	}
}

async function fetchWithCorrelation(
	request: Request,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const traceId = requestTraceId(request.headers);
	// The MCP handler owns SEP-414 body metadata; don't override it with a generated header.
	const response = await correlatedErrorResponse(
		await worker.fetch(request, env, ctx),
		traceId,
		false,
	);
	if (response.status >= 400)
		console.warn("[MCP] request failed", {
			event: "tedix.mcp.error",
			traceId: response.headers.get("X-Tedix-Trace-Id"),
			httpStatus: response.status,
		});
	return response;
}

export default {
	fetch(
		request: Request,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return fetchWithCorrelation(stripServiceBindingMarker(request), env, ctx);
	},
};
