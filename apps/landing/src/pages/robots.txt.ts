import type { APIRoute } from "astro";
import { buildPublicRobotsTxt } from "../lib/robots";

/**
 * Custom robots.txt optimized for GEO/AEO visibility.
 *
 * Allows AI crawlers that drive citation and discovery (ChatGPT, Claude, Perplexity,
 * Google AI Overviews). Blocks training-only scrapers that extract content without
 * attribution. Also allows Cloudflare's AI Search crawler for our own indexing.
 *
 * @see docs/domains/geo.md — AI crawler access requirements
 */
const TEDIX_BASE_DOMAINS = ["tedix.dev"];

export const GET: APIRoute = ({ request, locals }) => {
	// Use the resolved hostname (from Host header via middleware) so a tenant's
	// custom domain gets its own sitemap URL, not the zone origin (tedix.dev).
	const requestUrl = new URL(request.url);
	const hostname =
		((locals as unknown as Record<string, unknown>).hostname as
			| string
			| undefined) ?? requestUrl.hostname;
	const origin = `https://${hostname}`;
	const sitemapURL = new URL("sitemap-index.xml", origin);

	// Cross-reference the Emdash blog sitemap on tedix base domains only.
	// The CMS serves published articles on the canonical apex domain.
	const isTedixBase = TEDIX_BASE_DOMAINS.some(
		(d) => hostname === d || hostname === `www.${d}`,
	);
	const blogSitemapURL = isTedixBase
		? "https://tedix.dev/sitemap-posts.xml"
		: undefined;

	return new Response(buildPublicRobotsTxt(sitemapURL, blogSitemapURL), {
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
};
