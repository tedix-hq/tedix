import { describe, expect, it } from "vite-plus/test";
import { getTrustedMcpHostAppContext } from "./mcp-host-context";

function headers() {
	return new Headers({
		"X-Tedix-Mcp-App-Id": "app_1",
		"X-Tedix-Mcp-App-Org-Id": "org_1",
		"X-Tedix-Mcp-App-Slug": "tenant-unified",
	});
}

describe("trusted MCP host app context", () => {
	it("trusts MCP host headers from service-binding traffic", () => {
		expect(
			getTrustedMcpHostAppContext({
				authType: "service-binding",
				headers: headers(),
			}),
		).toEqual({
			appId: "app_1",
			appOrgId: "org_1",
			appSlug: "tenant-unified",
		});
	});

	it("ignores spoofed MCP host headers from direct callers", () => {
		for (const authType of ["user", "tedi", "apikey", "m2m"] as const) {
			expect(
				getTrustedMcpHostAppContext({ authType, headers: headers() }),
			).toEqual({});
		}
	});
});
