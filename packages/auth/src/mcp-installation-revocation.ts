import { compactVerify, createLocalJWKSet, type JSONWebKeySet } from "jose";
import { buildDescopeMcpDiscoveryUrl } from "./descope-mcp";
import { DESCOPE_MANAGEMENT_BASE_URL, type DescopeEnv } from "./types";

/** Expired access tokens prove only which installation may be revoked, never access. */
export async function verifyMcpRevocationProof(
	env: DescopeEnv,
	input: { accessToken: string; resourceUrl: string; mcpServerId: string },
	fetcher: typeof fetch = fetch,
) {
	const discoveryUrl = buildDescopeMcpDiscoveryUrl({
		baseUrl: env.DESCOPE_BASE_URL ?? DESCOPE_MANAGEMENT_BASE_URL,
		projectId: env.DESCOPE_PROJECT_ID,
		resourceId: input.mcpServerId,
	});
	const read = async (url: string) => {
		const response = await fetcher(url, {
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error("OAuth metadata unavailable");
		return response.json();
	};
	const metadata = (await read(discoveryUrl)) as {
		issuer: string;
		jwks_uri: string;
		revocation_endpoint: string;
	};
	const issuer = discoveryUrl.replace("/.well-known/openid-configuration", "");
	if (metadata.issuer !== issuer) throw new Error("OAuth issuer mismatch");
	for (const endpoint of [metadata.jwks_uri, metadata.revocation_endpoint]) {
		const url = new URL(endpoint);
		if (
			url.protocol !== "https:" ||
			url.origin !== new URL(issuer).origin ||
			url.username ||
			url.password
		)
			throw new Error("OAuth endpoint mismatch");
	}
	const keys = (await read(metadata.jwks_uri)) as JSONWebKeySet;
	const verified = await compactVerify(
		input.accessToken,
		createLocalJWKSet(keys),
		{ algorithms: ["RS256", "PS256", "ES256"] },
	);
	const claims = JSON.parse(
		new TextDecoder().decode(verified.payload),
	) as Record<string, unknown>;
	const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (
		claims.iss !== issuer ||
		!audiences.includes(input.resourceUrl) ||
		claims.token_type !== "access_token" ||
		claims.entityType === "tedi" ||
		![claims.sub, claims.azp, claims.dci, claims.tedixConsentRevision].every(
			(value) => typeof value === "string" && value.length > 0,
		) ||
		!/^[-a-f0-9]{36}$/i.test(String(claims.tedixConsentRevision))
	)
		throw new Error("Invalid installation proof");
	return {
		descopeUserId: claims.sub as string,
		clientId: claims.azp as string,
		revision: claims.tedixConsentRevision as string,
		revocationEndpoint: metadata.revocation_endpoint,
	};
}
