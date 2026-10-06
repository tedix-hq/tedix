import { describe, expect, it, vi } from "vite-plus/test";
import { staticAssetResponse } from "./static-assets";

describe("immutable tenant static assets", () => {
	const metadata = { size: 5, httpEtag: '"hash"' };
	it("streams GET without buffering and isolates the tenant key", async () => {
		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("hello"));
				controller.close();
			},
		});
		const get = vi.fn().mockResolvedValue({ ...metadata, body });
		const response = await staticAssetResponse(
			new Request("https://site/_astro/editor.hash.js"),
			{ get } as unknown as R2Bucket,
			"tenant-a",
			"/_astro/editor.hash.js",
		);
		expect(get.mock.calls[0]![0]).toBe("static/tenant-a/editor.hash.js");
		expect(response!.body).toBe(body);
		expect(response!.headers.get("etag")).toBe('"hash"');
		expect(response!.headers.get("content-length")).toBe("5");
		expect(await response!.text()).toBe("hello");
	});
	it("HEAD reads metadata only and weak/list validators produce a bodyless 304", async () => {
		const head = vi.fn().mockResolvedValue(metadata);
		const get = vi.fn();
		const bucket = { head, get } as unknown as R2Bucket;
		const response = await staticAssetResponse(
			new Request("https://site/_astro/a.js", { method: "HEAD" }),
			bucket,
			"a",
			"/_astro/a.js",
		);
		expect(response!.status).toBe(200);
		expect(response!.body).toBeNull();
		expect(get).not.toHaveBeenCalled();
		const cached = await staticAssetResponse(
			new Request("https://site/_astro/a.js", {
				method: "HEAD",
				headers: { "if-none-match": '"other", W/"hash"' },
			}),
			bucket,
			"a",
			"/_astro/a.js",
		);
		expect(cached!.status).toBe(304);
		expect(cached!.body).toBeNull();
		expect(cached!.headers.has("content-length")).toBe(false);
	});
	it("passes conditional GET to R2 without unrelated preconditions", async () => {
		const get = vi.fn().mockResolvedValue(metadata);
		const response = await staticAssetResponse(
			new Request("https://site/_astro/a.js", {
				headers: { "if-none-match": '"hash"', "if-match": '"unrelated"' },
			}),
			{ get } as unknown as R2Bucket,
			"a",
			"/_astro/a.js",
		);
		expect(response!.status).toBe(304);
		expect(get.mock.calls[0]![1].onlyIf.get("if-none-match")).toBe('"hash"');
		expect(get.mock.calls[0]![1].onlyIf.has("if-match")).toBe(false);
	});
	it("missing assets fall through and writes do not read R2", async () => {
		const get = vi.fn().mockResolvedValue(null);
		const bucket = { get } as unknown as R2Bucket;
		expect(
			await staticAssetResponse(
				new Request("https://site/_astro/missing.js"),
				bucket,
				"a",
				"/_astro/missing.js",
			),
		).toBeNull();
		get.mockClear();
		expect(
			(await staticAssetResponse(
				new Request("https://site/_astro/a.js", { method: "POST" }),
				bucket,
				"a",
				"/_astro/a.js",
			))!.status,
		).toBe(405);
		expect(get).not.toHaveBeenCalled();
	});
});
