import { defineMiddleware, sequence } from "astro:middleware";
import { env } from "cloudflare:workers";
import { withLandingAgentDiscoveryLinks } from "./lib/agent-discovery";
import { serveCliDownload } from "./lib/cli-downloads";
import { PUBLIC_CONTENT_SIGNAL } from "./lib/content-signals";

const agentDiscoveryHeader = defineMiddleware(async (context, next) => {
	const response = await next();
	const contentType = response.headers.get("content-type") ?? "";
	const isRedirect = response.status >= 300 && response.status < 400;
	if (!contentType.includes("text/html") && !isRedirect) return response;

	return withLandingAgentDiscoveryLinks(
		response,
		context.site ?? context.url.origin,
		env.API_URL,
	);
});

const cliDownloads = defineMiddleware(async (context, next) => {
	const response = await serveCliDownload(
		context.request,
		env.CLI_RELEASES,
		env.CLI_DOWNLOAD_HOST,
	);
	return response ?? next();
});

/**
 * Add Content-Signal HTTP header to all HTML responses.
 *
 * Complements the <meta name="content-signal"> tag for AI crawlers that
 * inspect HTTP headers before parsing the HTML body.
 *
 * @see docs/domains/geo.md — Content Signals framework (web4agents.org)
 */
const contentSignalHeader = defineMiddleware(async (_context, next) => {
	const response = await next();
	const contentType = response.headers.get("content-type") || "";
	if (
		contentType.includes("text/html") ||
		contentType.includes("text/markdown") ||
		contentType.includes("application/xml")
	) {
		if (!response.headers.has("Content-Signal")) {
			response.headers.set("Content-Signal", PUBLIC_CONTENT_SIGNAL);
		}
	}
	return response;
});

/**
 * Build a redirect with **mutable** headers.
 *
 * `Response.redirect()` returns a response whose headers are immutable. Astro's
 * cache provider (`cacheCloudflare()` + `routeRules`) runs `applyCacheHeaders`
 * on every SSR response, so an immutable redirect makes it throw
 * `TypeError: Can't modify immutable headers` — surfacing as an empty 500 for
 * every redirect this middleware emits.
 */
function redirect(target: URL, status: 301 | 302 | 308): Response {
	return new Response(null, {
		status,
		headers: { Location: target.toString() },
	});
}

const legacyBlogRedirect = defineMiddleware((context, next) => {
	const { pathname, search } = context.url;
	if (pathname !== "/blog" && !pathname.startsWith("/blog/")) {
		return next();
	}

	const slug = pathname.replace(/^\/blog\/?/, "").replace(/\/$/, "");
	if (slug === "archive") {
		const archiveTarget = new URL("/posts/", "https://blog.tedix.dev");
		archiveTarget.search = search;
		return redirect(archiveTarget, 301);
	}

	const target = new URL(
		slug ? `/posts/${slug}/` : "/",
		"https://blog.tedix.dev",
	);
	target.search = search;

	return redirect(target, 301);
});

/**
 * `/sitemap.xml` is the conventional discovery path crawlers probe directly,
 * and Google already knows it for this property. Point it at the real index
 * rather than letting it fall through to the `[locale]` catch-all.
 */
const sitemapAliasRedirect = defineMiddleware((context, next) => {
	if (context.url.pathname !== "/sitemap.xml") {
		return next();
	}
	return redirect(new URL("/sitemap-index.xml", context.url), 301);
});

const euroLabsRedirect = defineMiddleware((context, next) => {
	const { pathname, search } = context.url;
	if (
		pathname !== "/EuroLabs" &&
		pathname !== "/eurolabs" &&
		pathname !== "/eurolabs/"
	) {
		return next();
	}

	const target = new URL("/EuroLabs/", context.url);
	target.search = search;
	return redirect(target, 301);
});

const trailingSlashRedirect = defineMiddleware((context, next) => {
	if (context.request.method !== "GET" && context.request.method !== "HEAD") {
		return next();
	}

	const { pathname, search } = context.url;
	if (pathname === "/" || pathname.endsWith("/")) {
		return next();
	}

	const lastSegment = pathname.split("/").pop() ?? "";
	if (lastSegment.includes(".")) {
		return next();
	}

	const target = new URL(`${pathname}/`, context.url);
	target.search = search;
	return redirect(target, 308);
});

export const onRequest = sequence(
	agentDiscoveryHeader,
	cliDownloads,
	legacyBlogRedirect,
	sitemapAliasRedirect,
	euroLabsRedirect,
	trailingSlashRedirect,
	contentSignalHeader,
);
