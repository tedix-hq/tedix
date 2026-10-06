import type { APIRoute } from "astro";
import {
	getHomeAlternateLinks,
	localizeHomePath,
	supportedLocaleCodes,
} from "../i18n/content";

const TEDIX_BASE_DOMAINS = ["tedix.dev"];

function isTedixBaseDomain(hostname: string): boolean {
	return TEDIX_BASE_DOMAINS.some(
		(domain) => hostname === domain || hostname === `www.${domain}`,
	);
}

/**
 * Standalone routes that are indexable but are not the localized home page and
 * not part of the app catalog, so nothing else would list them.
 *
 * Deliberately excluded: `/onepager/`, `/linktree/`, `/aaron-linktree/`,
 * `/adriana-linktree/` and `/EuroLabs/` (share targets, not search landing
 * pages), `/waitlist/` (redirects to app login) and `/tedixpay-demo/`
 * (301s to `/tedixpay/`). Paths carry the trailing slash the site redirects to.
 */
const STATIC_PAGES: { path: string; priority: string; changefreq: string }[] = [
	{ path: "/tedixpay/", priority: "0.8", changefreq: "weekly" },
	{ path: "/skills-over-mcp/", priority: "0.7", changefreq: "weekly" },
	{ path: "/contact/", priority: "0.6", changefreq: "monthly" },
	{ path: "/imprint/", priority: "0.3", changefreq: "yearly" },
	{ path: "/privacy/", priority: "0.3", changefreq: "yearly" },
	{ path: "/terms/", priority: "0.3", changefreq: "yearly" },
	{ path: "/cookies/", priority: "0.3", changefreq: "yearly" },
];

export const GET: APIRoute = ({ request }) => {
	const url = new URL(request.url);
	const baseUrl = url.origin;
	const now = new Date().toISOString().split("T")[0];

	if (!isTedixBaseDomain(url.hostname)) {
		return new Response("", {
			status: 404,
			headers: { "Content-Type": "application/xml" },
		});
	}

	const alternateLinks = getHomeAlternateLinks(new URL(baseUrl));
	const entries = supportedLocaleCodes
		.map((locale) => {
			const loc = new URL(localizeHomePath(locale), baseUrl).toString();
			const alternates = alternateLinks
				.map(
					(link) => `
    <xhtml:link rel="alternate" hreflang="${link.hreflang}" href="${link.href}" />`,
				)
				.join("");

			return `
  <url>
    <loc>${loc}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${locale === "en" ? "1.0" : "0.9"}</priority>${alternates}
  </url>`;
		})
		.join("");

	const staticEntries = STATIC_PAGES.map(
		({ path, priority, changefreq }) => `
  <url>
    <loc>${new URL(path, baseUrl).toString()}</loc>
    <lastmod>${now}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`,
	).join("");

	const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries}${staticEntries}
</urlset>`;

	return new Response(sitemap.trim(), {
		headers: {
			"Content-Type": "application/xml",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
