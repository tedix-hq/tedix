import type { APIRoute } from "astro";
import { decodeSlug, resolveEmDashPath } from "emdash";
import { env as workerEnv } from "cloudflare:workers";
import { renderPostMarkdown } from "../lib/post-markdown";

export const GET: APIRoute = async ({ params }) => {
	const rawPath = params.path;
	if (!rawPath) return new Response("Not Found", { status: 404 });
	const locale = /^(en|de|es|fr|it|pt|nl)(?:\/|$)/.exec(rawPath)?.[1];
	const defaultLocale =
		(workerEnv as Record<string, string | undefined>).DEFAULT_LOCALE ?? "en";
	if (locale === defaultLocale)
		return new Response("Not Found", { status: 404 });
	const collectionPath = locale ? rawPath.slice(locale.length + 1) : rawPath;
	// Astro selects this catchall before a dynamic /[locale]/posts/[slug].md
	// route. Resolve the conventional post path directly; native custom patterns
	// continue through Emdash's collection URL resolver below.
	const conventionalPost = /^posts\/([^/]+?)(?:\.md)?$/i.exec(collectionPath);
	if (conventionalPost) {
		const slug = decodeSlug(conventionalPost[1]);
		return slug
			? renderPostMarkdown(slug, locale)
			: new Response("Not Found", { status: 404 });
	}
	const contentPath = collectionPath.replace(/\.md$/i, "");
	const lookupPaths = Array.from(
		new Set([
			`/${contentPath}`,
			`/${contentPath}`.replace(/\/+$/, "") || "/",
			`${`/${contentPath}`.replace(/\/+$/, "")}/`,
		]),
	);
	const resolved = (
		await Promise.all(lookupPaths.map((path) => resolveEmDashPath(path)))
	).find((candidate) => candidate?.collection === "posts");
	if (resolved?.collection !== "posts") {
		return new Response("Not Found", { status: 404 });
	}
	const slug = resolved.params.slug ?? resolved.entry.id;
	return renderPostMarkdown(slug, locale);
};
