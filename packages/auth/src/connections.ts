/**
 * @tedix/auth - Descope Token Vault (Connections) Wrapper
 *
 * Wraps Descope's Outbound Application / Token Vault APIs for OAuth connection management.
 * Used when tedis auto-connect to operator apps via stored OAuth tokens.
 *
 * SDK methods used:
 * - management.outboundApplication.fetchToken(appId, userId, tenantId, options)
 * - management.outboundApplication.fetchTokenByScopes(appId, userId, scopes, options, tenantId)
 * - management.outboundApplication.fetchTenantToken(appId, tenantId, options)
 * - management.outboundApplication.fetchTenantTokenByScopes(appId, tenantId, scopes, options)
 * - management.outboundApplication.deleteUserTokens(appId, userId)
 * - management.outboundApplication.loadAllApplications()
 * - management.outboundApplication.listAppsWithUserToken(userId, tenantId)
 * - management.outboundApplication.uploadUserApiKey(appId, userId, apiKey, tenantId)
 * - management.outboundApplication.uploadTenantApiKey(appId, tenantId, apiKey)
 *
 * NOTE: Requires Descope management key. Only use in apps/api.
 *
 * Docs: https://docs.descope.com/identity-federation/outbound-apps/using-outbound-apps
 */

import { guardedFetch, SsrfBlockedError } from "@tedix/ssrf-guard";
import type { DescopeClient } from "./descope.ts";
import { descopeFetch, descopeManagementFetch } from "./descope-fetch.ts";
import { normalizeIssuerForComparison } from "./oauth-iss.ts";
import { TEDIX_OUTBOUND_MCP_OAUTH_CLIENT_ID } from "./oauth-client-registration.ts";
import { DESCOPE_DEFAULT_BASE_URL } from "./types.ts";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { sleep } from "@tedix/worker-kit/sleep";

// =============================================================================
// TOKEN EXTRACTION HELPER
// =============================================================================

function extractAccessToken(raw: string): string {
	// Descope Token Vault values are opaque. Provider-specific credential shapes
	// such as `projectId:managementKey` are intentionally composed before upload,
	// so the retrieval path must never split or normalize compound strings.
	return raw;
}

// =============================================================================
// TYPES
// =============================================================================

const CONNECTION_LOOKUP_KINDS = [
	"user_latest",
	"user_scoped",
	"tenant_latest",
	"tenant_scoped",
	"named_user_latest",
	"named_user_scoped",
	"named_tenant_latest",
	"named_tenant_scoped",
] as const;
type ConnectionLookupKind = (typeof CONNECTION_LOOKUP_KINDS)[number];

/** Safe failure classification: never retain provider bodies, tokens, or raw causes. */
export class ConnectionTokenLookupError extends Error {
	readonly status: number | undefined;
	readonly lookupKind: ConnectionLookupKind | undefined;
	readonly upstreamCode: string | undefined;
	constructor(
		status?: number,
		diagnostic?: { lookupKind?: ConnectionLookupKind; upstreamCode?: unknown },
	) {
		const lookupKind =
			diagnostic?.lookupKind &&
			CONNECTION_LOOKUP_KINDS.includes(diagnostic.lookupKind)
				? diagnostic.lookupKind
				: undefined;
		const upstreamCode =
			typeof diagnostic?.upstreamCode === "string" &&
			diagnostic.upstreamCode.length === 7 &&
			/^E[0-9]{6}$/.test(diagnostic.upstreamCode)
				? diagnostic.upstreamCode
				: undefined;
		const safeStatus =
			typeof status === "number" &&
			Number.isInteger(status) &&
			status >= 400 &&
			status <= 599
				? status
				: undefined;
		const details = [
			safeStatus ? `upstream status ${safeStatus}` : null,
			lookupKind,
			upstreamCode,
		].filter(Boolean);
		super(
			`Connection credential lookup unavailable${details.length ? ` (${details.join(", ")})` : ""}`,
		);
		this.name = "ConnectionTokenLookupError";
		this.status = safeStatus;
		this.lookupKind = lookupKind;
		this.upstreamCode = upstreamCode;
	}
}

/** Inspect only a bounded error response; discard every field except its vendor code. */
async function readLookupErrorCode(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4096) return undefined;
			chunks.push(value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return isRecord(body) ? body.errorCode : undefined;
	} catch {
		return undefined;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export interface ConnectionToken {
	/** Descope token ID (used for deletion via deleteTokenById) */
	id?: string;
	/** OAuth access token or API key */
	accessToken: string;
	/** Token expiration timestamp (unix seconds), if available */
	expiresAt?: number;
	/** OAuth scopes granted, if available */
	scopes?: string[];
	/** Native vault account selector, not a display label. */
	externalIdentifier?: string;
	/** Provider subject observed on this grant; not a Tedix authorization identity. */
	tokenSub?: string;
}

/** Tedix-owned selectors are distinct from upstream BYOS metadata. */
export function isNamedConnectionExternalIdentifier(value: unknown): boolean {
	return typeof value === "string" && /^tedix_[0-9a-f-]{36}$/.test(value);
}

export interface PersonalConnectionSelection {
	appId: string;
	userId: string;
	/** Must be derived from an authorized connection instance by the API caller. */
	externalIdentifier: string;
	scopes?: string[];
}

/**
 * Descope's REST API supports named user grants, but Node SDK 2.17.0 drops
 * externalIdentifier from its fetch payload. Keep that selector on BOTH exact
 * scope and latest-token lookups for both user and tenant grants.
 */
export function fetchPersonalConnectionToken(
	env: {
		DESCOPE_PROJECT_ID: string;
		DESCOPE_MANAGEMENT_KEY: string;
		DESCOPE_BASE_URL?: string;
	},
	selection: PersonalConnectionSelection,
) {
	return fetchNamedConnectionToken(env, selection);
}

export function fetchNamedTenantConnectionToken(
	env: {
		DESCOPE_PROJECT_ID: string;
		DESCOPE_MANAGEMENT_KEY: string;
		DESCOPE_BASE_URL?: string;
	},
	selection: {
		appId: string;
		tenantId: string;
		externalIdentifier: string;
		scopes?: string[];
	},
) {
	return fetchNamedConnectionToken(env, selection);
}

async function fetchNamedConnectionToken(
	env: {
		DESCOPE_PROJECT_ID: string;
		DESCOPE_MANAGEMENT_KEY: string;
		DESCOPE_BASE_URL?: string;
	},
	selection:
		| PersonalConnectionSelection
		| {
				appId: string;
				tenantId: string;
				externalIdentifier: string;
				scopes?: string[];
		  },
): Promise<ConnectionToken | null> {
	let lookupKind: ConnectionLookupKind =
		"userId" in selection
			? selection.scopes?.length
				? "named_user_scoped"
				: "named_user_latest"
			: selection.scopes?.length
				? "named_tenant_scoped"
				: "named_tenant_latest";
	if (
		!selection.appId ||
		!("userId" in selection ? selection.userId : selection.tenantId) ||
		!selection.externalIdentifier.trim() ||
		selection.externalIdentifier.length > 200
	) {
		throw new ConnectionTokenLookupError(undefined, { lookupKind });
	}
	const baseUrl = (env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	const lookup = async (scopes?: string[]): Promise<ConnectionToken | null> => {
		lookupKind =
			"userId" in selection
				? scopes?.length
					? "named_user_scoped"
					: "named_user_latest"
				: scopes?.length
					? "named_tenant_scoped"
					: "named_tenant_latest";
		const response = await descopeFetch(
			`${baseUrl}/v1/mgmt/outbound/app/${"userId" in selection ? "user" : "tenant"}/token${scopes?.length ? "" : "/latest"}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.DESCOPE_PROJECT_ID}:${env.DESCOPE_MANAGEMENT_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					appId: selection.appId,
					...("userId" in selection
						? { userId: selection.userId }
						: { tenantId: selection.tenantId }),
					externalIdentifier: selection.externalIdentifier,
					...(scopes?.length ? { scopes } : {}),
					options: { withRefreshToken: false, forceRefresh: false },
				}),
			},
			{ idempotent: true },
		);
		if (response.status === 404) return null;
		if (!response.ok)
			throw new ConnectionTokenLookupError(response.status, {
				lookupKind,
				upstreamCode: await readLookupErrorCode(response),
			});
		const body: unknown = await response.json();
		const token = isRecord(body) ? body.token : undefined;
		if (
			!isRecord(token) ||
			token.appId !== selection.appId ||
			("userId" in selection
				? token.userId !== selection.userId
				: token.tenantId !== selection.tenantId) ||
			token.externalIdentifier !== selection.externalIdentifier ||
			("userId" in selection &&
				token.tenantId !== undefined &&
				token.tenantId !== "") ||
			typeof token.id !== "string" ||
			!token.id ||
			(token.tokenSub !== undefined && typeof token.tokenSub !== "string")
		) {
			throw new ConnectionTokenLookupError(undefined, { lookupKind });
		}
		if (typeof token.accessToken !== "string" || !token.accessToken)
			return null;
		if (
			token.scopes !== undefined &&
			(!Array.isArray(token.scopes) ||
				!token.scopes.every((scope) => typeof scope === "string"))
		) {
			throw new ConnectionTokenLookupError(undefined, { lookupKind });
		}
		return {
			id: token.id,
			accessToken: token.accessToken,
			externalIdentifier: selection.externalIdentifier,
			...(typeof token.tokenSub === "string" && token.tokenSub
				? { tokenSub: token.tokenSub }
				: {}),
			...(Number.isSafeInteger(Number(token.accessTokenExpiry)) &&
			Number(token.accessTokenExpiry) > 0
				? { expiresAt: Number(token.accessTokenExpiry) }
				: {}),
			scopes: token.scopes as string[] | undefined,
		};
	};
	try {
		const exact = await lookup(selection.scopes);
		if (exact)
			return tokenCoversScopes(exact, selection.scopes ?? []) ? exact : null;
		// Descope exact-scope selection can miss a broader grant. Any fallback is
		// still bound to the SAME account and locally checked for scope coverage.
		if (!selection.scopes?.length) return null;
		const latest = await lookup();
		return tokenCoversScopes(latest, selection.scopes) ? latest : null;
	} catch (error) {
		throw error instanceof ConnectionTokenLookupError
			? error
			: new ConnectionTokenLookupError(undefined, { lookupKind });
	}
}

/**
 * Does a granted scope satisfy a required one?
 *
 * Exact match, or the granted scope is the read/write parent of a required
 * `.readonly` scope. Google issues `.../auth/documents` for an app that asked
 * for `.../auth/documents.readonly`, and a set-membership test rejects the
 * strictly BROADER grant — every tool then fails "Connection credential not
 * found" while the dashboard shows the provider connected. Accepting the parent
 * grants no access the user has not already consented to; it only stops us
 * discarding a token that covers the requirement.
 */
function scopeSatisfies(granted: string, required: string): boolean {
	if (granted === required) return true;
	const READONLY_SUFFIX = ".readonly";
	return (
		required.endsWith(READONLY_SUFFIX) &&
		granted === required.slice(0, -READONLY_SUFFIX.length)
	);
}

function tokenCoversScopes(
	token: ConnectionToken | null,
	requiredScopes: string[],
): token is ConnectionToken {
	if (!token?.accessToken) return false;
	if (requiredScopes.length === 0) return true;
	if (!token.scopes?.length) return false;
	const granted = token.scopes;
	return requiredScopes.every((required) =>
		granted.some((scope) => scopeSatisfies(scope, required)),
	);
}

/** Configuration for creating a new connection provider (Descope Outbound App). */
export interface ConnectionProviderConfig {
	/** Human-readable provider name */
	name: string;
	/** Provider kind. Explicitly drives Descope appType when present. */
	type?: "oauth" | "api_key";
	/** Optional description */
	description?: string;
	/** Logo URL or data:image payload for the provider */
	logo?: string;
	/** OAuth client ID */
	clientId?: string;
	/** OAuth client secret */
	clientSecret?: string;
	/** OAuth authorization URL */
	authorizationUrl?: string;
	/** Additional query params appended to authorization requests */
	authorizationUrlParams?: Array<{ key: string; value: string }>;
	/** OAuth token URL */
	tokenUrl?: string;
	/** Additional query params appended to token exchange requests */
	tokenUrlParams?: Array<{ key: string; value: string }>;
	/** OAuth token revocation endpoint */
	revocationUrl?: string;
	/** OIDC discovery URL (auto-populates auth/token URLs) */
	discoveryUrl?: string;
	/** Whether to use PKCE for the OAuth flow */
	pkce?: boolean;
	/** Default OAuth scopes to request */
	defaultScopes?: string[];
	/** Default redirect URL after successful OAuth flow */
	defaultRedirectUrl?: string;
	/** Domain to use for OAuth callbacks */
	callbackDomain?: string;
	/** OAuth access type — "offline" requests a refresh token */
	accessType?: "offline" | "online";
	/** OAuth prompt parameters */
	prompt?: Array<"none" | "login" | "consent" | "select_account">;
	/** Enable Dynamic Client Registration — provider auto-registers Descope as an OAuth client */
	useDcr?: boolean;
	/** DCR registration endpoint URL */
	dcrUrl?: string;
	/**
	 * OAuth/OIDC client `application_type` (RFC 7591 / OIDC Registration §2).
	 *
	 * Descope redeems the authorization code on a server-side, redirect-based
	 * callback, so the registered client is a confidential "web" client. The
	 * correct DCR `application_type` is therefore "web" — sending "native" (or
	 * letting a strict authorization server default to it) imposes
	 * loopback/custom-scheme redirect rules that reject Tedix's https callback.
	 *
	 * NOTE: Descope performs the upstream DCR itself; its outbound-app
	 * create/update API (CreateOutboundAppRequest in the Descope management API)
	 * exposes no field to forward `application_type` to that DCR call, so this is
	 * recorded discovery metadata and is intentionally NOT sent to Descope (see
	 * buildOutboundAppCreateBody). It documents the intended client shape and is
	 * the value to pass directly once Tedix performs its own DCR or migrates to
	 * CIMD (see useDcr/dcrUrl below).
	 */
	applicationType?: "web" | "native";
	/** Tedix-side metadata; not sent to Descope outbound app APIs. */
	credentialProfile?: unknown;
}

/** Non-secret metadata update for an existing Descope Outbound App. */
export interface ConnectionProviderMetadataUpdate {
	/** Human-readable provider name */
	name?: string;
	/** Provider description */
	description?: string;
	/** Logo URL or data:image payload for the provider */
	logo?: string;
	/** Default OAuth scopes to request, including an empty list to clear them */
	defaultScopes?: string[];
}

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

export interface DescopeConnectionManagementEnv {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
	DESCOPE_BASE_URL?: string;
}

export interface UploadUserApiKeyTokenParams {
	/** Descope outbound app ID. Use project-specific apps instead of labels. */
	appId: string;
	/** Descope user ID that owns the key. */
	userId: string;
	/** Static API key / PAT value to store in Descope's outbound app vault. */
	apiKey: string;
	/** Optional Descope tenant ID for tenant-aware user storage. */
	tenantId?: string;
}

export interface UploadTenantApiKeyTokenParams {
	/** Descope outbound app ID. Use project-specific apps instead of labels. */
	appId: string;
	/** Descope tenant ID that owns the key. */
	tenantId: string;
	/** Static API key / PAT value to store in Descope's outbound app vault. */
	apiKey: string;
}

/** OAuth grant imported into the tenant-scoped Descope Token Vault. */
export interface UploadTenantOAuthTokenParams {
	/** Descope outbound app ID that owns refresh and retrieval policy. */
	appId: string;
	/** Descope tenant ID that receives the organization-wide grant. */
	tenantId: string;
	/** Access token returned by the upstream authorization server. */
	accessToken: string;
	/** Refresh token, when the upstream issued one. */
	refreshToken?: string;
	/** Access-token expiry as Unix seconds, when known. */
	accessTokenExpiry?: number;
	/** OAuth token type. MCP authorization uses Bearer unless the AS says otherwise. */
	accessTokenType?: string;
	/** Exact scopes granted by the upstream authorization server. */
	scopes?: string[];
	/** Optional upstream tenant/account identifier. */
	externalIdentifier?: string;
	/** Optional OIDC ID token returned alongside the access token. */
	idToken?: string;
	/** Descope user ID of the operator who granted tenant consent. */
	grantedBy: string;
	/** Ask Descope to verify the refresh token while importing it. */
	verifyRefresh?: boolean;
}

export interface ExchangedOAuthToken {
	accessToken: string;
	refreshToken?: string;
	accessTokenExpiry?: number;
	accessTokenType: string;
	scopes?: string[];
	idToken?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const METADATA_FETCH_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_DESCOPE_LOGO_BYTES = 256 * 1024;
const DESCOPE_LOGO_CONTENT_TYPES = new Set([
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/svg+xml",
	"image/webp",
	"image/x-icon",
	"image/vnd.microsoft.icon",
]);

function unique<T>(items: T[]): T[] {
	return Array.from(new Set(items));
}

function descopeManagementAuthHeader(
	env: DescopeConnectionManagementEnv,
): string {
	return `Bearer ${env.DESCOPE_PROJECT_ID}:${env.DESCOPE_MANAGEMENT_KEY}`;
}

function descopeManagementUrl(
	env: DescopeConnectionManagementEnv,
	path: string,
): string {
	const baseUrl = (env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);
	return `${baseUrl}${path}`;
}

async function parseDescopeManagementJson(
	response: Response,
): Promise<unknown> {
	const text = await response.text().catch(() => "");
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return {};
	}
}

async function postDescopeManagementJson(
	env: DescopeConnectionManagementEnv,
	path: string,
	body: Record<string, unknown>,
	operation: string,
): Promise<unknown> {
	const response = await descopeManagementFetch(env, {
		url: descopeManagementUrl(env, path),
		method: "POST",
		body,
		idempotent: false,
		errorPrefix: `${operation} failed`,
	});
	return parseDescopeManagementJson(response);
}

async function getDescopeManagementJson(
	env: DescopeConnectionManagementEnv,
	path: string,
	operation: string,
): Promise<unknown> {
	const response = await descopeManagementFetch(env, {
		url: descopeManagementUrl(env, path),
		method: "GET",
		idempotent: true,
		errorPrefix: `${operation} failed`,
	});
	return parseDescopeManagementJson(response);
}

function isDataImageLogo(value: string): boolean {
	return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value.trim());
}

function isHttpLogoUrl(value: string): boolean {
	try {
		const protocol = new URL(value).protocol;
		return protocol === "https:" || protocol === "http:";
	} catch {
		return false;
	}
}

function logoContentTypeFromUrl(url: string): string | null {
	const pathname = (() => {
		try {
			return new URL(url).pathname.toLowerCase();
		} catch {
			return "";
		}
	})();
	if (pathname.endsWith(".svg")) return "image/svg+xml";
	if (pathname.endsWith(".png")) return "image/png";
	if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg"))
		return "image/jpeg";
	if (pathname.endsWith(".webp")) return "image/webp";
	if (pathname.endsWith(".gif")) return "image/gif";
	if (pathname.endsWith(".ico")) return "image/x-icon";
	return null;
}

function normalizeLogoContentType(
	contentType: string | null,
	url: string,
): string | null {
	const normalized = contentType?.split(";")[0]?.trim().toLowerCase();
	if (normalized && DESCOPE_LOGO_CONTENT_TYPES.has(normalized)) {
		return normalized;
	}
	return logoContentTypeFromUrl(url);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const chunkSize = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		binary += String.fromCharCode(
			...bytes.subarray(offset, offset + chunkSize),
		);
	}
	return btoa(binary);
}

async function fetchLogoDataUri(logoUrl: string): Promise<string | null> {
	try {
		const response = await fetch(logoUrl, {
			headers: {
				Accept: "image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8",
				"User-Agent": "Tedix Descope Logo Sync/1.0 (+https://tedix.dev)",
			},
		});
		if (!response.ok) return null;
		const contentType = normalizeLogoContentType(
			response.headers.get("content-type"),
			logoUrl,
		);
		if (!contentType) return null;
		const contentLength = Number(response.headers.get("content-length"));
		if (
			Number.isFinite(contentLength) &&
			contentLength > MAX_DESCOPE_LOGO_BYTES
		)
			return null;
		const buffer = await response.arrayBuffer();
		if (buffer.byteLength === 0 || buffer.byteLength > MAX_DESCOPE_LOGO_BYTES)
			return null;
		return `data:${contentType};base64,${arrayBufferToBase64(buffer)}`;
	} catch {
		return null;
	}
}

async function normalizeDescopeLogoValue(
	logo: string | undefined,
): Promise<string | undefined> {
	if (!logo) return logo;
	const trimmed = logo.trim();
	if (!trimmed) return undefined;
	if (isDataImageLogo(trimmed)) return trimmed;
	if (!isHttpLogoUrl(trimmed)) return trimmed;
	return (await fetchLogoDataUri(trimmed)) ?? trimmed;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
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
	const path = parsed.pathname.replace(/\/+$/, "");
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
	const path = parsed.pathname.replace(/\/+$/, "");
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

// =============================================================================
// CONNECTION TOKEN OPERATIONS
// =============================================================================

/**
 * Fetch a connection token for a specific app and user.
 * Uses Descope's Outbound Application API to retrieve stored OAuth tokens.
 *
 * @param client - Descope management client
 * @param appId - The connected app ID (Descope outbound app ID)
 * @param userId - The Descope user ID
 * @param tenantId - Optional tenant ID for tenant-scoped connections
 * @returns Connection token data or null if not found
 */
export async function fetchConnectionToken(
	client: DescopeClient,
	appId: string,
	userId: string,
	tenantId?: string,
): Promise<ConnectionToken | null> {
	try {
		const response = await client.management.outboundApplication.fetchToken(
			appId,
			userId,
			tenantId,
			{ forceRefresh: false },
		);

		if (!response.ok) {
			if (response.code === 404) return null;
			throw new ConnectionTokenLookupError(response.code, {
				lookupKind: "user_latest",
				upstreamCode: response.error?.errorCode,
			});
		}
		if (!response.data)
			throw new ConnectionTokenLookupError(undefined, {
				lookupKind: "user_latest",
			});

		const token = response.data;
		// Latest-token selection is not an unlabeled-account selector. Never
		// accidentally serve a newly named slot through the legacy default path.
		if (
			isNamedConnectionExternalIdentifier(
				(token as unknown as Record<string, unknown>).externalIdentifier,
			)
		)
			return null;
		const accessToken = extractAccessToken(token.accessToken ?? "");

		// Descope may return ok=true with empty token data when the connection
		// exists but has no live token (e.g., after disconnect). Treat that as
		// "no token" so callers don't render stale "connected" status.
		if (!accessToken) {
			return null;
		}

		return {
			id: token.id,
			accessToken,
			expiresAt: token.accessTokenExpiry,
			scopes: token.scopes,
		};
	} catch (error) {
		throw error instanceof ConnectionTokenLookupError
			? error
			: new ConnectionTokenLookupError(undefined, {
					lookupKind: "user_latest",
				});
	}
}

/**
 * Fetch a connection token filtered by required scopes.
 * Uses Descope's Outbound Application API with scope-based token selection.
 *
 * @param client - Descope management client
 * @param appId - The connected app ID
 * @param userId - The Descope user ID
 * @param scopes - Required OAuth scopes
 * @param tenantId - Optional tenant ID
 * @returns Connection token data or null if not found/insufficient scopes
 */
export async function fetchConnectionTokenByScopes(
	client: DescopeClient,
	appId: string,
	userId: string,
	scopes: string[],
	tenantId?: string,
): Promise<ConnectionToken | null> {
	let lookupFailure: ConnectionTokenLookupError | undefined;
	const fetchFallback = async () => {
		const fallback = await fetchConnectionToken(
			client,
			appId,
			userId,
			tenantId,
		);
		if (tokenCoversScopes(fallback, scopes)) return fallback;
		if (lookupFailure) throw lookupFailure;
		return null;
	};

	try {
		const response =
			await client.management.outboundApplication.fetchTokenByScopes(
				appId,
				userId,
				scopes,
				{ withRefreshToken: false },
				tenantId,
			);

		if (!response.ok || !response.data) {
			if (response.code !== 404)
				lookupFailure = new ConnectionTokenLookupError(response.code, {
					lookupKind: "user_scoped",
					upstreamCode: response.error?.errorCode,
				});
			return fetchFallback();
		}

		const token = response.data;
		if (
			isNamedConnectionExternalIdentifier(
				(token as unknown as Record<string, unknown>).externalIdentifier,
			)
		)
			return fetchFallback();
		const accessToken = extractAccessToken(token.accessToken ?? "");

		if (!accessToken) return fetchFallback();

		return {
			id: token.id,
			accessToken,
			expiresAt: token.accessTokenExpiry,
			scopes: token.scopes,
		};
	} catch (error) {
		lookupFailure =
			error instanceof ConnectionTokenLookupError
				? error
				: new ConnectionTokenLookupError(undefined, {
						lookupKind: "user_scoped",
					});
	}

	// Descope can return 404 for scope-filtered lookup even when fetchToken()
	// returns a live token with the required scopes. Keep the runtime strict by
	// validating the fallback token locally before returning it.
	return fetchFallback();
}

/**
 * Fetch a connection token scoped to a tenant (organization).
 * Used for tedi-operated connections where the token belongs to the org, not a specific user.
 *
 * @param client - Descope management client
 * @param appId - The connected app ID (Descope outbound app ID)
 * @param tenantId - Descope tenant ID (organization-level)
 * @returns Connection token data or null if not found
 */
export async function fetchTenantConnectionToken(
	client: DescopeClient,
	appId: string,
	tenantId: string,
): Promise<ConnectionToken | null> {
	try {
		const response =
			await client.management.outboundApplication.fetchTenantToken(
				appId,
				tenantId,
				{ forceRefresh: false },
			);

		if (!response.ok) {
			if (response.code === 404) return null;
			throw new ConnectionTokenLookupError(response.code, {
				lookupKind: "tenant_latest",
				upstreamCode: response.error?.errorCode,
			});
		}
		if (!response.data)
			throw new ConnectionTokenLookupError(undefined, {
				lookupKind: "tenant_latest",
			});

		const token = response.data;
		if (
			isNamedConnectionExternalIdentifier(
				(token as unknown as Record<string, unknown>).externalIdentifier,
			)
		)
			return null;
		const accessToken = extractAccessToken(token.accessToken ?? "");

		// Descope may return ok=true with empty token data when the connection
		// exists but has no live token (e.g., after disconnect). Treat that as
		// "no token" so callers don't render stale "connected" status.
		if (!accessToken) {
			return null;
		}

		return {
			id: token.id,
			accessToken,
			expiresAt: token.accessTokenExpiry,
			scopes: token.scopes,
		};
	} catch (error) {
		throw error instanceof ConnectionTokenLookupError
			? error
			: new ConnectionTokenLookupError(undefined, {
					lookupKind: "tenant_latest",
				});
	}
}

/**
 * Fetch a tenant-scoped connection token filtered by scopes.
 * Used for tedi-operated connections that require specific OAuth scopes.
 *
 * @param client - Descope management client
 * @param appId - The connected app ID
 * @param tenantId - Descope tenant ID (organization-level)
 * @param scopes - Required OAuth scopes
 * @returns Connection token data or null if not found/insufficient scopes
 */
export async function fetchTenantConnectionTokenByScopes(
	client: DescopeClient,
	appId: string,
	tenantId: string,
	scopes: string[],
): Promise<ConnectionToken | null> {
	let lookupFailure: ConnectionTokenLookupError | undefined;
	const fetchFallback = async () => {
		const fallback = await fetchTenantConnectionToken(client, appId, tenantId);
		if (tokenCoversScopes(fallback, scopes)) return fallback;
		if (lookupFailure) throw lookupFailure;
		return null;
	};

	try {
		const response =
			await client.management.outboundApplication.fetchTenantTokenByScopes(
				appId,
				tenantId,
				scopes,
				{ withRefreshToken: false },
			);

		if (!response.ok || !response.data) {
			if (response.code !== 404)
				lookupFailure = new ConnectionTokenLookupError(response.code, {
					lookupKind: "tenant_scoped",
					upstreamCode: response.error?.errorCode,
				});
			return fetchFallback();
		}

		const token = response.data;
		if (
			isNamedConnectionExternalIdentifier(
				(token as unknown as Record<string, unknown>).externalIdentifier,
			)
		)
			return null;
		const accessToken = extractAccessToken(token.accessToken ?? "");

		if (!accessToken) {
			return fetchFallback();
		}

		return {
			id: token.id,
			accessToken,
			expiresAt: token.accessTokenExpiry,
			scopes: token.scopes,
		};
	} catch (error) {
		lookupFailure =
			error instanceof ConnectionTokenLookupError
				? error
				: new ConnectionTokenLookupError(undefined, {
						lookupKind: "tenant_scoped",
					});
	}

	return fetchFallback();
}

/**
 * Delete stored connection tokens for a user/app combination.
 * Uses Descope's Outbound Application API for token deletion.
 *
 * At least one of appId or userId must be provided.
 * Token deletion cannot be undone.
 *
 * @param client - Descope management client
 * @param appId - Optional app ID (if omitted, deletes all connections for user)
 * @param userId - Optional user ID (if omitted, deletes all connections for app)
 * @throws Error if neither appId nor userId is provided
 */
export async function deleteConnectionTokens(
	client: DescopeClient,
	appId?: string,
	userId?: string,
): Promise<void> {
	if (!appId && !userId) {
		throw new Error(
			"deleteConnectionTokens requires at least one of appId or userId",
		);
	}

	try {
		await client.management.outboundApplication.deleteUserTokens(appId, userId);
	} catch (error) {
		console.error("[Auth] deleteConnectionTokens failed:", error);
		throw error;
	}
}

/**
 * List outbound app IDs for which a user currently has a valid stored token.
 * Returns `null` when Descope cannot answer, so callers can fall back to legacy
 * per-app token probes without hiding connections during a transient API issue.
 *
 * Deliberately does not pass a tenantId to Descope: outbound apps here are
 * project-level (not tenant-scoped), so their stored user tokens aren't
 * tenant-indexed. Filtering by tenantId makes Descope return an empty (but
 * `ok: true`) list for every such app, which would silently hide every real
 * connection instead of surfacing a lookup failure.
 */
export async function listUserConnectedAppIds(
	client: DescopeClient,
	userId: string,
): Promise<Set<string> | null> {
	try {
		const response =
			await client.management.outboundApplication.listAppsWithUserToken(userId);
		if (!response.ok || !response.data) return null;
		return new Set(response.data.filter(Boolean));
	} catch (error) {
		console.warn("[Auth] listUserConnectedAppIds failed:", error);
		return null;
	}
}

function assertDescopeOk(
	response: { ok?: boolean; error?: unknown },
	operation: string,
): void {
	if (response.ok) return;
	const detail =
		response.error instanceof Error
			? response.error.message
			: typeof response.error === "string"
				? response.error
				: JSON.stringify(response.error ?? response);
	throw new Error(`${operation} failed: ${detail}`);
}

// =============================================================================
// API KEY / PAT TOKEN UPLOAD
// =============================================================================

/**
 * Upload a user-scoped API key or Personal Access Token to Descope's outbound app vault.
 *
 * Use a project-specific outbound app ID for distinct credentials
 * (for example one app per PromptWatch project) instead of storing labels.
 */
export async function uploadUserApiKeyToken(
	client: DescopeClient,
	params: UploadUserApiKeyTokenParams,
): Promise<void> {
	try {
		const response =
			await client.management.outboundApplication.uploadUserApiKey(
				params.appId,
				params.userId,
				params.apiKey,
				params.tenantId,
			);
		assertDescopeOk(response, "Descope outbound app user API key upload");
	} catch (error) {
		console.error("[Auth] uploadUserApiKeyToken failed:", error);
		throw error;
	}
}

/**
 * Upload a tenant-scoped API key or Personal Access Token to Descope's outbound app vault.
 *
 * Use a project-specific outbound app ID for distinct credentials
 * (for example one app per PromptWatch project) instead of storing labels.
 */
export async function uploadTenantApiKeyToken(
	client: DescopeClient,
	params: UploadTenantApiKeyTokenParams,
): Promise<void> {
	try {
		const response =
			await client.management.outboundApplication.uploadTenantApiKey(
				params.appId,
				params.tenantId,
				params.apiKey,
			);
		assertDescopeOk(response, "Descope outbound app tenant API key upload");
	} catch (error) {
		console.error("[Auth] uploadTenantApiKeyToken failed:", error);
		throw error;
	}
}

/**
 * Import an OAuth authorization-code result into Descope's tenant Token Vault.
 *
 * This is the settlement boundary for Tedix-owned CIMD callbacks. The caller
 * performs PKCE exchange and issuer validation first; this function moves the
 * resulting secret material directly into Descope and never persists it in D1.
 * Descope then owns refresh rotation and scoped token retrieval.
 */
export async function uploadTenantOAuthToken(
	env: DescopeConnectionManagementEnv,
	params: UploadTenantOAuthTokenParams,
): Promise<void> {
	if (!params.appId.trim()) throw new Error("OAuth token appId is required");
	if (!params.tenantId.trim())
		throw new Error("OAuth token tenantId is required");
	if (!params.accessToken.trim()) {
		throw new Error("OAuth token accessToken is required");
	}
	if (!params.grantedBy.trim()) {
		throw new Error("OAuth token grantedBy is required");
	}
	if (
		params.accessTokenExpiry !== undefined &&
		(!Number.isInteger(params.accessTokenExpiry) ||
			params.accessTokenExpiry <= 0)
	) {
		throw new Error(
			"OAuth token accessTokenExpiry must be positive Unix seconds",
		);
	}

	await postDescopeManagementJson(
		env,
		"/v1/mgmt/outbound/app/tenant/oauthtoken/upload",
		{
			appId: params.appId,
			tenantId: params.tenantId,
			accessToken: params.accessToken,
			...(params.refreshToken ? { refreshToken: params.refreshToken } : {}),
			...(params.accessTokenExpiry !== undefined
				? { accessTokenExpiry: params.accessTokenExpiry }
				: {}),
			accessTokenType: params.accessTokenType || "Bearer",
			...(params.scopes?.length ? { scopes: params.scopes } : {}),
			...(params.externalIdentifier
				? { externalIdentifier: params.externalIdentifier }
				: {}),
			...(params.idToken ? { idToken: params.idToken } : {}),
			grantedBy: params.grantedBy,
			verifyRefresh: params.verifyRefresh ?? false,
		},
		"Descope outbound app tenant OAuth token upload",
	);
}

/** Redeem one CIMD authorization code with PKCE and RFC 8707 binding. */
const CIMD_EXCHANGE_TIMEOUT_MS = 15_000;
const CIMD_TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;

async function readBoundedCimdResponse(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	const declaredLength = Number(response.headers.get("Content-Length"));
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > CIMD_TOKEN_RESPONSE_MAX_BYTES
	) {
		throw new Error("OAuth token endpoint response is too large");
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const cancelOnAbort = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal.addEventListener("abort", cancelOnAbort, { once: true });
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	let bytes = 0;
	let text = "";
	try {
		if (signal.aborted) throw new Error("OAuth token exchange timed out");
		for (;;) {
			const { done, value } = await reader.read();
			if (signal.aborted) throw new Error("OAuth token exchange timed out");
			if (done) break;
			bytes += value.byteLength;
			if (bytes > CIMD_TOKEN_RESPONSE_MAX_BYTES) {
				throw new Error("OAuth token endpoint response is too large");
			}
			text += decoder.decode(value, { stream: true });
		}
		return text + decoder.decode();
	} finally {
		signal.removeEventListener("abort", cancelOnAbort);
		void reader.cancel().catch(() => undefined);
	}
}

export async function exchangeCimdAuthorizationCode(
	params: {
		tokenUrl: string;
		code: string;
		codeVerifier: string;
		resource: string;
		redirectUri: string;
		clientId: string;
	},
	fetchFn: FetchLike = fetch,
): Promise<ExchangedOAuthToken> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code: params.code,
		code_verifier: params.codeVerifier,
		redirect_uri: params.redirectUri,
		client_id: params.clientId,
		resource: params.resource,
	});
	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => {
			controller.abort();
			reject(new Error("OAuth token exchange timed out"));
		}, CIMD_EXCHANGE_TIMEOUT_MS);
	});
	try {
		return await Promise.race([exchange(), timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}

	async function exchange(): Promise<ExchangedOAuthToken> {
		let response: Response;
		try {
			response = await guardedFetch(
				params.tokenUrl,
				{
					method: "POST",
					headers: {
						Accept: "application/json",
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body,
					signal: controller.signal,
				},
				{ fetchFn, maxRedirects: 0 },
			);
		} catch {
			throw new Error("OAuth token endpoint request failed");
		}
		if (response.status >= 300 && response.status < 400) {
			throw new Error("OAuth token endpoint redirected");
		}
		let text: string;
		try {
			text = await readBoundedCimdResponse(response, controller.signal);
		} catch (error) {
			if (
				error instanceof Error &&
				error.message === "OAuth token endpoint response is too large"
			)
				throw error;
			throw new Error("OAuth token endpoint response could not be read");
		}
		let payload: Record<string, unknown> = {};
		try {
			const parsed: unknown = text ? JSON.parse(text) : {};
			if (!isRecord(parsed)) throw new Error("Invalid token response");
			payload = parsed;
		} catch {
			throw new Error("OAuth token endpoint returned invalid JSON");
		}
		if (!response.ok) {
			throw new Error(`OAuth token exchange failed (HTTP ${response.status})`);
		}
		if (typeof payload.access_token !== "string" || !payload.access_token) {
			throw new Error("OAuth token response missing access_token");
		}
		const expiresIn =
			typeof payload.expires_in === "number" &&
			Number.isFinite(payload.expires_in) &&
			payload.expires_in > 0
				? Math.floor(payload.expires_in)
				: undefined;
		const scope = typeof payload.scope === "string" ? payload.scope.trim() : "";
		return {
			accessToken: payload.access_token,
			...(typeof payload.refresh_token === "string" && payload.refresh_token
				? { refreshToken: payload.refresh_token }
				: {}),
			...(expiresIn
				? { accessTokenExpiry: Math.floor(Date.now() / 1000) + expiresIn }
				: {}),
			accessTokenType:
				typeof payload.token_type === "string" && payload.token_type
					? payload.token_type
					: "Bearer",
			...(scope ? { scopes: scope.split(/\s+/) } : {}),
			...(typeof payload.id_token === "string" && payload.id_token
				? { idToken: payload.id_token }
				: {}),
		};
	}
}

// =============================================================================
// CONNECTION PROVIDER LIFECYCLE
// =============================================================================

/**
 * Detect the right `appType` for the Descope outbound app.
 *
 * Descope's server defaults `appType: "oauth"` if not sent, but the SDK type
 * doesn't expose this field on the create payload — meaning every app created
 * via the SDK gets tagged "oauth", including pure API-key entries that have no
 * clientId / authorizationUrl / tokenUrl. The Descope console correctly tags
 * API-key apps as "apikey" because it bypasses the SDK and sends the field
 * directly. We use raw REST to do the same.
 *
 * Verified against the Descope management API schema (CreateOutboundAppRequest) — `appType` is a top-level string field on the
 * create payload.
 */
function inferAppType(config: ConnectionProviderConfig): "oauth" | "apikey" {
	if (config.type === "api_key") return "apikey";
	if (config.type === "oauth") return "oauth";
	const isOAuth =
		!!config.authorizationUrl ||
		!!config.discoveryUrl ||
		!!config.tokenUrl ||
		!!config.clientId ||
		!!config.useDcr;
	return isOAuth ? "oauth" : "apikey";
}

function buildOutboundAppCreateBody(
	config: ConnectionProviderConfig & { id?: string },
): Record<string, unknown> {
	const body: Record<string, unknown> = {
		name: config.name,
		appType: inferAppType(config),
	};
	if (config.id) body.id = config.id;
	if (config.description) body.description = config.description;
	if (config.logo) body.logo = config.logo;
	if (config.clientId) body.clientId = config.clientId;
	if (config.clientSecret) body.clientSecret = config.clientSecret;
	if (config.authorizationUrl) body.authorizationUrl = config.authorizationUrl;
	if (config.authorizationUrlParams?.length)
		body.authorizationUrlParams = config.authorizationUrlParams;
	if (config.tokenUrl) body.tokenUrl = config.tokenUrl;
	if (config.tokenUrlParams?.length)
		body.tokenUrlParams = config.tokenUrlParams;
	if (config.revocationUrl) body.revocationUrl = config.revocationUrl;
	if (config.discoveryUrl) body.discoveryUrl = config.discoveryUrl;
	if (config.pkce !== undefined) body.pkce = config.pkce;
	if (config.defaultScopes?.length) body.defaultScopes = config.defaultScopes;
	if (config.defaultRedirectUrl)
		body.defaultRedirectUrl = config.defaultRedirectUrl;
	if (config.callbackDomain) body.callbackDomain = config.callbackDomain;
	if (config.accessType) body.accessType = config.accessType;
	if (config.prompt?.length) body.prompt = config.prompt;
	if (config.useDcr !== undefined) body.useDcr = config.useDcr;
	if (config.dcrUrl) body.dcrUrl = config.dcrUrl;
	// `config.applicationType` is deliberately NOT forwarded: Descope performs
	// the upstream Dynamic Client Registration on our behalf and its outbound-app
	// API has no field to pass `application_type` through (CreateOutboundAppRequest
	// in the Descope management API). Sending an unknown field would be ignored
	// at best and rejected at worst. It stays as discovery metadata documenting
	// the intended confidential "web" client shape.
	//
	// CIMD MIGRATION DIRECTION (do not implement yet): RFC 7591 Dynamic Client
	// Registration (`useDcr`/`dcrUrl` above) is being deprecated in the 2026 MCP
	// authorization revision in favor of Client ID Metadata Documents (CIMD): the
	// client is identified by a stable HTTPS URL resolving to a hosted client
	// metadata JSON document, rather than registering per authorization server.
	// Once Descope (or a Tedix-hosted client) exposes a CIMD URL, this DCR path
	// should be superseded by publishing that document and passing its URL as the
	// `client_id`, with `application_type: "web"` declared inside the document.
	// Keep DCR working until CIMD is broadly supported upstream.
	return body;
}

function buildOutboundAppMetadataUpdateBody(
	appId: string,
	config: ConnectionProviderMetadataUpdate,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const body: Record<string, unknown> = { ...existing, id: appId };
	if (config.name !== undefined) body.name = config.name;
	if (config.description !== undefined) body.description = config.description;
	if (config.logo !== undefined) body.logo = config.logo;
	if (config.defaultScopes !== undefined)
		body.defaultScopes = config.defaultScopes;
	if (typeof body.name !== "string" || body.name.trim().length === 0) {
		throw new Error(
			`Descope outbound app ${appId} is missing name; cannot update metadata safely`,
		);
	}
	return body;
}

async function createOutboundAppViaRest(
	body: Record<string, unknown>,
	env: DescopeConnectionManagementEnv,
): Promise<{ id: string }> {
	const data = (await postDescopeManagementJson(
		env,
		"/v1/mgmt/outbound/app/create",
		body,
		"Descope outbound app create",
	)) as { app?: { id: string }; id?: string };
	const id = data.app?.id ?? data.id;
	if (!id) {
		throw new Error("Descope outbound/app/create response missing app.id");
	}
	return { id };
}

async function updateOutboundAppViaRest(
	body: Record<string, unknown>,
	env: DescopeConnectionManagementEnv,
): Promise<{ id: string }> {
	const data = (await postDescopeManagementJson(
		env,
		"/v1/mgmt/outbound/app/update",
		{ app: body },
		"Descope outbound app update",
	)) as { app?: { id: string }; id?: string };
	const id = data.app?.id ?? data.id ?? (body.id as string | undefined);
	if (!id) {
		throw new Error("Descope outbound/app/update response missing app.id");
	}
	return { id };
}

async function loadOutboundAppViaRest(
	appId: string,
	env: DescopeConnectionManagementEnv,
): Promise<Record<string, unknown>> {
	const data = await getDescopeManagementJson(
		env,
		`/v1/mgmt/outbound/app/${encodeURIComponent(appId)}`,
		"Descope outbound app load",
	);
	const app = isRecord(data) && isRecord(data.app) ? data.app : data;
	if (!isRecord(app)) {
		throw new Error(`Descope outbound/app/${appId} response missing app`);
	}
	return app;
}

/**
 * Does a Descope outbound application still exist?
 *
 * Deleting an outbound app does NOT release its stored tenant API-key token:
 * `/v1/mgmt/outbound/app/tenant/token` keeps serving the credential and Descope
 * exposes no way to delete it (`/v1/mgmt/outbound/token` answers E151016 for
 * api-key tokens; the user-token endpoint demands a `userId`), so a deleted
 * app's orphaned token stays live. Callers use this to refuse credentials for an app that
 * no longer exists.
 *
 * Only a definitive 404 answers `false`. Transport errors and other statuses
 * answer `true`: a network blip must not sever credential resolution for a live
 * integration.
 */
export async function outboundAppExists(
	appId: string,
	env: DescopeConnectionManagementEnv,
): Promise<boolean> {
	try {
		const response = await descopeFetch(
			descopeManagementUrl(
				env,
				`/v1/mgmt/outbound/app/${encodeURIComponent(appId)}`,
			),
			{
				method: "GET",
				headers: {
					Authorization: descopeManagementAuthHeader(env),
					Accept: "application/json",
				},
			},
			{ idempotent: true },
		);
		return response.status !== 404;
	} catch (error) {
		console.warn(
			`[Auth] outboundAppExists(${appId}) probe failed, assuming it exists:`,
			error,
		);
		return true;
	}
}

async function normalizeProviderConfigLogo(
	config: ConnectionProviderConfig,
): Promise<ConnectionProviderConfig> {
	const logo = await normalizeDescopeLogoValue(config.logo);
	return logo === config.logo ? config : { ...config, logo };
}

async function normalizeProviderMetadataLogo(
	config: ConnectionProviderMetadataUpdate,
): Promise<ConnectionProviderMetadataUpdate> {
	if (config.logo === undefined) return config;
	const logo = await normalizeDescopeLogoValue(config.logo);
	return logo === config.logo ? config : { ...config, logo };
}

function isApiKeyOutboundAppShape(app: Record<string, unknown>): boolean {
	if (app.appType === "apikey") return true;
	const hasText = (value: unknown) =>
		typeof value === "string" && value.trim().length > 0;
	return !(
		hasText(app.authorizationUrl) ||
		hasText(app.discoveryUrl) ||
		hasText(app.tokenUrl) ||
		hasText(app.clientId) ||
		app.useDcr === true
	);
}

/**
 * Create a new connection provider (Descope Outbound Application).
 * Registers an OAuth/OIDC application or API-key entry in Descope's Token Vault.
 *
 * Uses raw REST (not the SDK) because Descope's Node SDK omits `appType`
 * from its OutboundApplication type — sending only what the SDK supports
 * leaves every app tagged "oauth" by server default, even pure API-key
 * entries. This breaks dashboards that classify by appType.
 *
 * @param env - Descope project + management key
 * @param config - Provider configuration (name, OAuth URLs, scopes, etc.)
 * @returns Object containing the created provider's ID
 */
/**
 * Default the OAuth callback domain to the project's Descope host (the custom
 * domain when configured, e.g. auth.tedix.dev) so the DCR-registered redirect
 * and the authorize redirect always agree. An explicit `callbackDomain` wins.
 * Applied at create time only — Descope bakes the redirect into the DCR client
 * at registration, so the domain must be present before the first connect.
 */
function applyDefaultCallbackDomain(
	config: ConnectionProviderConfig,
	env: DescopeConnectionManagementEnv,
): ConnectionProviderConfig {
	if (config.callbackDomain) return config;
	try {
		const host = new URL(env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL).host;
		return host ? { ...config, callbackDomain: host } : config;
	} catch {
		return config;
	}
}

export async function createConnectionProvider(
	env: DescopeConnectionManagementEnv,
	config: ConnectionProviderConfig,
): Promise<{ id: string }> {
	try {
		const normalizedConfig = await normalizeProviderConfigLogo(
			applyDefaultCallbackDomain(config, env),
		);
		try {
			return await createOutboundAppViaRest(
				buildOutboundAppCreateBody(normalizedConfig),
				env,
			);
		} catch (error) {
			if (
				normalizedConfig.logo !== config.logo &&
				typeof config.logo === "string" &&
				isHttpLogoUrl(config.logo) &&
				inferAppType(config) === "apikey"
			) {
				return await createOutboundAppViaRest(
					buildOutboundAppCreateBody(config),
					env,
				);
			}
			throw error;
		}
	} catch (error) {
		console.error("[Auth] createConnectionProvider failed:", error);
		throw error;
	}
}

/**
 * Create a new connection provider with a custom human-readable ID.
 *
 * `id` is an optional field on `createApplication` in the Descope SDK
 * (typed as `WithOptional<OutboundApplication, 'id'>`). Passing it sets a
 * stable ID (e.g. "google-gmail") so D1 app_tools.config.auth.connectionId
 * references never break when recreating connections.
 *
 * DCR fields (`useDcr`, `dcrUrl`) are not in the SDK type — they go through
 * raw REST only when specified.
 */
export async function createConnectionProviderWithId(
	appId: string,
	config: ConnectionProviderConfig,
	env: DescopeConnectionManagementEnv,
): Promise<{ id: string }> {
	// Always use raw REST — see createConnectionProvider for rationale.
	// The SDK doesn't expose `appType` (or DCR fields), so we'd lose both.
	const normalizedConfig = await normalizeProviderConfigLogo(
		applyDefaultCallbackDomain(config, env),
	);
	try {
		return await createOutboundAppViaRest(
			buildOutboundAppCreateBody({ ...normalizedConfig, id: appId }),
			env,
		);
	} catch (error) {
		if (
			normalizedConfig.logo !== config.logo &&
			typeof config.logo === "string" &&
			isHttpLogoUrl(config.logo) &&
			inferAppType(config) === "apikey"
		) {
			return await createOutboundAppViaRest(
				buildOutboundAppCreateBody({ ...config, id: appId }),
				env,
			);
		}
		throw error;
	}
}

export async function updateConnectionProviderWithId(
	appId: string,
	config: ConnectionProviderConfig,
	env: DescopeConnectionManagementEnv,
): Promise<{ id: string }> {
	const normalizedConfig = await normalizeProviderConfigLogo(config);
	try {
		return await updateOutboundAppViaRest(
			buildOutboundAppCreateBody({ ...normalizedConfig, id: appId }),
			env,
		);
	} catch (error) {
		if (
			normalizedConfig.logo !== config.logo &&
			typeof config.logo === "string" &&
			isHttpLogoUrl(config.logo) &&
			inferAppType(config) === "apikey"
		) {
			return await updateOutboundAppViaRest(
				buildOutboundAppCreateBody({ ...config, id: appId }),
				env,
			);
		}
		throw error;
	}
}

export async function updateConnectionProviderMetadataWithId(
	appId: string,
	config: ConnectionProviderMetadataUpdate,
	env: DescopeConnectionManagementEnv,
): Promise<{ id: string }> {
	const existing = await loadOutboundAppViaRest(appId, env);
	const normalizedConfig = await normalizeProviderMetadataLogo(config);
	try {
		return await updateOutboundAppViaRest(
			buildOutboundAppMetadataUpdateBody(appId, normalizedConfig, existing),
			env,
		);
	} catch (error) {
		if (
			normalizedConfig.logo !== config.logo &&
			typeof config.logo === "string" &&
			isHttpLogoUrl(config.logo) &&
			isApiKeyOutboundAppShape(existing)
		) {
			return await updateOutboundAppViaRest(
				buildOutboundAppMetadataUpdateBody(appId, config, existing),
				env,
			);
		}
		throw error;
	}
}

export async function upsertConnectionProviderWithId(
	appId: string,
	config: ConnectionProviderConfig,
	env: DescopeConnectionManagementEnv,
): Promise<{ id: string; status: "created" | "updated" }> {
	try {
		const created = await createConnectionProviderWithId(appId, config, env);
		return { ...created, status: "created" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			!message.includes("409") &&
			!message.toLowerCase().includes("already") &&
			!message.toLowerCase().includes("exist") &&
			!message.includes("E151001") &&
			!message.toLowerCase().includes("failed to persist oauth app")
		) {
			throw error;
		}
		const updated = await updateConnectionProviderWithId(appId, config, env);
		return { ...updated, status: "updated" };
	}
}

/**
 * Delete a connection provider (Descope Outbound Application).
 * This is irreversible and removes all associated token storage.
 *
 * @param client - Descope management client
 * @param appId - The outbound app ID to delete
 */
export async function deleteConnectionProvider(
	client: DescopeClient,
	appId: string,
): Promise<void> {
	try {
		await client.management.outboundApplication.deleteApplication(appId);
	} catch (error) {
		console.error("[Auth] deleteConnectionProvider failed:", error);
		throw error;
	}
}

/**
 * Delete stored tokens for a tenant/app combination.
 *
 * The Descope SDK has no direct tenant token deletion method.
 * Strategy: fetch the tenant token to get its ID, then delete by ID.
 * Falls back to deleteUserTokens(appId) if the token has no ID.
 *
 * @param client - Descope management client
 * @param appId - The outbound app ID whose tokens should be deleted
 * @param tenantId - Descope tenant ID for the organization
 */
export async function deleteTenantTokens(
	client: DescopeClient,
	appId: string,
	tenantId: string,
): Promise<void> {
	try {
		// Fetch the tenant token to get its ID
		const response =
			await client.management.outboundApplication.fetchTenantToken(
				appId,
				tenantId,
				{ withRefreshToken: false },
			);

		if (response.ok && response.data?.id) {
			// Delete by specific token ID — safe, doesn't affect other tenants
			await client.management.outboundApplication.deleteTokenById(
				response.data.id,
			);
		} else {
			// Fallback: no-op — we cannot safely delete without a specific token ID
			// because deleteUserTokens(appId, undefined) would wipe ALL users' tokens
			// for this app. Log and return without deleting.
			console.warn(
				"[Auth] deleteTenantTokens: tenant token has no ID — skipping deletion to avoid data loss",
				{ appId, tenantId },
			);
		}
	} catch (error) {
		console.error("[Auth] deleteTenantTokens failed:", error);
		throw error;
	}
}

// =============================================================================
// SCOPE ESCALATION
// =============================================================================

/**
 * Adaptive Connect — request an OAuth connection URL for a user.
 *
 * Calls Descope's `POST /v1/mgmt/outbound/app/connect` (Adaptive Connect endpoint).
 * Used when a tool needs an OAuth token that doesn't exist yet, or when additional
 * consent is needed. Returns a URL to redirect the user through the OAuth flow.
 *
 * Auth: `Bearer {PROJECT_ID}:{userToken}` — user JWT (MCP access token), not management key.
 * Scopes default to the connection configuration but callers may pass an
 * explicit scope list to request least-privilege consent for a specific flow.
 *
 * Docs: https://docs.descope.com/agentic-identity-hub/connections/storing-connections#connection-endpoint
 *
 * @param appId - The Descope outbound app ID
 * @param redirectUrl - Where to redirect after the user grants consent
 * @param env - Project ID + optional base URL
 * @param userToken - Raw Descope user JWT (not management key)
 * @param tenantId - Optional tenant ID to associate the token with a specific tenant
 * @param scopes - Optional explicit scopes for this consent request
 * @returns `{ url }` — OAuth authorization URL to redirect the user to
 */
export async function getAdaptiveConnectUrl(
	appId: string,
	redirectUrl: string,
	env: { DESCOPE_PROJECT_ID: string; DESCOPE_BASE_URL?: string },
	userToken: string,
	tenantId?: string,
	scopes?: string[],
	externalIdentifier?: string,
): Promise<{ url: string }> {
	const baseUrl = env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL;

	const body: Record<string, unknown> = {
		appId,
		options: { redirectUrl },
	};
	if (scopes && scopes.length > 0) {
		body.options = { ...(body.options as Record<string, unknown>), scopes };
	}
	if (externalIdentifier !== undefined) {
		if (!externalIdentifier.trim() || externalIdentifier.length > 200) {
			throw new Error("Named connections require a valid account selector");
		}
		body.options = {
			...(body.options as Record<string, unknown>),
			externalIdentifier,
		};
	}
	if (tenantId) {
		body.tenantId = tenantId;
		body.tenantLevel = true;
	}

	const response = await descopeFetch(
		`${baseUrl}/v1/mgmt/outbound/app/connect`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${env.DESCOPE_PROJECT_ID}:${userToken}`,
			},
			body: JSON.stringify(body),
		},
		{ idempotent: false },
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "unknown");
		throw new Error(
			`Descope Adaptive Connect failed (${response.status}): ${text}`,
		);
	}

	const data = (await response.json()) as { url?: string };
	if (!data.url) {
		throw new Error("Descope Adaptive Connect returned no URL");
	}
	return { url: data.url };
}
