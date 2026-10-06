import { describe, expect, it, vi } from "vite-plus/test";
import {
	publicAssetCacheEligible,
	publicAssetCacheRequest,
	publicAssetClientResponse,
	imageRepresentationEtag,
	validateImageSourceRevision,
} from "./tenant-public-cache";

describe("public asset cache boundary", () => {
	it("bypasses authentication, preview, edits, ranges and writes before lookup", () => {
		const cases: Record<string, string>[] = [
			{ cookie: "session=abc" },
			{ authorization: "Bearer abc" },
			{ range: "bytes=0-9" },
			{ "x-tedix-cms-internal-auth": "abc" },
		];
		for (const headers of cases)
			expect(
				publicAssetCacheEligible(
					new Request("https://a/_image", {
						headers,
					}),
				),
			).toBe(false);
		for (const query of ["?_preview=invalid", "?_edit"])
			expect(
				publicAssetCacheEligible(new Request("https://a/_image" + query)),
			).toBe(false);
		expect(
			publicAssetCacheEligible(
				new Request("https://a/_image", { method: "POST" }),
			),
		).toBe(false);
		expect(publicAssetCacheEligible(new Request("https://a/_astro/a.js"))).toBe(
			true,
		);
	});
	it("normalizes inner requests to unconditional GET, then handles client weak validators", async () => {
		const request = new Request("https://a/_astro/a.js", {
			method: "HEAD",
			headers: { "if-none-match": 'W/"one"' },
		});
		const inner = publicAssetCacheRequest(new URL(request.url));
		expect(inner.method).toBe("GET");
		expect([...inner.headers]).toEqual([]);
		const response = publicAssetClientResponse(
			request,
			new Response("body", {
				headers: { etag: '"one"', "content-length": "4" },
			}),
		);
		expect(response.status).toBe(304);
		expect(response.body).toBeNull();
		expect(response.headers.has("content-length")).toBe(false);
		const fresh = publicAssetClientResponse(
			new Request(request.url),
			new Response("body", { headers: { etag: '"one"' } }),
		);
		expect(await fresh.text()).toBe("body");
	});
	it("returns HEAD metadata without a body and keeps mutable browsers revalidating", () => {
		const result = publicAssetClientResponse(
			new Request("https://a/_image", { method: "HEAD" }),
			new Response("body", {
				headers: {
					"cache-control": "public,max-age=31536000",
					"content-length": "4",
					"cf-cache-status": "HIT",
				},
			}),
			true,
		);
		expect(result.body).toBeNull();
		expect(result.headers.get("content-length")).toBe("4");
		expect(result.headers.get("x-tedix-asset-cache")).toBe("HIT");
		expect(result.headers.get("cache-control")).toBe(
			"public, max-age=0, must-revalidate",
		);
	});
	it("changes representation validators for source replacement and transform options", async () => {
		const url = new URL("https://a/_image?href=source&w=200");
		const first = await imageRepresentationEtag('"v1"', url);
		expect(await imageRepresentationEtag('"v2"', url)).not.toBe(first);
		expect(
			await imageRepresentationEtag(
				'"v1"',
				new URL("https://a/_image?href=source&w=400"),
			),
		).not.toBe(first);
	});
	it("refuses and cancels a fill racing source replacement", async () => {
		const cancel = vi.fn();
		const source = {
			etag: '"new"',
			body: new ReadableStream<Uint8Array>({ cancel }),
		};
		expect(await validateImageSourceRevision(source, '"old"')).toBe(false);
		expect(cancel).toHaveBeenCalledOnce();
		expect(
			await validateImageSourceRevision(
				{ etag: '"new"', body: new ReadableStream() },
				'"new"',
			),
		).toBe(true);
	});
});
