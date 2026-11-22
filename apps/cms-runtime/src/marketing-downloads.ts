const RELEASE_PREFIX = "releases/";
const DESKTOP_LATEST = "desktop/latest.json";
const DESKTOP_RELEASE_PREFIX = "desktop/releases/";
const MUTABLE_KEYS = new Set(["install.sh", "latest.json", "beta.json"]);

// Stable links for the docs and the website: always the release that
// desktop/latest.json names, so they move only when that pointer moves.
const DESKTOP_LATEST_ASSET =
	/^\/desktop\/latest\/Tedix-darwin-(arm64|x64)\.zip$/;
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const isRelease = (key: string) =>
	key.startsWith(RELEASE_PREFIX) || key.startsWith(DESKTOP_RELEASE_PREFIX);

function objectKey(pathname: string): string | null {
	const key = pathname.replace(/^\/+/, "");
	if (!key || key.includes("..") || key.includes("\\") || key.includes("//")) {
		return null;
	}
	if (MUTABLE_KEYS.has(key) || key === DESKTOP_LATEST || isRelease(key))
		return key;
	return null;
}

function fallbackContentType(key: string): string {
	if (key.endsWith(".json")) return "application/json; charset=utf-8";
	if (key.endsWith(".sh") || key.endsWith("SHA256SUMS")) {
		return "text/plain; charset=utf-8";
	}
	return "application/octet-stream";
}

function responseHeaders(object: R2Object, key: string): Headers {
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	if (!headers.has("Content-Type")) {
		headers.set("Content-Type", fallbackContentType(key));
	}
	headers.set("ETag", object.httpEtag);
	headers.set("Accept-Ranges", "bytes");
	// Public wildcard for release downloads, not the worker-kit origin allowlist.
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Cache-Control",
		isRelease(key)
			? "public, max-age=31536000, immutable"
			: key === DESKTOP_LATEST
				? "no-store"
				: "public, max-age=300, must-revalidate",
	);
	return headers;
}

function parseRange(
	header: string,
	size: number,
): { offset: number; length: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return null;
	const [, rawStart = "", rawEnd = ""] = match;
	if (!rawStart && !rawEnd) return null;
	if (!rawStart) {
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
		const length = Math.min(size, suffix);
		return { offset: size - length, length };
	}
	const offset = Number(rawStart);
	if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size)
		return null;
	const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
	if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return null;
	const end = Math.min(size - 1, requestedEnd);
	return { offset, length: end - offset + 1 };
}

/** The current release's zip for one architecture, or null when there is none. */
async function latestDesktopAsset(
	bucket: R2Bucket,
	arch: string,
): Promise<string | null> {
	const pointer = await bucket.get(DESKTOP_LATEST);
	if (!pointer || !("body" in pointer)) return null;
	let version: unknown;
	try {
		version = ((await pointer.json()) as { version?: unknown }).version;
	} catch {
		return null;
	}
	if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
		return null;
	}
	const key = `${DESKTOP_RELEASE_PREFIX}${version}/Tedix-${version}-darwin-${arch}.zip`;
	return (await bucket.head(key)) ? key : null;
}

export async function serveCliDownload(
	request: Request,
	bucket: R2Bucket,
	expectedHost: string,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (url.hostname !== expectedHost) return null;
	if (request.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
				"Access-Control-Max-Age": "86400",
			},
		});
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD, OPTIONS" },
		});
	}
	const latestAsset = DESKTOP_LATEST_ASSET.exec(url.pathname);
	if (latestAsset?.[1]) {
		const target = await latestDesktopAsset(bucket, latestAsset[1]);
		if (!target) return new Response("Not Found", { status: 404 });
		return new Response(null, {
			status: 302,
			headers: {
				Location: `${url.origin}/${target}`,
				"Cache-Control": "no-store",
				"Access-Control-Allow-Origin": "*",
			},
		});
	}
	const key = objectKey(url.pathname);
	if (!key) return new Response("Not Found", { status: 404 });

	if (request.method === "HEAD") {
		const object = await bucket.head(key);
		if (!object) return new Response("Not Found", { status: 404 });
		const headers = responseHeaders(object, key);
		headers.set("Content-Length", String(object.size));
		return new Response(null, { headers });
	}

	const rangeHeader = request.headers.get("Range");
	let requestedRange: { offset: number; length: number } | undefined;
	let fullSize: number | undefined;
	if (rangeHeader) {
		const metadata = await bucket.head(key);
		if (!metadata) return new Response("Not Found", { status: 404 });
		fullSize = metadata.size;
		requestedRange = parseRange(rangeHeader, metadata.size) ?? undefined;
		if (!requestedRange) {
			return new Response("Range Not Satisfiable", {
				status: 416,
				headers: { "Content-Range": `bytes */${metadata.size}` },
			});
		}
	}
	const object = await bucket.get(key, {
		onlyIf: request.headers,
		...(requestedRange ? { range: requestedRange } : {}),
	});
	if (!object) return new Response("Not Found", { status: 404 });
	const headers = responseHeaders(object, key);
	if (!("body" in object) || !object.body) {
		return new Response(null, { status: 304, headers });
	}
	if (requestedRange && fullSize !== undefined) {
		headers.set("Content-Length", String(requestedRange.length));
		headers.set(
			"Content-Range",
			`bytes ${requestedRange.offset}-${requestedRange.offset + requestedRange.length - 1}/${fullSize}`,
		);
		return new Response(object.body, { status: 206, headers });
	}
	headers.set("Content-Length", String(object.size));
	return new Response(object.body, { headers });
}
