import { publicAssetCacheEligible } from "./tenant-public-cache";
import { EDGE_CACHE_EXCLUDED_PREFIXES } from "./edge-cache-headers";

/**
 * Parent-side cache for anonymous tenant HTML pages.
 *
 * Every tenant page render costs a dozen sequential tenant-database round
 * trips (2-3 s from a distant colo), while the static apps/landing site
 * answers in ~0.2 s. Clients and the CDN still receive `private, no-store`
 * (see ./edge-cache-headers): this cache lives inside the Worker, in the
 * Cache API, under a key built from the resolved tenant, never from the bare
 * URL. Workers Cache keys omit the hostname, which is how responses once
 * crossed tenant boundaries; this key names the host, site, slug, restore
 * epoch and bundle explicitly.
 *
 * A page is stored only when the tenant declares a public policy or, for
 * marketing-template HTML without any policy, under the marketing default.
 * Freshness is short and stale pages are revalidated in the background, so a
 * published edit is visible within about a minute.
 */
export const MARKETING_PAGE_CACHE_CONTROL =
	"public, max-age=60, stale-while-revalidate=86400";

const CACHED_AT_HEADER = "X-Tedix-Page-Cached-At";
const FRESH_FOR_HEADER = "X-Tedix-Page-Fresh-For";
export const PAGE_CACHE_STATUS_HEADER = "X-Tedix-Page-Cache";

export interface PageCacheIdentity {
	siteId: string;
	slug: string;
	restoreEpoch: number;
	bundleEtag: string;
	bundleVersion: number;
}

export interface PageCachePolicy {
	freshSeconds: number;
	staleSeconds: number;
}

/** Anonymous GET of a public page path; HEAD and assets keep their own paths. */
export function pageCacheEligible(request: Request, pathname: string): boolean {
	return (
		request.method === "GET" &&
		publicAssetCacheEligible(request) &&
		!EDGE_CACHE_EXCLUDED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
	);
}

/**
 * The render behind a shared page is cookie-free, so a client-only cookie the
 * visitor happened to carry can never shape what other visitors receive.
 */
export function anonymousPageRequest(request: Request): Request {
	if (!request.headers.has("cookie")) return request;
	const anonymous = new Request(request);
	anonymous.headers.delete("cookie");
	return anonymous;
}

/** Headers the parent or tenant reads to decide the public host of a page. */
const HOST_HEADERS = [
	"X-Tedix-Public-Host",
	"X-Forwarded-Host",
	"X-Original-Host",
];

export async function pageCacheKey(
	request: Request,
	tenantUrl: URL,
	identity: PageCacheIdentity,
): Promise<Request> {
	const url = new URL(request.url);
	const material = JSON.stringify([
		url.host,
		url.pathname,
		url.search,
		tenantUrl.href,
		HOST_HEADERS.map((name) => request.headers.get(name)),
		identity.siteId,
		identity.slug,
		identity.restoreEpoch,
		identity.bundleVersion,
		identity.bundleEtag,
	]);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(material),
	);
	const hex = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return new Request(
		`https://${url.host}/_tedix/page-cache/${identity.slug}/${hex}`,
		{ method: "GET" },
	);
}

function directiveSeconds(
	directives: string[],
	name: string,
): number | undefined {
	const directive = directives.find((value) => value.startsWith(`${name}=`));
	if (!directive) return undefined;
	const seconds = Number.parseInt(directive.slice(name.length + 1), 10);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** The policy a tenant page response declares, or null when it is not shareable. */
export function pageCachePolicy(
	response: Response,
	templateSlug: string,
): PageCachePolicy | null {
	if (response.status !== 200) return null;
	if (!(response.headers.get("content-type") ?? "").startsWith("text/html"))
		return null;
	if (response.headers.has("set-cookie")) return null;
	if ((response.headers.get("vary") ?? "").includes("*")) return null;
	const declared =
		response.headers.get("cache-control") ??
		(templateSlug === "marketing" ? MARKETING_PAGE_CACHE_CONTROL : null);
	if (!declared) return null;
	const directives = declared
		.toLowerCase()
		.split(",")
		.map((value) => value.trim());
	if (
		!directives.includes("public") ||
		directives.some((value) =>
			["private", "no-store", "no-cache"].includes(value.split("=")[0]!),
		)
	)
		return null;
	const freshSeconds = directiveSeconds(directives, "max-age");
	if (!freshSeconds) return null;
	return {
		freshSeconds,
		staleSeconds: directiveSeconds(directives, "stale-while-revalidate") ?? 0,
	};
}

/** A stored copy that expires from the Cache API at the end of its stale window. */
export function pageCacheEntry(
	response: Response,
	policy: PageCachePolicy,
	now: number,
): Response {
	const headers = new Headers(response.headers);
	headers.set(
		"Cache-Control",
		`public, max-age=${policy.freshSeconds + policy.staleSeconds}`,
	);
	headers.set(CACHED_AT_HEADER, String(now));
	headers.set(FRESH_FOR_HEADER, String(policy.freshSeconds));
	headers.delete("Server-Timing");
	return new Response(response.body, { status: 200, headers });
}

/** Strip storage bookkeeping and report whether the copy is still fresh. */
export function pageCacheHit(
	cached: Response,
	now: number,
): { response: Response; fresh: boolean } {
	const cachedAt = Number(cached.headers.get(CACHED_AT_HEADER));
	const freshFor = Number(cached.headers.get(FRESH_FOR_HEADER));
	const fresh =
		Number.isFinite(cachedAt) &&
		Number.isFinite(freshFor) &&
		now - cachedAt <= freshFor * 1000;
	const headers = new Headers(cached.headers);
	headers.delete(CACHED_AT_HEADER);
	headers.delete(FRESH_FOR_HEADER);
	headers.delete("Cache-Control");
	headers.delete("cf-cache-status");
	headers.set(PAGE_CACHE_STATUS_HEADER, fresh ? "HIT" : "STALE");
	return {
		response: new Response(cached.body, { status: 200, headers }),
		fresh,
	};
}

/**
 * Serve a tenant page through the cache. A stale copy is answered at once and
 * refreshed after the response; a miss renders inline and stores the result
 * only when the tenant's response declares a shareable policy.
 */
export async function cachedTenantPage(args: {
	cache: Cache;
	key: Request;
	templateSlug: string;
	waitUntil: (promise: Promise<unknown>) => void;
	render: () => Promise<Response>;
	now?: () => number;
}): Promise<Response> {
	const now = args.now ?? Date.now;
	const store = async (rendered: Response): Promise<Response> => {
		const policy = pageCachePolicy(rendered, args.templateSlug);
		const headers = new Headers(rendered.headers);
		headers.set(PAGE_CACHE_STATUS_HEADER, policy ? "MISS" : "BYPASS");
		if (!policy || !rendered.body)
			return new Response(rendered.body, {
				status: rendered.status,
				statusText: rendered.statusText,
				headers,
			});
		const [client, stored] = rendered.body.tee();
		args.waitUntil(
			args.cache
				.put(
					args.key,
					pageCacheEntry(
						new Response(stored, { status: 200, headers: rendered.headers }),
						policy,
						now(),
					),
				)
				.catch((error) =>
					console.error("[cms-runtime] page cache store failed", error),
				),
		);
		return new Response(client, { status: 200, headers });
	};

	let cached: Response | undefined;
	try {
		cached = await args.cache.match(args.key);
	} catch (error) {
		console.error("[cms-runtime] page cache lookup failed", error);
	}
	if (cached) {
		const hit = pageCacheHit(cached, now());
		if (!hit.fresh)
			args.waitUntil(
				args
					.render()
					.then(async (rendered) => {
						const response = await store(rendered);
						await response.body?.cancel();
					})
					.catch((error) =>
						console.error("[cms-runtime] page cache refresh failed", error),
					),
			);
		return hit.response;
	}
	return store(await args.render());
}
