import { describe, it, expect } from "vite-plus/test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { exchangeOidcCode, readOidcConfig, mapOidcScopes } from "./oidc";

const config = readOidcConfig({
	kind: "oidc",
	issuer: "https://id.example.test/realms/acme",
	clientId: "tedix",
	redirectUri: "https://acme.example.test/auth/oidc/callback",
	scopes: ["openid", "profile"],
	scopeMapping: { profile: ["apps:read"] },
});
async function fixture(claims: Record<string, unknown> = {}) {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = { ...(await exportJWK(publicKey)), kid: "fixture" };
	const token = await new SignJWT({ nonce: "nonce", ...claims })
		.setProtectedHeader({ alg: "RS256", kid: "fixture" })
		.setIssuer(config.issuer)
		.setAudience(config.clientId)
		.setSubject("alice")
		.setIssuedAt()
		.setExpirationTime("5m")
		.sign(privateKey);
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("openid-configuration"))
			return Response.json({
				issuer: config.issuer,
				authorization_endpoint: "https://id.example.test/authorize",
				token_endpoint: "https://id.example.test/token",
				jwks_uri: "https://id.example.test/keys",
			});
		if (url.endsWith("/keys")) return Response.json({ keys: [jwk] });
		expect(String(init?.body)).toContain("code_verifier=verifier");
		return Response.json({ id_token: token, scope: "openid profile admin" });
	};
	return {
		config,
		code: "code",
		verifier: "verifier",
		nonce: "nonce",
		fetcher,
	};
}
describe("generic OIDC", () => {
	it("verifies a signed ID token and maps only configured granted scopes", async () => {
		const result = await exchangeOidcCode(await fixture());
		expect(result.subject).toBe("alice");
		expect(result.scopes).toEqual(["openid", "profile"]);
		expect(mapOidcScopes(config, result.scopes)).toEqual(["apps:read"]);
	});
	it("rejects mismatched nonce and authorized party", async () => {
		await expect(
			exchangeOidcCode(await fixture({ nonce: "attacker" })),
		).rejects.toThrow();
		await expect(
			exchangeOidcCode(await fixture({ azp: "another-client" })),
		).rejects.toThrow();
	});
	it("rejects wrong issuer and audience", async () => {
		const input = await fixture();
		await expect(
			exchangeOidcCode({
				...input,
				config: { ...config, clientId: "another-client" },
			}),
		).rejects.toThrow();
		const fetcher = async () =>
			Response.json({ issuer: "https://evil.example.test" });
		await expect(exchangeOidcCode({ ...input, fetcher })).rejects.toThrow();
	});
	it("requires TLS, openid, and rejects platform grants", () => {
		expect(() =>
			readOidcConfig({ ...config, issuer: "http://127.0.0.1:8080" }),
		).toThrow();
		expect(() =>
			readOidcConfig({ ...config, issuer: "http://127.0.0.1:8080" }, true),
		).not.toThrow();
		expect(() => readOidcConfig({ ...config, scopes: ["profile"] })).toThrow();
		expect(() =>
			readOidcConfig({
				...config,
				scopeMapping: { profile: ["platform:admin"] },
			}),
		).toThrow();
	});
});
