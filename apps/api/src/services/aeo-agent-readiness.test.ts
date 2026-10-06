import { describe, expect, it } from "vite-plus/test";
import { scanAgentReadiness } from "./aeo-agent-readiness";

function response(body: string, init: ResponseInit = {}): Response {
	return new Response(body, init);
}

describe("scanAgentReadiness", () => {
	it("returns scored checks with bounded HTTP evidence", async () => {
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/robots.txt")) {
				return response(
					"User-agent: GPTBot\nAllow: /\nContent-Signal: ai-train=no, search=yes, ai-input=yes\nSitemap: https://example.com/sitemap.xml",
					{ status: 200, headers: { "content-type": "text/plain" } },
				);
			}
			if (url.endsWith("/sitemap.xml")) {
				return response("<urlset></urlset>", { status: 200 });
			}
			if (url === "https://example.com/") {
				return response("# Example", {
					status: 200,
					headers: {
						"content-type": "text/markdown",
						link: '</.well-known/api-catalog>; rel="api-catalog"',
					},
				});
			}
			return response("missing", { status: 404 });
		}) as typeof fetch;

		const result = await scanAgentReadiness(
			"https://example.com/",
			"content",
			fetchImpl,
		);

		expect(result.hostname).toBe("example.com");
		expect(result.summary).toEqual({ pass: 6, fail: 0, neutral: 6 });
		expect(result.level).toBe(5);
		expect(
			result.checks.find((item) => item.key === "contentSignals"),
		).toMatchObject({
			status: "pass",
			evidence: {
				request: { url: "https://example.com/robots.txt" },
				response: { status: 200 },
			},
		});
	});

	it("rejects an unsafe input before fetching it", async () => {
		const fetchImpl = (async () =>
			response("", { status: 200 })) as typeof fetch;
		await expect(
			scanAgentReadiness("https://127.0.0.1/secrets", "all", fetchImpl),
		).rejects.toThrow("Cannot connect to private networks");
	});
});
