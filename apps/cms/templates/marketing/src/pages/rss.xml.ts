import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { contentHref } from "../lib/content-url";
import { getPublicSiteUrl } from "../lib/site-url";

export const GET: APIRoute = async (context) => {
	const [{ entries: posts }, settings] = await Promise.all([
		getEmDashCollection("posts", {
			orderBy: { published_at: "desc" },
			limit: 50,
		}),
		getSiteSettings(),
	]);

	const siteTitle = settings?.title ?? context.locals.org.siteTitle;
	const siteUrl = settings?.url?.replace(/\/+$/, "") ?? getPublicSiteUrl();

	const items = posts.map(async (post) => {
		const pubDate = post.data.publishedAt;
		const slug = post.data.slug ?? post.id;
		const postUrl = await contentHref("posts", slug);
		return `    <item>
      <title><![CDATA[${post.data.title ?? "Untitled"}]]></title>
      <link>${postUrl}</link>
      <guid isPermaLink="true">${postUrl}</guid>
      ${post.data.excerpt ? `<description><![CDATA[${post.data.excerpt}]]></description>` : ""}
      ${pubDate ? `<pubDate>${pubDate.toUTCString()}</pubDate>` : ""}
    </item>`;
	});
	const renderedItems = (await Promise.all(items)).join("\n");

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${siteTitle}</title>
    <link>${siteUrl}</link>
    <description>${siteTitle} RSS Feed</description>
    <atom:link href="${siteUrl}/rss.xml" rel="self" type="application/rss+xml" />
${renderedItems}
  </channel>
</rss>`;

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};
