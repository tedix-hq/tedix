import { decodeUnverifiedJwtClaims } from "@tedix/auth/web";
import {
	mountSessionBroker,
	PRODUCT_SESSION_BROKER_POLICIES,
} from "@tedix/auth/mount-session-broker";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
} from "@tedix/tenant-directory";
import { constantTimeEquals } from "./tenant-internal-auth";
import {
	CMS_HUMAN_ASSERTION_HEADER,
	CMS_HUMAN_IDENTITY_HEADER,
} from "./tenant-human-auth";

export const CMS_BROKER_SESSION_COOKIE =
	PRODUCT_SESSION_BROKER_POLICIES.cms.productCookie;
export const CMS_BROKER_START_PATH = "/_emdash/api/auth/session-broker/start";
export const CMS_BROKER_CALLBACK_PATH =
	"/_emdash/api/auth/session-broker/callback";
export const CMS_FORWARDED_USER_AUTH_HEADER = "X-Tedix-CMS-Forwarded-User-Auth";

export interface CmsSessionBrokerEnv {
	CMS_SESSION_BROKER?: SessionBrokerRpc;
	ENVIRONMENT?: string;
}

export interface CmsProductSessionDiagnostic {
	audienceMatchesProject: boolean;
	dctMatchesTenant: boolean;
	expiresInFuture: boolean;
	hasEmail: boolean;
	hasSubject: boolean;
	issuerMatchesProject: boolean;
	issuerIsProjectId: boolean;
}

function safeAdminRedirect(value: string | null): string {
	return value?.startsWith("/_emdash/admin") &&
		!value.startsWith("//") &&
		!value.includes("\\") &&
		!value.includes("#") &&
		value.length < 2048
		? value
		: "/_emdash/admin";
}

/**
 * Return privacy-safe claim-shape diagnostics for a product session. The raw
 * token and all user/tenant identifiers deliberately remain outside the
 * result so a rejected Loader-bound session can be observed without leaking
 * credentials or personal data into Worker logs.
 */
export function diagnoseCmsProductSession(
	request: Request,
	env: CmsSessionBrokerEnv,
	expected: { projectId: string | undefined; tenantId: string },
): CmsProductSessionDiagnostic | null {
	const session = resolveProductSession(
		request.headers.get("Cookie"),
		CMS_BROKER_SESSION_COOKIE,
	);
	if (!session) return null;
	const claims = decodeUnverifiedJwtClaims(session);
	if (!claims) return null;
	const audience = Array.isArray(claims.aud)
		? claims.aud.filter((value): value is string => typeof value === "string")
		: typeof claims.aud === "string"
			? [claims.aud]
			: [];
	const projectId = expected.projectId;
	return {
		audienceMatchesProject:
			audience.length === 0 ||
			Boolean(projectId && audience.some((value) => value.includes(projectId))),
		dctMatchesTenant: claims.dct === expected.tenantId,
		expiresInFuture:
			typeof claims.exp === "number" &&
			claims.exp > Math.floor(Date.now() / 1000),
		hasEmail: typeof claims.email === "string" && claims.email.length > 0,
		hasSubject: typeof claims.sub === "string" && claims.sub.length > 0,
		issuerIsProjectId: Boolean(projectId && claims.iss === projectId),
		issuerMatchesProject:
			typeof claims.iss !== "string" ||
			Boolean(projectId && claims.iss.includes(projectId)),
	};
}

const CMS_AUTH_REJECTION_CODES = new Set([
	"missing_session",
	"missing_email",
	"issuer_mismatch",
	"audience_mismatch",
	"human_assertion_disabled",
	"human_assertion_format",
	"human_assertion_json",
	"human_assertion_signature",
	"human_assertion_binding",
	...[
		"unknown",
		"ERR_JOSE_GENERIC",
		"ERR_JOSE_ALG_NOT_ALLOWED",
		"ERR_JOSE_NOT_SUPPORTED",
		"ERR_JWT_CLAIM_VALIDATION_FAILED",
		"ERR_JWT_EXPIRED",
		"ERR_JWT_INVALID",
		"ERR_JWS_INVALID",
		"ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
		"ERR_JWK_INVALID",
		"ERR_JWKS_INVALID",
		"ERR_JWKS_NO_MATCHING_KEY",
		"ERR_JWKS_MULTIPLE_MATCHING_KEYS",
		"ERR_JWKS_TIMEOUT",
	].map((code) => `jwt_validation:${code}`),
]);

/** Project only canonical auth event codes from Worker Loader console arguments. */
export function cmsAuthRejectionCodes(
	logs: readonly { message: unknown }[],
): string[] {
	const codes = new Set<string>();
	for (const log of logs) {
		const messages = Array.isArray(log.message) ? log.message : [log.message];
		for (const message of messages) {
			if (typeof message !== "string") continue;
			try {
				const data: unknown = JSON.parse(message);
				if (
					data &&
					typeof data === "object" &&
					"event" in data &&
					data.event === "cms.descope_auth_rejected" &&
					"code" in data &&
					typeof data.code === "string" &&
					CMS_AUTH_REJECTION_CODES.has(data.code)
				)
					codes.add(data.code);
			} catch {
				// Tenant log strings are untrusted; never relay malformed content.
			}
		}
	}
	return [...codes];
}

/** Diagnose only transport shape; never expose authentication material or URL queries. */
export function diagnoseCmsTenantRejection(
	tenantRequest: Request,
	response: Response,
): { hasProjectedSession: boolean; redirectPath: string | null } {
	const cookie = tenantRequest.headers.get("Cookie") ?? "";
	const authorization = tenantRequest.headers.get("Authorization") ?? "";
	const location = response.headers.get("Location");
	let redirectPath: string | null = null;
	if (location) {
		try {
			const redirect = new URL(location, tenantRequest.url);
			if (redirect.protocol === "https:" || redirect.protocol === "http:") {
				redirectPath = redirect.pathname;
			}
		} catch {
			// A malformed Location has no useful redirect path.
		}
	}
	return {
		hasProjectedSession:
			/(?:^|;\s*)DS=[^;\s]+/.test(cookie) ||
			/^Bearer\s+\S+/i.test(authorization),
		redirectPath,
	};
}

function isBrowserAdminNavigation(request: Request, url: URL): boolean {
	if (!url.pathname.startsWith("/_emdash/admin")) return false;
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const accept = request.headers.get("Accept") ?? "";
	return !accept || accept.includes("text/html") || accept.includes("*/*");
}

export async function handleCmsSessionBroker(
	request: Request,
	env: CmsSessionBrokerEnv,
	tenantId: string,
	tenantSlug: string,
): Promise<Response | null> {
	const url = new URL(request.url);
	const canonicalOrigin = buildSurfaceUrl("cms", tenantSlug, {
		platformDomain: platformDomainForEnvironment(
			env.ENVIRONMENT ?? "production",
		),
	});
	if (!canonicalOrigin)
		return new Response("Invalid CMS tenant\n", { status: 503 });
	if (url.origin !== canonicalOrigin) {
		const brokerPath =
			url.pathname === CMS_BROKER_START_PATH ||
			url.pathname === CMS_BROKER_CALLBACK_PATH ||
			url.pathname === "/_emdash/api/auth/logout";
		if (!brokerPath && !isBrowserAdminNavigation(request, url)) return null;
		const location = new URL(`${url.pathname}${url.search}`, canonicalOrigin);
		return new Response(null, {
			status: 302,
			headers: {
				"Cache-Control": "no-store",
				Location: location.toString(),
				"Referrer-Policy": "no-referrer",
			},
		});
	}
	const broker = env.CMS_SESSION_BROKER;
	const mounted = broker ? mountSessionBroker("cms", broker) : null;
	if (url.pathname === CMS_BROKER_CALLBACK_PATH) {
		if (!mounted)
			return new Response("Session broker unavailable\n", { status: 503 });
		return mounted.finish(request);
	}
	if (
		url.pathname === CMS_BROKER_START_PATH ||
		url.pathname === "/_emdash/api/auth/logout"
	) {
		if (!mounted)
			return new Response("Session broker unavailable\n", { status: 503 });
		const logout = url.pathname === "/_emdash/api/auth/logout";
		return mounted.start({
			operation: logout ? "logout" : "issue_session",
			redirectPath: logout
				? "/_emdash/admin/login"
				: safeAdminRedirect(url.searchParams.get("redirect_to")),
			request,
			tenantId: logout ? null : tenantId,
		});
	}
	if (!isBrowserAdminNavigation(request, url)) return null;

	const session = resolveProductSession(
		request.headers.get("Cookie"),
		CMS_BROKER_SESSION_COOKIE,
	);
	if (!session) {
		const redirect = new URL(CMS_BROKER_START_PATH, url.origin);
		redirect.searchParams.set(
			"redirect_to",
			url.pathname === "/_emdash/admin/login"
				? "/_emdash/admin"
				: `${url.pathname}${url.search}`,
		);
		return Response.redirect(redirect.toString(), 302);
	}
	if (url.pathname === "/_emdash/admin/login") {
		return new Response(null, {
			status: 302,
			headers: {
				"Cache-Control": "no-store",
				Location: `${canonicalOrigin}/_emdash/admin`,
				"Referrer-Policy": "no-referrer",
			},
		});
	}
	return null;
}

function stripCmsSessionCookies(cookieHeader: string | null): string | null {
	const retained = (cookieHeader ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)
		.filter((part) => {
			const name = part.split("=", 1)[0];
			return name !== "DS" && name !== CMS_BROKER_SESSION_COOKIE;
		});
	return retained.length > 0 ? retained.join("; ") : null;
}

/**
 * Move a host-only CMS product session across the Worker Loader boundary as an
 * internal-only canonical `DS` cookie. Emdash reserves `Authorization: Bearer`
 * for its own PAT/OAuth tokens before external-auth providers run, so a Descope
 * JWT in that header is rejected without reaching our verifier. The host-only
 * product cookie never enters the tenant isolate. An authenticated Studio
 * request can instead carry its caller's DS JWT through a separate attestation
 * that is consumed here; the tenant never receives the shared secret or an
 * internal-admin credential. An explicit caller Bearer remains authoritative.
 */
export function withCmsProductSession(
	request: Request,
	sharedInternalAuthToken?: string,
): Request {
	const cookieHeader = request.headers.get("Cookie");
	const session = resolveProductSession(
		cookieHeader,
		CMS_BROKER_SESSION_COOKIE,
	);
	const forwardedAuth = request.headers.get(CMS_FORWARDED_USER_AUTH_HEADER);
	const authenticatedForward =
		sharedInternalAuthToken &&
		forwardedAuth &&
		constantTimeEquals(forwardedAuth, sharedInternalAuthToken);
	const forwardedSessions = (cookieHeader ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith("DS="));
	const headers = new Headers(request.headers);
	// The shared attestation must never cross into a tenant isolate. An empty
	// value reliably neutralizes the original header when Request init headers
	// are merged rather than replaced by the local runtime.
	if (forwardedAuth !== null) headers.set(CMS_FORWARDED_USER_AUTH_HEADER, "");
	// These are minted only by the parent after tenant and active bundle lookup.
	if (headers.has(CMS_HUMAN_IDENTITY_HEADER))
		headers.set(CMS_HUMAN_IDENTITY_HEADER, "");
	if (headers.has(CMS_HUMAN_ASSERTION_HEADER))
		headers.set(CMS_HUMAN_ASSERTION_HEADER, "");
	const retainedCookies = stripCmsSessionCookies(cookieHeader);
	if (retainedCookies) headers.set("Cookie", retainedCookies);
	else headers.delete("Cookie");
	const canonicalSession = session
		? `DS=${encodeURIComponent(session)}`
		: authenticatedForward && forwardedSessions.length === 1
			? forwardedSessions[0]
			: null;
	if (!headers.has("Authorization") && canonicalSession) {
		headers.set(
			"Cookie",
			retainedCookies
				? `${retainedCookies}; ${canonicalSession}`
				: canonicalSession,
		);
	}
	return new Request(request, { headers });
}
