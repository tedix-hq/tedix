import { env as workerEnv } from "cloudflare:workers";
import { getEmDashEntry, getSeoMeta } from "emdash";
import { contentMarkdownHref, contentPath } from "./content-url";
import {
	type MediaLike,
	portableToMarkdown,
	resolveMediaUrl,
} from "./portable-content";
import { getPublicSiteUrl } from "./site-url";

const yamlScalar = (s: string) => {
	if (/[:\-#@&*!|>'"%`?,[\]{}]/.test(s) || /^\s|\s$/.test(s)) {
		return `"${s.replace(/"/g, '\\"')}"`;
	}
	return s;
};

export async function renderPostMarkdown(
	slug: string,
	requestedLocale?: string,
): Promise<Response> {
	const orgLocale =
		(workerEnv as Record<string, string | undefined>).DEFAULT_LOCALE ?? "en";
	const locale = requestedLocale ?? orgLocale;
	const { entry: post } = await getEmDashEntry("posts", slug, {
		locale,
	});
	if (!post) return new Response("Not Found", { status: 404 });

	const tags = post.data.terms?.tag ?? [];
	const categories = post.data.terms?.category ?? [];

	const publicSiteUrl = getPublicSiteUrl();
	const blocks = Array.isArray(post.data.content) ? post.data.content : [];
	const body = portableToMarkdown(blocks, {
		origin: publicSiteUrl,
		faqHeading:
			locale === "de"
				? "Häufig gestellte Fragen"
				: "Frequently Asked Questions",
	});
	const canonicalPath = await contentPath("posts", slug, {
		locale,
		defaultLocale: orgLocale,
	});
	const seo = getSeoMeta(post, {
		siteUrl: publicSiteUrl,
		path: canonicalPath,
	});
	const canonicalMarkdownHref = await contentMarkdownHref("posts", slug, {
		locale,
		defaultLocale: orgLocale,
	});

	const fm: string[] = ["---"];
	const postRecord = post.data as unknown as Record<string, unknown>;
	fm.push(`title: ${yamlScalar(seo.ogTitle || post.data.title || "Untitled")}`);
	if (seo.description) fm.push(`description: ${yamlScalar(seo.description)}`);
	if (post.data.publishedAt)
		fm.push(`published: ${post.data.publishedAt.toISOString()}`);
	if (post.data.updatedAt)
		fm.push(`updated: ${post.data.updatedAt.toISOString()}`);
	const byline = post.data.bylines?.[0]?.byline;
	if (byline?.displayName) fm.push(`author: ${yamlScalar(byline.displayName)}`);
	const readingTime = postRecord.reading_time;
	if (typeof readingTime === "number" || typeof readingTime === "string")
		fm.push(`reading_time: ${readingTime}`);
	const featuredImage = resolveMediaUrl(
		postRecord.featured_image as MediaLike,
		publicSiteUrl,
	);
	if (featuredImage) fm.push(`image: ${yamlScalar(featuredImage)}`);
	if (categories.length > 0)
		fm.push(
			`categories: [${categories.map((c) => yamlScalar(c.label)).join(", ")}]`,
		);
	if (tags.length > 0)
		fm.push(`tags: [${tags.map((t) => yamlScalar(t.label)).join(", ")}]`);
	if (seo.canonical) fm.push(`canonical: ${seo.canonical}`);
	fm.push(`markdown: ${yamlScalar(canonicalMarkdownHref)}`);
	fm.push("---", "");

	return new Response(`${fm.join("\n")}${body}\n`, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=300, s-maxage=3600",
			"X-Robots-Tag": "all",
		},
	});
}
