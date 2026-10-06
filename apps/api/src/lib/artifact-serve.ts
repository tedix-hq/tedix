/**
 * Stream a durable tedi artifact's R2 body to the browser.
 *
 * A `tedi_artifacts` row stores `uri = r2://<bucket>/<key>` (a raw object) plus
 * the deliverable's `mimeType`. This helper resolves the bucket name to the
 * matching apps/api R2 binding, then streams the object with the right
 * Content-Type so HTML renders, PDFs/images open inline, and CSV/blobs download.
 * Honors a `Range` request (HTTP 206) so video deliverables can be scrubbed.
 *
 * No auth here — callers (the signed-token route and the session route in
 * `index.ts`) authorize first, then delegate to this pure streamer.
 */

export interface ArtifactR2Env {
	TEDI_R2_BUCKET?: R2Bucket;
	SKILL_ARTIFACTS?: R2Bucket;
	R2_BUCKET?: R2Bucket;
	CONTENT_CMS_BUCKET?: R2Bucket;
}

/** Minimal artifact shape needed to stream — a subset of the `tedi_artifacts` row. */
export interface StreamableArtifact {
	uri: string | null;
	mimeType: string | null;
}

/** Map an `r2://<bucket>/...` bucket name to its apps/api binding. */
export function artifactBucketBinding(
	env: ArtifactR2Env,
	bucketName: string,
): R2Bucket | undefined {
	switch (bucketName) {
		case "tedix-tedi-production":
			return env.TEDI_R2_BUCKET;
		case "skill-artifacts-production":
			return env.SKILL_ARTIFACTS;
		case "tedix-assets":
			return env.R2_BUCKET;
		case "content-cms":
			return env.CONTENT_CMS_BUCKET;
		case "tedi-storage":
			// Legacy workstation-evidence refs: the adapter stamped
			// "tedi-storage" but always wrote via a binding
			// bound to tedix-tedi-production — alias to that bucket.
			return env.TEDI_R2_BUCKET;
		default:
			return undefined;
	}
}

function parseR2Uri(uri: string): { bucket: string; key: string } | null {
	const m = /^r2:\/\/([^/]+)\/(.+)$/.exec(uri);
	if (!m?.[1] || !m[2]) return null;
	return { bucket: m[1], key: m[2] };
}

// ---------------------------------------------------------------------------
// Bundle artifacts (multi-file deliverables — interactive dashboards/sites)
// ---------------------------------------------------------------------------
// A bundle row stores `uri = r2://<bucket>/<prefix>/` (trailing slash) plus
// `metadata: { bundle: true, entrypoint }`. Requests to the bare artifact URL
// serve the entrypoint; `/artifacts[/s]/:tediId/:artifactId/<subpath>` serves
// individual bundle files with extension-derived content types.

const BUNDLE_CONTENT_TYPES: Record<string, string> = {
	css: "text/css; charset=utf-8",
	csv: "text/csv; charset=utf-8",
	gif: "image/gif",
	htm: "text/html; charset=utf-8",
	html: "text/html; charset=utf-8",
	ico: "image/x-icon",
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	js: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	md: "text/markdown; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	pdf: "application/pdf",
	png: "image/png",
	svg: "image/svg+xml",
	ttf: "font/ttf",
	txt: "text/plain; charset=utf-8",
	wasm: "application/wasm",
	webp: "image/webp",
	woff: "font/woff",
	woff2: "font/woff2",
	xml: "application/xml; charset=utf-8",
};

/** Content type for a bundle file, by extension. Octet-stream when unknown. */
export function guessBundleContentType(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BUNDLE_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** True when a `tedi_artifacts.metadata` value marks a multi-file bundle. */
export function isBundleArtifact(metadata: unknown): boolean {
	return (
		typeof metadata === "object" &&
		metadata !== null &&
		(metadata as { bundle?: unknown }).bundle === true
	);
}

/**
 * Resolve a request subpath within a bundle artifact to the concrete R2
 * object as a `StreamableArtifact`. Empty subpath → the bundle's entrypoint
 * (default `index.html`). Returns null on traversal/malformed paths — callers
 * should 404.
 */
export function resolveBundleObject(
	artifact: { uri: string | null; metadata: unknown },
	subpath: string,
): StreamableArtifact | null {
	if (!artifact.uri?.startsWith("r2://") || !artifact.uri.endsWith("/")) {
		return null;
	}
	const meta = (artifact.metadata ?? {}) as { entrypoint?: unknown };
	const entrypoint =
		typeof meta.entrypoint === "string" && meta.entrypoint
			? meta.entrypoint
			: "index.html";
	const cleaned = subpath.replace(/^\/+/, "").trim();
	const effective = cleaned === "" ? entrypoint : cleaned;
	let segments: string[];
	try {
		// Decode BEFORE the traversal check so %2e%2e cannot smuggle "..".
		segments = effective.split("/").map((s) => decodeURIComponent(s));
	} catch {
		return null;
	}
	if (segments.some((s) => !s || s === "." || s === ".." || s.includes("/"))) {
		return null;
	}
	const path = segments.join("/");
	return {
		uri: `${artifact.uri}${path}`,
		mimeType: guessBundleContentType(path),
	};
}

const PLAIN = { "Content-Type": "text/plain; charset=utf-8" } as const;

/**
 * Stream the artifact body. `rangeHeader` is the raw `Range` request header (or
 * null). Returns a `Response` (200, 206, or an error status) — never throws on a
 * missing object; callers have already authorized.
 */
/**
 * Content types that cannot execute script in a top-level browsing context.
 *
 * An allowlist, deliberately: the set of scriptable types is open-ended
 * (svg, xhtml, xml, and whatever ships next), while the set of inert ones is
 * small and enumerable. Matched on the media type alone, case-folded, with any
 * `;charset=...` parameter stripped.
 */
const INERT_CONTENT_TYPES = new Set([
	"application/octet-stream",
	"application/pdf",
	"application/json",
	"text/plain",
	"text/csv",
	"text/markdown",
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/x-icon",
	"font/woff",
	"font/woff2",
	"font/ttf",
	"font/otf",
]);

const INERT_CONTENT_TYPE_PREFIXES = ["audio/", "video/"];

export function isInertContentType(contentType: string): boolean {
	const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	if (INERT_CONTENT_TYPES.has(mediaType)) return true;
	return INERT_CONTENT_TYPE_PREFIXES.some((prefix) =>
		mediaType.startsWith(prefix),
	);
}

export async function streamArtifactObject(
	env: ArtifactR2Env,
	artifact: StreamableArtifact,
	rangeHeader: string | null,
): Promise<Response> {
	if (!artifact.uri || !artifact.uri.startsWith("r2://")) {
		return new Response("Artifact has no streamable body", {
			status: 415,
			headers: PLAIN,
		});
	}
	const parsed = parseR2Uri(artifact.uri);
	if (!parsed) {
		return new Response("Malformed artifact uri", {
			status: 422,
			headers: PLAIN,
		});
	}
	const bucket = artifactBucketBinding(env, parsed.bucket);
	if (!bucket) {
		return new Response("Unknown artifact bucket", {
			status: 404,
			headers: PLAIN,
		});
	}

	const contentType = artifact.mimeType || "application/octet-stream";

	// Security headers. mimeType is caller-controlled (record_artifact), so a tedi
	// could write text/html with arbitrary JS; serving it inline from the API
	// origin would be stored-XSS. nosniff stops content sniffing; for HTML we add a
	// CSP sandbox (opaque origin) so it renders but cannot read api.tedix.dev
	// cookies/DOM or call same-origin APIs (allow-scripts keeps dashboards interactive).
	//
	// ACAO *: the sandbox gives the document an OPAQUE origin, so a bundle
	// dashboard's own `fetch("data.json"+location.search)` is a cross-origin
	// request from origin "null" — without this header the browser rejects it
	// and the dashboard renders empty (found live in Chrome; curl can't catch
	// CORS). Safe: access is capability-gated (signed URL / session upstream),
	// CORS is not an auth layer, and requests are non-credentialed.
	// Not @tedix/worker-kit/cors: that helper is an origin ALLOWLIST; this is a
	// deliberate public wildcard for non-credentialed, capability-gated bytes.
	const securityHeaders: Record<string, string> = {
		"X-Content-Type-Options": "nosniff",
		"Access-Control-Allow-Origin": "*",
	};
	// DENY BY DEFAULT. This used to sandbox only `text/html`, which made the
	// gate a list of the ONE scriptable type someone thought of. `nosniff` does
	// not help here — it stops sniffing AWAY from the declared type, and the
	// declared type is the executable one. An artifact served as
	// `image/svg+xml` or `application/xhtml+xml` is a document that runs
	// script on api.tedix.dev, where the DS session cookie is readable
	// (non-HttpOnly, scoped to .tedix.dev) and same-origin `fetch("/rpc/*")`
	// drives the whole authenticated API as the victim. A tedi chooses this
	// value (record_artifact) and tedis ingest untrusted content, so a lower
	// privilege principal could hand its operator an account takeover.
	//
	// Everything is sandboxed unless it is provably inert, so a content type
	// nobody anticipated fails CLOSED.
	if (!isInertContentType(contentType)) {
		securityHeaders["Content-Security-Policy"] =
			"sandbox allow-scripts allow-popups allow-forms";
	}

	// Range request → 206 partial (video scrubbing, large downloads).
	const range = rangeHeader ? /^bytes=(\d+)-(\d*)$/.exec(rangeHeader) : null;
	if (range) {
		const head = await bucket.head(parsed.key);
		if (!head) {
			return new Response("Artifact body not found", {
				status: 404,
				headers: PLAIN,
			});
		}
		const total = head.size;
		const start = Number(range[1]);
		const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
		if (start >= total || start > end) {
			return new Response("Range Not Satisfiable", {
				status: 416,
				headers: { ...PLAIN, "Content-Range": `bytes */${total}` },
			});
		}
		const length = end - start + 1;
		const part = await bucket.get(parsed.key, {
			range: { offset: start, length },
		});
		if (!part) {
			return new Response("Artifact body not found", {
				status: 404,
				headers: PLAIN,
			});
		}
		return new Response(part.body, {
			status: 206,
			headers: {
				...securityHeaders,
				"Content-Type": contentType,
				"Content-Length": String(length),
				"Content-Range": `bytes ${start}-${end}/${total}`,
				"Accept-Ranges": "bytes",
				"Cache-Control": "private, max-age=300",
			},
		});
	}

	const obj = await bucket.get(parsed.key);
	if (!obj) {
		return new Response("Artifact body not found", {
			status: 404,
			headers: PLAIN,
		});
	}
	return new Response(obj.body, {
		headers: {
			...securityHeaders,
			"Content-Type": contentType,
			"Content-Length": String(obj.size),
			"Accept-Ranges": "bytes",
			"Cache-Control": "private, max-age=300",
			"Content-Disposition": "inline",
		},
	});
}
