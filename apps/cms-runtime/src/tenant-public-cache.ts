/**
 * Cookies that only browser scripts or Cloudflare's edge read: the theme
 * switch, Google Analytics after consent, and bot management. No tenant
 * render reads them, so a request carrying only these is still anonymous.
 */
const CLIENT_ONLY_COOKIE =
	/^(?:theme|_ga|_ga_[A-Za-z0-9]+|_gid|_gcl_au|__cf_bm|cf_clearance)$/;

/** True when every cookie in the header is one no server render reads. */
export function clientOnlyCookies(header: string | null): boolean {
	return (header ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)
		.every((part) => CLIENT_ONLY_COOKIE.test(part.split("=", 1)[0]!.trim()));
}

/** Only anonymous public asset requests enter the native response cache. */
export function publicAssetCacheEligible(request: Request): boolean {
	const url = new URL(request.url);
	return (
		(request.method === "GET" || request.method === "HEAD") &&
		clientOnlyCookies(request.headers.get("cookie")) &&
		![
			"authorization",
			"range",
			"if-match",
			"if-unmodified-since",
			"x-tedix-cms-internal-auth",
		].some((name) => request.headers.has(name)) &&
		!["_preview", "_edit"].some((name) => url.searchParams.has(name))
	);
}

/** Cache one complete representation; caller validators are evaluated outside. */
export function publicAssetCacheRequest(url: URL): Request {
	return new Request(url, { method: "GET" });
}

export function publicAssetClientResponse(
	request: Request,
	response: Response,
	mutable = false,
): Response {
	const headers = new Headers(response.headers);
	const nativeStatus = response.headers.get("cf-cache-status");
	if (nativeStatus) headers.set("X-Tedix-Asset-Cache", nativeStatus);
	if (mutable)
		headers.set("Cache-Control", "public, max-age=0, must-revalidate");
	const tag = headers.get("etag");
	const matches =
		tag &&
		request.headers
			.get("if-none-match")
			?.split(",")
			.some(
				(value) =>
					value.trim() === "*" || value.trim().replace(/^W\//, "") === tag,
			);
	if (matches) {
		void response.body?.cancel();
		headers.delete("content-length");
		return new Response(null, { status: 304, headers });
	}
	if (request.method === "HEAD") void response.body?.cancel();
	return new Response(request.method === "HEAD" ? null : response.body, {
		status: response.status,
		headers,
	});
}

export async function imageRepresentationEtag(
	sourceEtag: string,
	url: URL,
): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([sourceEtag, url.pathname, url.search]),
		),
	);
	return (
		'"' +
		Array.from(new Uint8Array(hash), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("") +
		'"'
	);
}

/** A source replaced between lookup and fill must never populate the old key. */
export async function validateImageSourceRevision(
	source: { etag: string | null; body: ReadableStream<Uint8Array> },
	expected?: string,
): Promise<boolean> {
	if (!expected || source.etag === expected) return true;
	await source.body.cancel();
	return false;
}
