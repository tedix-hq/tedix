import { safeDeployDetails } from "./deploy-status-safety";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { probeCmsDeploy, classifyProbeError } from "./deploy-health";

const html =
	'<html><head><link href="/_astro/app.hash.css"></head><body><img src="/_image?href=%2Fmedia%2Fhero.png&amp;w=100"></body></html>';
const candidate = {
	url: "https://site.test",
	version: 7,
	etag: "candidate",
	jobId: "cms-test",
	staticFilenames: ["app.hash.css"],
	signal: new AbortController().signal,
};
function response(
	body: string | Uint8Array = html,
	type = "text/html",
	version = "7",
) {
	return new Response(body as BodyInit, {
		headers: {
			"Content-Type": type,
			"X-Tedix-Bundle-Version": version,
			"X-Tedix-Bundle-Etag": "candidate",
			"X-Tedix-Image-Transform": "images",
		},
	});
}
function healthy() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input));
		return url.pathname === "/"
			? response()
			: url.pathname.includes("/_astro/")
				? response("body{}", "text/css")
				: response(new Uint8Array([1, 2, 3]), "image/webp");
	});
}
afterEach(() => vi.restoreAllMocks());
describe("candidate deploy health", () => {
	it("fetches real HTML, a declared page asset, and a transformed image without caches", async () => {
		const fetcher = healthy();
		expect((await probeCmsDeploy(candidate)).response.status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(3);
		for (const [input, init] of fetcher.mock.calls) {
			const url = new URL(String(input));
			expect(url.searchParams.get("_tedix_version")).toBe("7");
			expect(url.searchParams.get("_tedix_etag")).toBe("candidate");
			expect(url.searchParams.get("_tedix_nonce")).toBeTruthy();
			expect(init).toMatchObject({
				redirect: "manual",
				headers: { "Cache-Control": "no-cache, no-store" },
				cf: { cacheTtl: 0, cacheEverything: false },
			});
		}
	});
	it("fails a redirect as an HTTP failure instead of following it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 301,
				headers: { Location: "https://elsewhere.example/" },
			}),
		);
		const result = await probeCmsDeploy(candidate);
		expect(result.code).toBe("PROBE_HTTP_FAILED");
		expect(result.response.status).toBe(301);
	});
	it.each(["page", "asset", "image"])(
		"rejects another bundle's %s response",
		async (stage) => {
			const fetcher = healthy();
			const original = fetcher.getMockImplementation()!;
			fetcher.mockImplementation(async (input, init) => {
				const url = new URL(String(input));
				if (
					(stage === "page" && url.pathname === "/") ||
					(stage === "asset" && url.pathname.includes("_astro")) ||
					(stage === "image" && url.pathname.includes("_image"))
				)
					return response(html, "text/html", "6");
				return original(input, init);
			});
			expect(await probeCmsDeploy(candidate)).toMatchObject({
				code: "PROBE_BUNDLE_MISMATCH",
				retryable: false,
			});
		},
	);
	it.each([
		["text", "text/plain", "PROBE_HTML_INVALID"],
		[
			'<html><link href="https://other.test/_astro/app.hash.css"></html>',
			"text/html",
			"PROBE_ASSET_MISSING",
		],
		[
			'<html><link href="/_astro/missing.css"></html>',
			"text/html",
			"PROBE_ASSET_MISSING",
		],
	])("rejects an incomplete page: %s", async (body, type, code) => {
		const fetcher = healthy();
		fetcher.mockResolvedValueOnce(response(body, type));
		expect(await probeCmsDeploy(candidate)).toMatchObject({ code });
	});
	it("accepts a page without image transforms", async () => {
		const fetcher = healthy();
		fetcher.mockResolvedValueOnce(
			response('<html><link href="/_astro/app.hash.css"></html>', "text/html"),
		);
		const result = await probeCmsDeploy(candidate);
		expect(result).not.toHaveProperty("code");
		expect(
			fetcher.mock.calls.some(([input]) => String(input).includes("/_image?")),
		).toBe(false);
	});
	it("does not accept an HTML fallback for CSS", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () => response());
		expect(await probeCmsDeploy(candidate)).toMatchObject({
			code: "PROBE_ASSET_INVALID",
		});
	});
	it("rejects image errors and network failures", async () => {
		const fetcher = healthy();
		const original = fetcher.getMockImplementation()!;
		fetcher.mockImplementation(async (input, init) =>
			String(input).includes("/_image?")
				? new Response(null, { status: 500 })
				: original(input, init),
		);
		expect(await probeCmsDeploy(candidate)).toMatchObject({
			code: "PROBE_HTTP_FAILED",
			retryable: false,
		});
		fetcher.mockRejectedValue(new Error("network failed"));
		expect(await probeCmsDeploy(candidate)).toMatchObject({
			code: "PROBE_NETWORK_FAILED",
			retryable: true,
		});
	});
	it("rejects an image response without native transform proof", async () => {
		const fetcher = healthy();
		const original = fetcher.getMockImplementation()!;
		fetcher.mockImplementation(async (input, init) => {
			const result = await original(input, init);
			result.headers.delete("X-Tedix-Image-Transform");
			return result;
		});
		expect(await probeCmsDeploy(candidate)).toMatchObject({
			code: "PROBE_IMAGE_INVALID",
		});
	});
	it("pins a shadow tenant while preserving canonical host and dependency paths", async () => {
		const fetcher = healthy();
		const dispatch = vi.fn((url: string, init: RequestInit) =>
			fetcher(url, init),
		);
		fetcher.mockResolvedValueOnce(
			response(
				'<html><link href="https://public.test/blog/_astro/app.hash.css"><img src="https://public.test/blog/_image?href=%2Fblog%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fhero.png&amp;w=64"></html>',
			),
		);
		expect(
			(
				await probeCmsDeploy({
					...candidate,
					url: "https://shadow.cms.test/blog",
					publicUrl: "https://public.test/blog",
					fetcher: dispatch,
				})
			).response.status,
		).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(3);
		expect(dispatch).toHaveBeenCalledTimes(3);
		for (const [input, init] of fetcher.mock.calls) {
			const url = new URL(String(input));
			expect(url.origin).toBe("https://shadow.cms.test");
			expect(url.pathname).toMatch(/^\/blog\//);
			expect(init?.headers).toMatchObject({
				"X-Tedix-Public-Host": "public.test",
			});
		}
	});
});

describe("probe failure classification", () => {
	it("names the failing request kind without exposing error text", () => {
		expect(
			classifyProbeError(new TypeError("Network connection lost."), false),
		).toBe("connection");
		expect(classifyProbeError(new Error("anything"), true)).toBe("timeout");
		expect(classifyProbeError("odd", false)).toBe("other");
	});
	it("keeps probe target and error kind in safe status details, drops free text", () => {
		expect(
			safeDeployDetails({
				probeTarget: "image",
				probeError: "connection",
				probeMessage: "secret text",
			}),
		).toEqual({ probeTarget: "image", probeError: "connection" });
		expect(safeDeployDetails({ probeTarget: "elsewhere" })).toBeUndefined();
	});
});
