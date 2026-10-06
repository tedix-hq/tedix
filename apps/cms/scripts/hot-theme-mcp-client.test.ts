import { describe, expect, it } from "vite-plus/test";
import { callHotThemeCode, connectHotThemeMcp } from "./hot-theme-mcp-client";

type RecordedRequest = {
	headers: Headers;
	body: {
		id: unknown;
		method: string;
		params?: { name?: string; _meta?: Record<string, unknown> };
	};
};

function siteBuilder(supportedVersions: string[]) {
	const requests: RecordedRequest[] = [];
	const fetch = async (_url: string, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as RecordedRequest["body"];
		requests.push({ headers: new Headers(init.headers), body });
		const result =
			body.method === "server/discover"
				? { resultType: "complete", supportedVersions, capabilities: {} }
				: {
						resultType: "complete",
						content: [{ type: "text", text: '{"result":true}' }],
					};
		return Response.json({ jsonrpc: "2.0", id: body.id, result });
	};
	return { fetch, requests };
}

describe("connectHotThemeMcp", () => {
	it("binds discovery and named calls to stateless MCP 2026-07-28", async () => {
		const server = siteBuilder(["2026-07-28"]);
		const client = await connectHotThemeMcp(
			"https://cms.example.test/mcp",
			{ "X-API-Key": "sk_test" },
			server.fetch,
		);
		const result = await callHotThemeCode(client, "async () => true");
		await client.close();

		expect(result.content).toEqual([{ type: "text", text: '{"result":true}' }]);
		expect(server.requests.map((request) => request.body.method)).toEqual([
			"server/discover",
			"tools/call",
		]);
		const [discover, call] = server.requests;
		expect(discover?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
		expect(discover?.headers.get("Mcp-Method")).toBe("server/discover");
		expect(call?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
		expect(call?.headers.get("Mcp-Method")).toBe("tools/call");
		expect(call?.headers.get("Mcp-Name")).toBe("code");
		expect(call?.headers.get("X-API-Key")).toBe("sk_test");
		expect(call?.headers.get("User-Agent")).toBe(
			"tedix-cms-hot-theme-validate/1.0",
		);
		expect(call?.body.params?._meta).toMatchObject({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": {
				name: "tedix-cms-hot-theme-validate",
			},
			"io.modelcontextprotocol/clientCapabilities": {},
		});
	});

	it("refuses an endpoint that does not advertise 2026-07-28", async () => {
		const server = siteBuilder(["2025-11-25"]);
		await expect(
			connectHotThemeMcp("https://cms.example.test/mcp", {}, server.fetch),
		).rejects.toThrow();
		expect(server.requests.map((request) => request.body.method)).toEqual([
			"server/discover",
		]);
	});
});
