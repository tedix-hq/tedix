import { describe, expect, it } from "vite-plus/test";
import { enforceMcpAccess } from "../mcp-access";
import { resolveWireAnnotations } from "./tool-registration-policy";
import type { AppTool } from "./server-context";

const toolId = `${"the"}${"rion"}_review_input`;
const toolScopes = { [toolId]: ["mcp:skills.admin"] };

function request(scopes: string) {
	return new Request("https://tenant.mcp.tedix.dev/mcp", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-tedix-auth-type": "external_agent",
			"x-tedix-auth-scopes": scopes,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: toolId, arguments: { input: "bounded" } },
		}),
	});
}

async function authorize(scopes: string) {
	return enforceMcpAccess({
		request: request(scopes),
		hostname: "tenant.mcp.tedix.dev",
		resolvedApp: {
			app: { slug: "tenant", organizationId: "org-1" },
			metadata: {
				mcpConfig: { authMode: "authenticated", toolScopes },
			},
			tools: [
				{
					id: "imported-row",
					toolId,
					toolTypeId: "mcp",
					title: "Review input",
					description: "Runs a signed proven skill.",
					inputSchema: { type: "object", properties: {} },
					config: {
						transport: "mcp",
						mcpServerUrl: "https://provider.example.test/mcp",
						mcpToolName: toolId,
						approvalPolicy: "work_item",
					},
					writeCapability: "destructive",
					authRequired: true,
					enabled: true,
				},
			],
		} as unknown as Parameters<typeof enforceMcpAccess>[0]["resolvedApp"],
		env: {} as CloudflareEnv,
		oauthJwtPayload: null,
		isDev: false,
	});
}

describe("imported tool-factory gateway policy", () => {
	it("rejects a caller missing the imported tenant scope", async () => {
		const denied = await authorize("mcp:skills.read");
		expect(denied?.response.status).toBe(403);
		expect(await denied?.response.json()).toMatchObject({
			error: "insufficient_scope",
			required_scopes: ["mcp:skills.admin"],
			missing_scopes: ["mcp:skills.admin"],
		});
	});

	it("admits the exact imported tenant scope", async () => {
		expect(await authorize("mcp:skills.admin")).toBeNull();
	});

	it("projects the signed approval classification into the MCP wire hints", () => {
		expect(
			resolveWireAnnotations({
				toolId,
				config: { transport: "mcp", approvalPolicy: "work_item" },
				writeCapability: "destructive",
				annotations: null,
				meta: null,
			} as unknown as AppTool),
		).toMatchObject({ destructiveHint: true, readOnlyHint: false });
	});
});
