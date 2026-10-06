import { describe, expect, it } from "vite-plus/test";
import {
	handleOutboundMcpClientMetadata,
	TEDIX_OUTBOUND_MCP_CLIENT_METADATA,
} from "./oauth-client-metadata";

const CLIENT_ID =
	"https://api.tedix.dev/.well-known/oauth-client/tedix-mcp.json";

describe("outbound MCP client metadata", () => {
	it("serves the stable public PKCE client identity", async () => {
		const response = handleOutboundMcpClientMetadata(new Request(CLIENT_ID));
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual(TEDIX_OUTBOUND_MCP_CLIENT_METADATA);
		expect(TEDIX_OUTBOUND_MCP_CLIENT_METADATA).toMatchObject({
			client_id: CLIENT_ID,
			redirect_uris: ["https://api.tedix.dev/oauth/mcp/callback"],
			token_endpoint_auth_method: "none",
		});
	});

	it("supports HEAD, rejects mutation, and ignores unrelated routes", async () => {
		const head = handleOutboundMcpClientMetadata(
			new Request(CLIENT_ID, { method: "HEAD" }),
		);
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe("");
		expect(
			handleOutboundMcpClientMetadata(
				new Request(CLIENT_ID, { method: "POST" }),
			)?.status,
		).toBe(405);
		expect(
			handleOutboundMcpClientMetadata(
				new Request("https://api.tedix.dev/health"),
			),
		).toBeNull();
	});
});
