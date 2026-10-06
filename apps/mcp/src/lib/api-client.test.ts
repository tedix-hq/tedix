import { describe, expect, it, vi } from "vite-plus/test";
import {
	getApiClient,
	getTediProfileApiClient,
	MCP_EDGE_CONTROL_PLANE_SCOPES,
} from "./api-client";

describe("MCP edge API service role", () => {
	it("rejects a missing service binding", () => {
		expect(() => getApiClient()).toThrow(
			"Service binding (serviceFetch) is required",
		);
	});
	it("delegates only the reviewed control-plane read scopes", async () => {
		expect(MCP_EDGE_CONTROL_PLANE_SCOPES).toEqual(["apps:read", "tedis:read"]);
		expect(MCP_EDGE_CONTROL_PLANE_SCOPES).not.toContain("*");
		expect(MCP_EDGE_CONTROL_PLANE_SCOPES).not.toContain("platform:admin");

		const fetch = vi.fn(async (request: Request) => {
			expect(new URL(request.url).origin).toBe("https://api");
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe(
				"apps:read tedis:read",
			);
			return Response.json({ json: { id: "app-1" } });
		});
		const client = getApiClient({
			serviceFetch: { fetch } as unknown as Fetcher,
		});
		await client.apps.get({
			appId: "00000000-0000-4000-8000-000000000001",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("scopes cross-org tedi profile reads to the internal system tenant", async () => {
		const fetch = vi.fn(async (request: Request) => {
			expect(new URL(request.url).origin).toBe("https://api");
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			expect(request.headers.get("X-Tedix-Org-Id")).toBe("system");
			expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe(
				"apps:read tedis:read",
			);
			return Response.json({ json: { id: "tedi-1" } });
		});
		const client = getTediProfileApiClient({ fetch } as unknown as Fetcher);
		await client.tedis.get({
			tediId: "00000000-0000-4000-8000-000000000001",
		});
		expect(fetch).toHaveBeenCalledOnce();
	});
});
