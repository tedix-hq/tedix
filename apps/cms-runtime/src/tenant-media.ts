import { validateImageSourceRevision } from "./tenant-public-cache";
import {
	MUTABLE_MEDIA_CACHE_CONTROL,
	type ImageTransformFormat,
	matchInternalMediaKey,
	parseTransformParams,
	resolveTransformQuality,
} from "emdash/media/image-endpoint";
import { type OrgInfo } from "./public-proxy";
import { type Env } from "./env";
export const CF_API = "https://api.cloudflare.com/client/v4";

// ── Image transforms (parent-Worker interception) ──────────────────
//
// Emdash's Astro image endpoint (image.endpoint, mounted at Astro's default
// /_image route — this repo's tenant templates don't override image.endpoint.route)
// calls the real Cloudflare Images binding chain (`env.IMAGES.input().transform().output()`)
// directly. That binding cannot be forwarded into a Worker-Loader-dispatched
// tenant isolate the way TenantR2 proxies R2 (this isn't a
// REST-shaped interface a WorkerEntrypoint can proxy — it's a chained,
// streaming transform pipeline). So /_image requests are intercepted here, at
// the parent, which has native IMAGES + R2 access, and served directly —
// mirroring how edge caching moved entirely to the parent Worker for the same
// "no native binding inside a dispatched isolate" reason.
//
// Contract mirrors `emdash/media/image-endpoint.ts` + `@emdash-cms/cloudflare`'s
// `image-endpoint.ts` exactly: `href` must resolve to the internal media route
// (`matchInternalMediaKey`), transform params are `w`/`h`/`f`/`q`
// (`parseTransformParams`). Only raster images are transformed; anything else,
// or a request this parent can't confidently handle, falls through to Worker
// Loader dispatch so the isolate's own `passthrough`-mode fallback still works.

export const IMAGE_ENDPOINT_ROUTE = "/_image";

export function tenantMediaKeyFromHref(
	href: string | null,
	prefix: string | null,
): string | null {
	const directKey = matchInternalMediaKey(href);
	if (directKey || !href || !prefix) return directKey;
	try {
		const mediaUrl = new URL(href, "http://localhost");
		// authz: public — resolved tenant prefix only; the caller reads the key from that tenant's R2 bucket.
		if (!mediaUrl.pathname.startsWith(`${prefix}/_emdash/api/media/file/`))
			return null;
		mediaUrl.pathname = mediaUrl.pathname.slice(prefix.length);
		return matchInternalMediaKey(mediaUrl.href);
	} catch {
		return null;
	}
}

const IMAGE_TRANSFORM_FORMAT_MIME: Record<
	ImageTransformFormat,
	ImageOutputOptions["format"]
> = {
	webp: "image/webp",
	avif: "image/avif",
	jpeg: "image/jpeg",
	png: "image/png",
};

async function fetchTenantR2ObjectStream(
	accountId: string,
	r2Token: string,
	bucketName: string,
	key: string,
): Promise<{
	body: ReadableStream<Uint8Array>;
	contentType: string;
	etag: string | null;
} | null> {
	const res = await fetch(
		`${CF_API}/accounts/${accountId}/r2/buckets/${bucketName}/objects/${encodeURIComponent(key)}`,
		{ headers: { Authorization: `Bearer ${r2Token}` } },
	);
	if (res.status === 404) return null;
	if (!res.ok || !res.body) {
		throw new Error(`R2 get failed for image transform: ${res.status}`);
	}
	return {
		body: res.body,
		etag: res.headers.get("etag"),
		contentType: res.headers.get("content-type") ?? "application/octet-stream",
	};
}

/**
 * Handle a `/_image` request directly at the parent, or return `null` to fall
 * through to normal Worker Loader dispatch (not an image-transform request,
 * not EmDash-internal media, non-raster source, or any error — the isolate's
 * own image endpoint remains a safe fallback in every non-handled case).
 */
export async function imageTransformResponse(
	env: Env,
	org: Pick<OrgInfo, "slug" | "publicPathPrefix" | "r2BucketName">,
	accountId: string,
	r2Token: string,
	url: URL,
	expectedSourceEtag?: string,
): Promise<Response | null> {
	// authz: public — public tenant-site image transform; only serves keys matchInternalMediaKey accepts.
	if (url.pathname !== IMAGE_ENDPOINT_ROUTE) return null;

	const key = tenantMediaKeyFromHref(
		url.searchParams.get("href"),
		org.publicPathPrefix,
	);
	if (!key) return null;

	const parsed = parseTransformParams(url.searchParams);
	if (!parsed.ok) return null;

	try {
		const source = await fetchTenantR2ObjectStream(
			accountId,
			r2Token,
			org.r2BucketName,
			key,
		);
		if (!source) return new Response("Not Found", { status: 404 });
		if (!(await validateImageSourceRevision(source, expectedSourceEtag)))
			return null;
		if (!source.contentType.startsWith("image/")) {
			await source.body.cancel();
			return null;
		}

		const { width, height, format, quality } = parsed.options;
		const outputMime = IMAGE_TRANSFORM_FORMAT_MIME[format] ?? "image/webp";
		const transform: ImageTransform = {};
		if (width) transform.width = width;
		if (height) transform.height = height;
		const output: ImageOutputOptions = { format: outputMime };
		const effectiveQuality = resolveTransformQuality(format, quality);
		if (effectiveQuality !== undefined) output.quality = effectiveQuality;

		const result = await env.IMAGES.input(source.body)
			.transform(transform)
			.output(output);
		const response = result.response();
		if (!response.body) return null;

		return new Response(response.body, {
			status: 200,
			headers: {
				"Content-Type": response.headers.get("Content-Type") ?? outputMime,
				"Cache-Control": MUTABLE_MEDIA_CACHE_CONTROL,
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		console.error(
			`[cms-runtime] parent-level image transform failed for ${org.slug}, falling through to isolate:`,
			error,
		);
		return null;
	}
}
