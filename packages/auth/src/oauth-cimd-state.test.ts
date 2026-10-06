import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import {
	buildCimdAuthorizationUrl,
	derivePkceS256Challenge,
	generatePkceVerifier,
	openOutboundMcpOAuthState,
	OUTBOUND_MCP_OAUTH_STATE_TTL_SECONDS,
	sealOutboundMcpOAuthState,
} from "./oauth-cimd-state.ts";

const transaction = {
	appId: "provider",
	organizationId: "00000000-0000-4000-8000-000000000001",
	tenantId: "org_tedix",
	grantedBy: "user_1",
	expectedIssuer: "https://auth.example.com",
	issSupported: true,
	tokenUrl: "https://auth.example.com/token",
	resource: "https://mcp.example.com/mcp",
	redirectUrl: "https://os.tedix.dev/oauth/callback",
	codeVerifier: "v".repeat(43),
	scopes: ["mcp:tools"],
};

describe("outbound MCP CIMD OAuth state", () => {
	it("round-trips a short-lived encrypted transaction", async () => {
		const sealed = await sealOutboundMcpOAuthState(transaction, "secret", 100);
		expect(sealed).not.toContain("org_tedix");
		await expect(
			openOutboundMcpOAuthState(sealed, "secret", 101),
		).resolves.toEqual({
			...transaction,
			v: 1,
			exp: 100 + OUTBOUND_MCP_OAUTH_STATE_TTL_SECONDS,
		});
	});

	it("rejects tampering, the wrong secret, and expiry", async () => {
		const sealed = await sealOutboundMcpOAuthState(transaction, "secret", 100);
		// Flip the first ciphertext byte after the 12-byte IV. Changing only the
		// last base64url character can alter padding bits without changing bytes.
		const tamperedBytes = Buffer.from(sealed, "base64url");
		tamperedBytes[12] ^= 1;
		const tampered = tamperedBytes.toString("base64url");
		await expect(
			openOutboundMcpOAuthState(tampered, "secret", 101),
		).rejects.toThrow("Invalid or expired OAuth state");
		await expect(
			openOutboundMcpOAuthState(sealed, "wrong", 101),
		).rejects.toThrow("Invalid or expired OAuth state");
		await expect(
			openOutboundMcpOAuthState(
				sealed,
				"secret",
				100 + OUTBOUND_MCP_OAUTH_STATE_TTL_SECONDS,
			),
		).rejects.toThrow("Invalid or expired OAuth state");
	});

	it("generates RFC 7636 S256 verifier and challenge values", async () => {
		const verifier = generatePkceVerifier();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await derivePkceS256Challenge(verifier)).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);
		await expect(derivePkceS256Challenge("too-short")).rejects.toThrow(
			"Invalid PKCE verifier",
		);
	});

	it("builds a CIMD authorization request with PKCE and resource binding", async () => {
		const url = new URL(
			await buildCimdAuthorizationUrl({
				authorizationUrl: "https://auth.example.com/authorize",
				clientId: "https://api.tedix.dev/client.json",
				redirectUri: "https://api.tedix.dev/oauth/mcp/callback",
				state: "sealed-state",
				codeVerifier: "v".repeat(43),
				scopes: ["mcp:tools", "profile"],
				additionalParams: [
					{ key: "resource", value: "https://mcp.example.com/mcp" },
				],
			}),
		);
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			client_id: "https://api.tedix.dev/client.json",
			response_type: "code",
			redirect_uri: "https://api.tedix.dev/oauth/mcp/callback",
			state: "sealed-state",
			code_challenge_method: "S256",
			resource: "https://mcp.example.com/mcp",
			scope: "mcp:tools profile",
		});
		expect(url.searchParams.get("code_challenge")).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);
	});
});
