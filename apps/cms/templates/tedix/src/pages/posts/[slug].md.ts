import type { APIRoute } from "astro";
import { decodeSlug } from "emdash";
import { env as workerEnv } from "cloudflare:workers";
import { renderPostMarkdown } from "../../lib/post-markdown";

export const GET: APIRoute = async ({ params, originPathname, url }) => {
	const slug = decodeSlug(params.slug);
	if (!slug) return new Response("Not Found", { status: 404 });
	const originalPath = originPathname ?? url.pathname;
	const publicPathPrefixRaw =
		(workerEnv as Record<string, string | undefined>).PUBLIC_PATH_PREFIX ?? "";
	const publicPathPrefix = publicPathPrefixRaw
		.trim()
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
	const localePath =
		publicPathPrefix && originalPath.startsWith(`${publicPathPrefix}/`)
			? originalPath.slice(publicPathPrefix.length)
			: originalPath;
	const locale = /^\/(en|de|es|fr|it|pt|nl)(?:\/|$)/.exec(localePath)?.[1];
	return renderPostMarkdown(slug, locale);
};
