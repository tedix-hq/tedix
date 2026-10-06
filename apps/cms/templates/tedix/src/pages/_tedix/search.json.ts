import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getPluginSettings, search } from "emdash";
import { contentPath } from "../../lib/content-url";
import { getPublicSiteUrl } from "../../lib/site-url";
import { readHomepagePolicy } from "../../lib/tedix-home-validation";

export const prerender = false;

/** Public URL projection over native published search; never accepts draft status. */
export const GET: APIRoute = async ({ url, locals }) => {
	const query = url.searchParams.get("q")?.trim() ?? "";
	const collections = url.searchParams
		.get("collections")
		?.split(",")
		.map((value) => value.trim());
	const locale = url.searchParams.get("locale") ?? undefined;
	const limit = Number(url.searchParams.get("limit") ?? 10);
	if (
		!query ||
		query.length > 160 ||
		[...url.searchParams.keys()].some(
			(key) => !["q", "collections", "locale", "limit"].includes(key),
		) ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		(collections !== undefined &&
			(collections.length > 20 ||
				collections.some((value) => !/^[a-z][a-z0-9_]{0,63}$/.test(value)))) ||
		(locale !== undefined && !/^[a-zA-Z0-9-]{1,35}$/.test(locale))
	)
		return Response.json(
			{
				error:
					"Provide a published query of 1-160 characters, valid collections/locale, and a limit of 1-100.",
			},
			{ status: 400 },
		);
	try {
		// Anonymous public middleware intentionally omits db; native search()
		// resolves the configured request database itself.
		await locals.emdash?.ensureSearchHealthy?.();
		const result = await search(query, {
			status: "published",
			limit,
			...(collections ? { collections } : {}),
			...(locale ? { locale } : {}),
		});
		const policy = readHomepagePolicy(
			(await getPluginSettings("tedix-homepage-policy")).policy,
		);
		const defaultLocale =
			(env as { DEFAULT_LOCALE?: string }).DEFAULT_LOCALE || "en";
		const prefix = (
			(env as { PUBLIC_PATH_PREFIX?: string }).PUBLIC_PATH_PREFIX ?? ""
		).replace(/\/+$/, "");
		const origin = getPublicSiteUrl();
		const items = await Promise.all(
			result.items.map(async (item) => {
				const localePrefix =
					item.locale && item.locale !== defaultLocale
						? `/${encodeURIComponent(item.locale)}`
						: "";
				const isHomepage =
					item.collection === policy.collection &&
					item.slug &&
					policy.slugs.includes(item.slug);
				const contentRoute = isHomepage
					? "/"
					: await contentPath(item.collection, item.slug ?? item.id);
				// Collection patterns may already include the public mount. Locale belongs
				// inside that mount so results remain on the tenant's routed surface.
				const unmountedRoute =
					prefix &&
					(contentRoute === prefix || contentRoute.startsWith(`${prefix}/`))
						? contentRoute.slice(prefix.length) || "/"
						: contentRoute;
				const path = `${prefix}${localePrefix}${unmountedRoute}`;
				return {
					collection: item.collection,
					id: item.id,
					slug: item.slug,
					locale: item.locale,
					title: item.title ?? item.slug ?? item.id,
					url: new URL(path, origin).href,
					...(item.snippet ? { snippet: item.snippet } : {}),
				};
			}),
		);
		return Response.json(
			{ data: { items } },
			{ headers: { "Cache-Control": "no-store" } },
		);
	} catch (error) {
		console.error("[tedix-search] Published search failed", error);
		return Response.json(
			{ error: "Published search is unavailable." },
			{ status: 503 },
		);
	}
};
