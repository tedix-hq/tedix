import { defineMiddleware } from "astro:middleware";

const INTERNAL_SESSION_RE = /(?:^|;\s*)DS=\S+/;
const AUTH_HEADER_RE = /^Bearer\s+\S+/i;
const BROKER_START_PATH = "/_emdash/api/auth/session-broker/start";

function isBrowserAdminNavigation(request: Request, url: URL): boolean {
	if (!url.pathname.startsWith("/_emdash/admin")) return false;
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const accept = request.headers.get("accept") ?? "";
	return !accept || accept.includes("text/html") || accept.includes("*/*");
}

function hasInternalAuth(request: Request): boolean {
	return (
		INTERNAL_SESSION_RE.test(request.headers.get("cookie") ?? "") ||
		AUTH_HEADER_RE.test(request.headers.get("authorization") ?? "")
	);
}

function safeAdminPath(url: URL): string {
	const requested =
		url.pathname === "/_emdash/admin/login"
			? (url.searchParams.get("redirect") ??
				url.searchParams.get("redirect_to"))
			: `${url.pathname}${url.search}`;
	return requested?.startsWith("/_emdash/admin") &&
		!requested.startsWith("//") &&
		!requested.includes("\\") &&
		!requested.includes("#") &&
		requested.length < 2048
		? requested
		: "/_emdash/admin";
}

function brokerRedirect(url: URL): Response {
	const start = new URL(BROKER_START_PATH, url.origin);
	start.searchParams.set("redirect_to", safeAdminPath(url));
	return new Response(null, {
		status: 302,
		headers: {
			"Cache-Control": "no-store",
			Location: start.toString(),
			"Referrer-Policy": "no-referrer",
		},
	});
}

/**
 * The parent CMS Worker owns browser authentication and projects its verified
 * host-only product session into the isolate as an internal `DS` cookie. The
 * tenant bundle contains no login UI, refresh logic, or browser cookie writer.
 */
export const onRequest = defineMiddleware(async (context, next) => {
	const url = new URL(context.request.url);
	if (!isBrowserAdminNavigation(context.request, url)) return next();

	if (
		url.pathname === "/_emdash/admin/login" &&
		hasInternalAuth(context.request)
	) {
		return Response.redirect(new URL("/_emdash/admin", url.origin), 302);
	}
	if (!hasInternalAuth(context.request)) {
		return brokerRedirect(url);
	}

	const response = await next();
	return response.status === 401 ? brokerRedirect(url) : response;
});
