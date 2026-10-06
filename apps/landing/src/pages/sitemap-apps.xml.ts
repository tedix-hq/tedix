/**
 * Dynamic Sitemap for App Catalog
 *
 * Generates a sitemap listing all app pages for SEO.
 * Paginates through the full catalog to capture every published app.
 * URL: /sitemap-apps.xml
 */

import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getCatalogClient } from "../lib/api";

/**
 * Never answer 200 with an empty catalog. `/apps/*` is the overwhelming
 * majority of this property's indexed pages, so a successful-looking sitemap
 * with zero URLs tells Google the catalog no longer exists — where a 5xx makes
 * it retry and keep the last good copy, and shows up as a sitemap error in
 * Search Console instead of silently reporting zero coverage.
 */
function catalogUnavailable(): Response {
	return new Response("<!-- catalog unavailable; retry later -->", {
		status: 503,
		headers: {
			"Content-Type": "application/xml",
			"Cache-Control": "no-store",
			"Retry-After": "600",
		},
	});
}

export const GET: APIRoute = async () => {
	const client = getCatalogClient(env);
	const baseUrl = (import.meta.env.SITE || "https://tedix.dev").replace(
		/\/$/,
		"",
	);

	const slugs: string[] = [];

	try {
		let offset = 0;
		const limit = 200;
		let hasMore = true;

		while (hasMore) {
			const result = await client.catalog.list({
				limit,
				offset,
			});

			const newSlugs = (result.apps || [])
				.filter(
					(app) => app.slug && app.connectorType !== "FIRST_PARTY_ECOSYSTEM",
				)
				.map((app) => app.slug as string);

			slugs.push(...newSlugs);
			hasMore = result.pagination?.hasMore ?? false;
			offset += limit;
		}
	} catch (error) {
		console.error("[Sitemap] Failed to fetch apps:", error);

		// Serve the pages collected before the failure; only give up entirely
		// when the very first page failed and there is nothing to publish.
		if (slugs.length === 0) {
			return catalogUnavailable();
		}
	}

	if (slugs.length === 0) {
		console.error("[Sitemap] Catalog returned zero apps");
		return catalogUnavailable();
	}

	const now = new Date().toISOString().split("T")[0];

	const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/apps/</loc>
    <changefreq>daily</changefreq>
    <priority>0.8</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${baseUrl}/apps/insights/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
    <lastmod>${now}</lastmod>
  </url>
${slugs
	.map(
		(slug) => `  <url>
    <loc>${baseUrl}/apps/${slug}/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.5</priority>
  </url>`,
	)
	.join("\n")}
</urlset>`;

	return new Response(sitemap.trim(), {
		status: 200,
		headers: {
			"Content-Type": "application/xml",
			"Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
		},
	});
};
