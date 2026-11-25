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

	it("leaves permission selection to consent even with broad configured scopes", async () => {
		const denial = await unauthenticated({
			protectedResourceMetadata: {
				scopes_supported: [
					"connections.admin",
					"connections.execute",
					"mcp:work.admin",
					"mcp:work.read",
					"mcp:work.write",
					"platform:admin",
					"tenant:custom.read",
				],
			},
		});
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

function scopedCall(headers: Record<string, string>) {
	return enforceMcpAccess({
		request: new Request("https://gateway.example.test/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-tedix-auth-type": "tedi",
				"x-tedix-auth-scopes": "mcp:work.read",
				...headers,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 7,
				method: "tools/call",
				params: { name: "admin_only", arguments: {} },
			}),
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
					toolScopes: { admin_only: ["mcp:work.write"] },
				},
			},
			tools: [],
		} as Parameters<typeof enforceMcpAccess>[0]["resolvedApp"],
		env: {} as CloudflareEnv,
		oauthJwtPayload: null,
		isDev: false,
	});
}

describe("authenticated insufficient_scope challenge", () => {
	it("names held plus missing scopes and the permission in plain words", async () => {
		const denial = await scopedCall({});
		expect(denial?.reason).toBe("insufficient_scope");
		expect(denial?.response.status).toBe(403);
		// Clients replace their grant on re-authorization, so the challenge
		// carries the held scope alongside the missing one.
		expect(denial?.response.headers.get("WWW-Authenticate")).toContain(
			'scope="mcp:work.read mcp:work.write"',
		);
		const body = (await denial?.response.json()) as {
			error?: string;
			message?: string;
		};
		expect(body.error).toBe("insufficient_scope");
		expect(body.message).toContain(
			'Allow the "mcp:work.write" permission when reconnecting.',
		);
	});

	it("answers Codex/ChatGPT clients with a 200 tool result carrying _meta", async () => {
		const denial = await scopedCall({
			"x-tedix-auth-client-id": "https://chatgpt.com/oauth/codex/client.json",
		});
		expect(denial?.reason).toBe("insufficient_scope");
		expect(denial?.response.status).toBe(200);
		const body = (await denial?.response.json()) as {
			id?: number;
			result?: {
				isError?: boolean;
				content?: { text?: string }[];
				_meta?: Record<string, string[]>;
			};
		};
		expect(body.id).toBe(7);
		expect(body.result?.isError).toBe(true);
		expect(body.result?.content?.[0]?.text).toContain(
			'Allow the "mcp:work.write" permission when reconnecting.',
		);
		expect(body.result?._meta?.["mcp/www_authenticate"]?.[0]).toContain(
			'scope="mcp:work.read mcp:work.write"',
		);
		expect(denial?.response.headers.get("WWW-Authenticate")).toContain(
			'error="insufficient_scope"',
		);
	});
});
