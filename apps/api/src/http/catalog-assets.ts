import type { Hono } from "hono";

export function registerCatalogAssets(app: Hono<{ Bindings: CloudflareEnv }>) {
	// authz: public — only catalog assets, never the bucket's tenant prefixes.
	app.on(["GET", "HEAD"], "/catalog-assets/*", async (c) => {
		let key: string;
		try {
			key = decodeURIComponent(
				new URL(c.req.url).pathname.slice("/catalog-assets/".length),
			);
		} catch {
			return c.text("Not found", 404);
		}
		if (
			!/^(app_catalog|app-assets)\/[A-Za-z0-9_./-]+$/.test(key) ||
			key.split("/").some((part) => !part || part === "." || part === "..")
		)
			return c.text("Not found", 404);
		if (!c.env.API_RATE_LIMITER) return c.text("Unavailable", 503);
		const limit = await c.env.API_RATE_LIMITER.limit({
			key: `catalog-assets:${c.req.header("CF-Connecting-IP") ?? "unknown"}`,
		});
		if (!limit.success) return c.text("Too many requests", 429);
		let object: R2Object | null;
		let body: ReadableStream | null = null;
		if (c.req.method === "HEAD") {
			object = await c.env.R2_BUCKET.head(key);
		} else {
			const result = await c.env.R2_BUCKET.get(key);
			object = result;
			body = result?.body ?? null;
		}
		if (!object) return c.text("Not found", 404);
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set("ETag", object.httpEtag);
		headers.set("Cache-Control", "public, max-age=3600");
		headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Cross-Origin-Resource-Policy", "cross-origin");
		return new Response(body, { headers });
	});
}
