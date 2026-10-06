import { defineMiddleware, sequence } from "astro:middleware";
import { env } from "cloudflare:workers";

function envString(name: string): string | undefined {
	const value = (env as Record<string, unknown>)[name];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function currentOrgSlug(): string {
	return envString("ORG_SLUG") ?? "preview";
}

const orgContext = defineMiddleware(async (context, next) => {
	const slug = currentOrgSlug();
	const siteTitle = envString("SITE_TITLE") ?? "Site Builder Preview";

	context.locals.org = { slug, siteTitle };

	return next();
});

const CANONICAL_SLASH_ROUTE_RE =
	/^\/(?:[a-z]{2}\/)?(?:category|tag)\/[^/.]+(?:\/[^/.]+)*$/;
const CANONICAL_ROOT_CONTENT_TRAILING_RE = /^\/[^/._][^/.]*\/$/;

const canonicalSlashRedirect = defineMiddleware(async (context, next) => {
	const { pathname, search } = context.url;
	if (CANONICAL_SLASH_ROUTE_RE.test(pathname)) {
		return context.redirect(`${pathname}/${search}`, 301);
	}
	// Root content paths are canonical without a trailing slash. Rewrite the
	// slashed form in place: a reverse redirect could loop with a browser's
	// cached permanent redirect. Canonical links, JSON-LD, and the sitemap
	// still advertise the slashless URL.
	if (
		CANONICAL_ROOT_CONTENT_TRAILING_RE.test(pathname) &&
		!pathname.startsWith("/_emdash") &&
		!pathname.startsWith("/_astro")
	) {
		return next(`${pathname.replace(/\/+$/, "")}${search}`);
	}

	return next();
});

// Dynamic Workers (Worker Loader) silently drops ReadableStream response
// bodies when they cross the isolate boundary. Buffer the body here —
// inside the Astro SSR pipeline — so the outgoing Response carries an
// ArrayBuffer that survives the boundary intact.
//
// Also normalises Astro 6 i18n fallback-route responses: when fallback
// routing (fallback: { en: "de" }) renders a page but the Cloudflare
// adapter emits it as HTTP 302 with a body and no Location header, the
// response is technically invalid. Downgrade to 200 so browsers and
// crawlers treat it as a normal page response.
const bufferBody = defineMiddleware(async (_context, next) => {
	const response = await next();
	if (!response.body) return response;
	const body = await response.arrayBuffer();
	const isBodyRedirect =
		(response.status === 301 || response.status === 302) &&
		!response.headers.has("location") &&
		body.byteLength > 0;
	return new Response(body, {
		status: isBodyRedirect ? 200 : response.status,
		statusText: isBodyRedirect ? "OK" : response.statusText,
		headers: response.headers,
	});
});

export const onRequest = sequence(
	orgContext,
	canonicalSlashRedirect,
	bufferBody,
);
