import { guardedFetch, SsrfBlockedError } from "@tedix/ssrf-guard";
import { normalizeConnectionScopes } from "@tedix/api-contract/utils/mcp-scope-catalog";
import { normalizeIssuerForComparison } from "./oauth-iss.ts";
import { TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID } from "./oauth-client-registration.ts";
import { trimTrailingSlashes } from "./utils.ts";
import { sleep } from "@tedix/worker-kit/sleep";
import {
	asStringArray,
	type ConnectionProviderConfig,
} from "./connection-providers.ts";

export interface McpConnectionDiscovery {
	mcpEndpointUrl: string;
	/**
	 * RFC 9728 protected-resource metadata URL. Null when the server does not
	 * publish protected-resource metadata and discovery fell back to RFC 8414
	 * authorization-server metadata directly.
	 */
	protectedResourceMetadataUrl: string | null;
	resource: string;
	/**
	 * Issuer-bound credential keying (RFC 9207 / MCP 2026 auth hardening): each
	 * discovered provider becomes a distinct Descope outbound app, and persisted
	 * OAuth tokens are keyed by that outbound `appId` together with the
	 * user/tenant (see fetchToken / fetchTenantToken). Because one outbound app
	 * carries exactly one `authorizationUrl`/`tokenUrl` pair, client credentials
	 * are never reused across authorization servers — this `authorizationServer`
	 * identifier is the validated issuer that app's credentials are bound to.
	 */
	authorizationServer: string;
	authorizationServerMetadataUrl: string;
	authorizationUrl: string;
	tokenUrl: string;
	revocationUrl: string | null;
	registrationMode: "cimd" | "dcr";
	clientIdMetadataDocumentSupported: boolean;
	dcrUrl: string | null;
	scopesSupported: string[];
	authorizationServerScopesSupported: string[];
	codeChallengeMethodsSupported: string[];
	tokenEndpointAuthMethodsSupported: string[];
	/**
	 * RFC 9207: whether the authorization server's RFC 8414 metadata advertises
	 * `authorization_response_iss_parameter_supported: true`. Surfaced from
	 * discovery so authorization-response handlers can enforce
	 * `assertAuthorizationResponseIss` (see `oauth-iss.ts`) with the strict
	 * absent-iss branch. Persisted (phase 1a) alongside the pinned issuer on
	 * `connection_providers.authorization_response_iss_supported` /
	 * `.pinned_issuer` by the apps/api createProviderFromMcp flow.
	 */
	authorizationResponseIssParameterSupported: boolean;
}

export interface DiscoveredMcpConnectionProvider {
	config: ConnectionProviderConfig;
	discovery: McpConnectionDiscovery;
	warnings: string[];
}

export type FetchLike = (
	input: string,
	init?: RequestInit,
) => Promise<Response>;

const METADATA_FETCH_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

/**
 * Try each candidate URL, returning the first valid JSON object document.
 * Returns `null` (with the accumulated per-candidate errors) when every
 * candidate is unavailable, so callers can fall back instead of throwing.
 */
async function tryFetchJsonFromCandidates(
	candidates: string[],
	fetchFn: FetchLike,
): Promise<{
	result: { url: string; json: Record<string, unknown> } | null;
	errors: string[];
}> {
	const errors: string[] = [];
	for (const url of unique(candidates)) {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				// SSRF guard: metadata candidates derive from remote-supplied values
				// (the operator's MCP URL on hop 1, the fetched document's
				// `authorization_servers[0]` on hop 2), so every candidate — and
				// every redirect hop it returns — is validated before fetching.
				const response = await guardedFetch(
					url,
					{
						headers: {
							Accept: "application/json",
							"User-Agent": "Tedix MCP Catalog/1.0 (+https://tedix.dev)",
						},
					},
					{ fetchFn },
				);
				if (!response.ok) {
					if (
						attempt === 0 &&
						METADATA_FETCH_RETRY_STATUSES.has(response.status)
					) {
						await sleep(250);
						continue;
					}
					errors.push(`${url} -> ${response.status}`);
					break;
				}
				const json = (await response.json()) as unknown;
				if (!json || typeof json !== "object" || Array.isArray(json)) {
					errors.push(`${url} -> non-object JSON`);
					break;
				}
				return {
					result: { url, json: json as Record<string, unknown> },
					errors,
				};
			} catch (error) {
				if (error instanceof SsrfBlockedError) {
					// Deterministic refusal — retrying cannot change the verdict.
					errors.push(`${url} -> ${error.message}`);
					break;
				}
				if (attempt === 0) {
					await sleep(250);
					continue;
				}
				errors.push(
					`${url} -> ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
	return { result: null, errors };
}

async function fetchJsonFromCandidates(
	candidates: string[],
	fetchFn: FetchLike,
	label: string,
): Promise<{ url: string; json: Record<string, unknown> }> {
	const { result, errors } = await tryFetchJsonFromCandidates(
		candidates,
		fetchFn,
	);
	if (result) return result;
	throw new Error(`Unable to fetch ${label}: ${errors.join("; ")}`);
}

function protectedResourceMetadataCandidates(resourceUrl: string): string[] {
	const parsed = new URL(resourceUrl);
	const path = trimTrailingSlashes(parsed.pathname);
	const candidates = [
		`${parsed.origin}/.well-known/oauth-protected-resource${path && path !== "/" ? path : ""}`,
		`${parsed.origin}/.well-known/oauth-protected-resource`,
		// Cloudflare Access advertises protected-resource metadata on this
		// documented vendor path rather than the RFC 9728 well-known path.
		`${parsed.origin}/.well-known/cloudflare-access-protected-resource${path && path !== "/" ? path : ""}`,
		`${parsed.origin}/.well-known/cloudflare-access-protected-resource`,
	];
	return unique(candidates);
}

function authorizationServerMetadataCandidates(issuerUrl: string): string[] {
	const parsed = new URL(issuerUrl);
	const path = trimTrailingSlashes(parsed.pathname);
	const candidates = [
		`${parsed.origin}/.well-known/oauth-authorization-server${path && path !== "/" ? path : ""}`,
		`${parsed.origin}/.well-known/oauth-authorization-server`,
	];
	return unique(candidates);
}

function requiredString(
	value: unknown,
	field: string,
	sourceUrl: string,
): string {
	if (typeof value === "string" && value.length > 0) return value;
	throw new Error(`${sourceUrl} is missing required field ${field}`);
}

function assertUrl(value: string, field: string, sourceUrl: string): string {
	try {
		return new URL(value).toString();
	} catch {
		throw new Error(`${sourceUrl} field ${field} is not a valid URL`);
	}
}

/** Validate an OAuth issuer without rewriting its byte representation. */
function assertIssuerUrl(
	value: string,
	field: string,
	sourceUrl: string,
): string {
	try {
		new URL(value);
		return value;
	} catch {
		throw new Error(`${sourceUrl} field ${field} is not a valid URL`);
	}
}

/**
 * RFC 8414 §3.3 / RFC 9207 issuer-mixup defense (client side).
 *
 * When Tedix follows an MCP protected resource to its authorization server and
 * fetches that server's metadata, the `issuer` advertised in the metadata MUST
 * exactly match the authorization-server identifier we used to locate it. A
 * mismatch means the metadata document is describing a *different* issuer than
 * the one we were directed to — the classic authorization-server mix-up /
 * substitution that RFC 9207 hardens against. We reject the discovery rather
 * than silently provisioning an outbound app whose credentials would be bound
 * to an attacker-influenced issuer.
 *
 * `expectedIssuer` is the authorization-server identifier we trusted (the
 * protected-resource `authorization_servers[0]`, or the MCP origin in the
 * RFC 8414 fallback). `metadataIssuer` is the `issuer` claim returned by that
 * server's metadata document, when present. Per RFC 8414 the `issuer` field is
 * REQUIRED, but some real servers omit it; when absent we treat it as a no-op
 * (there is no second value to cross-check) and continue relying on the
 * transport origin we fetched from.
 */
function assertDiscoveredIssuerMatches(params: {
	expectedIssuer: string;
	metadataIssuer: unknown;
	metadataUrl: string;
}): void {
	const { expectedIssuer, metadataIssuer, metadataUrl } = params;
	if (typeof metadataIssuer !== "string" || metadataIssuer.length === 0) {
		// RFC 8414 makes `issuer` REQUIRED, but with no second value to compare
		// against there is no mix-up signal to act on here.
		return;
	}
	if (
		normalizeIssuerForComparison(metadataIssuer) !==
		normalizeIssuerForComparison(expectedIssuer)
	) {
		throw new Error(
			`Authorization-server issuer mismatch: ${metadataUrl} advertises issuer ` +
				`"${metadataIssuer}" but was located via authorization server ` +
				`"${expectedIssuer}". Refusing to provision a connection for a ` +
				`mismatched issuer (RFC 8414 §3.3 / RFC 9207 issuer-mixup defense).`,
		);
	}
}

/**
 * Build a Descope outbound-app config from an upstream MCP protected resource.
 *
 * The MCP URL itself is the OAuth protected resource, not the DCR endpoint.
 * We fetch RFC 9728 protected-resource metadata first, follow its
 * authorization server to RFC 8414 metadata, then use that server's
 * `registration_endpoint` as Descope's `dcrUrl`.
 *
 * Many real-world OAuth MCP servers (e.g. Atlassian) do not publish RFC 9728
 * protected-resource metadata but do publish RFC 8414 authorization-server
 * metadata plus DCR. When the protected-resource document is unavailable
 * (all candidates 404), we fall back to fetching the authorization-server
 * metadata directly at the MCP endpoint origin and proceed with the same
 * provider-building logic (DCR + PKCE).
 */
export async function discoverMcpConnectionProvider(
	input: {
		mcpEndpointUrl: string;
		id?: string;
		name: string;
		description?: string;
		logo?: string;
		defaultScopes?: string[];
		includeResourceParameter?: boolean;
	},
	fetchFn: FetchLike = fetch,
): Promise<DiscoveredMcpConnectionProvider> {
	const mcpEndpointUrl = new URL(input.mcpEndpointUrl).toString();
	const { result: protectedResource, errors: protectedResourceErrors } =
		await tryFetchJsonFromCandidates(
			protectedResourceMetadataCandidates(mcpEndpointUrl),
			fetchFn,
		);

	let resource: string;
	let authorizationServer: string;
	let protectedScopes: string[];
	let authorizationMetadata: { url: string; json: Record<string, unknown> };

	if (protectedResource) {
		resource = assertUrl(
			requiredString(
				protectedResource.json.resource,
				"resource",
				protectedResource.url,
			),
			"resource",
			protectedResource.url,
		);
		const authorizationServers = asStringArray(
			protectedResource.json.authorization_servers,
		);
		if (authorizationServers.length === 0) {
			throw new Error(
				`${protectedResource.url} is missing authorization_servers`,
			);
		}
		const primaryAuthorizationServer = authorizationServers[0];
		if (!primaryAuthorizationServer) {
			throw new Error(
				`${protectedResource.url} is missing authorization_servers[0]`,
			);
		}

		const authorizationServerLookupUrl = assertUrl(
			primaryAuthorizationServer,
			"authorization_servers[0]",
			protectedResource.url,
		);
		authorizationMetadata = await fetchJsonFromCandidates(
			authorizationServerMetadataCandidates(authorizationServerLookupUrl),
			fetchFn,
			"OAuth authorization server metadata",
		);
		// RFC 8414 §3.3 / RFC 9207: the authorization server we were directed to
		// by the protected resource MUST advertise itself as the same issuer.
		// Reject mismatches before this server's endpoints are recorded into an
		// outbound app and its tokens get persisted.
		assertDiscoveredIssuerMatches({
			expectedIssuer: primaryAuthorizationServer,
			metadataIssuer: authorizationMetadata.json.issuer,
			metadataUrl: authorizationMetadata.url,
		});
		const metadataIssuer = authorizationMetadata.json.issuer;
		authorizationServer = assertIssuerUrl(
			typeof metadataIssuer === "string" && metadataIssuer.length > 0
				? metadataIssuer
				: primaryAuthorizationServer,
			"issuer",
			authorizationMetadata.url,
		);
		protectedScopes = asStringArray(protectedResource.json.scopes_supported);
	} else {
		// RFC 8414 fallback: no protected-resource metadata, so fetch the
		// authorization-server metadata directly at the MCP endpoint origin.
		const { result: fallbackMetadata, errors: authorizationServerErrors } =
			await tryFetchJsonFromCandidates(
				authorizationServerMetadataCandidates(mcpEndpointUrl),
				fetchFn,
			);
		if (!fallbackMetadata) {
			throw new Error(
				`Unable to fetch OAuth metadata for ${mcpEndpointUrl}: ` +
					`protected-resource metadata unavailable (${protectedResourceErrors.join("; ")}); ` +
					`authorization-server metadata unavailable (${authorizationServerErrors.join("; ")})`,
			);
		}
		authorizationMetadata = fallbackMetadata;
		// The MCP URL is itself the OAuth protected resource (RFC 9728 §2);
		// without protected-resource metadata, use it as the resource value.
		resource = mcpEndpointUrl;
		// Prefer the RFC 8414 `issuer` as the authorization-server identifier,
		// falling back to the metadata document's origin.
		const issuer =
			typeof fallbackMetadata.json.issuer === "string" &&
			fallbackMetadata.json.issuer.length > 0
				? fallbackMetadata.json.issuer
				: new URL(fallbackMetadata.url).origin;
		authorizationServer = assertIssuerUrl(
			issuer,
			"issuer",
			fallbackMetadata.url,
		);
		protectedScopes = [];
	}

	const authorizationUrl = assertUrl(
		requiredString(
			authorizationMetadata.json.authorization_endpoint,
			"authorization_endpoint",
			authorizationMetadata.url,
		),
		"authorization_endpoint",
		authorizationMetadata.url,
	);
	const tokenUrl = assertUrl(
		requiredString(
			authorizationMetadata.json.token_endpoint,
			"token_endpoint",
			authorizationMetadata.url,
		),
		"token_endpoint",
		authorizationMetadata.url,
	);
	const clientIdMetadataDocumentSupported =
		authorizationMetadata.json.client_id_metadata_document_supported === true;
	const registrationEndpoint = authorizationMetadata.json.registration_endpoint;
	const dcrUrl =
		typeof registrationEndpoint === "string" && registrationEndpoint.length > 0
			? assertUrl(
					registrationEndpoint,
					"registration_endpoint",
					authorizationMetadata.url,
				)
			: null;
	if (!clientIdMetadataDocumentSupported && !dcrUrl) {
		throw new Error(
			`${authorizationMetadata.url} supports neither Client ID Metadata Documents nor Dynamic Client Registration`,
		);
	}
	const revocationUrlRaw = authorizationMetadata.json.revocation_endpoint;
	const revocationUrl =
		typeof revocationUrlRaw === "string" && revocationUrlRaw.length > 0
			? assertUrl(
					revocationUrlRaw,
					"revocation_endpoint",
					authorizationMetadata.url,
				)
			: null;

	const authorizationServerScopes = asStringArray(
		authorizationMetadata.json.scopes_supported,
	);
	const defaultScopes = input.defaultScopes?.length
		? input.defaultScopes
		: protectedScopes.length
			? protectedScopes
			: authorizationServerScopes;
	const warnings: string[] = [];
	if (defaultScopes.length === 0) {
		warnings.push(
			"The MCP protected resource did not advertise scopes_supported and no defaultScopes were provided.",
		);
	}
	const unsupportedByResource = protectedScopes.length
		? defaultScopes.filter((scope) => !protectedScopes.includes(scope))
		: [];
	if (unsupportedByResource.length > 0) {
		throw new Error(
			`Requested scopes are not advertised by the MCP protected resource: ${unsupportedByResource.join(", ")}`,
		);
	}

	const codeChallengeMethods = asStringArray(
		authorizationMetadata.json.code_challenge_methods_supported,
	);
	const tokenEndpointAuthMethods = asStringArray(
		authorizationMetadata.json.token_endpoint_auth_methods_supported,
	);
	const resourceParams =
		input.includeResourceParameter === false
			? []
			: [{ key: "resource", value: resource }];

	if (
		clientIdMetadataDocumentSupported &&
		!codeChallengeMethods.includes("S256")
	) {
		throw new Error(
			`${authorizationMetadata.url} advertises Client ID Metadata Documents without required PKCE S256 support`,
		);
	}
	const registrationMode = clientIdMetadataDocumentSupported ? "cimd" : "dcr";
	return {
		config: {
			name: input.name,
			description: input.description,
			logo: input.logo,
			authorizationUrl,
			authorizationUrlParams: resourceParams,
			tokenUrl,
			tokenUrlParams: resourceParams,
			revocationUrl: revocationUrl ?? undefined,
			pkce: codeChallengeMethods.includes("S256"),
			defaultScopes,
			...(registrationMode === "cimd"
				? {
						clientId: TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID,
						useDcr: false,
					}
				: { useDcr: true, dcrUrl: dcrUrl! }),
			// Confidential, redirect-based server-side client (RFC 7591). Avoids
			// authorization servers defaulting DCR to "native" and rejecting the
			// https callback redirect URI.
			applicationType: "web",
		},
		discovery: {
			mcpEndpointUrl,
			protectedResourceMetadataUrl: protectedResource?.url ?? null,
			resource,
			authorizationServer,
			authorizationServerMetadataUrl: authorizationMetadata.url,
			authorizationUrl,
			tokenUrl,
			revocationUrl,
			dcrUrl,
			registrationMode,
			clientIdMetadataDocumentSupported,
			scopesSupported: protectedScopes,
			authorizationServerScopesSupported: authorizationServerScopes,
			codeChallengeMethodsSupported: codeChallengeMethods,
			tokenEndpointAuthMethodsSupported: tokenEndpointAuthMethods,
			authorizationResponseIssParameterSupported:
				authorizationMetadata.json
					.authorization_response_iss_parameter_supported === true,
		},
		warnings,
	};
}
