import { describe, expect, it } from "vite-plus/test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { verifyMcpRevocationProof } from "./mcp-installation-revocation";

describe("installation revocation proof", () => {
	it("accepts an expired signed installation proof but rejects forged authority", async () => {
		const { privateKey, publicKey } = await generateKeyPair("RS256");
		const issuer = "https://auth.example.test/v1/apps/agentic/project/server";
		const audience = "https://connect.example.test/mcp";
		const sign = (aud = audience, key = privateKey) =>
			new SignJWT({
				token_type: "access_token",
				azp: "shared-client",
				dci: "shared-consent",
				tedixConsentRevision: "00000000-0000-4000-8000-000000000001",
			})
				.setProtectedHeader({ alg: "RS256", kid: "fixture" })
				.setSubject("user")
				.setIssuer(issuer)
				.setAudience(aud)
				.setIssuedAt(1)
				.setExpirationTime(2)
				.sign(key);
		const keys = {
			keys: [{ ...(await exportJWK(publicKey)), kid: "fixture" }],
		};
		const fetcher = (async (url: string | URL | Request) => {
			if (String(url).endsWith("/.well-known/openid-configuration"))
				return Response.json({
					issuer,
					jwks_uri: "https://auth.example.test/keys",
					revocation_endpoint: "https://auth.example.test/revoke",
				});
			expect(String(url)).toBe("https://auth.example.test/keys");
			return Response.json(keys);
		}) as typeof fetch;
		const env = {
			DESCOPE_PROJECT_ID: "project",
			DESCOPE_BASE_URL: "https://auth.example.test",
		};
		const verify = (accessToken: string) =>
			verifyMcpRevocationProof(
				env,
				{ accessToken, resourceUrl: audience, mcpServerId: "server" },
				fetcher,
			);
		await expect(verify(await sign())).resolves.toMatchObject({
			descopeUserId: "user",
			clientId: "shared-client",
			revision: "00000000-0000-4000-8000-000000000001",
		});
		await expect(
			verify(await sign("https://another.example/mcp")),
		).rejects.toThrow();
		await expect(
			verify(await sign(audience, (await generateKeyPair("RS256")).privateKey)),
		).rejects.toThrow();
	});
});
