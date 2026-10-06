const RELEASE_PREFIX = "releases/";
const MUTABLE_KEYS = new Set(["install.sh", "latest.json"]);

function objectKey(pathname: string): string | null {
	const key = pathname.replace(/^\/+/, "");
	if (!key || key.includes("..") || key.includes("\\") || key.includes("//")) {
		return null;
	}
	if (MUTABLE_KEYS.has(key) || key.startsWith(RELEASE_PREFIX)) return key;
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
	headers.set("Access-Control-Allow-Origin", "*");
	headers.set("Cross-Origin-Resource-Policy", "cross-origin");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Cache-Control",
		key.startsWith(RELEASE_PREFIX)
			? "public, max-age=31536000, immutable"
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
