import { describe, expect, it } from "vite-plus/test";
import { MEMBER_CLIENT_SCOPE } from "@tedix/mcp-shared/auth/consent-scopes";
import {
	handleOAuthClientMetadata,
	TEDIX_CLI_CLIENT_METADATA,
	TEDIX_CLI_REDIRECT_URI,
} from "./oauth-client-metadata";

const CLIENT_ID =
	"https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json";

describe("Tedix CLI client metadata", () => {
	it("publishes one stable, branded, public PKCE client with an exact HTTPS broker redirect", async () => {
		const response = handleOAuthClientMetadata(new Request(CLIENT_ID));
		expect(response?.status).toBe(200);
		expect(response?.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(response?.headers.get("Cache-Control")).toContain("public");
		expect(await response?.json()).toEqual(TEDIX_CLI_CLIENT_METADATA);
		expect(TEDIX_CLI_CLIENT_METADATA).toMatchObject({
			client_id: CLIENT_ID,
			client_name: "Tedix CLI",
			client_uri: "https://tedix.dev",
			logo_uri: "https://os.tedix.dev/images/tedi-astronaut-waving.png",
			redirect_uris: [TEDIX_CLI_REDIRECT_URI],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		});
		expect(TEDIX_CLI_REDIRECT_URI).toBe(
			"https://os.tedix.dev/cli/oauth/callback",
		);
	});

	it("serves Devin through the same metadata handler with bounded public-client redirects", async () => {
		const id = "https://os.tedix.dev/.well-known/oauth-client/devin.json";
		const response = handleOAuthClientMetadata(new Request(id));
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			client_id: id,
			client_name: "Devin",
			client_uri: "https://devin.ai",
			redirect_uris: [
				"https://api.devin.ai/mcp/oauth/callback",
				"http://localhost:8765/callback",
			],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: MEMBER_CLIENT_SCOPE,
		});
		const head = handleOAuthClientMetadata(new Request(id, { method: "HEAD" }));
		expect(head?.status).toBe(200);
		expect(await head?.text()).toBe("");
		expect(
			handleOAuthClientMetadata(new Request(id, { method: "POST" }))?.status,
		).toBe(405);
		for (const url of [
			id.replace("https:", "http:"),
			id.replace("os.tedix.dev", "evil.example"),
			`${id}/extra`,
		]) {
			expect(handleOAuthClientMetadata(new Request(url))).toBeNull();
		}
	});

	it("serves OpenCode a public client with its default loopback callback", async () => {
		const id = "https://os.tedix.dev/.well-known/oauth-client/opencode.json";
		const response = handleOAuthClientMetadata(new Request(id));
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual({
			client_id: id,
			client_name: "OpenCode",
			client_uri: "https://opencode.ai",
			redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
			scope: MEMBER_CLIENT_SCOPE,
		});
	});

	it("rejects mutation methods and lookalike hosts or paths", () => {
		expect(
			handleOAuthClientMetadata(new Request(CLIENT_ID, { method: "POST" }))
				?.status,
		).toBe(405);
		for (const url of [
			"https://evil.example/.well-known/oauth-client/tedix-cli.json",
			"https://os.tedix.dev/.well-known/oauth-client/tedix-cli",
			"http://os.tedix.dev/.well-known/oauth-client/tedix-cli.json",
		]) {
			expect(handleOAuthClientMetadata(new Request(url))).toBeNull();
		}
	});
});
