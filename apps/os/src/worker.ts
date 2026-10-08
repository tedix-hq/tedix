/**
 * Tedix OS origin router.
 *
 * The Worker runs before assets on every route so the origin can refuse an
 * unprovisioned tenant before any shell HTML is served, and so response
 * headers are set by code rather than by a static `_headers` file that only
 * applies to asset hits: `apps/os` owns its origin.
 *
 * The router deliberately holds no authority. It resolves the tenant from the
 * host for ROUTING only; every authorization decision is re-derived by
 * `apps/api` from the caller's identity. It executes no user code, holds no
 * tenant secrets, and owns no canonical state.
 *
 * Because the `*.os.tedix.dev` wildcard DNS record exists, every
 * slug resolves at the edge, so the fail-closed property moved here: a slug is
 * served the shell only when `apps/api` confirms its organization carries the
 * explicit `features.os` provisioning flag. Resolution goes over the
 * API_SERVICE binding and is Cache API cached; a resolver outage without a
 * cached answer refuses 503 rather than serving unknown tenants.
 *
 * Typed against the standard fetch interfaces rather than Cloudflare's worker
 * types so this module stays testable in the app's DOM-lib test environment
 * and carries no runtime dependency on a Workers-only global.
 */
import {
	callRpc,
	type FetcherLike,
	serviceBindingFetch,
} from "@tedix/api-client/internal";
import { validateToken } from "@tedix/auth/jwt";
import {
	decodeUnverifiedJwtClaims,
	DESCOPE_SESSION_COOKIE,
} from "@tedix/auth/web";
import {
	isLocalDemoProject,
	isLoopbackUrl,
	LOCAL_DEMO_TOKEN,
} from "@tedix/auth/local-demo";
import {
	canonicalizeProductSessionCookieHeader,
	resolveProductSession,
} from "@tedix/auth/product-session-broker";
import { resolveOsTenant } from "@/shared/os-tenant";
import { applyInboundTrustHeaderHygiene } from "@tedix/worker-kit/request-auth";
import { handleCliOAuthRelay } from "./auth/cli-oauth-relay";
import {
	CLI_BROKER_SESSION_COOKIE,
	handleOsSessionBroker,
	OS_BROKER_SESSION_COOKIE,
	type OsSessionBrokerEnv,
} from "./auth/session-broker";
import { CAPN_ROUTE_PATH } from "./capnweb/contract";
import { COLLAB_PRESENCE_HEADER } from "./collab/presence";
import {
	authenticateCollabPresence,
	localCollabPresence,
} from "./collab/worker-presence";
import { createOsClientErrorIngest } from "./lib/error-reporting/ingest";
import { OS_CLIENT_ERROR_PATH } from "./lib/error-reporting/report";
import { WEBMCP_TELEMETRY_PATH } from "./lib/webmcp/telemetry";
import { createWebMcpTelemetryIngest } from "./lib/webmcp/telemetry-ingest";
import { handleTedixCliClientMetadata } from "./oauth-client-metadata";
import {
	injectWebMcpBridge,
	servesWebMcpBridge,
	WEBMCP_BRIDGE_PATH,
	webMcpBridgeResponse,
} from "./webmcp/bridge-injection";
import {
	handleProviderCohortHost,
	PROVIDER_COHORT_PATH,
	PROVIDER_COHORT_SESSION_PATH,
} from "./webmcp/provider-cohort-host";
import {
	handleWidgetMcp,
	handleWidgetResource,
	type WidgetServiceIdentity,
} from "./widgets/proxy";
import { base64UrlEncode } from "@tedix/auth/utils";

/**
 * Kept only on the Worker-side request between product-session normalization
 * and the collaboration presence projection. It must never leave for the DO.
 */
const COLLAB_VERIFIED_SESSION_HEADER = "X-Tedix-Collab-Verified-Session";

/** Structural slice of a Durable Object namespace so tests stay DOM-lib clean. */
export interface CollabRoomNamespace {
	idFromName(name: string): unknown;
	get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface OsRouterEnv extends OsSessionBrokerEnv {
	readonly ASSETS: { fetch(request: Request): Promise<Response> };
	/**
	 * Service binding to apps/api. Present in every deployed environment;
	 * absent only in the zero-account local lane, where every slug is a local
	 * fake tenant and provisioning is not enforced.
	 */
	readonly API_SERVICE?: FetcherLike;
	/** Collaborative-editing rooms; absent in the zero-account local lane. */
	readonly COLLAB_ROOM?: CollabRoomNamespace;
	/**
	 * Service binding to the MCP edge worker. Required for the widget bridge
	 * in deployed environments: a public fetch to *.mcp.tedix.dev from this
	 * worker would route to the zone's dummy DNS origin (same-zone
	 * subrequest), not the MCP worker.
	 */
	readonly MCP_SERVICE?: FetcherLike;
	readonly TEDIX_LOCAL_DEMO_ENABLED?: string;
	/** Secret: exact embedded:session provider key; never sent to a browser. */
	readonly TEDIX_PROVIDER_COHORT_API_KEY?: string;
	/** Fixed, nonsecret identity and organization target for this bounded cohort. */
	readonly PROVIDER_COHORT_OS_TENANT_ID?: string;
	readonly PROVIDER_COHORT_EXTERNAL_TENANT_ID?: string;
	/** Release sha stamped by deploy:production; "unknown" outside a deploy. */
	readonly GIT_SHA?: string;
}

const DESCOPE_OUTBOUND_BRIDGE_PATH = "/auth/descope/v1/outbound/oauth/connect";
const OUTBOUND_APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/**
 * An outbound-connect intent never exchanges a product session code, but the
 * broker contract still requires an unpredictable correlation digest. Keep the
 * raw random value out of the request, URL, and durable intent state.
 */
async function randomOutboundStateHash(): Promise<string> {
	const state = new Uint8Array(32);
	crypto.getRandomValues(state);
	const digest = await crypto.subtle.digest("SHA-256", state);
	return `sha256-${base64UrlEncode(new Uint8Array(digest))}`;
}

type OutboundConnectBody = {
	appId: string;
	connectionInstanceId?: string;
	tenantId?: string;
	tenantLevel?: boolean;
	options?: { redirectUrl?: string; scopes?: string[] };
};

async function handleDescopeOutboundConnect(
	request: Request,
	env: OsRouterEnv,
	hostTenantId: string | null,
): Promise<Response> {
	if (request.method !== "POST" || !hostTenantId) {
		return refuse(
			404,
			"Outbound connections are available on tenant workspaces only.",
		);
	}
	if (!env.DESCOPE_PROJECT_ID) {
		return refuse(503, "Outbound connection identity is unavailable.");
	}
	const session = resolveProductSession(
		request.headers.get("Cookie"),
		OS_BROKER_SESSION_COOKIE,
	);
	if (!session || !productSessionMatchesTenant(session, hostTenantId)) {
		return refuse(401, "Authentication required.");
	}
	let body: OutboundConnectBody;
	try {
		body = (await request.json()) as OutboundConnectBody;
	} catch {
		return refuse(400, "Malformed outbound connection request.");
	}
	if (!OUTBOUND_APP_ID_PATTERN.test(body.appId)) {
		return refuse(400, "Invalid outbound application id.");
	}
	const tenantLevel = body.tenantLevel === true;
	if (tenantLevel && body.tenantId !== hostTenantId) {
		return refuse(
			403,
			"Tenant connection target does not match this workspace.",
		);
	}
	if (tenantLevel) {
		if (!env.API_SERVICE) {
			return refuse(503, "Connection authorization is unavailable.");
		}
		const cookie = canonicalizeProductSessionCookieHeader(
			request.headers.get("Cookie"),
			OS_BROKER_SESSION_COOKIE,
		);
		try {
			const context = await callRpc<{
				authority: { permissions: string[] };
			}>(
				"userSettings/getContext",
				{},
				{
					apiUrl: "https://api",
					fetch: serviceBindingFetch(env.API_SERVICE),
					headers: {
						Cookie: cookie ?? "",
						"X-Tedix-Tenant-Id": hostTenantId,
					},
					timeoutMs: 5_000,
				},
			);
			if (!context.authority.permissions.includes("integrations:manage")) {
				return refuse(
					403,
					"Managing organization connections requires permission.",
				);
			}
		} catch {
			return refuse(
				403,
				"Managing organization connections requires permission.",
			);
		}
	}
	const redirectUrl = body.options?.redirectUrl;
	try {
		if (
			!redirectUrl ||
			new URL(redirectUrl).origin !== new URL(request.url).origin
		) {
			return refuse(400, "Invalid outbound connection callback.");
		}
	} catch {
		return refuse(400, "Invalid outbound connection callback.");
	}
	if (!env.OS_SESSION_BROKER) {
		return refuse(503, "Outbound connection broker is unavailable.");
	}
	// Descope's REST connect endpoint requires a refresh JWT. Product hosts
	// deliberately receive only a scoped session JWT, so the browser makes a
	// top-level handoff to auth.tedix.dev; that host alone holds the refresh
	// cookie and starts the external provider flow.
	let externalIdentifier: string | undefined;
	let outboundUserId: string | undefined;
	let scopes = body.options?.scopes;
	if (
		scopes !== undefined &&
		(!Array.isArray(scopes) ||
			scopes.length > 100 ||
			!scopes.every(
				(scope) =>
					typeof scope === "string" && scope.length > 0 && scope.length <= 2048,
			))
	)
		return refuse(400, "Invalid consent scopes.");
	if (body.connectionInstanceId !== undefined) {
		if (!env.API_SERVICE)
			return refuse(503, "Account verification is unavailable.");
		try {
			const prepared = await callRpc<{
				externalIdentifier: string;
				userId: string;
				scopes: string[];
			}>(
				"connections/preparePersonalConnection",
				{
					appId: body.appId,
					connectionInstanceId: body.connectionInstanceId,
					scope: tenantLevel ? "tenant" : "user",
					scopes,
				},
				{
					apiUrl: "https://api",
					fetch: serviceBindingFetch(env.API_SERVICE),
					headers: {
						Cookie:
							canonicalizeProductSessionCookieHeader(
								request.headers.get("Cookie"),
								OS_BROKER_SESSION_COOKIE,
							) ?? "",
						"X-Tedix-Tenant-Id": hostTenantId,
					},
					timeoutMs: 5000,
				},
			);
			externalIdentifier = prepared.externalIdentifier;
			outboundUserId = prepared.userId;
			scopes = prepared.scopes;
		} catch {
			return refuse(
				403,
				"This account is not available to you in this workspace.",
			);
		}
	}
	const handoff = await env.OS_SESSION_BROKER.createIntent({
		operation: "outbound_connect",
		outboundAppId: body.appId,
		...(scopes?.length ? { outboundScopes: scopes } : {}),
		...(externalIdentifier
			? { outboundExternalIdentifier: externalIdentifier }
			: {}),
		...(outboundUserId ? { outboundUserId } : {}),
		redirectPath: "/oauth/callback",
		stateHash: await randomOutboundStateHash(),
		targetOrigin: new URL(request.url).origin,
		tenantId: tenantLevel ? hostTenantId : null,
	});
	return Response.json(
		{ url: handoff.authorizeUrl },
		{ headers: { "Cache-Control": "no-store" } },
	);
}

export interface TenantResolution {
	provisioned: boolean;
	/**
	 * The host org's Descope tenant id. The proxy asserts it as
	 * `X-Tedix-Tenant-Id` on every forwarded request so the HOSTNAME decides
	 * the organization context — never whichever tenant the caller's session
	 * happens to have selected. apps/api independently proves the caller's
	 * membership in the asserted tenant and fails closed on a mismatch.
	 */
	descopeTenantId?: string | null;
}

export type TenantResolver = (
	env: OsRouterEnv,
	slug: string,
) => Promise<TenantResolution>;

type CollabGadgetDetail = { gadget: { workspaceId: string } };

type CollabOutputDetail = { output: { workspaceId: string | null } };

/** Provisioned answers are stable; unprovisioned slugs re-check sooner so a fresh activation propagates fast. */
const PROVISIONED_TTL_SECONDS = 300;
const UNPROVISIONED_TTL_SECONDS = 60;

export const resolveTenantViaApi: TenantResolver = async (env, slug) => {
	if (!env.API_SERVICE) {
		throw new Error("API_SERVICE binding is absent");
	}
	const result = await callRpc<TenantResolution>(
		"osTenant/resolve",
		{ slug },
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: { "X-Service-Binding": "true" },
			timeoutMs: 5_000,
			// Read-only resolution; one retry covers a transient binding hiccup.
			retry: 1,
		},
	);
	return {
		provisioned: result.provisioned === true,
		descopeTenantId: result.descopeTenantId ?? null,
	};
};

function resolutionCache(): Cache | undefined {
	return (globalThis as { caches?: { default?: Cache } }).caches?.default;
}

function resolutionCacheKey(slug: string): Request {
	return new Request(`https://tenant-resolve.tedix-os.internal/${slug}`);
}

async function resolveWithCache(
	env: OsRouterEnv,
	slug: string,
	resolver: TenantResolver,
): Promise<TenantResolution | "unavailable"> {
	const cache = resolutionCache();
	const key = resolutionCacheKey(slug);
	if (cache) {
		const hit = await cache.match(key);
		if (hit) return (await hit.json()) as TenantResolution;
	}
	try {
		const resolution = await resolver(env, slug);
		if (cache) {
			const ttl = resolution.provisioned
				? PROVISIONED_TTL_SECONDS
				: UNPROVISIONED_TTL_SECONDS;
			await cache.put(
				key,
				new Response(JSON.stringify(resolution), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": `max-age=${ttl}`,
					},
				}),
			);
		}
		return resolution;
	} catch (error) {
		console.error(
			`OS tenant resolution failed for slug "${slug}": ${(error as Error).message}`,
		);
		return "unavailable";
	}
}

/**
 * Applied to every response, including asset hits. `public/_headers` covers
 * only assets served directly, which is no longer the path requests take.
 */
const SECURITY_HEADERS: readonly (readonly [string, string])[] = [
	["X-Content-Type-Options", "nosniff"],
	["X-Frame-Options", "DENY"],
	["Referrer-Policy", "strict-origin-when-cross-origin"],
	["X-Robots-Tag", "noindex, nofollow, noarchive"],
	["Cache-Control", "private, no-store"],
];

function withSecurityHeaders(
	response: Response,
	framePolicy: "DENY" | "SAMEORIGIN" = "DENY",
): Response {
	// Worker-owned responses have mutable headers. Keep them intact so the
	// runtime's distinct Set-Cookie fields survive; reconstructing a Headers
	// object can coalesce those fields at the edge and silently discard all but
	// one browser cookie. Asset/fetch responses may be immutable, so clone only
	// on that path.
	try {
		for (const [name, value] of SECURITY_HEADERS) {
			response.headers.set(
				name,
				name === "X-Frame-Options" ? framePolicy : value,
			);
		}
		if (framePolicy === "SAMEORIGIN") {
			response.headers.set("Content-Security-Policy", "frame-ancestors 'self'");
		}
		return response;
	} catch {
		const headers = new Headers(response.headers);
		for (const [name, value] of SECURITY_HEADERS) {
			headers.set(name, name === "X-Frame-Options" ? framePolicy : value);
		}
		if (framePolicy === "SAMEORIGIN") {
			headers.set("Content-Security-Policy", "frame-ancestors 'self'");
		}
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}

function isDocumentNavigation(request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	return (
		request.headers.get("Sec-Fetch-Dest") === "document" ||
		(request.headers.get("Accept") ?? "").includes("text/html")
	);
}

function refuse(status: number, reason: string): Response {
	return withSecurityHeaders(
		new Response(`${reason}\n`, {
			status,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		}),
	);
}

/** The oRPC transport paths this Worker proxies. */
function isOrpcTransportPath(pathname: string): boolean {
	return (
		pathname.startsWith("/api/rpc/") || pathname.startsWith("/cli/api/rpc/")
	);
}

function isKernelVoiceTranscriptionPath(pathname: string): boolean {
	return pathname === "/api/kernel/voice/transcribe";
}

/**
 * Refuse an API request in the shape its CLIENT can actually parse.
 *
 * `/api/rpc/*` is an oRPC transport: the client parses the body as an oRPC
 * error envelope. A `text/plain` refusal therefore never reaches the caller as
 * its reason — it surfaces as "Malformed Orpc Error Response", so a 401, a 404
 * and a 503 all look identical and unactionable.
 *
 * That masking has real cost. A broken cookie handoff on the first-organization
 * bootstrap presented to the user only as a generic `session_unavailable`
 * redirect, because the 401 this Worker returned could not be read by the
 * caller that had to report it.
 *
 * The envelope mirrors what `apps/api` itself returns for the same condition —
 * verified against a live 401 from `api.tedix.dev`, which is
 * `{"json":{"defined":true,"inferable":true,"code":"UNAUTHORIZED","message":…}}` —
 * so the client parses a proxy refusal exactly as it parses an origin one.
 */
function refuseApi(
	url: URL,
	status: number,
	code: string,
	reason: string,
): Response {
	if (!isOrpcTransportPath(url.pathname)) return refuse(status, reason);
	return withSecurityHeaders(
		new Response(
			JSON.stringify({
				json: { defined: true, inferable: true, code, message: reason },
			}),
			{
				status,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			},
		),
	);
}

function withBrokerApiSession(
	request: Request,
	productCookie: string,
	allowInitialDescopeSession = false,
	requiredTenantId: string | null = null,
): Request | null {
	const productSession = resolveProductSession(
		request.headers.get("Cookie"),
		productCookie,
	);
	if (
		requiredTenantId !== null &&
		!productSessionMatchesTenant(productSession, requiredTenantId)
	) {
		return null;
	}
	const cookie = canonicalizeProductSessionCookieHeader(
		request.headers.get("Cookie"),
		productCookie,
	);
	if (!cookie) {
		const authorization = request.headers.get("Authorization");
		if (
			!allowInitialDescopeSession ||
			!authorization?.startsWith("Bearer ") ||
			authorization.length <= "Bearer ".length
		) {
			return null;
		}
		// The canonical API validates the signed Descope JWT and binds every
		// bootstrap mutation to its subject. This bearer fallback exists only
		// while the just-completed flow has the token in memory but has not yet
		// materialized the host-only DS cookie.
		const headers = new Headers(request.headers);
		headers.delete("Cookie");
		return new Request(request, { headers });
	}
	const headers = new Headers(request.headers);
	headers.delete("Authorization");
	headers.set("Cookie", cookie);
	return new Request(request, { headers });
}

/** Routing hint only; apps/api still verifies the signature and membership. */
function productSessionMatchesTenant(
	session: string | null,
	tenantId: string,
): boolean {
	return decodeUnverifiedJwtClaims(session)?.dct === tenantId;
}

/**
 * The signed-in subject to attach to a client error report, decoded from the
 * host-only product session WITHOUT verification.
 *
 * This is a triage label and never authority: the report it rides on grants
 * nothing, and every real decision in this Worker is made elsewhere from a
 * verified session. Deriving it here rather than accepting it in the body is
 * what keeps the endpoint from being an identity-spoofing surface.
 */
function reportedUserIdFromSession(request: Request): string | undefined {
	const session = resolveProductSession(
		request.headers.get("Cookie"),
		OS_BROKER_SESSION_COOKIE,
	);
	if (!session) return undefined;
	const subject = decodeUnverifiedJwtClaims(session)?.sub;
	return typeof subject === "string" && subject.length > 0
		? subject
		: undefined;
}

/**
 * One ingest per isolate: it owns the log-shed window, so it must outlive a
 * single request without being rebuilt per call.
 */
const clientErrorIngest = createOsClientErrorIngest();

/** Same per-isolate lifetime as the error sink: it owns its own log-shed window. */
const webMcpTelemetryIngest = createWebMcpTelemetryIngest();

function withCollabSession(
	request: Request,
	env: OsRouterEnv,
	hostTenantId: string | null,
): Request | null {
	const broker = withBrokerApiSession(
		request,
		OS_BROKER_SESSION_COOKIE,
		false,
		hostTenantId,
	);
	if (broker) {
		const session = resolveProductSession(
			request.headers.get("Cookie"),
			OS_BROKER_SESSION_COOKIE,
		);
		if (!session) return null;
		const headers = new Headers(broker.headers);
		headers.set(COLLAB_VERIFIED_SESSION_HEADER, session);
		return new Request(broker, { headers });
	}
	// Direct agent clients cannot attach cookies to a WebSocket handshake, but
	// can present a signed Descope bearer. It receives the same API authorization
	// and tenant-bound presence verification as the browser lane.
	if (request.headers.get("Authorization")?.startsWith("Bearer "))
		return request;
	if (request.headers.get("X-API-Key")?.startsWith("sk_")) return request;
	// Zero-account local development has no identity provider by design.
	return env.DESCOPE_PROJECT_ID ? null : request;
}

function isLocalDemoOrigin(request: Request, env: OsRouterEnv): boolean {
	return (
		env.TEDIX_LOCAL_DEMO_ENABLED === "true" &&
		isLocalDemoProject(env.DESCOPE_PROJECT_ID) &&
		isLoopbackUrl(request.url)
	);
}

function withLocalDemoAuthorization(
	request: Request,
	env: OsRouterEnv,
): Request | null {
	if (!isLocalDemoOrigin(request, env)) return null;
	const headers = new Headers(request.headers);
	headers.set("Authorization", `Bearer ${LOCAL_DEMO_TOKEN}`);
	return new Request(request, { headers });
}

type WidgetSessionVerifier = typeof validateToken;

/**
 * Verify the host-only browser session before projecting it across the
 * in-process MCP service binding. The exact signed session crosses only that
 * private boundary; the MCP edge revalidates it as OAuth user authority and
 * independently applies app/tool authorization. A tenant mismatch fails closed
 * before any MCP request.
 */
export async function authenticateWidgetBridge(
	request: Request,
	env: OsRouterEnv,
	hostTenantId: string,
	verify: WidgetSessionVerifier = validateToken,
): Promise<{
	request: Request;
	serviceIdentity: WidgetServiceIdentity;
} | null> {
	const authenticated = withBrokerApiSession(request, OS_BROKER_SESSION_COOKIE);
	if (!authenticated || !env.DESCOPE_PROJECT_ID) return null;
	const session = resolveProductSession(
		request.headers.get("Cookie"),
		OS_BROKER_SESSION_COOKIE,
	);
	if (!session) return null;
	try {
		const payload = await verify(session, {
			projectId: env.DESCOPE_PROJECT_ID,
		});
		const subject = typeof payload.sub === "string" ? payload.sub : null;
		const tenantId = typeof payload.dct === "string" ? payload.dct : null;
		if (!subject || tenantId !== hostTenantId) return null;
		return {
			request: authenticated,
			serviceIdentity: { sessionToken: session, tenantId: hostTenantId },
		};
	} catch {
		return null;
	}
}

type BrowserMcpAuthorizationResolver = (input: {
	request: Request;
	env: OsRouterEnv;
	hostTenantId: string;
}) => Promise<readonly string[]>;

async function resolveBrowserMcpAuthorization(input: {
	request: Request;
	env: OsRouterEnv;
	hostTenantId: string;
}): Promise<readonly string[]> {
	if (!input.env.API_SERVICE) throw new Error("API service unavailable");
	const authorization = await callRpc<{
		policyVersion: 1;
		scopes: string[];
	}>(
		"userSettings/getBrowserMcpAuthorization",
		{},
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(input.env.API_SERVICE),
			headers: {
				Cookie:
					canonicalizeProductSessionCookieHeader(
						input.request.headers.get("Cookie"),
						OS_BROKER_SESSION_COOKIE,
					) ?? "",
				"X-Tedix-Tenant-Id": input.hostTenantId,
			},
			timeoutMs: 5_000,
		},
	);
	return authorization.scopes;
}

/** Re-resolve the signed user's tenant capabilities for one WebMCP request. */
export async function authorizeBrowserMcpBridge(
	request: Request,
	env: OsRouterEnv,
	hostTenantId: string,
	serviceIdentity: WidgetServiceIdentity,
	resolve: BrowserMcpAuthorizationResolver = resolveBrowserMcpAuthorization,
): Promise<WidgetServiceIdentity | null> {
	try {
		const scopes = await resolve({ request, env, hostTenantId });
		return { ...serviceIdentity, browserMcpScopes: [...scopes] };
	} catch {
		return null;
	}
}

/**
 * Same-origin API proxy: `/api/*` on a tenant host forwards to `apps/api`
 * over the service binding, so the browser talks one origin (cookies flow,
 * no CORS, EventSource works) while `apps/api` remains the sole authority —
 * the proxy forwards the caller's own credentials (Authorization, Cookie,
 * Last-Event-ID) untouched and apps/api re-derives the organization from
 * them. The hostname selects the requested organization context but grants no
 * authority; apps/api independently verifies membership and permissions.
 *
 * Two deliberate subtractions:
 * - a client-supplied `X-Tedix-Tenant-Id` is stripped, then replaced with the
 *   provisioned hostname's resolved tenant id.
 * - Responses pass through as-is (status, headers, streaming body) so SSE
 *   frames flow unbuffered; the document security headers are for the shell,
 *   not API payloads.
 */
async function proxyApiRequest(
	request: Request,
	env: OsRouterEnv,
	url: URL,
	hostTenantId: string | null = null,
): Promise<Response> {
	if (!env.API_SERVICE) {
		return refuse(503, "The local lane has no API binding.");
	}
	const upstream = new URL(
		url.pathname.replace(/^\/(?:cli\/)?api/, "") || "/",
		"https://api",
	);
	upstream.search = url.search;
	// Dictation submits the short-lived, API-validated kernel token minted by
	// `/kernel/ws-token`. Preserve it across the public-ingress header scrub for
	// this one route; all other browser API traffic continues to use the
	// httpOnly session translation below.
	const voiceTranscriptionAuthorization = isKernelVoiceTranscriptionPath(
		url.pathname,
	)
		? request.headers.get("Authorization")
		: null;
	const headers = new Headers(request.headers);
	// Every request reaching this proxy is public browser ingress: strip EVERY
	// client-suppliable internal-trust marker (service-binding flag, caller
	// identity/authority, tenancy, external-agent identity, operator consent…)
	// before forwarding to the trusted apps/api binding. A browser never
	// legitimately supplies one, and leaving them verbatim is one Host/IP
	// refactor away from a cross-tenant authority grant. `false` = always
	// external here; this origin never receives an internally-stamped request.
	applyInboundTrustHeaderHygiene(headers, false);
	if (voiceTranscriptionAuthorization)
		headers.set("Authorization", voiceTranscriptionAuthorization);
	// The scoped WebSocket-token mint deliberately accepts a Descope bearer,
	// not cookies. The OS session is httpOnly, so translate it only inside this
	// trusted same-origin proxy for this exact endpoint; the browser never sees
	// the long-lived session JWT and receives only the 10-minute kernel token.
	// authz: public — same-origin proxy ingress; apps/api validates the translated bearer and tenant membership.
	if (url.pathname === "/api/kernel/ws-token") {
		const session = resolveProductSession(
			headers.get("Cookie"),
			DESCOPE_SESSION_COOKIE,
		);
		if (!session)
			return refuseApi(url, 401, "UNAUTHORIZED", "Authentication required.");
		headers.set("Authorization", `Bearer ${session}`);
		headers.delete("Cookie");
	}
	// The hostname decides the organization context: the client override was
	// stripped above, and the WORKER asserts the host org's tenant id. apps/api
	// independently proves the caller's membership in the asserted tenant
	// (resolveTenantOverride) and fails closed on a mismatch, so a session whose
	// selected Descope tenant differs from the host can never read or write
	// another org through this origin.
	if (hostTenantId) headers.set("X-Tedix-Tenant-Id", hostTenantId);
	const hasBody = request.method !== "GET" && request.method !== "HEAD";
	// A service binding may consume a forwarded ReadableStream after this
	// proxy handler has returned. Workerd then rejects multipart dictation with
	// "Can't read from request stream after response has been sent." Buffer only
	// the explicitly size-bounded voice upload; keep all other API bodies and
	// SSE responses streaming.
	const body = hasBody
		? isKernelVoiceTranscriptionPath(url.pathname)
			? await request.arrayBuffer()
			: request.body
		: null;
	return env.API_SERVICE.fetch(
		new Request(upstream.toString(), {
			method: request.method,
			headers,
			body,
			redirect: "manual",
			// Required by Node's fetch for streamed bodies; accepted by workerd.
			duplex: "half",
		} as RequestInit),
	);
}

/**
 * An unprovisioned slug must not resolve — `docs/engineering/product/tedix-os.md` makes
 * that a product rule, and serving the shell to one would leak the existence
 * and shape of the surface. `os.tedix.dev` is the central launcher: it serves
 * the SPA (the CLI-login org picker and workspace launcher) and resolves no
 * tenant, so it skips tenant provisioning and falls through to asset serving.
 */
export async function handleOsRequest(
	request: Request,
	env: OsRouterEnv,
	resolver: TenantResolver = resolveTenantViaApi,
): Promise<Response> {
	const url = new URL(request.url);
	const tenant = resolveOsTenant(url.hostname, env.OS_URL);
	if (tenant.kind === "invalid") {
		return refuse(404, "No Tedix OS workspace at this hostname.");
	}
	// authz: public — OAuth Client ID Metadata Document (CIMD, currently an
	// IETF Internet-Draft), distinct from RFC 9728 protected-resource metadata.
	// This exact,
	// immutable HTTPS identity lets every tenant resource recognize one branded
	// PKCE-only CLI client instead of accumulating unverified DCR registrations.
	const clientMetadata = handleTedixCliClientMetadata(request);
	if (clientMetadata) return clientMetadata;
	// authz: public — exact CIMD callback broker. The state carries only a
	// validated localhost port and opaque CSRF nonce; the destination host and
	// callback path are hardcoded by handleCliOAuthRelay.
	const cliOAuthRelay = handleCliOAuthRelay(request);
	if (cliOAuthRelay) return withSecurityHeaders(cliOAuthRelay);
	// authz: public — deploy provenance only. GIT_SHA is stamped at deploy
	// (--var GIT_SHA:<sha>) and release tooling reads it to tell which commit
	// is live. Answered
	// on every host role before tenant resolution so an unprovisioned or
	// unresolvable tenant still reports what code it runs.
	if (url.pathname === "/health") {
		return withSecurityHeaders(
			Response.json({
				status: "ok",
				deployedSha: String(env.GIT_SHA || "unknown"),
			}),
		);
	}
	// authz: public — bare 307 redirect to the central launcher login; carries no session or tenant data.
	if (tenant.kind === "tenant" && url.pathname === "/cli/login") {
		const launcher = new URL(
			"/cli/login",
			env.OS_URL ?? "https://os.tedix.dev",
		);
		launcher.search = url.search;
		return withSecurityHeaders(Response.redirect(launcher, 307));
	}
	// tenant.kind === "launcher" (os.tedix.dev) resolves no tenant and falls
	// through to asset serving below — it is the central login/launcher surface.
	let hostTenantId: string | null = null;
	if (tenant.kind === "tenant" && env.API_SERVICE) {
		const resolution = await resolveWithCache(env, tenant.slug, resolver);
		if (resolution === "unavailable") {
			return refuse(503, "Tenant resolution is temporarily unavailable.");
		}
		if (!resolution.provisioned) {
			return refuse(404, "No Tedix OS workspace at this hostname.");
		}
		hostTenantId = resolution.descopeTenantId ?? null;
		if (!hostTenantId) {
			return refuse(
				503,
				"This Tedix OS workspace has no authentication tenant.",
			);
		}
	}

	// authz: public — the shared WebMCP bridge script. The
	// zone-level toggle is off, so this Worker serves the @tedix/webmcp-core
	// bridge itself; the script is static, identical for every caller, and
	// holds no authority — the /mcp relay it talks to authenticates per call.
	// Served after the provisioning gate so an unprovisioned slug still 404s.
	if (url.pathname === WEBMCP_BRIDGE_PATH && servesWebMcpBridge(tenant.kind)) {
		return webMcpBridgeResponse(request, withSecurityHeaders);
	}

	// The frontend error sink is deliberately open to any browser that can load
	// the shell: a fatal first-render failure or a broken session is exactly the
	// class of defect worth reporting, and requiring a product session would
	// silently drop it. Nothing is read from the report and nothing is stored;
	// the endpoint bounds the body, allowlists the shape, and sheds its own
	// logging above a per-isolate rate, so it cannot become a write amplifier.
	// The signed-in subject is stamped here from the host-only session cookie,
	// never accepted from the body.
	// authz: public — frontend error sink; must accept reports from a browser with no working session.
	if (url.pathname === OS_CLIENT_ERROR_PATH) {
		return withSecurityHeaders(
			await clientErrorIngest.handle(request, {
				tenant: tenant.kind === "tenant" ? tenant.slug : tenant.kind,
				deployedSha: String(env.GIT_SHA || "unknown"),
				reportedUserId: reportedUserIdFromSession(request),
			}),
		);
	}

	// WebMCP invocation telemetry: same posture as the client-error sink above
	// — open to shell-bearing browsers because nothing sensitive is carried.
	// The batch is tool names, scope keys, outcome classes, and durations;
	// never arguments, results, or user content. Nothing is read from it and
	// nothing is stored; the handler bounds the body, allowlists the exact
	// shape, and sheds its own logging above a per-isolate rate, so it cannot
	// become a write amplifier.
	// authz: public — bounded observability sink; a report grants nothing and requiring a session would drop the tail of a dying tab.
	if (url.pathname === WEBMCP_TELEMETRY_PATH) {
		return withSecurityHeaders(
			await webMcpTelemetryIngest.handle(request, {
				tenant: tenant.kind === "tenant" ? tenant.slug : tenant.kind,
				deployedSha: String(env.GIT_SHA || "unknown"),
			}),
		);
	}

	const brokerResponse = await handleOsSessionBroker(
		request,
		env,
		tenant,
		hostTenantId,
	);
	if (brokerResponse) return withSecurityHeaders(brokerResponse);
	// authz: verified OS session on the fixed Tedix tenant host. This is a
	// first-party provider-host pilot, separate from OS Quick Chat and /mcp.
	if (
		url.pathname === PROVIDER_COHORT_PATH ||
		url.pathname === PROVIDER_COHORT_SESSION_PATH
	) {
		// The proxy helper rebuilds its input Request and consumes a POST body.
		// Guard a clone so the cohort handler can parse the original body.
		const authenticated = withBrokerApiSession(
			request.clone(),
			OS_BROKER_SESSION_COOKIE,
		);
		if (!authenticated) return refuse(401, "Authentication required");
		return withSecurityHeaders(
			await handleProviderCohortHost(request, env, hostTenantId),
		);
	}
	if (url.pathname === DESCOPE_OUTBOUND_BRIDGE_PATH) {
		const authenticated = withBrokerApiSession(
			new Request(request.url, { headers: request.headers }),
			OS_BROKER_SESSION_COOKIE,
		);
		if (!authenticated) return refuse(401, "Authentication required.");
		return withSecurityHeaders(
			await handleDescopeOutboundConnect(request, env, hostTenantId),
		);
	}

	if (
		url.pathname === "/api" ||
		url.pathname.startsWith("/api/") ||
		url.pathname === "/cli/api" ||
		url.pathname.startsWith("/cli/api/")
	) {
		const cliApi =
			url.pathname === "/cli/api" || url.pathname.startsWith("/cli/api/");
		if (cliApi && tenant.kind !== "launcher") {
			return refuseApi(
				url,
				404,
				"NOT_FOUND",
				"CLI APIs are only served on the launcher host.",
			);
		}
		const descopeSessionBootstrap =
			tenant.kind === "launcher" &&
			(url.pathname ===
				`${cliApi ? "/cli/api" : "/api"}/rpc/organizations/getMyOrganization` ||
				(!cliApi && url.pathname === "/api/rpc/members/acceptInvitation"));
		let authenticated =
			withLocalDemoAuthorization(request, env) ??
			withBrokerApiSession(
				request,
				cliApi ? CLI_BROKER_SESSION_COOKIE : OS_BROKER_SESSION_COOKIE,
				// These exact canonical bootstrap verbs run after Descope authentication
				// but before a product-specific broker session exists. The invitation
				// handler independently binds the D1 row to the verified bearer subject.
				// Every other apex API requires its product-specific cookie.
				descopeSessionBootstrap,
				cliApi ? null : hostTenantId,
			);
		if (!authenticated) {
			return refuseApi(url, 401, "UNAUTHORIZED", "Authentication required.");
		}
		if (isKernelVoiceTranscriptionPath(url.pathname)) {
			const authorization = request.headers.get("Authorization");
			if (authorization) {
				const headers = new Headers(authenticated.headers);
				headers.set("Authorization", authorization);
				authenticated = new Request(authenticated, { headers });
			}
		}
		return proxyApiRequest(authenticated, env, url, hostTenantId);
	}

	if (url.pathname.startsWith("/collab/")) {
		const authenticated =
			withLocalDemoAuthorization(request, env) ??
			withCollabSession(request, env, hostTenantId);
		if (!authenticated) return refuse(401, "Authentication required.");
		return handleCollabUpgrade(authenticated, env, url, tenant, hostTenantId);
	}

	// Cap'n Web: a browser-session projection over the same kernelRuntime
	// handlers the oRPC surface uses — no browser-only business verb. This is
	// the only event transport (there is no SSE fallback lane; a browser that
	// cannot establish it degrades to visible polling client-side).
	//
	// There is no feature flag. Every guard is server-side: a provisioned tenant host, an authenticated session, and
	// (inside mountCapnChat) a same-origin upgrade the caller's own credentials
	// can authorize in the host tenant, under payload and depth limits.
	//
	// The local-demo escape mirrors `/collab`: zero-account local development
	// (loopback + demo project + TEDIX_LOCAL_DEMO_ENABLED) authorizes with the
	// deterministic local bearer, which mountCapnChat forwards ONLY in this
	// mode — see the host-binding note in capnweb/mount.ts.
	if (url.pathname === CAPN_ROUTE_PATH) {
		const localDemo = isLocalDemoOrigin(request, env);
		if (tenant.kind !== "tenant" && !localDemo) {
			return refuse(404, "No Tedix OS workspace at this hostname.");
		}
		const { mountCapnChat } = await import("./capnweb/mount");
		const authenticated = localDemo
			? withLocalDemoAuthorization(request, env)
			: withBrokerApiSession(
					request,
					OS_BROKER_SESSION_COOKIE,
					false,
					hostTenantId,
				);
		if (!authenticated) return refuse(401, "Authentication required.");
		return mountCapnChat(authenticated, env, hostTenantId, { localDemo });
	}

	// Governed widget bridge (docs/engineering/mcp/apps.md): the SPA fetches ui://
	// resources and relays widget-originated MCP calls through these
	// same-origin endpoints; the caller's own session rides through and
	// iframes never see a token. Tenant hosts only.
	if (tenant.kind === "tenant") {
		const authenticated: {
			request: Request;
			serviceIdentity?: WidgetServiceIdentity;
		} | null =
			env.MCP_SERVICE && hostTenantId
				? await authenticateWidgetBridge(request, env, hostTenantId)
				: (() => {
						const fallback = withBrokerApiSession(
							request,
							OS_BROKER_SESSION_COOKIE,
							false,
							hostTenantId,
						);
						return fallback ? { request: fallback } : null;
					})();
		const mcpFetch = env.MCP_SERVICE
			? serviceBindingFetch(env.MCP_SERVICE)
			: undefined;
		if (
			(url.pathname === "/widgets/resource" ||
				url.pathname === "/widgets/mcp") &&
			env.MCP_SERVICE
		) {
			if (!hostTenantId || !env.API_SERVICE) {
				return refuse(503, "Browser MCP authorization is unavailable.");
			}
			if (!authenticated?.serviceIdentity) {
				return refuse(401, "Authentication required.");
			}
			const browserIdentity = await authorizeBrowserMcpBridge(
				request,
				env,
				hostTenantId,
				authenticated.serviceIdentity,
			);
			if (!browserIdentity) {
				return refuse(403, "Browser MCP authorization was not granted.");
			}
			authenticated.serviceIdentity = browserIdentity;
		}
		if (url.pathname === "/widgets/resource") {
			if (!authenticated) return refuse(401, "Authentication required.");
			return handleWidgetResource(
				authenticated.request,
				url,
				mcpFetch,
				authenticated.serviceIdentity,
			);
		}
		if (url.pathname === "/widgets/mcp") {
			if (!authenticated) return refuse(401, "Authentication required.");
			return handleWidgetMcp(
				authenticated.request,
				url,
				mcpFetch,
				authenticated.serviceIdentity,
			);
		}
		// WebMCP bridge: a same-origin streamable-HTTP
		// MCP endpoint for in-page browser agents. The injected WebMCP bridge
		// script discovers tools here with the visitor's own session; the MCP
		// edge stays the authority on every call.
		if (url.pathname === "/mcp") {
			if (!authenticated) return refuse(401, "Authentication required.");
			if (!hostTenantId) return refuse(404, "Workspace is not provisioned.");
			if (!env.API_SERVICE) {
				return refuse(503, "Browser MCP authorization is unavailable.");
			}
			const browserIdentity = await authorizeBrowserMcpBridge(
				request,
				env,
				hostTenantId,
				authenticated.serviceIdentity!,
			);
			if (!browserIdentity) {
				return refuse(403, "Browser MCP authorization was not granted.");
			}
			authenticated.serviceIdentity = browserIdentity;
			const { handleWebMcpEndpoint } = await import("./webmcp/endpoint");
			return handleWebMcpEndpoint(
				authenticated.request,
				url,
				tenant.slug,
				mcpFetch,
				authenticated.serviceIdentity,
			);
		}
		if (url.pathname === "/_tedix/webmcp/portable-call") {
			if (!authenticated) return refuse(401, "Authentication required.");
			if (!hostTenantId || !env.API_SERVICE || !authenticated.serviceIdentity)
				return refuse(503, "Portable route authorization is unavailable.");
			const browserIdentity = await authorizeBrowserMcpBridge(
				request,
				env,
				hostTenantId,
				authenticated.serviceIdentity,
			);
			if (!browserIdentity)
				return refuse(403, "Browser MCP authorization was not granted.");
			const { handleOsPortableCall } = await import("./webmcp/endpoint");
			return handleOsPortableCall(
				authenticated.request,
				url,
				tenant.slug,
				browserIdentity,
				async (input) => {
					try {
						const verdict = await callRpc<{ authorized: true }>(
							"tedis/authorizeOsPortableCall",
							input,
							{
								apiUrl: "https://api",
								fetch: serviceBindingFetch(env.API_SERVICE!),
								headers: {
									"X-Service-Binding": "true",
									Cookie:
										canonicalizeProductSessionCookieHeader(
											request.headers.get("Cookie"),
											OS_BROKER_SESSION_COOKIE,
										) ?? "",
									"X-Tedix-Tenant-Id": hostTenantId,
								},
								timeoutMs: 5_000,
							},
						);
						return verdict.authorized === true;
					} catch {
						return false;
					}
				},
				mcpFetch,
			);
		}
	}

	// A tenant document mounts only after its hostname has a session JWT minted
	// for that exact Descope tenant. This is a routing hint, not authorization:
	// apps/api still verifies signature, membership, and host context per call.
	if (
		tenant.kind === "tenant" &&
		hostTenantId &&
		isDocumentNavigation(request) &&
		!productSessionMatchesTenant(
			resolveProductSession(
				request.headers.get("cookie"),
				OS_BROKER_SESSION_COOKIE,
			),
			hostTenantId,
		)
	) {
		// A failed broker callback deliberately returns to the fixed product
		// recovery document with an error. Let that one document mount the login
		// UI; redirecting it immediately would create an unbounded recovery loop.
		// Redirect to the same-origin bounce document rather than to `start`
		// directly: a 302 preserves the navigation's original provenance, and a
		// visitor following a link from Slack or email would otherwise reach the
		// same-origin-gated start verb cross-site and see a bare 403.
		if (!url.searchParams.has("error")) {
			const bounce = new URL("/auth/session-broker/continue", url.origin);
			bounce.searchParams.set("redirect_to", `${url.pathname}${url.search}`);
			return withSecurityHeaders(Response.redirect(bounce, 302));
		}
	}

	const asset = await env.ASSETS.fetch(request);
	const isSandboxProxy =
		url.pathname === "/sandbox_proxy" || url.pathname === "/sandbox_proxy.html";
	// The shell document gets the shared WebMCP bridge tag appended into <head>
	// on tenant hosts — after header stamping, which
	// HTMLRewriter's transform preserves. The sandbox proxy is exempt: widget
	// guests run on a null origin, where the injected module script dies on
	// CORS and has no business running anyway.
	const stamped = withSecurityHeaders(
		asset,
		isSandboxProxy ? "SAMEORIGIN" : "DENY",
	);
	return isSandboxProxy ? stamped : injectWebMcpBridge(stamped, tenant.kind);
}

/**
 * Collaborative-editing socket: `/collab/{workspaceId}/{docKey}` on a tenant
 * host upgrades into the workspace's CollabRoom Durable Object.
 *
 * The room holds LIVE SESSION STATE ONLY (an OT change stream plus presence) —
 * canonical truth stays in D1 behind apps/api's CAS revision contracts, and the
 * DO never sees a credential. Authorization happens HERE, per connection: the
 * caller's own forwarded credentials must read the document through apps/api
 * (the sole authority) before the socket reaches the room. The hostname slug
 * only namespaces the room id; it grants nothing.
 *
 * THE READ IS AN AUTHORIZATION PROBE AND NOTHING ELSE — the revision body never
 * crosses this hop. Seeding is not this hop's problem: the base is established
 * once by `OtAuthority.seed`, which is single-writer and idempotent, so the
 * first client's `base` handshake seeds the room and every later offer is
 * ignored. There is no concurrent-seed race for a server-side seed to prevent.
 */
async function handleCollabUpgrade(
	request: Request,
	env: OsRouterEnv,
	url: URL,
	tenant: ReturnType<typeof resolveOsTenant>,
	hostTenantId: string | null = null,
): Promise<Response> {
	const localDemo = isLocalDemoOrigin(request, env);
	if (tenant.kind !== "tenant" && !localDemo) {
		return refuse(404, "Collaboration is only served on tenant hosts.");
	}
	if (!env.COLLAB_ROOM || !env.API_SERVICE) {
		return refuse(503, "Collaboration is unavailable on this origin.");
	}
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return refuse(426, "Expected a WebSocket upgrade.");
	}
	const segments = url.pathname.split("/").filter(Boolean);
	const workspaceId = segments[1];
	const docKey = segments[2] ? decodeURIComponent(segments[2]) : "";
	if (!workspaceId || segments.length !== 3 || !docKey) {
		return refuse(404, "Malformed collaboration room path.");
	}
	// The caller's OWN credentials authenticate this read — never a
	// service-binding claim, which would swap the auth mode and evaluate
	// the call without the user's org context (the /api proxy sets no such
	// header either). Reading the selected document proves its exact
	// workspace membership; the response body is deliberately discarded.
	const apiHeaders: Record<string, string> = {};
	const authorization = request.headers.get("Authorization");
	const apiKey = request.headers.get("X-API-Key");
	const cookie = request.headers.get("Cookie");
	if (authorization) apiHeaders.Authorization = authorization;
	if (apiKey) apiHeaders["X-API-Key"] = apiKey;
	if (cookie) apiHeaders.Cookie = cookie;
	if (hostTenantId) apiHeaders["X-Tedix-Tenant-Id"] = hostTenantId;
	const rpcOptions = {
		apiUrl: "https://api",
		fetch: serviceBindingFetch(env.API_SERVICE),
		headers: apiHeaders,
		timeoutMs: 5_000,
	};
	try {
		const separator = docKey.indexOf(":");
		const kind = separator > 0 ? docKey.slice(0, separator) : "";
		const documentId = separator > 0 ? docKey.slice(separator + 1) : "";
		if (!documentId) throw new Error("Malformed collaboration document key");
		if (kind === "gadget") {
			const detail = await callRpc<CollabGadgetDetail>(
				"osWorkspaces/gadgets/get",
				{ workspaceId, gadgetId: documentId },
				rpcOptions,
			);
			if (detail.gadget.workspaceId !== workspaceId) {
				throw new Error("Gadget workspace mismatch");
			}
		} else if (kind === "output") {
			const detail = await callRpc<CollabOutputDetail>(
				"osWorkspaces/outputs/get",
				{ outputId: documentId },
				rpcOptions,
			);
			if (detail.output.workspaceId !== workspaceId) {
				throw new Error("Output workspace mismatch");
			}
		} else {
			throw new Error("Unsupported collaboration document kind");
		}
	} catch {
		// Unauthorized, foreign-org, and not-found all collapse to one refusal:
		// room existence must not leak across organizations.
		console.warn("Collab upgrade refused: document authorization failed");
		return refuse(403, "You do not have access to this workspace.");
	}
	const presence = localDemo
		? await localCollabPresence("local")
		: env.DESCOPE_PROJECT_ID
			? hostTenantId
				? await authenticateCollabPresence(
						request,
						env.DESCOPE_PROJECT_ID,
						hostTenantId,
						undefined,
						request.headers.get(COLLAB_VERIFIED_SESSION_HEADER) ?? undefined,
					)
				: null
			: await localCollabPresence(
					tenant.kind === "tenant" ? tenant.slug : "local",
				);
	if (!presence) {
		// Do not surface the distinction to the caller: it would reveal whether a
		// document exists. The server log retains the operational cause without
		// recording a credential, document id, or identity payload.
		console.warn("Collab upgrade refused: presence verification failed");
		return refuse(403, "Collaboration identity is unavailable.");
	}
	const tenantScope = tenant.kind === "tenant" ? tenant.slug : "local";
	const roomName = `${tenantScope}:${workspaceId}:${docKey}`;
	const room = env.COLLAB_ROOM.get(env.COLLAB_ROOM.idFromName(roomName));
	// Credentials stop at this Worker. The DO receives only a strict, verified,
	// privacy-safe presence projection over the internal namespace binding.
	const headers = new Headers(request.headers);
	headers.delete("Authorization");
	headers.delete("Cookie");
	headers.delete("X-API-Key");
	headers.delete(COLLAB_VERIFIED_SESSION_HEADER);
	// Strip every client-suppliable internal-trust marker (this is public
	// browser ingress) so no forged identity/authority header reaches the room.
	applyInboundTrustHeaderHygiene(headers, false);
	headers.delete(COLLAB_PRESENCE_HEADER);
	headers.set(COLLAB_PRESENCE_HEADER, JSON.stringify(presence));
	return room.fetch(new Request(request, { headers }));
}

// The runtime invokes fetch(request, env, executionContext); the wrapper keeps
// the third argument from shadowing handleOsRequest's injectable resolver.
export default {
	fetch: (request: Request, env: OsRouterEnv) => handleOsRequest(request, env),
};

// Durable Object class for the COLLAB_ROOM binding.
export { CollabRoom } from "./collab/room";
