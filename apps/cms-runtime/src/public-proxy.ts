import { isMarketingHost, type MarketingEnv } from "./marketing";
import { createDbClient, type DbClient } from "@tedix/db/client";
import {
	getCmsSiteByActiveWwwAlias,
	getCmsSiteByHostname,
	getCmsSiteBySlug,
} from "@tedix/db/queries/cms-sites";
import {
	buildSurfaceUrl,
	platformDomainForEnvironment,
	resolveSurfaceTenant,
} from "@tedix/tenant-directory";
import { normalizeWebMcpToolPacks, type WebMcpToolPack } from "./webmcp";
import { type Env } from "./env";
// ── Drizzle client (per-isolate; D1 binding rebound per request) ──

let cachedDb: DbClient | null = null;
let cachedDbBinding: D1Database | null = null;
export function getDb(d1: D1Database): DbClient {
	if (cachedDbBinding !== d1 || !cachedDb) {
		cachedDb = createDbClient(d1);
		cachedDbBinding = d1;
	}
	return cachedDb;
}

// ── Hostname → slug ───────────────────────────────────────────────

/** Grammar, environment domains, and slug rules come from tenant-directory. */
function extractSlug(hostname: string, environment: string): string | null {
	const resolved = resolveSurfaceTenant(hostname, {
		platformDomain: platformDomainForEnvironment(environment),
		expectedSurface: "cms",
	});
	return resolved.kind === "tenant" ? resolved.slug : null;
}

export async function resolveSlug(
	env: Env,
	hostname: string,
): Promise<{ slug: string; customDomain: boolean } | null> {
	if (env.MARKETING_SITE_SLUG && isMarketingHost(hostname, env))
		return { slug: env.MARKETING_SITE_SLUG, customDomain: false };
	const slug = extractSlug(hostname, env.ENVIRONMENT);
	if (slug) return { slug, customDomain: false };

	// Every custom-domain request reads the active mapping. A cached hit could
	// continue serving a removed hostname, or serve the previous tenant after a
	// domain transfer.
	const db = getDb(env.PLATFORM_DB);
	const site = await getCmsSiteByHostname(db, hostname);
	return site ? { slug: site.slug, customDomain: true } : null;
}

/** A companion hostname redirects public pages only; editor and service paths
 * must never gain tenant routing authority from the alias. */
export function isWwwCompanionPublicPath(pathname: string): boolean {
	let path: string;
	try {
		path = decodeURIComponent(pathname).toLowerCase();
	} catch {
		return false;
	}
	if (path.startsWith("/_")) return false;
	return ![
		"/.well-known",
		"/admin",
		"/api",
		"/auth",
		"/callback",
		"/login",
		"/logout",
		"/mcp",
		"/oauth",
		"/session",
		"/signin",
		"/signup",
	].some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export async function wwwCompanionRedirect(
	request: Request,
	url: URL,
	env: Env,
	knownSite?: Awaited<ReturnType<typeof getCmsSiteByActiveWwwAlias>>,
): Promise<Response | null> {
	if (
		(request.method !== "GET" && request.method !== "HEAD") ||
		!url.hostname.startsWith("www.") ||
		!isWwwCompanionPublicPath(url.pathname)
	)
		return null;
	// The query checks the active companion, site, and canonical apex in D1 on
	// every request. A removed or transferred alias must stop redirecting now.
	const site =
		knownSite === undefined
			? await getCmsSiteByActiveWwwAlias(getDb(env.PLATFORM_DB), url.hostname)
			: knownSite;
	if (!site?.customDomain) return null;
	const target = new URL(`https://${site.customDomain}`);
	target.pathname = url.pathname;
	target.search = url.search;
	return Response.redirect(target, 301);
}

// ── Org lookup (platform D1) ──────────────────────────────────────

export interface OrgInfo {
	slug: string;
	siteId: string;
	templateSlug: string;
	r2BucketName: string;
	siteTitle: string;
	/**
	 * Per-org branding (logo, palette, fonts, social URLs) auto-extracted at
	 * app creation and editable in the dashboard. Serialized JSON injected
	 * into the tenant isolate; the SEO plugin + theme read it for sameAs,
	 * twitter handle, logo URL, etc. — without per-org content backfill.
	 */
	brandingJson: string | null;
	socialJson: string | null;
	/**
	 * Descope tenant used for CMS admin authentication.
	 *
	 * Defaults to the app owner's tenant, but can be overridden through
	 * metadata.blogConfig.authDescopeTenantId for customer-owned editorial access.
	 */
	descopeTenantId: string;
	/** Explicit platform-D1 marker for the immutable assertion-aware bundle. */
	humanAssertionBundleEtag: string | null;
	/** Custom public hostname (e.g. "blog.tedix.dev") used for routing lookup. */
	cmsDomain: string | null;
	/**
	 * Public origin/base URL. Collection paths are owned by native Emdash
	 * urlPattern, so reverse-proxy prefixes such as /ratgeber should be modeled
	 * on the collection, not encoded into this base URL.
	 * Falls back to the cms.tedix.dev URL when unset.
	 */
	publicSiteUrl: string;
	/**
	 * Optional public mount path used by customer reverse proxies. This is not
	 * part of Emdash siteUrl; it lets the edge adapt infrastructure URLs and
	 * prefix-stripping proxy requests while collection urlPattern remains the
	 * canonical content-routing source.
	 */
	publicPathPrefix: string | null;
	/** Read-only public WebMCP packs enabled for this tenant. */
	webMcpToolPacks: readonly WebMcpToolPack[];
	/** Per-org default locale; tenant middleware redirects root-locale paths
	 * to `/{locale}/...` when this is set to a non-default locale. */
	defaultLocale: string | null;
}

const orgCache = new Map<string, { info: OrgInfo | null; expiresAt: number }>();
const ORG_TTL_MS = 5 * 60 * 1000;
export const HOT_THEME_PUBLIC_PATH = "/_tedix/theme.css";

export function hotThemeCssKey(slug: string): string {
	return `hot-themes/${slug}/current.css`;
}

export function hotThemeManifestKey(slug: string): string {
	return `hot-themes/${slug}/manifest.json`;
}

function publicHostFrom(publicSiteUrl: string): string | null {
	try {
		return new URL(publicSiteUrl).host;
	} catch {
		return null;
	}
}

export function publicOriginFrom(publicSiteUrl: string): string | null {
	try {
		return new URL(publicSiteUrl).origin;
	} catch {
		return null;
	}
}

function normalizePublicPathPrefix(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (!trimmed || trimmed === "/") return null;
	const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	const normalized = withLeadingSlash
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "");
	if (normalized === "/" || normalized.includes("..")) return null;
	return normalized;
}

function publicPathPrefixFromOrg(org: OrgInfo): string | null {
	return org.publicPathPrefix;
}

function isPublicInfrastructurePath(pathname: string): boolean {
	return (
		pathname.startsWith("/_astro/") ||
		pathname.startsWith("/_emdash/") ||
		pathname.startsWith("/_tedix/") ||
		// Astro's default image-transform endpoint. Same category as /_astro/:
		// infrastructure, not user content, so it must not be prefix-rewritten
		// for reverse-proxied tenants — the parent-level interception in
		// imageTransformResponse() checks the unprefixed pathname.
		pathname === "/_image" ||
		pathname.startsWith("/api/") ||
		pathname === "/favicon.ico" ||
		pathname === "/robots.txt" ||
		pathname === "/rss.xml" ||
		pathname === "/llms.txt" ||
		pathname === "/sitemap.xml" ||
		/^\/sitemap-[^/]+\.xml$/.test(pathname)
	);
}

/**
 * Emdash (0.31.x) emits sitemap URLs without a trailing slash while every page
 * it renders declares the trailing-slash form as its canonical. Search Console
 * then reads the whole sitemap as non-canonical — blog.tedix.dev sat at 13
 * submitted / 0 indexed and reported "Page with redirect" against exactly these
 * URLs. Normalise the sitemap to the canonical form the pages advertise.
 *
 * Marketing-template CMS tenants use slashless canonical paths, except for
 * tedix-landing on tedix.dev, whose archived landing pages use trailing slashes.
 * Only extensionless paths are touched, so `/rss.xml` and asset URLs are left
 * alone, and only inside a sitemap document.
 */
export function canonicalizeSitemapUrls(
	xml: string,
	trailingSlash = true,
	nativeCanonicals = false,
): string {
	// Canonical-aware Emdash owns each entry URL, including mixed slash conventions.
	if (nativeCanonicals) return xml;
	if (!xml.includes("<urlset") && !xml.includes("<sitemapindex")) return xml;

	const withTrailingSlash = (rawUrl: string): string => {
		let url: URL;
		try {
			url = new URL(rawUrl);
		} catch {
			return rawUrl;
		}
		if (!trailingSlash) {
			url.pathname = url.pathname.replace(/\/+$/, "") || "/";
			return url.toString();
		}
		// authz: public — not a route: sitemap <loc> trailing-slash rewrite helper.
		if (url.pathname.endsWith("/")) return rawUrl;
		const lastSegment = url.pathname.split("/").pop() ?? "";
		if (lastSegment === "" || lastSegment.includes(".")) return rawUrl;
		url.pathname = `${url.pathname}/`;
		return url.toString();
	};

	return xml
		.replace(
			/<loc>([^<]+)<\/loc>/g,
			(_match, url: string) => `<loc>${withTrailingSlash(url.trim())}</loc>`,
		)
		.replace(
			/href="([^"]+)"/g,
			(_match, url: string) => `href="${withTrailingSlash(url.trim())}"`,
		);
}

/** The archived Tedix site is the one exception to marketing's slashless URLs. */
export function sitemapUsesTrailingSlash(
	site: Pick<OrgInfo, "slug" | "templateSlug" | "publicSiteUrl">,
	env: Pick<MarketingEnv, "MARKETING_DOMAINS">,
): boolean {
	const hostname = new URL(site.publicSiteUrl).hostname;
	if (site.slug === "tedix-landing" && hostname === "tedix.dev") return true;
	return site.templateSlug !== "marketing" && !isMarketingHost(hostname, env);
}

export function patchReverseProxyHtml(html: string, org: OrgInfo): string {
	const prefix = publicPathPrefixFromOrg(org);
	if (!prefix) return html;
	const publicOrigin = publicOriginFrom(org.publicSiteUrl);

	let patched = html
		.replaceAll('href="/"', `href="${prefix}/"`)
		.replaceAll("href='/'", `href='${prefix}/'`);

	for (const route of ["posts", "category", "tag"]) {
		const prefixedRoute =
			route === "posts" ? `${prefix}/` : `${prefix}/${route}/`;
		patched = patched
			.replaceAll(`href="/${route}/`, `href="${prefixedRoute}`)
			.replaceAll(`href='/${route}/`, `href='${prefixedRoute}`);
	}

	for (const file of ["rss.xml", "sitemap.xml", "llms.txt"]) {
		patched = patched
			.replaceAll(`href="/${file}`, `href="${prefix}/${file}`)
			.replaceAll(`href='/${file}`, `href='${prefix}/${file}`);
	}

	for (const assetPath of ["_astro", "_emdash/api/media", "_tedix"]) {
		patched = patched
			.replaceAll(`href="/${assetPath}/`, `href="${prefix}/${assetPath}/`)
			.replaceAll(`href='/${assetPath}/`, `href='${prefix}/${assetPath}/`)
			.replaceAll(`src="/${assetPath}/`, `src="${prefix}/${assetPath}/`)
			.replaceAll(`src='/${assetPath}/`, `src='${prefix}/${assetPath}/`)
			.replaceAll(`srcset="/${assetPath}/`, `srcset="${prefix}/${assetPath}/`)
			.replaceAll(`srcset='/${assetPath}/`, `srcset='${prefix}/${assetPath}/`)
			.replaceAll(
				`component-url="/${assetPath}/`,
				`component-url="${prefix}/${assetPath}/`,
			)
			.replaceAll(
				`component-url='/${assetPath}/`,
				`component-url='${prefix}/${assetPath}/`,
			)
			.replaceAll(
				`renderer-url="/${assetPath}/`,
				`renderer-url="${prefix}/${assetPath}/`,
			)
			.replaceAll(
				`renderer-url='/${assetPath}/`,
				`renderer-url='${prefix}/${assetPath}/`,
			)
			.replaceAll(`url("/${assetPath}/`, `url("${prefix}/${assetPath}/`)
			.replaceAll(`url('/${assetPath}/`, `url('${prefix}/${assetPath}/`);
		if (publicOrigin) {
			patched = patched
				.replaceAll(
					`${publicOrigin}/${assetPath}/`,
					`${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`href="${publicOrigin}/${assetPath}/`,
					`href="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`href='${publicOrigin}/${assetPath}/`,
					`href='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`src="${publicOrigin}/${assetPath}/`,
					`src="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`src='${publicOrigin}/${assetPath}/`,
					`src='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`srcset="${publicOrigin}/${assetPath}/`,
					`srcset="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`srcset='${publicOrigin}/${assetPath}/`,
					`srcset='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`component-url="${publicOrigin}/${assetPath}/`,
					`component-url="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`component-url='${publicOrigin}/${assetPath}/`,
					`component-url='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`renderer-url="${publicOrigin}/${assetPath}/`,
					`renderer-url="${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`renderer-url='${publicOrigin}/${assetPath}/`,
					`renderer-url='${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`url("${publicOrigin}/${assetPath}/`,
					`url("${publicOrigin}${prefix}/${assetPath}/`,
				)
				.replaceAll(
					`url('${publicOrigin}/${assetPath}/`,
					`url('${publicOrigin}${prefix}/${assetPath}/`,
				);
		}
	}

	// Astro's transform endpoint has a query immediately after its route.
	// Prefix only root-relative/public-origin references; leave already-prefixed
	// links and unrelated hostnames alone.
	patched = patched
		.replaceAll('="/_image?', `="${prefix}/_image?`)
		.replaceAll("='/_image?", `='${prefix}/_image?`)
		.replaceAll(" /_image?", ` ${prefix}/_image?`);
	if (publicOrigin)
		patched = patched.replaceAll(
			`${publicOrigin}/_image?`,
			`${publicOrigin}${prefix}/_image?`,
		);

	if (publicOrigin) {
		patched = patched
			.replaceAll(
				`rel="canonical" href="${publicOrigin}"`,
				`rel="canonical" href="${publicOrigin}${prefix}/"`,
			)
			.replaceAll(
				`rel='canonical' href='${publicOrigin}'`,
				`rel='canonical' href='${publicOrigin}${prefix}/'`,
			);
		for (const file of [
			"rss.xml",
			"sitemap.xml",
			"sitemap-posts.xml",
			"llms.txt",
		]) {
			patched = patched.replaceAll(
				`${publicOrigin}/${file}`,
				`${publicOrigin}${prefix}/${file}`,
			);
		}
		patched = patched
			.replaceAll(
				`${publicOrigin}/_emdash/admin`,
				`${publicOrigin}${prefix}/_emdash/admin`,
			)
			.replaceAll(
				'parsed.pathname.startsWith("/_emdash/admin")',
				`(parsed.pathname.startsWith("/_emdash/admin") || parsed.pathname.startsWith("${prefix}/_emdash/admin"))`,
			)
			.replaceAll(
				'new URL("/_emdash/admin", window.location.origin)',
				`new URL("${prefix}/_emdash/admin", window.location.origin)`,
			);
	}

	return patched;
}

export function ensureHotThemeLink(html: string): string {
	if (
		html.includes("data-tedix-hot-theme") ||
		html.includes(HOT_THEME_PUBLIC_PATH)
	) {
		return html;
	}
	return html.replace(
		/<\/head>/i,
		`\n\t\t<link rel="stylesheet" href="${HOT_THEME_PUBLIC_PATH}" data-tedix-hot-theme />\n$&`,
	);
}

export function patchReverseProxyLocation(
	location: string | null,
	org: OrgInfo,
): string | null {
	const prefix = publicPathPrefixFromOrg(org);
	const publicOrigin = publicOriginFrom(org.publicSiteUrl);
	const publicHost = publicHostFrom(org.publicSiteUrl);
	if (!location || !prefix || !publicOrigin || !publicHost) return location;

	const isRootRelativeLocation = location.startsWith("/");
	let target: URL;
	try {
		target = new URL(location, publicOrigin);
	} catch {
		return location;
	}

	// authz: public — not a route: redirect Location prefix rewrite helper.
	if (
		isRootRelativeLocation &&
		target.host === publicHost &&
		target.pathname.startsWith(`${prefix}/`) &&
		!target.pathname.startsWith(`${prefix}/_emdash/`)
	) {
		return target.toString();
	}

	if (target.host !== publicHost || target.pathname.startsWith(`${prefix}/`)) {
		return location;
	}

	const shouldPrefix =
		target.pathname === "/" ||
		target.pathname.startsWith("/_emdash/") ||
		target.pathname.startsWith("/_astro/") ||
		target.pathname.startsWith("/posts/") ||
		target.pathname.startsWith("/category/") ||
		target.pathname.startsWith("/tag/") ||
		["/rss.xml", "/sitemap.xml", "/llms.txt"].includes(target.pathname);

	if (!shouldPrefix) return location;

	// authz: public — not a route: redirect Location prefix rewrite helper.
	if (target.pathname === "/" || target.pathname === "/posts/") {
		target.pathname = `${prefix}/`;
	} else if (target.pathname.startsWith("/posts/")) {
		target.pathname = `${prefix}/${target.pathname.slice("/posts/".length)}`;
	} else {
		target.pathname = `${prefix}${target.pathname}`;
	}
	return target.toString();
}

function publicUrlFrom(publicSiteUrl: string): URL | null {
	try {
		return new URL(publicSiteUrl);
	} catch {
		return null;
	}
}

function hostMatchesPublicSite(
	request: Request,
	requestUrl: URL,
	org: OrgInfo,
): boolean {
	const publicHost = publicHostFrom(org.publicSiteUrl);
	if (!publicHost) return false;
	return (
		effectiveRequestHost(request, requestUrl.host).toLowerCase() === publicHost
	);
}

function pathMatchesPublicPrefix(requestUrl: URL, org: OrgInfo): boolean {
	const prefix = publicPathPrefixFromOrg(org);
	if (!prefix) return false;
	return (
		requestUrl.pathname === prefix ||
		requestUrl.pathname.startsWith(`${prefix}/`)
	);
}

function publicProxyRequest(
	request: Request,
	rewrittenUrl: URL,
	publicHost: string,
): Request {
	const headers = new Headers(request.headers);
	headers.set("X-Tedix-Public-Host", publicHost);
	return new Request(rewrittenUrl, {
		body: request.body,
		headers,
		method: request.method,
		redirect: request.redirect,
	});
}

export function normalizePublicProxyRequest(
	request: Request,
	requestUrl: URL,
	org: OrgInfo,
): { request: Request; url: URL } {
	const publicUrl = publicUrlFrom(org.publicSiteUrl);
	const prefix = publicPathPrefixFromOrg(org);
	const publicHostMatch =
		publicUrl !== null && hostMatchesPublicSite(request, requestUrl, org);
	if (
		!publicUrl ||
		(!publicHostMatch && !pathMatchesPublicPrefix(requestUrl, org))
	) {
		return { request, url: requestUrl };
	}

	const rewrittenUrl = new URL(requestUrl);
	rewrittenUrl.protocol = publicUrl.protocol;
	rewrittenUrl.host = publicUrl.host;

	if (!prefix)
		return {
			request: publicProxyRequest(request, rewrittenUrl, publicUrl.host),
			url: rewrittenUrl,
		};

	const hasPrefix =
		requestUrl.pathname === prefix ||
		requestUrl.pathname.startsWith(`${prefix}/`);

	if (
		publicHostMatch &&
		!hasPrefix &&
		!isPublicInfrastructurePath(requestUrl.pathname)
	) {
		if (requestUrl.pathname !== "/") {
			rewrittenUrl.pathname = `${prefix}${requestUrl.pathname}`;
		}
		return {
			request: publicProxyRequest(request, rewrittenUrl, publicUrl.host),
			url: rewrittenUrl,
		};
	}

	if (hasPrefix) {
		const unprefixedPath =
			requestUrl.pathname === prefix
				? "/"
				: requestUrl.pathname.slice(prefix.length) || "/";
		if (unprefixedPath !== "/" && isPublicInfrastructurePath(unprefixedPath)) {
			rewrittenUrl.pathname = unprefixedPath;
		}
	}
	return {
		request: publicProxyRequest(request, rewrittenUrl, publicUrl.host),
		url: rewrittenUrl,
	};
}

function shouldNoindexOrigin(requestHost: string, org: OrgInfo): boolean {
	const publicHost = publicHostFrom(org.publicSiteUrl);
	return publicHost !== null && requestHost !== publicHost;
}

export function canonicalPublicUrl(
	org: OrgInfo,
	pathname: string,
	search = "",
): string | null {
	const publicUrl = publicUrlFrom(org.publicSiteUrl);
	if (!publicUrl) return null;

	const target = new URL(publicUrl.origin);
	const prefix = publicPathPrefixFromOrg(org);
	let targetPath = pathname || "/";
	if (prefix) {
		if (targetPath === "/posts" || targetPath === "/posts/") {
			targetPath = `${prefix}/`;
		} else if (targetPath.startsWith("/posts/")) {
			const rest = targetPath
				.slice("/posts/".length)
				.replace(/^\/+/, "")
				.replace(/\/+$/, "");
			targetPath = rest ? `${prefix}/${rest}` : `${prefix}/`;
		}
		const hasPrefix =
			targetPath === prefix || targetPath.startsWith(`${prefix}/`);
		const shouldPrefix =
			!hasPrefix &&
			(targetPath === "/" ||
				targetPath.startsWith("/posts/") ||
				targetPath.startsWith("/category/") ||
				targetPath.startsWith("/tag/") ||
				[
					"/rss.xml",
					"/sitemap.xml",
					"/sitemap-posts.xml",
					"/llms.txt",
				].includes(targetPath));
		if (shouldPrefix) {
			targetPath = targetPath === "/" ? `${prefix}/` : `${prefix}${targetPath}`;
		}
	}
	target.pathname = targetPath;
	target.search = search;
	return target.toString();
}

export function shouldRedirectCmsOriginRequest(
	request: Request,
	requestUrl: URL,
	env: Env,
	org: OrgInfo,
): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	// Emdash validates _preview itself. Let its signed preview reach the tenant
	// origin, including `/`, before the public canonical redirect runs.
	if (requestUrl.searchParams.has("_preview")) return false;
	const requestHost = effectiveRequestHost(
		request,
		requestUrl.host,
	).toLowerCase();
	const publicHost = publicHostFrom(org.publicSiteUrl)?.toLowerCase();
	if (!publicHost || requestHost === publicHost) return false;
	return (
		extractSlug(requestUrl.hostname, env.ENVIRONMENT) !== null ||
		(isMarketingHost(requestUrl.hostname, env) &&
			org.slug === env.MARKETING_SITE_SLUG)
	);
}

/**
 * Tenant templates answer an unknown path with `Astro.redirect("/404")`. Serve
 * that page in place instead, so a missing URL returns a real 404 rather than
 * a 302 to a 404 page that crawlers and link checkers read as a redirect.
 */
export function isSoftNotFound(response: Response, request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	if (response.status < 300 || response.status >= 400) return false;
	const location = response.headers.get("location");
	if (!location) return false;
	const target = new URL(location, request.url);
	return (
		target.origin === new URL(request.url).origin && target.pathname === "/404"
	);
}

export function isOriginRedirectablePath(pathname: string): boolean {
	return (
		pathname === "/" ||
		pathname.startsWith("/posts/") ||
		pathname.startsWith("/category/") ||
		pathname.startsWith("/tag/") ||
		["/rss.xml", "/sitemap.xml", "/sitemap-posts.xml", "/llms.txt"].includes(
			pathname,
		)
	);
}

export function originRobotsResponse(org: OrgInfo): Response {
	const sitemapUrl = canonicalPublicUrl(org, "/sitemap.xml");
	const body = [
		"User-agent: *",
		"Disallow: /",
		sitemapUrl ? `Sitemap: ${sitemapUrl}` : null,
		"",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return new Response(body, {
		status: 200,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
			"X-Robots-Tag": "noindex, nofollow",
		},
	});
}

export function effectiveRequestHost(
	request: Request,
	fallbackHost: string,
): string {
	const tedixPublicHost = request.headers.get("X-Tedix-Public-Host");
	if (tedixPublicHost)
		return tedixPublicHost.split(",")[0]?.trim() || fallbackHost;

	return (
		request.headers.get("X-Forwarded-Host")?.split(",")[0]?.trim() ||
		request.headers.get("X-Original-Host")?.split(",")[0]?.trim() ||
		fallbackHost
	);
}

function imageContentTypeFromPath(pathname: string): string | null {
	const ext = pathname.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "svg":
			return "image/svg+xml";
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "ico":
			return "image/x-icon";
		case "avif":
			return "image/avif";
		default:
			return null;
	}
}

export function applyEdgeResponseHeaders(
	response: Response,
	requestHost: string,
	org: OrgInfo,
	pathname: string,
): Response {
	const headers = new Headers(response.headers);
	let changed = false;

	if (shouldNoindexOrigin(requestHost, org)) {
		headers.set("X-Robots-Tag", "noindex, nofollow");
		changed = true;
	}

	// authz: public — not a route: response header fix-up for media file responses.
	if (pathname.startsWith("/_emdash/api/media/file/")) {
		const imageContentType = imageContentTypeFromPath(pathname);
		if (imageContentType) {
			headers.set("Content-Type", imageContentType);
			headers.delete("Content-Disposition");
			headers.delete("Content-Security-Policy");
			changed = true;
		}
	}

	if (!changed) return response;

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function lookupOrg(
	env: Env,
	slug: string,
	fresh = false,
): Promise<OrgInfo | null> {
	const now = Date.now();
	const cached = orgCache.get(slug);
	if (!fresh && cached && cached.expiresAt > now) return cached.info;

	const db = getDb(env.PLATFORM_DB);
	const site = await getCmsSiteBySlug(db, slug);

	if (!site || site.status !== "active") {
		orgCache.set(slug, { info: null, expiresAt: now + ORG_TTL_MS });
		return null;
	}

	const ownerOrg = await db.query.organizations.findFirst({
		where: { id: site.organizationId },
	});
	const config = site.config ?? {};
	const blogConfig = (config.blog ?? {}) as Record<string, unknown>;
	const authDescopeTenantId =
		typeof blogConfig.authDescopeTenantId === "string"
			? blogConfig.authDescopeTenantId
			: null;
	const descopeTenantId = authDescopeTenantId ?? ownerOrg?.descopeTenantId;

	if (!descopeTenantId) {
		console.error(
			`[cms-runtime] CMS site ${slug} has no Descope auth tenant; set site config or organization.descopeTenantId`,
		);
		orgCache.set(slug, { info: null, expiresAt: now + ORG_TTL_MS });
		return null;
	}

	const r2BucketName = `tedix-cms-media-${slug}`;

	const branding = config.branding ?? null;
	const socialLinks = config.socialLinks ?? null;
	const cmsFallbackUrl =
		buildSurfaceUrl("cms", slug, {
			platformDomain: platformDomainForEnvironment(env.ENVIRONMENT),
		}) ?? `https://${slug}.cms.tedix.dev`;
	const cmsDomain = site.customDomain;
	const publicSiteUrl =
		site.canonicalUrl.replace(/\/+$/, "") ??
		(cmsDomain ? `https://${cmsDomain}` : null) ??
		cmsFallbackUrl;
	const publicPathPrefix = normalizePublicPathPrefix(site.publicPathPrefix);
	const webMcpConfig = (
		blogConfig as
			| {
					webMcp?: { enabled?: unknown; toolPacks?: unknown };
			  }
			| undefined
	)?.webMcp;
	const webMcpToolPacks =
		webMcpConfig?.enabled === false
			? []
			: normalizeWebMcpToolPacks(webMcpConfig?.toolPacks);
	const info: OrgInfo = {
		slug,
		siteId: site.id,
		templateSlug: site.templateSlug,
		r2BucketName,
		siteTitle: site.name,
		brandingJson: branding ? JSON.stringify(branding) : null,
		socialJson: socialLinks ? JSON.stringify(socialLinks) : null,
		descopeTenantId,
		humanAssertionBundleEtag:
			typeof blogConfig.humanAssertionBundleEtag === "string"
				? blogConfig.humanAssertionBundleEtag
				: null,
		cmsDomain: cmsDomain ?? null,
		publicSiteUrl,
		publicPathPrefix,
		webMcpToolPacks,
		defaultLocale:
			typeof blogConfig.defaultLocale === "string"
				? blogConfig.defaultLocale
				: null,
	};
	orgCache.set(slug, { info, expiresAt: now + ORG_TTL_MS });
	return info;
}
