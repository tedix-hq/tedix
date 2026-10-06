import { env as workerEnv } from "cloudflare:workers";
import type { APIRoute } from "astro";
import {
	getEmDashCollection,
	getEmDashEntry,
	getI18nConfig,
	getSiteSettings,
} from "emdash";
import { t } from "../i18n/strings";
import {
	collectionIndexHref,
	contentHref,
	contentMarkdownHref,
} from "../lib/content-url";
import { getPublicSiteUrl } from "../lib/site-url";

function publicDiscoveryUrl(file: "rss.xml" | "sitemap.xml") {
	const origin = getPublicSiteUrl().replace(/\/+$/, "");
	const prefixRaw =
		(workerEnv as unknown as Record<string, string | undefined>)
			.PUBLIC_PATH_PREFIX ?? "";
	const prefix = prefixRaw
		.trim()
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
	const publicPrefix = prefix && prefix !== "/" ? prefix : "";
	return `${origin}${publicPrefix}/${file}`;
}

function textField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isIndexable(data: Record<string, unknown>): boolean {
	const seo = data.seo;
	return !(
		seo &&
		typeof seo === "object" &&
		"noIndex" in seo &&
		seo.noIndex === true
	);
}

// tedix.dev retains the final apps/landing discovery overview. Other marketing
// tenants continue to generate their own published page and article index.
const TEDIX_ARCHIVED_LLMS =
	"# Tedix\n\n> Tedix is a platform for autonomous digital workers (tedis) that build AI-powered apps, create content, and operate infrastructure end-to-end.\n\nTedix enables businesses to deploy AI-native experiences across ChatGPT, Claude, and other AI platforms. Each customer gets a tedi — an autonomous AI worker that learns the business, generates AEO-optimized content, and operates MCP apps.\n\n## Blog\n\n- [Blog](https://blog.tedix.dev/posts/): Latest articles and insights\n- [Full article index with AI-readable content](https://blog.tedix.dev/llms.txt)\n\n## Platform\n\n- [Tedix Homepage](https://tedix.dev): AI That Learns Your Business\n- [AI App Directory](https://tedix.dev/apps): Browse AI apps across ChatGPT, Claude, and more\n- [Public REST API catalog](https://api.tedix.dev/openapi.json): Canonical OpenAPI 3.1 description\n- [Public REST API reference](https://api.tedix.dev/docs): Human-readable Scalar reference\n- [Contact](https://tedix.dev/contact): Get in touch\n\n## MCP Apps\n\n- [Tedix MCP Server](https://tedix.mcp.tedix.dev): Platform administration and management tools\n- Each customer app has its own MCP server at {slug}.mcp.tedix.dev with domain-specific tools";

// Emdash owns sitemap.xml natively. Query each configured locale explicitly:
// getEmDashCollection otherwise resolves to the current request/default locale.
export const GET: APIRoute = async (context) => {
	if (new URL(getPublicSiteUrl()).hostname === "tedix.dev") {
		return new Response(TEDIX_ARCHIVED_LLMS, {
			headers: {
				"Content-Type": "text/markdown; charset=utf-8",
				"Cache-Control": "public, max-age=3600",
			},
		});
	}
	const orgLocale =
		(workerEnv as unknown as Record<string, string | undefined>)
			.DEFAULT_LOCALE ??
		getI18nConfig()?.defaultLocale ??
		"en";
	const locales = [
		...new Set([orgLocale, ...(getI18nConfig()?.locales ?? [])]),
	];
	const [contentByLocale, settings] = await Promise.all([
		Promise.all(
			locales.map(async (locale) => {
				const [
					{ entries: posts, error: postsError },
					{ entries: pages, error: pagesError },
				] = await Promise.all([
					getEmDashCollection("posts", {
						orderBy: { published_at: "desc" },
						limit: 200,
						locale,
						status: "published",
					}),
					getEmDashCollection("pages", {
						limit: 200,
						locale,
						status: "published",
					}),
				]);
				if (postsError || pagesError) {
					throw postsError ?? pagesError;
				}
				// Collection listings omit the separate native SEO row. Resolve each
				// published entry before deciding whether crawlers should see it.
				const [postDetails, pageDetails] = await Promise.all([
					Promise.all(
						posts.map(async (post) => {
							const id =
								textField(post.data.id) ?? textField(post.data.slug) ?? post.id;
							const result = await getEmDashEntry("posts", id, { locale });
							if (result.error) throw result.error;
							return result.entry;
						}),
					),
					Promise.all(
						pages.map(async (page) => {
							const id =
								textField(page.data.id) ?? textField(page.data.slug) ?? page.id;
							const result = await getEmDashEntry("pages", id, { locale });
							if (result.error) throw result.error;
							return result.entry;
						}),
					),
				]);
				return {
					locale,
					posts: postDetails.filter(
						(post): post is NonNullable<typeof post> =>
							post !== null && isIndexable(post.data),
					),
					pages: pageDetails.filter(
						(page): page is NonNullable<typeof page> =>
							page !== null && isIndexable(page.data),
					),
				};
			}),
		),
		getSiteSettings(),
	]);

	const siteTitle =
		settings?.title ??
		(context.locals as { org?: { siteTitle?: string } }).org?.siteTitle ??
		"Site";

	const lines: string[] = [`# ${siteTitle}`, ""];
	if (settings?.tagline) lines.push(settings.tagline, "");
	for (const { locale, posts, pages } of contentByLocale) {
		if (pages.length) {
			lines.push(`## Pages (${locale})`, "");
			for (const page of pages) {
				const slug = textField(page.data.slug) ?? page.id;
				const href =
					slug === "home"
						? `${getPublicSiteUrl()}/${locale === orgLocale ? "" : `${locale}/`}`
						: await contentHref("pages", slug, {
								locale,
								defaultLocale: orgLocale,
							});
				lines.push(`- [${textField(page.data.title) ?? slug}](${href})`);
			}
			lines.push("");
		}
		if (posts.length) {
			lines.push(`## ${t("articles", locale)} (${locale})`, "");
			for (const post of posts) {
				const title = textField(post.data.title) ?? "Untitled";
				const slug = textField(post.data.slug) ?? post.id;
				const excerpt = (textField(post.data.excerpt) ?? "")
					.replace(/\s+/g, " ")
					.trim();
				lines.push(
					`- [${title}](${await contentMarkdownHref("posts", slug, { locale, defaultLocale: orgLocale })})${excerpt ? `: ${excerpt}` : ""}`,
				);
			}
			lines.push("");
		}
	}
	lines.push("", "## Optional", "");
	for (const { locale, posts } of contentByLocale) {
		if (posts.length) {
			lines.push(
				`- [${t("articles", locale)} (${locale})](${await collectionIndexHref("posts", { locale, defaultLocale: orgLocale })}): Article index`,
			);
		}
	}
	lines.push(`- [Sitemap](${publicDiscoveryUrl("sitemap.xml")}): All URLs`);
	lines.push(`- [RSS feed](${publicDiscoveryUrl("rss.xml")}): Latest posts`);

	return new Response(`${lines.join("\n")}\n`, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=300, s-maxage=3600",
		},
	});
};
