import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	handleWebMcpRequest,
	WEBMCP_MCP_PATH,
	WEBMCP_PROTOCOL_VERSION,
	type WebMcpOrgInfo,
} from "./webmcp";

const org: WebMcpOrgInfo = {
	slug: "a",
	siteTitle: "A",
	publicSiteUrl: "https://site.example",
	publicPathPrefix: "/guide",
	webMcpToolPacks: ["site-search"],
};
function request(query: string, options: Record<string, unknown> = {}) {
	return new Request(`https://site.example/guide${WEBMCP_MCP_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "search_site",
			"mcp-protocol-version": WEBMCP_PROTOCOL_VERSION,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "search_site", arguments: { query, ...options } },
			_meta: {
				"io.modelcontextprotocol/protocolVersion": WEBMCP_PROTOCOL_VERSION,
				"io.modelcontextprotocol/clientInfo": {},
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		}),
	});
}
async function search(site = org, options: Record<string, unknown> = {}) {
	return (await (await handleWebMcpRequest(
		request("body phrase", options),
		site,
		WEBMCP_MCP_PATH,
		{ limit: async () => ({ success: true }) },
	))!.json()) as any;
}
afterEach(() => vi.unstubAllGlobals());
describe("native published WebMCP search", () => {
	it("uses native body search, published status, titles, routes and locale", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						items: [
							{
								collection: "pages",
								id: "1",
								slug: "nested/page",
								title: "Actual heading",
								locale: "en",
								url: "https://site.example/guide/nested/page",
							},
							{
								collection: "posts",
								id: "2",
								slug: "energie",
								title: "Energie",
								locale: "de",
								url: "https://site.example/guide/de/posts/energie",
							},
						],
					},
				}),
			),
		);
		vi.stubGlobal("fetch", fetch);
		const result = await search();
		const url = new URL(fetch.mock.calls[0]![0]);
		expect(url.pathname).toBe("/guide/_tedix/search.json");
		expect(url.searchParams.get("q")).toBe("body phrase");
		expect(url.searchParams.has("status")).toBe(false);
		expect(url.searchParams.has("limit")).toBe(false);
		expect(result.result.structuredContent.results).toEqual([
			{
				title: "Actual heading",
				url: "https://site.example/guide/nested/page",
			},
			{ title: "Energie", url: "https://site.example/guide/de/posts/energie" },
		]);
	});
	it("forwards native search controls and returns plain-text excerpts", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					data: {
						items: [
							{
								collection: "posts",
								id: "1",
								title: "Deutsch",
								url: "https://site.example/guide/de/posts/article",
								snippet:
									"<mark>Hallo</mark> &amp; &lt;script&gt; &quot;text&quot; &#39;x&#39;",
							},
						],
					},
				}),
			),
		);
		vi.stubGlobal("fetch", fetch);
		const result = await search(org, {
			collections: ["posts", "pages"],
			locale: "de",
			limit: 3,
		});
		const url = new URL(fetch.mock.calls[0]![0]);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			q: "body phrase",
			collections: "posts,pages",
			locale: "de",
			limit: "3",
		});
		expect(result.result.structuredContent.results[0].excerpt).toBe(
			"Hallo & <script> \"text\" 'x'",
		);
		expect(result.result.content[0].text).toContain("Hallo & <script>");
	});
	it("rejects unsupported selectors and invalid bounds before fetching", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		for (const options of [
			{ status: "draft" },
			{ limit: 0 },
			{ limit: 101 },
			{ limit: 1.5 },
			{ collections: ["../private"] },
			{ locale: "de&status=draft" },
		]) {
			expect((await search(org, options)).result.isError).toBe(true);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects redirects outside the tenant and reports disabled/native errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { location: "https://other.example/_emdash/api/search" },
				}),
			),
		);
		expect((await search()).result.isError).toBe(true);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("disabled", { status: 503 })),
		);
		expect((await search()).result.isError).toBe(true);
	});
	it("rejects outside-mount native URLs, including locale-prefixed mounts", async () => {
		for (const url of [
			"https://site.example/private",
			"https://other.example/guide/page",
			"https://site.example/en/guide/read/page",
		]) {
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(
						JSON.stringify({
							data: {
								items: [
									{
										collection: "posts",
										id: "1",
										title: "Outside",
										locale: "en",
										url,
									},
								],
							},
						}),
					),
				),
			);
			const payload = await search();
			expect(payload.result.isError).toBe(true);
			expect(payload.result.content[0].text).toContain("outside this tenant");
		}
	});
	it("accepts native localized URLs on a subdomain without a mount", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						data: {
							items: [
								{
									collection: "posts",
									id: "1",
									title: "Translated",
									url: "https://site.example/de/blog/article",
								},
							],
						},
					}),
				),
			),
		);
		expect(
			(await search({ ...org, publicPathPrefix: null })).result
				.structuredContent.results[0].url,
		).toBe("https://site.example/de/blog/article");
	});
});
