import { describe, expect, it } from "vite-plus/test";
import {
	handleTedixCliClientMetadata,
	TEDIX_CLI_CLIENT_METADATA,
	TEDIX_CLI_REDIRECT_URI,
} from "./oauth-client-metadata";

const CLIENT_ID =
	"https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json";

describe("Tedix CLI client metadata", () => {
	it("publishes one stable, branded, public PKCE client with an exact HTTPS broker redirect", async () => {
		const response = handleTedixCliClientMetadata(new Request(CLIENT_ID));
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

	it("rejects mutation methods and lookalike hosts or paths", () => {
		expect(
			handleTedixCliClientMetadata(new Request(CLIENT_ID, { method: "POST" }))
				?.status,
		).toBe(405);
		for (const url of [
			"https://evil.example/.well-known/oauth-client/tedix-cli.json",
			"https://os.tedix.dev/.well-known/oauth-client/tedix-cli",
			"http://os.tedix.dev/.well-known/oauth-client/tedix-cli.json",
		]) {
			expect(handleTedixCliClientMetadata(new Request(url))).toBeNull();
		}
	});
});
