import { env as workerEnv } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { t } from "../i18n/strings";
import { contentMarkdownHref } from "../lib/content-url";
import { getPublicSiteUrl } from "../lib/site-url";

function publicDiscoveryUrl(file: "rss.xml" | "sitemap.xml") {
	const origin = getPublicSiteUrl().replace(/\/+$/, "");
	const prefixRaw =
		(workerEnv as Record<string, string | undefined>).PUBLIC_PATH_PREFIX ?? "";
	const prefix = prefixRaw
		.trim()
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
	const publicPrefix = prefix && prefix !== "/" ? prefix : "";
	return `${origin}${publicPrefix}/${file}`;
}

// Emdash owns sitemap.xml natively. llms.txt still needs the same locale
// rationale: without article
// listings is functionally useless to LLM crawlers — getEmDashCollection
// must query the org's actual content locale, not Astro's platform-wide
// default.
export const GET: APIRoute = async (context) => {
	const orgLocale =
		(workerEnv as Record<string, string | undefined>).DEFAULT_LOCALE ?? "en";
	const [{ entries: posts }, settings] = await Promise.all([
		getEmDashCollection("posts", {
			orderBy: { published_at: "desc" },
			limit: 200,
			locale: orgLocale,
			status: "published",
		}),
		getSiteSettings(),
	]);

	const siteTitle = settings?.title ?? context.locals.org.siteTitle;

	const lines: string[] = [
		`# ${siteTitle}`,
		"",
		`## ${t("articles", orgLocale)}`,
		"",
	];
	for (const p of posts) {
		const title = p.data.title ?? "Untitled";
		const slug = p.data.slug ?? p.id;
		const excerpt = (p.data.excerpt ?? "").replace(/\s+/g, " ").trim();
		lines.push(
			`- [${title}](${await contentMarkdownHref("posts", slug, { locale: orgLocale, defaultLocale: orgLocale })})${excerpt ? `: ${excerpt}` : ""}`,
		);
	}
	lines.push("", "## Optional", "");
	lines.push(`- [Sitemap](${publicDiscoveryUrl("sitemap.xml")}): All URLs`);
	lines.push(`- [RSS feed](${publicDiscoveryUrl("rss.xml")}): Latest posts`);

	return new Response(`${lines.join("\n")}\n`, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=300, s-maxage=3600",
		},
	});
};
