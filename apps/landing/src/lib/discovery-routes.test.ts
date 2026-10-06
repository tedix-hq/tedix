import type { APIContext } from "astro";
import { describe, expect, it } from "vite-plus/test";
import { GET as robots } from "../pages/robots.txt";
import { GET as sitemapIndex } from "../pages/sitemap-index.xml";
import { GET as llms } from "../pages/llms.txt";

function context(hostname: string, resolvedHostname?: string): APIContext {
	return {
		request: new Request(`https://${hostname}/`),
		locals: resolvedHostname ? { hostname: resolvedHostname } : {},
	} as APIContext;
}

const blogSitemap = "https://tedix.dev/sitemap-posts.xml";

describe("landing crawler discovery routes", () => {
	it.each(["tedix.dev", "www.tedix.dev"])(
		"advertises the native blog sitemap on %s",
		async (hostname) => {
			const robotsResponse = await robots(context(hostname));
			const indexResponse = await sitemapIndex(context(hostname));
			expect(robotsResponse.headers.get("Content-Type")).toContain(
				"text/plain",
			);
			expect(await robotsResponse.text()).toContain(`Sitemap: ${blogSitemap}`);
			expect(indexResponse.headers.get("Content-Type")).toContain(
				"application/xml",
			);
			const index = await indexResponse.text();
			expect(index).toContain(`<loc>${blogSitemap}</loc>`);
			expect(index).toContain(
				`<loc>https://${hostname}/sitemap-pages.xml</loc>`,
			);
			expect(index).not.toContain("blog.tedix.dev");
		},
	);

	it("does not advertise Tedix blog content for a customer hostname", async () => {
		const robotsResponse = await robots(
			context("tedix.dev", "customer.example"),
		);
		const robotsText = await robotsResponse.text();
		expect(robotsText).toContain(
			"Sitemap: https://customer.example/sitemap-index.xml",
		);
		expect(robotsText).not.toContain(blogSitemap);
		const indexResponse = await sitemapIndex(context("customer.example"));
		expect(await indexResponse.text()).not.toContain("<loc>");
	});

	it("links the blog and its native index without promising an unavailable markdown feed", async () => {
		const response = await llms(context("tedix.dev"));
		const text = await response.text();
		expect(response.headers.get("Content-Type")).toContain("text/markdown");
		expect(text).toContain("[Blog](https://tedix.dev/blog)");
		expect(text).toContain(`[Blog sitemap](${blogSitemap})`);
		expect(text).not.toContain("blog.tedix.dev");
	});
});
