import { describe, expect, it } from "vite-plus/test";
import {
	classifyMcpClientRegistrationMethod,
	encodeTedixCliOAuthRelayState,
	TEDIX_CLI_OAUTH_CLIENT_ID,
	TEDIX_CLI_OAUTH_REDIRECT_URI,
} from "./oauth-client-registration";

describe("classifyMcpClientRegistrationMethod", () => {
	it("recognizes the stable Tedix CLI CIMD identity", () => {
		expect(TEDIX_CLI_OAUTH_CLIENT_ID).toBe(
			"https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json",
		);
		expect(
			classifyMcpClientRegistrationMethod({
				authType: "oauth",
				clientId: TEDIX_CLI_OAUTH_CLIENT_ID,
			}),
		).toBe("cimd");
	});

	it("binds the public HTTPS callback to a validated loopback port", () => {
		expect(TEDIX_CLI_OAUTH_REDIRECT_URI).toBe(
			"https://os.tedix.dev/cli/oauth/callback",
		);
		expect(encodeTedixCliOAuthRelayState("nonce_1", 49_152)).toBe(
			"nonce_1.49152",
		);
		expect(() => encodeTedixCliOAuthRelayState("bad/state", 49_152)).toThrow();
		expect(() => encodeTedixCliOAuthRelayState("nonce", 0)).toThrow();
	});

	it("recognizes CIMD URL client ids", () => {
		expect(
			classifyMcpClientRegistrationMethod({
				authType: "oauth",
				clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
			}),
		).toBe("cimd");
	});

	it("classifies other interactive OAuth clients as DCR compatibility", () => {
		expect(
			classifyMcpClientRegistrationMethod({
				authType: "oauth",
				clientId: "dcr-client-123",
			}),
		).toBe("dcr");
	});

	it("classifies managed machine clients as pre-registered", () => {
		for (const authType of ["m2m", "tedi", "external_agent"] as const) {
			expect(
				classifyMcpClientRegistrationMethod({
					authType,
					clientId: "managed-client-123",
				}),
			).toBe("pre_registered");
		}
	});

	it("does not invent a registration mode without a client identity", () => {
		expect(
			classifyMcpClientRegistrationMethod({ authType: "anonymous" }),
		).toBeUndefined();
	});
});
