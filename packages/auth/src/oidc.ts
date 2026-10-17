import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import {
	OidcIdentityConfigSchema,
	type OidcIdentityConfig,
} from "@tedix/api-contract/schemas/oidc-identity";
import { base64UrlEncode } from "./utils";

type OidcFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export function oidcRandom() {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
export async function oidcDigest(value: string) {
	return base64UrlEncode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);
}
export function readOidcConfig(
	value: unknown,
	local = false,
): OidcIdentityConfig {
	const config = OidcIdentityConfigSchema.parse(value);
	for (const address of [config.issuer, config.redirectUri]) {
		const url = new URL(address);
		if (
			url.username ||
			url.password ||
			url.hash ||
			url.search ||
			(url.protocol !== "https:" &&
				!(
					local &&
					url.protocol === "http:" &&
					["localhost", "127.0.0.1"].includes(url.hostname)
				))
		)
			throw new Error("OIDC requires HTTPS (loopback only in development)");
	}
	if (!config.scopes.includes("openid"))
		throw new Error("OIDC requires openid scope");
	if (
		Object.values(config.scopeMapping)
			.flat()
			.some((s) => s === "platform:admin" || s.includes("*"))
	)
		throw new Error("OIDC cannot grant platform authority");
	return config;
}
interface OidcMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
	end_session_endpoint?: string;
}
/** Discovery endpoints stay on the configured issuer origin; redirects are refused. */
export async function discoverOidc(
	config: OidcIdentityConfig,
	fetcher: OidcFetch = fetch,
): Promise<OidcMetadata> {
	const response = await fetcher(
		`${config.issuer}/.well-known/openid-configuration`,
		{ redirect: "manual", signal: AbortSignal.timeout(10_000) },
	);
	if (!response.ok) throw new Error("OIDC discovery failed");
	const metadata = (await response.json()) as OidcMetadata;
	if (metadata.issuer !== config.issuer)
		throw new Error("OIDC issuer mismatch");
	for (const endpoint of [
		metadata.authorization_endpoint,
		metadata.token_endpoint,
		metadata.jwks_uri,
		...(metadata.end_session_endpoint ? [metadata.end_session_endpoint] : []),
	]) {
		const url = new URL(endpoint);
		if (
			url.origin !== new URL(config.issuer).origin ||
			url.username ||
			url.password ||
			url.hash
		)
			throw new Error("OIDC endpoint origin mismatch");
	}
	return metadata;
}
export async function exchangeOidcCode(input: {
	config: OidcIdentityConfig;
	code: string;
	verifier: string;
	nonce: string;
	fetcher?: OidcFetch;
}) {
	const fetcher = input.fetcher ?? fetch;
	const metadata = await discoverOidc(input.config, fetcher);
	const response = await fetcher(metadata.token_endpoint, {
		method: "POST",
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: input.code,
			client_id: input.config.clientId,
			redirect_uri: input.config.redirectUri,
			code_verifier: input.verifier,
		}),
	});
	if (!response.ok) throw new Error("OIDC code exchange failed");
	const tokens = (await response.json()) as {
		id_token?: string;
		scope?: string;
	};
	if (!tokens.id_token) throw new Error("OIDC ID token missing");
	const keysResponse = await fetcher(metadata.jwks_uri, {
		redirect: "manual",
		signal: AbortSignal.timeout(10_000),
	});
	if (!keysResponse.ok) throw new Error("OIDC keys unavailable");
	const jwks = (await keysResponse.json()) as JSONWebKeySet;
	const { payload } = await jwtVerify(
		tokens.id_token,
		createLocalJWKSet(jwks),
		{
			issuer: input.config.issuer,
			audience: input.config.clientId,
			algorithms: ["RS256", "ES256"],
			requiredClaims: ["sub", "exp", "iat", "nonce"],
			maxTokenAge: "10m",
		},
	);
	if (
		payload.nonce !== input.nonce ||
		!payload.sub ||
		(payload.azp !== undefined && payload.azp !== input.config.clientId) ||
		(Array.isArray(payload.aud) &&
			payload.aud.length > 1 &&
			payload.azp !== input.config.clientId)
	)
		throw new Error("OIDC nonce or authorized party mismatch");
	// Scope authority comes from the token response, bounded by the requested set.
	const granted = (tokens.scope ?? "")
		.split(/\s+/)
		.filter((s) => input.config.scopes.includes(s));
	return { subject: payload.sub, expiresAt: payload.exp!, scopes: granted };
}
export function mapOidcScopes(config: OidcIdentityConfig, granted: string[]) {
	return [
		...new Set(granted.flatMap((scope) => config.scopeMapping[scope] ?? [])),
	];
}
