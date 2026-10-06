import { describe, expect, it } from "vite-plus/test";
import { PUBLIC_ROBOTS_CONTENT_SIGNAL } from "./content-signals";
import { buildPublicRobotsTxt } from "./robots";

describe("public robots.txt", () => {
	it("publishes the explicit public-content policy for AI and wildcard groups", () => {
		const robots = buildPublicRobotsTxt(
			new URL("https://tedix.dev/sitemap-index.xml"),
			"https://tedix.dev/sitemap-posts.xml",
		);

		expect(robots.match(/^Content-Signal:.*$/gim)).toEqual([
			`Content-Signal: ${PUBLIC_ROBOTS_CONTENT_SIGNAL}`,
			`Content-Signal: ${PUBLIC_ROBOTS_CONTENT_SIGNAL}`,
		]);
		expect(robots).toContain("User-agent: GPTBot");
		expect(robots).toContain("User-agent: Cloudflare-AI-Search");
		expect(robots).toContain("User-agent: *\nContent-Signal:");
		expect(robots).toContain("User-agent: CCBot\nDisallow: /");
		expect(robots).toContain("Sitemap: https://tedix.dev/sitemap-index.xml");
		expect(robots).toContain("Sitemap: https://tedix.dev/sitemap-posts.xml");
	});
});
