import { SsrfBlockedError } from "@tedix/ssrf-guard";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { fetchContentSource } from "./content-source-fetch";

afterEach(() => vi.unstubAllGlobals());

describe("fetchContentSource", () => {
	it.each([
		"http://localhost/feed.xml",
		"http://10.0.0.5/sitemap.xml",
		"https://metadata.internal/doc.pdf",
	])("refuses %s", async (url) => {
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		await expect(fetchContentSource(url)).rejects.toBeInstanceOf(
			SsrfBlockedError,
		);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("refuses a redirect to a private address", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { Location: "http://127.0.0.1/secret" },
				}),
			),
		);
		await expect(
			fetchContentSource("https://example.com/sitemap.xml"),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("fetches a public source and a tenant's own Tedix site", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response("ok"));
		vi.stubGlobal("fetch", fetcher);
		await fetchContentSource("https://example.com/feed.xml");
		await fetchContentSource("https://acme.cms.tedix.dev/sitemap.xml");
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
