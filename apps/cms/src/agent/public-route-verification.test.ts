import { describe, expect, it, vi } from "vite-plus/test";
import { verifyPublicCmsRoutes } from "./public-route-verification";

function page(
	url: string,
	options: {
		title?: string;
		h1?: string;
		lang?: string;
		canonical?: string;
	} = {},
) {
	return new Response(
		`<!doctype html><html lang="${options.lang ?? "en"}"><head><title>${options.title ?? "Tedix — Agents you can hold accountable"}</title><link href="${options.canonical ?? url}" rel="canonical"></head><body><h1>${options.h1 ?? "Agents you can hold accountable"}</h1></body></html>`,
		{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

describe("public CMS route verification", () => {
	it("proves the configured canonical route and records bounded page identity", async () => {
		const fetcher = vi.fn(async (url: string) => page(url));
		const result = await verifyPublicCmsRoutes({
			canonicalUrl: "https://tedix.dev/",
			routes: [
				{ path: "/", expectedLang: "en", expectedTitleContains: "Agents" },
			],
			fetcher: fetcher as typeof fetch,
		});
		expect(result.ok).toBe(true);
		expect(result.routes[0]).toMatchObject({
			path: "/",
			url: "https://tedix.dev/",
			status: 200,
			ok: true,
			lang: "en",
			h1: "Agents you can hold accountable",
		});
		expect(fetcher).toHaveBeenCalledWith(
			"https://tedix.dev/",
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("detects a blog feed accidentally served at the product root", async () => {
		const result = await verifyPublicCmsRoutes({
			canonicalUrl: "https://tedix.dev/",
			routes: [
				{
					path: "/",
					expectedTitleContains: "Agents",
					forbiddenTitle: "All articles",
				},
			],
			fetcher: (async (url: string) =>
				page(url, {
					title: "All articles — Tedix",
					h1: "All articles",
				})) as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.routes[0]?.title).toBe("All articles — Tedix");
	});

	it("rejects unsafe site addresses and routes before any fetch", async () => {
		const fetcher = vi.fn();
		for (const canonicalUrl of [
			"http://tedix.dev/",
			"https://user:pass@tedix.dev/",
			"https://127.0.0.1/",
			"https://localhost/",
			"https://tedix.dev:443/",
			"https://tedix.dev/%2e%2e/",
		]) {
			await expect(
				verifyPublicCmsRoutes({
					canonicalUrl,
					routes: [{ path: "/" }],
					fetcher,
				}),
			).rejects.toThrow();
		}
		for (const path of [
			"https://other.dev/",
			"//other.dev/",
			"/../private",
			"/%2f%2fother.dev",
			"/a?token=x",
			"/a\\b",
		]) {
			await expect(
				verifyPublicCmsRoutes({
					canonicalUrl: "https://tedix.dev/",
					routes: [{ path }],
					fetcher,
				}),
			).rejects.toThrow();
		}
		await expect(
			verifyPublicCmsRoutes({
				canonicalUrl: "https://tedix.dev/",
				routes: [],
				fetcher,
			}),
		).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("rejects external and cross-path redirects", async () => {
		for (const location of ["https://example.com/", "/blog/"]) {
			const result = await verifyPublicCmsRoutes({
				canonicalUrl: "https://tedix.dev/",
				routes: [{ path: "/" }],
				fetcher: (async () =>
					new Response(null, {
						status: 302,
						headers: { location },
					})) as typeof fetch,
			});
			expect(result.ok).toBe(false);
			expect(result.routes[0]?.error).toMatch(/redirected away/);
		}
	});

	it("requires exact canonical and localized language", async () => {
		const result = await verifyPublicCmsRoutes({
			canonicalUrl: "https://tedix.dev/",
			routes: [{ path: "/de", expectedLang: "de" }],
			fetcher: (async (url: string) =>
				page(url, {
					canonical: "https://tedix.dev/",
					lang: "en",
				})) as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.routes[0]?.canonical).toBe("https://tedix.dev/");
	});

	it("keeps prefix-mounted tenant checks under its configured public path", async () => {
		const fetcher = vi.fn(async (url: string) => page(url));
		const result = await verifyPublicCmsRoutes({
			canonicalUrl: "https://customer.example.com/guide/",
			routes: [{ path: "/article" }],
			fetcher: fetcher as typeof fetch,
		});
		expect(result.ok).toBe(true);
		expect(fetcher.mock.calls[0]?.[0]).toBe(
			"https://customer.example.com/guide/article",
		);
	});
});
