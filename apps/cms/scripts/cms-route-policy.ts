/**
 * Route policy the CMS orchestration smoke asserts against.
 *
 * Two distinct runtime rules govern where a tenant's routes actually live, and
 * conflating them is what made the smoke report the wrong answer for
 * prefix-mounted tenants (only the mounted prefix is reverse-proxied; the
 * public root belongs to the tenant's own origin):
 *
 * 1. WHERE A PATH LIVES ON THE PUBLIC SURFACE — `normalizePublicProxyRequest()`
 *    / `isPublicInfrastructurePath()` in `apps/cms-runtime/src/index.ts`. The
 *    customer proxies only `${prefix}/*`, and infrastructure paths are stripped
 *    back to root on the way in. So `/robots.txt`, `/sitemap.xml`, `/llms.txt`
 *    and `/rss.xml` are all served at `${prefix}${path}` publicly. Checking the
 *    unprefixed path checks the customer's own web server, not the CMS.
 *
 * 2. WHERE THE ORIGIN CANONICALLY REDIRECTS TO — `canonicalPublicUrl()` in the
 *    same file. Its prefix list is NARROWER than rule 1: `/robots.txt` is not
 *    origin-redirectable at all (the origin serves its own noindex robots),
 *    while `/`, `/posts/*`, `/category/*`, `/tag/*`, `/rss.xml`,
 *    `/sitemap.xml`, `/sitemap-posts.xml` and `/llms.txt` do get prefixed.
 *
 * Paths handed to these helpers are CANONICAL (root-relative, as the CMS
 * exposes them on an unprefixed tenant), except that a path already carrying
 * the tenant prefix is left alone — the collection index and post paths are
 * derived from `postUrlPattern` and are already public-shaped.
 */

export type RoutePolicyTenant = {
	publicBaseUrl: string;
	/**
	 * Public mount prefix, mirroring `org.publicPathPrefix`
	 * (`metadata.blogConfig.publicPathPrefix`) which
	 * `publicPathPrefixFromOrg()` reads at runtime.
	 */
	publicPathPrefix?: string;
	/** False when the public root belongs to the customer, not the CMS. */
	publicRootOwnedByCms?: boolean;
};

/**
 * Paths `canonicalPublicUrl()` rewrites onto the prefix when the origin issues
 * its canonical redirect. Deliberately excludes `/robots.txt`.
 */
const ORIGIN_CANONICAL_PREFIXED_PATHS = [
	"/rss.xml",
	"/sitemap.xml",
	"/sitemap-posts.xml",
	"/llms.txt",
];

export function stripTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/** Normalize a configured prefix to `/segment` form, or null when absent. */
export function normalizePublicPathPrefix(
	prefix: string | undefined,
): string | null {
	if (!prefix) return null;
	const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
	const normalized = stripTrailingSlash(
		withLeadingSlash.replace(/\/{2,}/g, "/"),
	);
	return normalized === "" || normalized === "/" ? null : normalized;
}

function normalizeCanonicalPath(canonicalPath: string): string {
	return canonicalPath === "" ? "/" : canonicalPath;
}

function carriesPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Resolve a canonical path onto the tenant's public surface.
 *
 * Returns null when the path is not CMS-owned there — today that is the site
 * root of a tenant whose public root belongs to the customer.
 */
export function publicSurfacePath(
	tenant: RoutePolicyTenant,
	canonicalPath: string,
): string | null {
	const path = normalizeCanonicalPath(canonicalPath);
	const prefix = normalizePublicPathPrefix(tenant.publicPathPrefix);

	if (path === "/" && tenant.publicRootOwnedByCms === false) return null;
	if (!prefix) return canonicalPath;
	if (carriesPrefix(path, prefix)) return canonicalPath;
	return path === "/" ? `${prefix}/` : `${prefix}${path}`;
}

/**
 * The public URL the ORIGIN is expected to canonically redirect a path to.
 * Mirrors `canonicalPublicUrl()` in apps/cms-runtime/src/index.ts.
 */
export function canonicalPublicUrl(
	tenant: RoutePolicyTenant,
	canonicalPath: string,
): string {
	const base = stripTrailingSlash(tenant.publicBaseUrl);
	const prefix = normalizePublicPathPrefix(tenant.publicPathPrefix);
	let target = normalizeCanonicalPath(canonicalPath);

	if (prefix) {
		if (target === "/posts" || target === "/posts/") {
			target = `${prefix}/`;
		} else if (target.startsWith("/posts/")) {
			const rest = target
				.slice("/posts/".length)
				.replace(/^\/+/, "")
				.replace(/\/+$/, "");
			target = rest ? `${prefix}/${rest}` : `${prefix}/`;
		}

		const shouldPrefix =
			!carriesPrefix(target, prefix) &&
			(target === "/" ||
				target.startsWith("/posts/") ||
				target.startsWith("/category/") ||
				target.startsWith("/tag/") ||
				ORIGIN_CANONICAL_PREFIXED_PATHS.includes(target));
		if (shouldPrefix) {
			target = target === "/" ? `${prefix}/` : `${prefix}${target}`;
		}
	}

	return `${base}${target}`;
}

/** Compare URLs ignoring a trailing slash, which is not a routing difference. */
export function comparableUrl(raw: string): string {
	const url = new URL(raw);
	const pathname =
		url.pathname === "/" ? "/" : url.pathname.replace(/\/+$/, "");
	return `${url.origin}${pathname}${url.search}`;
}
