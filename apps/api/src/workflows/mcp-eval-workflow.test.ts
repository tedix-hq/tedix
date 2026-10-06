import { describe, expect, it, vi } from "vite-plus/test";
import { FirstPartyMcpError } from "../lib/first-party-mcp";
import { listMcpEvalTools } from "./mcp-eval-client";
import { buildMcpEvalTestSuite } from "./mcp-eval-workflow";

vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));

describe("listMcpEvalTools", () => {
	function evalHost(supportedVersions: string[]) {
		const requests: Array<{
			headers: Headers;
			body: {
				id: unknown;
				method: string;
				params?: { _meta?: Record<string, unknown> };
			};
		}> = [];
		const fetch = async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body));
			requests.push({ headers: new Headers(init.headers), body });
			const result =
				body.method === "server/discover"
					? { resultType: "complete", supportedVersions, capabilities: {} }
					: {
							resultType: "complete",
							ttlMs: 0,
							cacheScope: "private",
							tools: [{ name: "search", inputSchema: { type: "object" } }],
						};
			return Response.json({ jsonrpc: "2.0", id: body.id, result });
		};
		return { fetch, requests };
	}

	it("binds 2026 protocol metadata and headers to discovery, then tools/list", async () => {
		const host = evalHost(["2026-07-28"]);

		const tools = await listMcpEvalTools({
			fetch: host.fetch,
			mcpUrl: "https://mcp.tedix.dev/mcp",
			mcpHost: "acme.mcp.tedix.dev",
		});

		expect(tools.map((tool) => tool.name)).toEqual(["search"]);
		expect(host.requests.map((request) => request.body.method)).toEqual([
			"server/discover",
			"tools/list",
		]);
		for (const request of host.requests) {
			expect(request.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
			expect(request.headers.get("Mcp-Method")).toBe(request.body.method);
			expect(request.headers.get("X-Tedix-Host")).toBe("acme.mcp.tedix.dev");
			expect(request.body.params?._meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			});
		}
	});

	it("rejects a host that does not advertise 2026-07-28 as unsupported", async () => {
		const host = evalHost(["2025-11-25"]);

		const failure = listMcpEvalTools({
			fetch: host.fetch,
			mcpUrl: "https://mcp.tedix.dev/mcp",
			mcpHost: "acme.mcp.tedix.dev",
		});

		await expect(failure).rejects.toBeInstanceOf(FirstPartyMcpError);
		await expect(failure).rejects.toMatchObject({
			kind: "unsupported_protocol",
		});
		expect(host.requests.map((request) => request.body.method)).toEqual([
			"server/discover",
		]);
	});
});

describe("buildMcpEvalTestSuite", () => {
	const tools = [
		{ name: "search_products", description: "Search the product catalog" },
		{ name: "get_product" },
	];

	it("uses the caller's custom prompts and expectations instead of generated tests", () => {
		const customTests = [
			{
				title: "find a product",
				prompt: "Find a red bicycle",
				expectedTools: ["search_products"],
			},
			{ title: "off-topic", prompt: "Tell me a joke", expectedTools: [] },
		];

		expect(buildMcpEvalTestSuite(tools, customTests)).toEqual({
			source: "custom",
			suite: customTests,
		});
	});

	it.each([undefined, []])(
		"generates routing tests when custom tests are %j",
		(customTests) => {
			expect(buildMcpEvalTestSuite(tools, customTests)).toEqual({
				source: "auto-generated",
				suite: [
					{
						title: "route-to-search_products",
						prompt: "Search the product catalog. Use the search_products tool.",
						expectedTools: ["search_products"],
					},
					{
						title: "route-to-get_product",
						prompt: "Use the get_product tool to perform its function.",
						expectedTools: ["get_product"],
					},
				],
			});
		},
	);

	it("bounds generated evaluation work to the first twenty discovered tools", () => {
		const discovered = Array.from({ length: 25 }, (_, index) => ({
			name: `tool_${index}`,
		}));
		const { suite } = buildMcpEvalTestSuite(discovered);
		expect(suite).toHaveLength(20);
		expect(suite.at(-1)?.expectedTools).toEqual(["tool_19"]);
	});
});
