import type { DescopeClient } from "./descope.ts";
import { normalizeConnectionScopes } from "@tedix/api-contract/utils/mcp-scope-catalog";
import { descopeFetch, descopeManagementFetch } from "./descope-fetch.ts";
import { DESCOPE_DEFAULT_BASE_URL } from "./types.ts";
import { trimTrailingSlashes } from "./utils.ts";
import { isRecord } from "@tedix/api-contract/utils/is-record";

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

export interface DescopeConnectionManagementEnv {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
	DESCOPE_BASE_URL?: string;
}

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

function descopeManagementAuthHeader(
	env: DescopeConnectionManagementEnv,
): string {
	return `Bearer ${env.DESCOPE_PROJECT_ID}:${env.DESCOPE_MANAGEMENT_KEY}`;
}

function descopeManagementUrl(
	env: DescopeConnectionManagementEnv,
	path: string,
): string {
	const baseUrl = trimTrailingSlashes(
		env.DESCOPE_BASE_URL || DESCOPE_DEFAULT_BASE_URL,
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

export async function postDescopeManagementJson(
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

export function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function assertDescopeOk(
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

/** Reconcile scopes without replacing OAuth client settings or touching vaulted grants. */
export async function syncConnectionProviderScopes(
	appId: string,
	scopes: string[],
	env: DescopeConnectionManagementEnv,
	dryRun = true,
): Promise<{ before: string[]; after: string[]; changed: boolean }> {
	const existing = await loadOutboundAppViaRest(appId, env);
	const before = normalizeConnectionScopes(
		asStringArray(existing.defaultScopes),
	);
	const after = normalizeConnectionScopes(scopes);
	const changed = JSON.stringify(before) !== JSON.stringify(after);
	if (changed && !dryRun) {
		await updateOutboundAppViaRest(
			buildOutboundAppMetadataUpdateBody(
				appId,
				{ defaultScopes: after },
				existing,
			),
			env,
		);
		const actual = await loadOutboundAppViaRest(appId, env);
		if (
			JSON.stringify(
				normalizeConnectionScopes(asStringArray(actual.defaultScopes)),
			) !== JSON.stringify(after)
		) {
			throw new Error(`Descope connection ${appId} scope readback failed`);
		}
	}
	return { before, after, changed };
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
		assertDescopeOk(
			await client.management.outboundApplication.deleteApplication(appId),
			"outboundApplication.deleteApplication",
		);
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
 * Fails without deleting anything if the token has no ID.
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

		assertDescopeOk(response, "outboundApplication.fetchTenantToken");
		if (!response.data?.id)
			throw new Error("Tenant token has no ID; deletion cannot be confirmed");
		assertDescopeOk(
			await client.management.outboundApplication.deleteTokenById(
				response.data.id,
			),
			"outboundApplication.deleteTokenById",
		);
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
