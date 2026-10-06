import {
	callRpc,
	serviceBindingFetch,
	type FetcherLike,
} from "@tedix/api-client/internal";
import { validateToken } from "@tedix/auth/jwt";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import { OS_BROKER_SESSION_COOKIE } from "../auth/session-broker";

/** One operator cohort, deliberately separate from OS Quick Chat and /mcp. */
export const PROVIDER_COHORT_PATH = "/jev-provider-cohort";
export const PROVIDER_COHORT_SESSION_PATH = `${PROVIDER_COHORT_PATH}/session`;
export const PROVIDER_COHORT_ROUTE_ID = "jev_provider_cohort";

interface ProviderCohortEnv {
	API_SERVICE?: FetcherLike;
	DESCOPE_PROJECT_ID?: string;
	TEDIX_PROVIDER_COHORT_API_KEY?: string;
	PROVIDER_COHORT_OS_TENANT_ID?: string;
	PROVIDER_COHORT_EXTERNAL_TENANT_ID?: string;
}

type VerifySession = typeof validateToken;
type ExchangeSession = typeof callRpc;

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(status: number, message: string): Response {
	const code =
		status === 401
			? "UNAUTHORIZED"
			: status === 403
				? "FORBIDDEN"
				: "UNAVAILABLE";
	return Response.json(
		{ code, message },
		{
			status,
			headers: { "Cache-Control": "private, no-store" },
		},
	);
}

function page(): Response {
	// Literal cohort context is presentation only. The session endpoint derives
	// its route assertion and external tenant target independently of this HTML.
	const route = JSON.stringify([
		{ match: PROVIDER_COHORT_PATH, routeKey: PROVIDER_COHORT_ROUTE_ID },
	]);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev provider cohort · Tedix</title></head><body><main><h1>Jev provider cohort</h1><p>This authenticated pilot uses the provider-hosted Tedi widget with a fixed Tedix organization route.</p></main><script async src="https://widget.tedix.dev/v1/loader.js" data-tedix-tenant="tedix" data-tedix-endpoint="${PROVIDER_COHORT_SESSION_PATH}" data-tedix-routes='${route}' data-tedix-preload="open"></script><script>addEventListener("pagehide",()=>window.Tedix?.shutdown());</script></body></html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "private, no-store",
		},
	});
}

/** The route and target are fixed by Worker config, never by browser JSON. */
export async function handleProviderCohortHost(
	request: Request,
	env: ProviderCohortEnv,
	hostTenantId: string | null,
	verify: VerifySession = validateToken,
	exchange: ExchangeSession = callRpc,
): Promise<Response> {
	const url = new URL(request.url);
	const isPage = url.pathname === PROVIDER_COHORT_PATH;
	if (!isPage && url.pathname !== PROVIDER_COHORT_SESSION_PATH)
		return fail(404, "Not found");
	if (url.hostname !== "tedix.os.tedix.dev" || url.protocol !== "https:")
		return fail(404, "Not found");
	if (
		!hostTenantId ||
		hostTenantId !== env.PROVIDER_COHORT_OS_TENANT_ID ||
		!env.DESCOPE_PROJECT_ID
	)
		return fail(403, "Cohort tenant is unavailable");
	const externalTenantId = env.PROVIDER_COHORT_EXTERNAL_TENANT_ID;
	if (!externalTenantId || !UUID.test(externalTenantId))
		return fail(503, "Cohort target is unavailable");
	const token = resolveProductSession(
		request.headers.get("Cookie"),
		OS_BROKER_SESSION_COOKIE,
	);
	if (!token) return fail(401, "Authentication required");
	let subject: string;
	try {
		const claims = await verify(token, { projectId: env.DESCOPE_PROJECT_ID });
		if (
			claims.dct !== hostTenantId ||
			typeof claims.sub !== "string" ||
			!claims.sub ||
			claims.sub.length > 200
		)
			return fail(403, "Cohort tenant is unavailable");
		subject = claims.sub;
	} catch {
		return fail(401, "Authentication required");
	}
	if (isPage) {
		if (request.method !== "GET" && request.method !== "HEAD")
			return fail(405, "Method not allowed");
		return request.method === "HEAD"
			? new Response(null, { headers: page().headers })
			: page();
	}
	if (request.method !== "POST") return fail(405, "Method not allowed");
	if (request.headers.get("Origin") !== url.origin)
		return fail(403, "Same-origin request required");
	try {
		const referer = new URL(request.headers.get("Referer") ?? "");
		if (
			referer.origin !== url.origin ||
			referer.pathname !== PROVIDER_COHORT_PATH
		)
			return fail(403, "Cohort page required");
	} catch {
		return fail(403, "Cohort page required");
	}
	if (
		request.headers.get("Content-Type")?.split(";", 1)[0]?.trim() !==
		"application/json"
	)
		return fail(415, "JSON request required");
	let input: unknown;
	try {
		const raw = await request.text();
		if (raw.length > 2_000) return fail(413, "Session request is too large");
		input = JSON.parse(raw);
	} catch {
		return fail(400, "Invalid session request");
	}
	if (!input || typeof input !== "object" || Array.isArray(input))
		return fail(400, "Invalid session request");
	const body = input as Record<string, unknown>;
	if (
		Object.keys(body).some(
			(key) => !["conversationId", "selectedTediId", "pathname"].includes(key),
		) ||
		typeof body.conversationId !== "string" ||
		!UUID.test(body.conversationId) ||
		(body.selectedTediId !== undefined &&
			(typeof body.selectedTediId !== "string" ||
				!UUID.test(body.selectedTediId))) ||
		(body.pathname !== undefined && body.pathname !== PROVIDER_COHORT_PATH)
	)
		return fail(400, "Invalid session request");
	const key = env.TEDIX_PROVIDER_COHORT_API_KEY;
	if (!key?.startsWith("sk_") || !env.API_SERVICE)
		return fail(503, "Cohort session is unavailable");
	try {
		const session = await exchange(
			"tedis/createEmbeddedProviderSession",
			{
				externalTenantId,
				hostUserId: subject,
				conversationId: body.conversationId,
				...(body.selectedTediId ? { selectedTediId: body.selectedTediId } : {}),
				portableRouteAssertion: {
					routeId: PROVIDER_COHORT_ROUTE_ID,
					pathname: PROVIDER_COHORT_PATH,
					routeKey: PROVIDER_COHORT_ROUTE_ID,
				},
			},
			{
				// Use the public hostname *through* the private binding: Host=api would
				// select service-binding auth before the exact API-key scope middleware.
				apiUrl: "https://api.tedix.dev",
				fetch: serviceBindingFetch(env.API_SERVICE),
				headers: { "X-API-Key": key },
				timeoutMs: 8_000,
			},
		);
		return Response.json(session, {
			headers: { "Cache-Control": "private, no-store" },
		});
	} catch (error) {
		const status =
			typeof error === "object" && error !== null && "status" in error
				? Number(error.status)
				: 502;
		return fail(
			status === 401 || status === 403 ? 403 : 502,
			status === 401 || status === 403
				? "Provider cohort access denied"
				: "Cohort session is unavailable",
		);
	}
}
