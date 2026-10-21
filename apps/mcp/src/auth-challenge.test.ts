import { describe, expect, it } from "vite-plus/test";
import { enforceMcpAccess } from "./mcp-access";

function unauthenticated(mcpConfig: Record<string, unknown>) {
	return enforceMcpAccess({
		request: new Request("https://gateway.example.test/mcp", {
			method: "POST",
		}),
		hostname: "gateway.example.test",
		resolvedApp: {
			app: {
				id: "gateway",
				name: "Example",
				slug: "example",
				domain: null,
				organizationId: "org_example",
			},
			metadata: {
				mcpConfig: {
					authMode: "authenticated" as const,
					capabilities: [],
					enforcePolicies: false,
					...mcpConfig,
				},
			},
			tools: [],
		} as Parameters<typeof enforceMcpAccess>[0]["resolvedApp"],
		env: {} as CloudflareEnv,
		oauthJwtPayload: null,
		isDev: false,
	});
}

describe("unauthenticated MCP challenge", () => {
	it("points at the protected-resource metadata a gateway serves without tool scopes", async () => {
		const denial = await unauthenticated({
			protectedResourceMetadata: { scopes_supported: ["mcp:work.read"] },
		});
		expect(denial?.response.status).toBe(401);
		expect(denial?.response.headers.get("WWW-Authenticate")).toBe(
			'Bearer resource_metadata="https://gateway.example.test/.well-known/oauth-protected-resource"',
		);
	});

	it("keeps the bare realm when the app advertises no OAuth at all", async () => {
		const denial = await unauthenticated({});
		expect(denial?.response.headers.get("WWW-Authenticate")).toBe(
			'Bearer realm="MCP"',
		);
	});
});
