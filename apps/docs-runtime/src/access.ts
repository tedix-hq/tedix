import { validateToken } from "@tedix/auth/jwt";
import {
	mountSessionBroker,
	PRODUCT_SESSION_BROKER_POLICIES,
} from "@tedix/auth/mount-session-broker";
import { resolveProductSession } from "@tedix/auth/product-session-broker";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import { getTenantId } from "@tedix/auth/types";
import { extractBearerToken } from "@tedix/worker-kit/request-auth";
import { contentFreeDocsException, docsLogger } from "./log";
import type { RuntimeDocsSite } from "./serving";

interface DocsAccessEnv {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_BASE_URL: string;
	DOCS_SESSION_BROKER?: SessionBrokerRpc;
}

export const DOCS_BROKER_SESSION_COOKIE =
	PRODUCT_SESSION_BROKER_POLICIES.docs.productCookie;

function bearerToken(request: Request): string | null {
	return extractBearerToken(request.headers.get("Authorization")?.trim());
}

function isTopLevelNavigation(request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const mode = request.headers.get("Sec-Fetch-Mode");
	if (mode) return mode === "navigate";
	const accept = request.headers.get("Accept");
	return !accept || accept.includes("text/html") || accept.includes("*/*");
}

function loginRedirect(request: Request) {
	const url = new URL(request.url);
	// A signed-out top-level navigation can carry cross-site provenance (a
	// link from Slack, email, or another site). `start` rejects that, so the
	// navigation first lands on the same-origin `continue` bounce, which
	// re-issues it to `start` with genuine same-origin headers.
	const loginUrl = new URL(
		isTopLevelNavigation(request)
			? "/auth/session-broker/continue"
			: "/auth/session-broker/start",
		request.url,
	);
	loginUrl.searchParams.set("redirect_to", `${url.pathname}${url.search}`);
	return new Response(null, {
		status: 302,
		headers: {
			"Cache-Control": "private, no-store",
			Location: loginUrl.toString(),
			Vary: "Cookie, Authorization",
		},
	});
}

function safeRedirectPath(url: URL): string {
	const redirectTo = url.searchParams.get("redirect_to");
	if (
		redirectTo?.startsWith("/") &&
		!redirectTo.startsWith("//") &&
		!redirectTo.includes("\\") &&
		!redirectTo.includes("\r") &&
		!redirectTo.includes("\n")
	) {
		const target = new URL(redirectTo, url.origin);
		if (target.origin === url.origin && !target.hash) {
			return `${target.pathname}${target.search}`;
		}
	}
	return "/";
}

export async function handleDocsSessionBroker(
	request: Request,
	env: DocsAccessEnv,
	site: RuntimeDocsSite,
): Promise<Response | null> {
	const url = new URL(request.url);
	const prefix = "/auth/session-broker";
	if (!url.pathname.startsWith(`${prefix}/`)) return null;
	if (!env.DOCS_SESSION_BROKER || !site.descopeTenantId) {
		return new Response("Session broker unavailable\n", {
			status: 503,
			headers: { "Cache-Control": "no-store" },
		});
	}
	const mounted = mountSessionBroker("docs", env.DOCS_SESSION_BROKER);
	if (url.pathname === `${prefix}/callback`) return mounted.finish(request);
	if (url.pathname === `${prefix}/continue`) {
		return mounted.continue({
			redirectPath: safeRedirectPath(url),
			request,
		});
	}
	if (url.pathname !== `${prefix}/start`) return null;
	return mounted.start({
		operation: "issue_session",
		redirectPath: safeRedirectPath(url),
		request,
		tenantId: site.descopeTenantId,
	});
}

export async function authorizeDocsSiteRequest(
	request: Request,
	env: DocsAccessEnv,
	site: RuntimeDocsSite,
): Promise<Response | null> {
	if (site.accessMode === "public") return null;
	if (!site.descopeTenantId) {
		docsLogger.error("Private docs site has no identity-provider tenant", {
			event: "docs.site.identity_unavailable",
			siteId: site.id,
		});
		return new Response("Documentation site access is unavailable", {
			status: 503,
			headers: { "Cache-Control": "private, no-store" },
		});
	}

	const token =
		bearerToken(request) ??
		resolveProductSession(
			request.headers.get("Cookie"),
			DOCS_BROKER_SESSION_COOKIE,
		);
	if (!token) return loginRedirect(request);

	try {
		const payload = await validateToken(token, {
			projectId: env.DESCOPE_PROJECT_ID,
			baseUrl: env.DESCOPE_BASE_URL,
			auditClaims: {
				surface: "docs-runtime:site",
				expected: [env.DESCOPE_PROJECT_ID],
			},
		});
		if (getTenantId(payload) === site.descopeTenantId) return null;
	} catch (error) {
		docsLogger.error("Private docs session validation failed", {
			event: "docs.session.validation_failed",
			siteId: site.id,
			failure: contentFreeDocsException(error),
		});
	}

	if (bearerToken(request)) {
		return new Response("Forbidden", {
			status: 403,
			headers: {
				"Cache-Control": "private, no-store",
				Vary: "Cookie, Authorization",
			},
		});
	}
	return loginRedirect(request);
}
