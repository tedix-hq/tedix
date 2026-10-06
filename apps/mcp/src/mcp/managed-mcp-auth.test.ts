import { describe, expect, it } from "vite-plus/test";
import {
	getTedixManagedTediHost,
	isTedixManagedMcpUrl,
	resolveManagedMcpAuthHeaders,
} from "./managed-mcp-auth";

describe("managed MCP auth", () => {
	it("recognizes managed app, tedi, and platform-hosted upstream MCP URLs", () => {
		expect(isTedixManagedMcpUrl("https://cto.tedi.tedix.dev/mcp")).toBe(true);
		expect(isTedixManagedMcpUrl("https://reflexos.tedi.tedix.tech/mcp")).toBe(
			true,
		);
		expect(isTedixManagedMcpUrl("https://reflexos.tedix.tech/mcp")).toBe(true);
		expect(isTedixManagedMcpUrl("https://reflexos.mcp.tedix.tech/mcp")).toBe(
			true,
		);
		expect(isTedixManagedMcpUrl("https://tedix.mcp.tedix.dev/mcp")).toBe(true);
		expect(isTedixManagedMcpUrl("https://mcp.cloudflare.com/mcp")).toBe(false);
		expect(isTedixManagedMcpUrl("https://api.tedix.tech/rpc")).toBe(false);
		expect(isTedixManagedMcpUrl("http://cto.tedi.tedix.dev/mcp")).toBe(false);
	});

	it("extracts service-binding routable tedi hosts only", () => {
		expect(getTedixManagedTediHost("https://cto.tedi.tedix.dev/mcp")).toBe(
			"cto.tedi.tedix.dev",
		);
		expect(
			getTedixManagedTediHost("https://reflexos.tedi.tedix.tech/mcp"),
		).toBe("reflexos.tedi.tedix.tech");
		expect(getTedixManagedTediHost("https://reflexos.tedix.tech/mcp")).toBe(
			null,
		);
		expect(getTedixManagedTediHost("https://reflexos.mcp.tedix.tech/mcp")).toBe(
			null,
		);
		expect(getTedixManagedTediHost("https://tedix.mcp.tedix.dev/mcp")).toBe(
			null,
		);
		expect(getTedixManagedTediHost("https://api.tedix.tech/rpc")).toBe(null);
		expect(getTedixManagedTediHost("http://cto.tedi.tedix.dev/mcp")).toBe(null);
		expect(getTedixManagedTediHost("https://mcp.cloudflare.com/mcp")).toBe(
			null,
		);
	});

	it("resolves and filters credential headers via API service binding", async () => {
		const fetcher = {
			fetch: async (request: Request) => {
				expect(request.url).toBe("https://api/rpc/mcpCredentials/resolve");
				expect(request.headers.get("X-Service-Binding")).toBe("true");
				expect(request.headers.get("X-Tedix-Tedi-Id")).toBe("tedi-1");
				return Response.json({
					json: {
						headers: {
							authorization: "Bearer token",
							"X-Tedix-Org-Id": "org-1",
							"X-Tedix-Tedi-Id": "tedi-1",
							"X-Do-Not-Forward": "nope",
						},
					},
				});
			},
		};

		const headers = await resolveManagedMcpAuthHeaders({
			serverUrl: "https://cto.tedi.tedix.dev/mcp",
			env: { API_SERVICE: fetcher } as unknown as CloudflareEnv,
			tediId: "tedi-1",
			orgId: "org-1",
		});

		expect(headers).toEqual({
			Authorization: "Bearer token",
			"X-Tedix-Org-Id": "org-1",
			"X-Tedix-Tedi-Id": "tedi-1",
		});
	});
});
