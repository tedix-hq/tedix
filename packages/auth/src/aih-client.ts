/**
 * Descope Agentic Identity Hub (AIH) — MCP server + M2M client management
 *
 * Handles tedi-as-first-class-citizen auth:
 * - Register/update/delete MCP servers in Descope's AIH (per-app or per-tedi)
 * - Exchange client_id + client_secret for an AIH access token (no user consent)
 *
 * Raw-fetch calls do not go through the Descope SDK, so this module owns base
 * URL selection and request retry policy directly.
 */

import { descopeFetch, descopeManagementFetch } from "./descope-fetch.ts";
import {
	createDescopeResource,
	deleteDescopeResource,
	loadAllDescopeResources,
	loadDescopeResource,
	updateDescopeResource,
	type DescopeResource,
} from "./descope-resource.ts";
import { DESCOPE_MANAGEMENT_BASE_URL } from "./types.ts";

const DESCOPE_AIH_BASE_URL = DESCOPE_MANAGEMENT_BASE_URL;

export const AIH_CLIENT_ID_SECRET_NAME = "AIH_CLIENT_ID";
export const AIH_CLIENT_SECRET_SECRET_NAME = "AIH_CLIENT_SECRET";

export function aihClientSecretNames(target: string): {
	clientIdName: string;
	clientSecretName: string;
} {
	const suffix = target
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	if (!suffix) {
		return {
			clientIdName: AIH_CLIENT_ID_SECRET_NAME,
			clientSecretName: AIH_CLIENT_SECRET_SECRET_NAME,
		};
	}
	return {
		clientIdName: `${AIH_CLIENT_ID_SECRET_NAME}_${suffix}`,
		clientSecretName: `${AIH_CLIENT_SECRET_SECRET_NAME}_${suffix}`,
	};
}

export interface AihAccessToken {
	accessToken: string;
	expiresIn: number; // seconds
}

export interface AihEnv {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY: string;
	/**
	 * Optional override for the Descope API base URL. When unset, raw AIH calls
	 * default to `DESCOPE_AIH_BASE_URL` (https://api.descope.com), so production
	 * behavior is unchanged. Lets non-default environments honor a custom host.
	 */
	DESCOPE_BASE_URL?: string;
}

export const MCP_CONSENT_PAGE_URL = "https://os.tedix.dev/oauth/consent";
// Registrations made before multi-organization consent became the only mode.
const LEGACY_MCP_CONSENT_PAGE_URL = `${MCP_CONSENT_PAGE_URL}?mode=multi-org`;

// ---------------------------------------------------------------------------
// MCP Server Management — CRUD via Descope Management API
// ---------------------------------------------------------------------------

export interface McpServerCreateParams {
	/** Display name shown in Descope Console and consent screens */
	name: string;
	/** Optional description */
	description?: string;
	/** Complete exact audience set accepted by the shared MCP resource server. */
	audienceWhitelist: string[];
	/** Scopes clients can request (categorized object). Defaults to a single minimal read-only (tedi:read) connection scope. */
	approvedScopes?: McpServerApprovedScopes;
	/** Callback URLs pre-approved for pre-registered OAuth clients. */
	approvedCallbackUrls?: string[];
	/** Enable DCR as a compatibility fallback for clients without CIMD support. */
	dynamicRegistration?: McpServerDynamicRegistration;
	/** Enable CIMD as the preferred AIH MCP client registration path. */
	cimdSettings?: CimdSettings;
	/** Optional AIH token/session lifetime settings. */
	sessionSettings?: McpServerSessionSettings;
	/** Operator-facing tags in Descope. */
	tags?: string[];
	/** Square logo shown in Descope consent/client surfaces. */
	logo?: string;
	/** Override the login page URL — inbound apps must use an `inbound-apps-*-consent` flow */
	loginPageURL?: string;
	/** Skip user consent screen (useful for internal/trusted tedis) */
	skipConsentScreen?: boolean;
	/** Ask Descope to attach all authorization metadata to generated tokens. */
	forceAddAllAuthorizationInfo?: boolean;
}

export interface McpServerDynamicRegistration {
	enabled?: boolean;
	flowId?: string | null;
	disableApprovedScopesAsDefault?: boolean | null;
	[key: string]: unknown;
}

export interface CimdDomainPolicy {
	domainPattern: string;
	enabled?: boolean;
	[key: string]: unknown;
}

export interface CimdSettings {
	enabled?: boolean;
	domainPolicies?: {
		policies?: CimdDomainPolicy[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface McpServerSessionSettings {
	enabled?: boolean;
	refreshTokenExpiration?: number;
	sessionTokenExpiration?: number;
	keySessionTokenExpiration?: number;
	[key: string]: unknown;
}

export interface McpServerScope {
	name: string;
	description?: string;
	optional?: boolean;
	values?: string[];
	[key: string]: unknown;
}

/** Descope returns approvedScopes as a categorized object, not a flat array. */
export interface McpServerApprovedScopes {
	permissionsScopes?: McpServerScope[];
	attributesScopes?: McpServerScope[];
	connectionsScopes?: McpServerScope[];
	[key: string]: unknown;
}

export interface McpServerRecord {
	id: string;
	name: string;
	description?: string | null;
	audienceWhitelist?: string[] | null;
	approvedScopes?: McpServerApprovedScopes | null;
	approvedCallbackUrls?: string[] | null;
	dynamicRegistration?: McpServerDynamicRegistration | null;
	cimdSettings?: CimdSettings | null;
	sessionSettings?: McpServerSessionSettings | null;
	tags?: string[] | null;
	logo?: string | null;
	loginPageURL?: string | null;
	loginPageUrl?: string | null;
	skipConsentScreen?: boolean | null;
	forceAddAllAuthorizationInfo?: boolean | null;
	[key: string]: unknown;
}

export interface McpServerClientRecord {
	id: string;
	name?: string | null;
	clientId?: string | null;
	client_id?: string | null;
	mcpServerId?: string | null;
	scopes?: string[] | null;
	tags?: string[] | null;
	status?: string | null;
	[key: string]: unknown;
}

export interface McpServerClientCreateParams {
	name: string;
	mcpServerId: string;
	scopes?: string[];
	tags?: string[];
	approvedCallbackUrls?: string[];
	logo?: string;
	forceAddAllAuthorizationInfo?: boolean;
}

export interface McpServerClientUpdateParams extends McpServerClientCreateParams {
	id: string;
}

export interface McpServerClientCredentials {
	id: string;
	clientId: string;
	clientSecret: string;
}

function descopeAihUrl(
	env: Pick<AihEnv, "DESCOPE_BASE_URL">,
	path: string,
): string {
	return `${env.DESCOPE_BASE_URL ?? DESCOPE_AIH_BASE_URL}${path}`;
}

async function readDescopeErrorBody(response: Response): Promise<string> {
	return response.text().catch(() => "(no body)");
}

function postDescopeManagementJson(
	env: AihEnv,
	path: string,
	body: unknown,
	options: { idempotent: boolean; errorPrefix: string },
): Promise<Response> {
	return descopeManagementFetch(env, {
		url: descopeAihUrl(env, path),
		method: "POST",
		body,
		idempotent: options.idempotent,
		errorPrefix: options.errorPrefix,
	});
}

export function buildMcpLoginPageURL(): string {
	return MCP_CONSENT_PAGE_URL;
}

function isMcpLoginPageURL(value: string | null | undefined): boolean {
	return (
		value === MCP_CONSENT_PAGE_URL || value === LEGACY_MCP_CONSENT_PAGE_URL
	);
}

/**
 * Mainstream MCP-client (assistant) domains we allow by default. Single source
 * of truth for both the AIH CIMD domain policies below and the MCP edge's CIMD
 * resolution allowlist (`apps/mcp/src/auth-helpers.ts`), which previously
 * hand-maintained the same list and could drift.
 */
export const MAINSTREAM_ASSISTANT_CIMD_DOMAINS = [
	"claude.ai",
	"chatgpt.com",
	"codex.openai.com",
	"mcpjam.com",
	"os.tedix.dev",
] as const;

export const DEFAULT_CIMD_DOMAIN_POLICIES: CimdDomainPolicy[] =
	MAINSTREAM_ASSISTANT_CIMD_DOMAINS.map((domainPattern) => ({
		domainPattern,
		enabled: true,
	}));

function hardenCimdSettings(
	settings: CimdSettings | null | undefined,
): CimdSettings {
	const policies = settings?.domainPolicies?.policies ?? [];
	const managedDomains = new Set(MAINSTREAM_ASSISTANT_CIMD_DOMAINS);
	const customPolicies = policies.filter(
		(policy) =>
			!managedDomains.has(
				policy.domainPattern as (typeof MAINSTREAM_ASSISTANT_CIMD_DOMAINS)[number],
			),
	);
	return {
		...settings,
		enabled: settings?.enabled ?? true,
		domainPolicies: {
			...settings?.domainPolicies,
			policies: [...DEFAULT_CIMD_DOMAIN_POLICIES, ...customPolicies],
		},
	};
}

export function hardenDescopeMcpServerRegistration<T extends McpServerRecord>(
	server: T,
	_env: Pick<AihEnv, "DESCOPE_PROJECT_ID">,
): T & McpServerRecord {
	const dynamicRegistration = server.dynamicRegistration ?? {};
	const loginPageURL = server.loginPageURL ?? server.loginPageUrl ?? null;
	return {
		...server,
		loginPageURL: isMcpLoginPageURL(loginPageURL)
			? loginPageURL
			: buildMcpLoginPageURL(),
		dynamicRegistration: {
			...dynamicRegistration,
			// DCR is the compatibility fallback for clients without CIMD; CIMD is
			// the preferred path. Honor an explicit opt-out (`enabled: false`) so a
			// caller can prefer CIMD as primary; default to enabled when unset for
			// backward compatibility.
			enabled: dynamicRegistration.enabled ?? true,
			// The Client Registration Flow assesses both DCR and CIMD clients.
			// Preserve an operator-selected flow; it is separate from the User
			// Consent Flow controlled by `loginPageURL`.
			flowId: dynamicRegistration.flowId ?? "",
			// Least-privilege: DCR-registered clients must NOT inherit the server's
			// full approved-scope envelope as their default grant. They now request
			// scopes explicitly and fail closed otherwise. Already-registered clients
			// keep their existing grants until re-registered.
			disableApprovedScopesAsDefault: true,
		},
		cimdSettings: hardenCimdSettings(server.cimdSettings),
	};
}

/**
 * Register a new MCP server in Descope AIH.
 * Returns the created server record (includes `id` = descopeMcpResourceId).
 */
function resourceToMcpServerRecord(resource: DescopeResource): McpServerRecord {
	const settings = resource.dynamicRegistrationSettings ?? {};
	return {
		...resource,
		id: resource.id,
		name: resource.name,
		description: resource.description,
		audienceWhitelist: [resource.uri],
		approvedScopes: resource.scopes,
		dynamicRegistration: settings.dynamicRegistration,
		cimdSettings: settings.cimdSettings,
		sessionSettings: settings.sessionSettings,
		tags: settings.tags,
		loginPageURL: settings.loginPageURL,
		skipConsentScreen: settings.skipConsentScreen,
		forceAddAllAuthorizationInfo: settings.forceAddAllAuthorizationInfo,
	};
}

/**
 * Register a current OAuth MCP Resource (`RS...`). Current Descope Resources
 * own one canonical URI; callers must not pass the legacy multi-audience model.
 */
export async function registerDescopeMcpResource(
	env: AihEnv,
	params: McpServerCreateParams,
): Promise<McpServerRecord> {
	const audienceWhitelist = [
		...new Set(params.audienceWhitelist.map((value) => value.trim())),
	].filter(Boolean);
	if (audienceWhitelist.length === 0) {
		throw new Error("Descope MCP server requires at least one exact audience");
	}
	if (audienceWhitelist.length !== 1) {
		throw new Error(
			"Descope OAuth MCP Resources require exactly one canonical URI",
		);
	}
	const body = hardenDescopeMcpServerRegistration(
		{
			id: "",
			name: params.name,
			audienceWhitelist,
			// Least-privilege fallback: when a caller omits approvedScopes, default to
			// a minimal READ scope rather than full tedi access. Callers that need
			// broader consent scopes pass them explicitly (the two production callers
			// in apps/api already supply their own approvedScopes envelope).
			approvedScopes: params.approvedScopes ?? {
				connectionsScopes: [
					{ name: "tedi:read", description: "Read-only tedi access" },
				],
			},
			approvedCallbackUrls: params.approvedCallbackUrls,
			dynamicRegistration: params.dynamicRegistration,
			cimdSettings: params.cimdSettings,
			sessionSettings: params.sessionSettings,
			tags: params.tags,
			logo: params.logo,
			// `loginPageURL` controls which Descope flow runs on consent. Inbound-app
			// MCP servers MUST use one of the inbound-app variants — anything else
			// (e.g. `sign-up-or-in`) makes Descope reject the request with E102005
			// "The flow type is invalid for this operation". The Tedix OS consent
			// page runs `inbound-apps-multi-org-consent` and preselects the tenant
			// already bound to the OAuth request.
			//
			// **Domain matters**: serve the consent page from `auth.tedix.dev` (our
			// custom Descope domain), not `api.descope.com`. The dashboard sets the
			// `dct` cookie on the `tedix.dev` parent domain — that cookie is what
			// the consent flow uses to resolve the authenticated user. Hitting the
			// raw `api.descope.com` URL loses that authenticated browser context.
			loginPageURL: params.loginPageURL,
			skipConsentScreen: params.skipConsentScreen ?? false,
			forceAddAllAuthorizationInfo: params.forceAddAllAuthorizationInfo,
		},
		env,
	);

	const resource = await createDescopeResource(env, {
		name: body.name,
		description: body.description ?? undefined,
		uri: audienceWhitelist[0]!,
		type: "mcp",
		scopes: body.approvedScopes ?? undefined,
		dynamicRegistrationSettings: {
			dynamicRegistration: body.dynamicRegistration ?? undefined,
			cimdSettings: body.cimdSettings ?? undefined,
			sessionSettings: body.sessionSettings ?? undefined,
			tags: body.tags ?? undefined,
			loginPageURL: body.loginPageURL ?? undefined,
			skipConsentScreen: body.skipConsentScreen ?? undefined,
			forceAddAllAuthorizationInfo:
				body.forceAddAllAuthorizationInfo ?? undefined,
		},
	});
	return resourceToMcpServerRecord(resource);
}

/**
 * Load a single MCP server from Descope AIH by ID.
 */
export async function loadDescopeMcpServer(
	env: AihEnv,
	mcpServerId: string,
): Promise<McpServerRecord> {
	return resourceToMcpServerRecord(await loadDescopeResource(env, mcpServerId));
}

/**
 * Update an existing MCP server in Descope AIH.
 * Note: Descope update requires the full server object (not a partial patch).
 */
export async function updateDescopeMcpServer(
	env: AihEnv,
	server: McpServerRecord,
): Promise<McpServerRecord> {
	const hardenedServer = hardenDescopeMcpServerRegistration(server, env);
	const current = await loadDescopeResource(env, server.id);
	const resource = await updateDescopeResource(env, {
		...current,
		name: hardenedServer.name,
		description: hardenedServer.description ?? undefined,
		uri: hardenedServer.audienceWhitelist?.[0] ?? current.uri,
		scopes: hardenedServer.approvedScopes ?? undefined,
		dynamicRegistrationSettings: {
			...current.dynamicRegistrationSettings,
			dynamicRegistration: hardenedServer.dynamicRegistration ?? undefined,
			cimdSettings: hardenedServer.cimdSettings ?? undefined,
			sessionSettings: hardenedServer.sessionSettings ?? undefined,
			tags: hardenedServer.tags ?? undefined,
			loginPageURL: hardenedServer.loginPageURL ?? undefined,
			skipConsentScreen: hardenedServer.skipConsentScreen ?? undefined,
			forceAddAllAuthorizationInfo:
				hardenedServer.forceAddAllAuthorizationInfo ?? undefined,
		},
	});
	return resourceToMcpServerRecord(resource);
}

/**
 * Delete an MCP server from Descope AIH by ID.
 */
export async function deleteDescopeMcpServer(
	env: AihEnv,
	mcpServerId: string,
): Promise<void> {
	await deleteDescopeResource(env, mcpServerId);
}

/**
 * Load all MCP servers in the Descope project.
 */
export async function loadAllDescopeMcpServers(
	env: AihEnv,
): Promise<McpServerRecord[]> {
	return (await loadAllDescopeResources(env)).map(resourceToMcpServerRecord);
}

// ---------------------------------------------------------------------------
// MCP Server Client Management — AIH pre-registered clients
// ---------------------------------------------------------------------------

function getClientIdFromRecord(client: McpServerClientRecord): string | null {
	return client.clientId ?? client.client_id ?? null;
}

function normalizeClientList(data: unknown): McpServerClientRecord[] {
	const body = data as {
		clients?: McpServerClientRecord[];
		data?: McpServerClientRecord[];
		client?: McpServerClientRecord;
	};
	if (Array.isArray(body.clients)) return body.clients;
	if (Array.isArray(body.data)) return body.data;
	if (body.client) return [body.client];
	return [];
}

function normalizeClientRecord(data: unknown): McpServerClientRecord | null {
	const body = data as {
		client?: McpServerClientRecord;
		data?: McpServerClientRecord;
	};
	return body.client ?? body.data ?? null;
}

/**
 * Create a pre-registered client on an AIH MCP server.
 *
 * This is the management-plane equivalent of setting up an M2M client for a
 * tedi. Descope policies only filter human authorization-code tokens; for
 * client_credentials tedis, the MCP server client scopes are the source of truth.
 */
export async function createDescopeMcpServerClient(
	env: AihEnv,
	params: McpServerClientCreateParams,
): Promise<McpServerClientCredentials> {
	const response = await postDescopeManagementJson(
		env,
		"/v1/mgmt/mcp/server/client/create",
		params,
		{
			idempotent: false,
			errorPrefix: "AIH MCP server client create failed",
		},
	);
	const data = (await response.json()) as {
		id?: string;
		clientId?: string;
		client_id?: string;
		cleartext?: string;
		client?: McpServerClientRecord & {
			cleartext?: string;
			clientSecret?: string;
			client_secret?: string;
		};
	};
	const client = data.client;
	const id = data.id ?? client?.id;
	const clientId =
		data.clientId ??
		data.client_id ??
		(client ? getClientIdFromRecord(client) : null);
	const clientSecret =
		data.cleartext ??
		client?.cleartext ??
		client?.clientSecret ??
		client?.client_secret;

	if (!id || !clientId || !clientSecret) {
		throw new Error(
			"AIH MCP server client create response missing id, clientId, or cleartext secret",
		);
	}

	return { id, clientId, clientSecret };
}

/**
 * Update a pre-registered AIH MCP server client. Descope's endpoint expects the
 * full mutable client payload, so callers pass the current id plus target fields.
 *
 * Known flakiness: `/v1/mgmt/mcp/server/client/update` has returned intermittent
 * 500s on scope changes. For a SCOPE change, prefer delete + recreate (as
 * `tedi-aih-client-sync.ts` does) — but note that path ROTATES the client secret,
 * so it is only safe when the caller re-persists the new credentials. For
 * metadata-only edits (tags, name) that must keep the existing secret, use this
 * update in place and let the caller handle a transient 500 via retry.
 */
export async function updateDescopeMcpServerClient(
	env: AihEnv,
	params: McpServerClientUpdateParams,
): Promise<McpServerClientRecord> {
	const response = await postDescopeManagementJson(
		env,
		"/v1/mgmt/mcp/server/client/update",
		params,
		{
			idempotent: false,
			errorPrefix: "AIH MCP server client update failed",
		},
	);
	const client = normalizeClientRecord(await response.json());
	if (!client?.id) {
		throw new Error("AIH MCP server client update response missing client.id");
	}
	return client;
}

/**
 * Search registered clients for an AIH MCP server.
 */
export async function searchDescopeMcpServerClients(
	env: AihEnv,
	params: { mcpServerId: string; name?: string; clientId?: string },
): Promise<McpServerClientRecord[]> {
	const response = await postDescopeManagementJson(
		env,
		"/v1/mgmt/mcp/server/clients/search",
		params,
		{
			idempotent: true,
			errorPrefix: "AIH MCP server clients search failed",
		},
	);
	return normalizeClientList(await response.json());
}

/**
 * Retrieve the current cleartext secret for a pre-registered AIH client.
 */
export async function getDescopeMcpServerClientSecret(
	env: AihEnv,
	params: { id: string; mcpServerId: string },
): Promise<string> {
	const response = await postDescopeManagementJson(
		env,
		"/v1/mgmt/mcp/server/client/secret",
		params,
		{
			idempotent: true,
			errorPrefix: "AIH MCP server client secret load failed",
		},
	);
	const data = (await response.json()) as {
		cleartext?: string;
		clientSecret?: string;
		client_secret?: string;
	};
	const secret = data.cleartext ?? data.clientSecret ?? data.client_secret;
	if (!secret) {
		throw new Error("AIH MCP server client secret response missing cleartext");
	}
	return secret;
}

/**
 * Delete a pre-registered AIH MCP server client.
 */
export async function deleteDescopeMcpServerClient(
	env: AihEnv,
	params: { id: string; mcpServerId: string },
): Promise<void> {
	await postDescopeManagementJson(
		env,
		"/v1/mgmt/mcp/server/client/delete",
		params,
		{
			idempotent: false,
			errorPrefix: "AIH MCP server client delete failed",
		},
	);
}

/**
 * Delete many pre-registered clients on one AIH MCP server in a single call.
 *
 * The reaper drains hundreds of expired external-agent clients per run, and one
 * request per client is both slow and rate-limit-prone. Descope's plural
 * endpoint deletes an id list against a single `mcpServerId`; callers group ids
 * by server and chunk each group (Descope accepts large lists, but a bounded
 * chunk keeps a failed request's blast radius small and the retry cheap).
 * Idempotent by nature — deleting an already-absent id is not an error.
 */
export async function deleteDescopeMcpServerClients(
	env: AihEnv,
	params: { ids: string[]; mcpServerId: string },
): Promise<void> {
	if (params.ids.length === 0) return;
	await postDescopeManagementJson(
		env,
		"/v1/mgmt/mcp/server/clients/delete",
		params,
		{
			idempotent: true,
			errorPrefix: "AIH MCP server clients batch delete failed",
		},
	);
}

// Inbound-application (thirdparty) consent management was removed with the inert
// `CONSENT_PURGE_ON_SCOPE_CHANGE` path. If consent search/purge is ever needed,
// build it on the SDK — `management.inboundApplication.searchConsents` /
// `deleteConsents` (present in @descope/node-sdk >= 2.9.0) — not a raw-fetch
// mirror.

/**
 * Exchange client_id + client_secret for a short-lived AIH access token.
 * Uses client_credentials grant — no user consent; AIH policies still apply.
 * The token's `aud` claim includes the MCP server URL.
 */
export async function exchangeAihClientCredentials(
	env: Pick<AihEnv, "DESCOPE_PROJECT_ID" | "DESCOPE_BASE_URL">,
	resource: string,
	clientId: string,
	clientSecret: string,
): Promise<AihAccessToken> {
	const body = new URLSearchParams({
		grant_type: "client_credentials",
		client_id: clientId,
		client_secret: clientSecret,
		resource,
	});

	const response = await descopeFetch(
		descopeAihUrl(env, "/oauth2/v1/apps/token"),
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
		},
		// client_credentials token issuance is stateless-safe to retry: an extra
		// issued token has no side effect. Marking it idempotent unlocks
		// descopeFetch's 5xx/timeout retries (non-idempotent calls retry 429 only).
		{ idempotent: true },
	);

	if (!response.ok) {
		const responseBody = await readDescopeErrorBody(response);
		throw new Error(
			`AIH token exchange failed [${response.status} ${response.statusText}]: ${responseBody}`,
		);
	}

	const data = (await response.json()) as {
		access_token?: string;
		expires_in?: number;
		token_type?: string;
	};

	if (!data.access_token) {
		throw new Error(`AIH token exchange response missing access_token`);
	}

	return {
		accessToken: data.access_token,
		expiresIn: data.expires_in ?? 3600,
	};
}
