import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { probeCmsDeploy } from "./deploy-health";

const html =
	'<html><head><link href="/_astro/app.hash.css"></head><body><img src="/_image?href=%2Fmedia%2Fhero.png&amp;w=100"></body></html>';
const candidate = {
	url: "https://site.test",
	runtimeHealthUrl: "https://cms.test/health",
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
		if (url.href === candidate.runtimeHealthUrl) return runtimeHealth();
		return url.pathname === "/"
			? response()
			: url.pathname.includes("/_astro/")
				? response("body{}", "text/css")
				: response(new Uint8Array([1, 2, 3]), "image/webp");
	});
}
function runtimeHealth() {
	return Response.json({ service: "cms-runtime", deployProbeVersion: 1 });
}
afterEach(() => vi.restoreAllMocks());
describe("candidate deploy health", () => {
	it.each([undefined, 0, 2])(
		"rejects runtime probe version %s before tenant dispatch",
		async (deployProbeVersion) => {
			const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({
					status: "ok",
					service: "cms-runtime",
					deployProbeVersion,
				}),
			);
			const result = await probeCmsDeploy(candidate);
			expect(result).toMatchObject({
				code: "runtime-without-attestation",
				retryable: false,
				probeUrl: candidate.runtimeHealthUrl,
			});
			expect(result.response.status).toBe(409);
			expect(fetcher).toHaveBeenCalledExactlyOnceWith(
				candidate.runtimeHealthUrl,
				expect.objectContaining({
					redirect: "error",
					signal: candidate.signal,
				}),
			);
		},
	);
	it.each(["page", "asset", "image"])(
		"requires advertised attestation on the %s",
		async (stage) => {
			const fetcher = healthy();
			const original = fetcher.getMockImplementation()!;
			fetcher.mockImplementation(async (input, init) => {
				const result = await original(input, init);
				const path = new URL(String(input)).pathname;
				if (
					(stage === "page" && path === "/") ||
					(stage === "asset" && path.includes("/_astro/")) ||
					(stage === "image" && path === "/_image")
				) {
					result.headers.delete("X-Tedix-Bundle-Version");
					result.headers.delete("X-Tedix-Bundle-Etag");
				}
				return result;
			});
			expect(await probeCmsDeploy(candidate)).toMatchObject({
				code: "PROBE_BUNDLE_MISMATCH",
				retryable: false,
			});
		},
	);
	it("fetches real HTML, a declared page asset, and a transformed image without caches", async () => {
		const fetcher = healthy();
		expect((await probeCmsDeploy(candidate)).response.status).toBe(200);
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(fetcher.mock.calls[0]?.[0]).toBe(candidate.runtimeHealthUrl);
		for (const [input, init] of fetcher.mock.calls.slice(1)) {
			const url = new URL(String(input));
			expect(url.searchParams.get("_tedix_version")).toBe("7");
			expect(url.searchParams.get("_tedix_etag")).toBe("candidate");
			expect(url.searchParams.get("_tedix_nonce")).toBeTruthy();
			expect(init).toMatchObject({
				redirect: "error",
				headers: { "Cache-Control": "no-cache, no-store" },
				cf: { cacheTtl: 0, cacheEverything: false },
			});
		}
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
		[
			'<html><link href="/_astro/app.hash.css"></html>',
			"text/html",
			"PROBE_IMAGE_MISSING",
		],
	])("rejects an incomplete page: %s", async (body, type, code) => {
		const fetcher = healthy();
		fetcher
			.mockResolvedValueOnce(runtimeHealth())
			.mockResolvedValueOnce(response(body, type));
		expect(await probeCmsDeploy(candidate)).toMatchObject({ code });
	});
	it("does not accept an HTML fallback for CSS", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
			String(input) === candidate.runtimeHealthUrl
				? runtimeHealth()
				: response(),
		);
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
		fetcher
			.mockResolvedValueOnce(runtimeHealth())
			.mockResolvedValueOnce(
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
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(dispatch).toHaveBeenCalledTimes(4);
		expect(dispatch.mock.calls[0]?.[0]).toBe(candidate.runtimeHealthUrl);
		for (const [input, init] of fetcher.mock.calls.slice(1)) {
			const url = new URL(String(input));
			expect(url.origin).toBe("https://shadow.cms.test");
			expect(url.pathname).toMatch(/^\/blog\//);
			expect(init?.headers).toMatchObject({
				"X-Tedix-Public-Host": "public.test",
			});
		}
	});
});
