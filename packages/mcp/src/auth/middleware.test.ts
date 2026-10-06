import { describe, expect, it } from "vite-plus/test";
import { createMcpAuthMiddleware } from "./middleware";

describe("gateway-token capability delegation", () => {
	it("defaults to no authority and accepts only configured exact scopes", async () => {
		const request = new Request("https://mcp.internal/mcp", {
			headers: { Authorization: "Bearer shared-secret" },
		});
		const unscoped = await createMcpAuthMiddleware({
			gatewayToken: "shared-secret",
		})(request);
		expect(unscoped).toMatchObject({
			authMethod: "gateway-token",
			scopes: [],
			principal: { scopes: [] },
		});

		const scoped = await createMcpAuthMiddleware({
			gatewayToken: "shared-secret",
			gatewayScopes: ["mcp:content.read"],
		})(request);
		expect(scoped).toMatchObject({
			scopes: ["mcp:content.read"],
			principal: { scopes: ["mcp:content.read"] },
		});
	});
});
