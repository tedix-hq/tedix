import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";
import { registerCatalogAssets } from "./catalog-assets";

function setup(allowed = true) {
	const object = {
		body: "logo",
		httpEtag: '"asset-etag"',
		writeHttpMetadata: (headers: Headers) =>
			headers.set("Content-Type", "image/svg+xml"),
	};
	const get = vi.fn(async (): Promise<typeof object | null> => object);
	const head = vi.fn(async () => ({ ...object, body: undefined }));
	const limit = vi.fn(async () => ({ success: allowed }));
	const env = {
		R2_BUCKET: { get, head },
		API_RATE_LIMITER: { limit },
	} as unknown as CloudflareEnv;
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	registerCatalogAssets(app);
	return { app, env, get, head, limit };
}

describe("public catalog assets", () => {
	it("serves a public logo with sandbox and cache headers", async () => {
		const { app, env, get } = setup();
		const r = await app.request(
			"/catalog-assets/app_catalog/example/app/logo.svg",
			{},
			env,
		);
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("logo");
		expect(get).toHaveBeenCalledWith("app_catalog/example/app/logo.svg");
		expect(r.headers.get("Content-Type")).toBe("image/svg+xml");
		expect(r.headers.get("Content-Security-Policy")).toBe(
			"default-src 'none'; sandbox",
		);
		expect(r.headers.get("Cache-Control")).toBe("public, max-age=3600");
		expect(r.headers.get("ETag")).toBe('"asset-etag"');
	});
	it.each([
		"os-output-revisions/v1/org/private.gz",
		"audit-exports/v1/private.jsonl.gz",
		"app_catalog/%2e%2e%2fos-output-revisions/private.gz",
		"app_catalog/%252e%252e/private.gz",
		"app_catalog/example%5c..%5cprivate",
		"app_catalog/%00private",
		"app_catalog/%ZZ",
	])(
		"rejects private or ambiguous key %s before storage access",
		async (key) => {
			const { app, env, get, head } = setup();
			const r = await app.request(`/catalog-assets/${key}`, {}, env);
			expect(r.status).toBe(404);
			expect(get).not.toHaveBeenCalled();
			expect(head).not.toHaveBeenCalled();
		},
	);
	it("reads metadata only for HEAD and refuses writes", async () => {
		const { app, env, get, head } = setup();
		const r = await app.request(
			"/catalog-assets/app-assets/icon.png",
			{ method: "HEAD" },
			env,
		);
		expect(r.status).toBe(200);
		expect(await r.text()).toBe("");
		expect(head).toHaveBeenCalledWith("app-assets/icon.png");
		expect(
			(
				await app.request(
					"/catalog-assets/app-assets/icon.png",
					{ method: "POST" },
					env,
				)
			).status,
		).toBe(404);
		expect(get).not.toHaveBeenCalled();
	});
	it("enforces rate limits and fails closed without a limiter", async () => {
		const { app, env, get } = setup(false);
		expect(
			(await app.request("/catalog-assets/app-assets/icon.png", {}, env))
				.status,
		).toBe(429);
		expect(
			(
				await app.request("/catalog-assets/app-assets/icon.png", {}, {
					...env,
					API_RATE_LIMITER: undefined,
				} as unknown as CloudflareEnv)
			).status,
		).toBe(503);
		expect(get).not.toHaveBeenCalled();
	});
	it("returns 404 when a public asset does not exist", async () => {
		const { app, env, get } = setup();
		get.mockResolvedValueOnce(null);
		expect(
			(await app.request("/catalog-assets/app-assets/missing.png", {}, env))
				.status,
		).toBe(404);
	});
});
