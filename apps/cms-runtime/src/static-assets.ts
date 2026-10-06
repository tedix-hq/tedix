/** Public immutable Astro assets; the key remains isolated by tenant slug. */
export async function staticAssetResponse(
	request: Request,
	bucket: R2Bucket,
	slug: string,
	pathname: string,
): Promise<Response | null> {
	if (!pathname.startsWith("/_astro/")) return null;
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET, HEAD" },
		});
	const filename = pathname.split("/").pop();
	if (!filename) return null;
	const key = `static/${slug}/${filename}`;
	const object =
		request.method === "HEAD"
			? await bucket.head(key)
			: await bucket.get(key, {
					onlyIf: new Headers(
						request.headers.has("if-none-match")
							? { "if-none-match": request.headers.get("if-none-match")! }
							: {},
					),
				});
	if (!object) return null;
	const ext = filename.split(".").pop()?.toLowerCase();
	const contentType =
		ext === "woff2"
			? "font/woff2"
			: ext === "woff"
				? "font/woff"
				: ext === "ttf"
					? "font/ttf"
					: ext === "css"
						? "text/css; charset=utf-8"
						: ext === "js" || ext === "mjs"
							? "application/javascript; charset=utf-8"
							: "application/octet-stream";
	const headers = new Headers({
		"Content-Type": contentType,
		"Cache-Control": "public, max-age=31536000, immutable",
		ETag: object.httpEtag,
	});
	const condition = request.headers.get("if-none-match");
	const matches = condition
		?.split(",")
		.some(
			(tag) =>
				tag.trim() === "*" ||
				tag.trim().replace(/^W\//, "") === object.httpEtag,
		);
	if (matches || (request.method === "GET" && !("body" in object)))
		return new Response(null, { status: 304, headers });
	headers.set("Content-Length", String(object.size));
	return new Response(
		request.method === "HEAD" ? null : (object as R2ObjectBody).body,
		{ headers },
	);
}
