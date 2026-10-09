/**
 * MCP Worker -- Auth helpers for the edge layer
 *
 * These are app-specific auth utilities used by the MCP Worker's
 * complex edge auth flow in index.ts. They wrap @tedix/auth JWT
 * validation and produce the OAuthUserContext used by this Worker.
 *
 * Generic/reusable auth middleware lives in @tedix/mcp-shared/auth.
 * This file contains only the app-specific wrappers that need access
 * to CloudflareEnv and WWW-Authenticate formatting.
 */

import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import {
	isDelegatedMcpToken,
	verifyDelegatedMcpToken,
	type DelegatedMcpClaims,
} from "@tedix/auth/delegated-mcp-token";
import { resolveLocalDemoUser } from "@tedix/auth/local-demo";
import {
	decodeTokenUnsafe,
	TokenValidationError,
	validateToken,
} from "@tedix/auth/jwt";
import { type AuthPrincipal, internalPrincipal } from "@tedix/auth/principal";
import { hasResourceAudience } from "@tedix/auth/resource-audience";
import {
	DESCOPE_MANAGEMENT_BASE_URL,
	extractJwtScopes,
	getTenantId,
	isPlatformAdmin,
	type JWTPayload,
} from "@tedix/auth/types";
import { buildWwwAuthenticate } from "@tedix/mcp-shared/auth";
import { CAPABILITY_SCOPES, hasScope } from "@tedix/mcp-shared/auth/scopes";
import { isServiceBinding } from "@tedix/worker-kit/request-auth";
import { getApiClient } from "./lib/api-client";
import { createMcpLogger } from "./log";
import type { AppTool } from "./mcp/server-context";
import {
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";

// Stable dot-separated component identities for this Worker's auth subsystem.
// They are the field every auth dashboard filters on, so they never interpolate.
const aihLog = createMcpLogger("mcp.auth.aih");
const authLog = createMcpLogger("mcp.auth.jwt");
const BROWSER_CAPABILITY_SCOPES = new Set<string>(CAPABILITY_SCOPES);

// =============================================================================
// TYPES
// =============================================================================

export interface OAuthUserContext {
	type: "oauth";
	/** Set only by verified credential-free loopback authentication, never headers. */
	localDemo?: true;
	userId?: string;
	organizationId?: string;
	email?: string;
	clientId?: string;
	scopes?: string[];
	payload: JWTPayload;
}

export interface ServiceBindingContext {
	type: "service-binding";
	userId?: string;
	organizationId?: string;
	scopes?: string[];
	principal?: AuthPrincipal;
	/**
	 * Tenant control-plane marker (kernel direct reads/writes). True only
	 * when the AUTHENTICATED service-binding caller sent X-Tedix-Kernel —
	 * external requests can never set it (public ingress strips the
	 * service-binding marker). Telemetry maps it to the
	 * `kernel` actor type; it does not change auth behavior.
	 */
	kernel?: boolean;
}

export interface DelegatedMcpContext {
	type: "delegated-mcp";
	claims: DelegatedMcpClaims;
}

export type AuthContext =
	| OAuthUserContext
	| ServiceBindingContext
	| DelegatedMcpContext;

export interface MultiOrgMcpSelection {
	organizations: Array<{
		organizationId: string;
		descopeTenantId: string;
		gatewaySlug: string;
	}>;
}

/**
 * Why a human MCP selection was not accepted. `unavailable` means the grant
 * could not be checked (provider or API outage) and the caller should retry;
 * otherwise the token or its grant is not valid and the client must reconnect.
 */
export type HumanMcpSelectionResult =
	| { ok: true; selection: MultiOrgMcpSelection }
	| { ok: false; unavailable: boolean; reason: string };

type HumanMcpSelectionConfig = {
	audience: string;
	mcpServerId: string;
	tenantId?: string;
	multiOrganization?: boolean;
};

/**
 * Accept only a human token for this one resource, then resolve its signed
 * selected tenant IDs through the API's live consent and membership check.
 * This check is repeated for every MCP request, including discovery.
 */
export async function validateHumanMcpSelection(
	payload: JWTPayload,
	env: CloudflareEnv,
	config: HumanMcpSelectionConfig,
): Promise<MultiOrgMcpSelection | null> {
	const result = await resolveHumanMcpSelection(payload, env, config);
	return result.ok ? result.selection : null;
}

/**
 * A grant that could not be checked is a retryable 503 and never asks the user
 * to reconnect; a real grant problem stays 403 and names its reason.
 */
export function humanMcpGrantFailureResponse(
	result: Extract<HumanMcpSelectionResult, { ok: false }>,
): Response {
	return Response.json(
		result.unavailable
			? {
					error: "human_mcp_grant_unavailable",
					reason: result.reason,
					message:
						"Access could not be verified right now. Retry shortly; reconnecting is not needed.",
				}
			: {
					error: "human_mcp_grant_invalid",
					reason: result.reason,
					message: `Reconnect this application to review permissions (${result.reason}).`,
				},
		{
			status: result.unavailable ? 503 : 403,
			headers: result.unavailable ? { "Retry-After": "5" } : undefined,
		},
	);
}

/** {@link validateHumanMcpSelection} with the denial reason kept. */
export async function resolveHumanMcpSelection(
	payload: JWTPayload,
	env: CloudflareEnv,
	config: HumanMcpSelectionConfig,
): Promise<HumanMcpSelectionResult> {
	const invalid = (reason: string): HumanMcpSelectionResult => ({
		ok: false,
		unavailable: false,
		reason,
	});
	const exactAudience = hasResourceAudience(payload, config.audience);
	const selected = payload.tedixSelectedOrganizations;
	if (
		!exactAudience ||
		payload.token_type !== "access_token" ||
		typeof payload.sub !== "string" ||
		!payload.sub ||
		typeof payload.dci !== "string" ||
		!payload.dci ||
		typeof payload.tedixConsentRevision !== "string" ||
		!payload.tedixConsentRevision ||
		typeof payload.azp !== "string" ||
		!payload.azp ||
		!Array.isArray(selected) ||
		selected.length < 1 ||
		selected.length > 10 ||
		selected.some((id) => typeof id !== "string" || !id || id.length > 256) ||
		new Set(selected).size !== selected.length
	) {
		return invalid("token_claims_invalid");
	}
	const scopes = extractJwtScopes(payload).filter(
		(scope) =>
			!["openid", "offline_access", "profile", "email"].includes(scope),
	);
	if (scopes.length === 0) return invalid("scope_missing");
	if (
		!config.multiOrganization &&
		(selected.length !== 1 ||
			payload.dct !== selected[0] ||
			(config.tenantId && selected[0] !== config.tenantId))
	)
		return invalid("token_claims_invalid");
	const sub = payload.sub;
	const azp = payload.azp;
	const dci = payload.dci;
	const tedixConsentRevision = payload.tedixConsentRevision;
	const decision = await Promise.resolve()
		.then(() =>
			getApiClient({
				serviceFetch: env.API_SERVICE,
			}).organizations.verifyMultiOrgMcpGrant({
				descopeUserId: sub,
				selectedTenantIds: selected as string[],
				mcpServerId: config.mcpServerId,
				clientId: azp,
				consentId: dci,
				consentRevision: tedixConsentRevision,
				tokenScopes: scopes,
			}),
		)
		.catch(() => null);
	// The API was unreachable or failed: the grant was not judged.
	if (!decision)
		return { ok: false, unavailable: true, reason: "grant_check_failed" };
	if (!decision.allowed)
		return decision.reason === "provider_unavailable"
			? { ok: false, unavailable: true, reason: decision.reason }
			: invalid(decision.reason);
	if (
		decision.organizations.length !== selected.length ||
		decision.organizations.some(
			(org, index) => org.descopeTenantId !== selected[index],
		)
	)
		return invalid("selection_mismatch");
	return { ok: true, selection: { organizations: decision.organizations } };
}

export function resolveMcpExpectedAudience(options: {
	hostname: string;
	authMode?: string;
	configuredAudience?: string;
}): string | null {
	if (options.authMode !== "proxy-target") {
		return `https://${options.hostname}/mcp`;
	}

	return options.configuredAudience?.trim() || null;
}

/**
 * Descope AIH client-credentials tokens are bound to an exact AIH MCP server
 * through their signed issuer and registered client, but their `aud` claim is
 * the client/project pair rather than the public MCP resource URL. Human OAuth
 * tokens remain RFC 8707 URL-audience-bound.
 *
 * The decode here is deliberately untrusted: it can only choose which claim
 * shape the signature validator checks. The token is still validated below,
 * and the MCP edge subsequently resolves the signed client against this same
 * server id before granting any tedi or external-agent authority.
 */
export function resolveMcpTokenValidationAudience(options: {
	token: string;
	projectId: string;
	expectedAudience?: string;
	mcpServerId?: string;
}): string | undefined {
	if (!options.expectedAudience || !options.mcpServerId) {
		return options.expectedAudience;
	}
	const payload = decodeTokenUnsafe(options.token);
	const legacyIssuerPrefix = `${DESCOPE_MANAGEMENT_BASE_URL}/v1/apps/agentic/${options.projectId}/`;
	const legacyIssuer =
		typeof payload?.iss === "string" &&
		payload.iss.startsWith(legacyIssuerPrefix);
	const legacyIssuerMatchesServer =
		payload?.iss === `${legacyIssuerPrefix}${options.mcpServerId}`;
	const isAihClientCredentials =
		typeof payload?.azp === "string" &&
		payload.azp.length > 0 &&
		typeof payload.sub === "string" &&
		/^TPA[A-Za-z0-9_-]+$/.test(payload.sub) &&
		(!legacyIssuer || legacyIssuerMatchesServer);
	return isAihClientCredentials ? undefined : options.expectedAudience;
}

export interface AihM2mClientScopeContext {
	clientId?: string;
	clientRecordId: string;
	name?: string | null;
	/**
	 * Effective scopes for this client. For a tedi client resolved with a live
	 * profile resolver, these are already bounded to the tedi's CURRENT D1
	 * capability profile — see {@link intersectScopes} and the request-time
	 * intersection in {@link resolveAihM2mClientScopeContext}.
	 */
	scopes: string[];
	tags: string[];
	/**
	 * The tedi id parsed from the client's `tedi:{id}` tag, when this is a tedi
	 * client (not an external-agent or CI client). Present regardless of whether
	 * a live-profile resolver was supplied.
	 */
	tediId?: string;
	/**
	 * The freshly-resolved (uncached) live D1 capability-profile scopes for
	 * {@link AihM2mClientScopeContext.tediId}, when a resolver was supplied and
	 * succeeded. The MCP edge enforces the intersection of these scopes and
	 * the exact server client's registered grant.
	 */
	tediProfileScopes?: string[];
	externalAgent?: {
		organizationId: string;
		principalId: string;
		sessionId: string;
	};
}

/**
 * Intersect a registered AIH client's baked scopes with the tedi's live D1
 * capability-profile scopes. The result is the subset present in BOTH: a
 * stale-broad client credential can never exceed the tedi's current profile,
 * and the profile can never silently widen a client past what it was
 * registered for. Order-preserving on the client scopes and de-duplicated.
 *
 * This is a pure, additive tightening: when the client scopes already equal the
 * profile scopes (the normal freshly-synced case) it is a no-op.
 */
export function intersectScopes(
	clientScopes: readonly string[],
	profileScopes: readonly string[],
): string[] {
	const profileSet = new Set(profileScopes);
	return [...new Set(clientScopes)].filter(
		(scope) =>
			profileSet.has(scope) ||
			(scope === "connections.read" && hasScope([...profileScopes], scope)),
	);
}

export interface ResolvedExternalAgentSessionAuth {
	principal: {
		id: string;
		organizationId: string;
		key: string;
		displayName: string;
		status: "active";
	};
	session: {
		id: string;
		organizationId: string;
		principalId: string;
		harness: string;
		harnessVersion: string;
		modelProvider: string;
		modelId: string;
		modelVersion: string;
		identitySource: "native" | "explicit" | "derived";
		status: "active";
		creditEligible: boolean;
	};
}

const AIH_M2M_CLIENT_SCOPE_CACHE_MAX_ENTRIES = 100;
const AIH_M2M_CLIENT_SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Short TTL for genuine misses (search succeeded, no matching client): a
 * freshly CLI-minted M2M client may not be visible to Descope search yet
 * (create→search propagation race), so a long-lived null would reject the
 * credential with tenant_mismatch "JWT has no tenant context" for minutes.
 * Transient search errors are never cached at all
 * (see lib/tenant-match.ts OrgTenantLookup for the same resolved/unresolved
 * pattern).
 */
const AIH_M2M_CLIENT_SCOPE_MISS_TTL_MS = 20 * 1000;
const aihM2mClientScopeCache = new Map<
	string,
	{ value: AihM2mClientScopeContext | null; expiresAt: number }
>();

interface AihMcpClientRecord {
	id?: string;
	name?: string | null;
	clientId?: string | null;
	client_id?: string | null;
	scopes?: string[] | null;
	tags?: string[] | null;
}

// =============================================================================
// HELPERS
// =============================================================================

export { buildWwwAuthenticate };

/**
 * Browser sessions may cross into the MCP edge only through a Worker service
 * binding. The marker alone is never trusted: public ingress strips the
 * service-binding marker, so isServiceBinding() is false for it.
 */
export function isTrustedBrowserBridge(headers: Headers): boolean {
	return (
		headers.get("X-Tedix-Browser-Bridge") === "true" &&
		isServiceBinding(headers)
	);
}

export function shouldEnforceTenantMatchForOAuth(
	headers: Pick<Headers, "get">,
	payload: { entityType?: unknown } | null,
): boolean {
	if (headers.get("x-tedix-auth-type") !== "oauth") return false;
	if (headers.get("x-tedix-auth-credential-mode") === "aih-m2m") {
		return false;
	}
	return payload?.entityType !== "tedi";
}

/**
 * AIH M2M tokens for tedis are issued under the platform Descope tenant, so
 * their JWT tenant is identity-provider metadata rather than the customer's
 * Tedix organization. Bind the request to the tedi's live D1 organization,
 * falling back only to the served app's already-resolved organization.
 */
export function resolveAihM2mTediOrganizationId(input: {
	liveOrganizationId?: string | null;
	servedAppOrganizationId?: string | null;
}): string | null {
	return input.liveOrganizationId ?? input.servedAppOrganizationId ?? null;
}

function getPayloadString(
	payload: Record<string, unknown>,
	key: string,
): string | null {
	const value = payload[key];
	return typeof value === "string" && value ? value : null;
}

function getMcpClientId(client: AihMcpClientRecord): string | null {
	return client.clientId ?? client.client_id ?? null;
}

function shouldAttemptAihM2mScopeHydration(
	payload: Record<string, unknown>,
): boolean {
	// Descope's SDK-normalized payload currently rewrites AIH M2M `iss` to the
	// project id, so the raw `/v1/apps/agentic/.../{mcpServerId}` issuer is not a
	// reliable post-validation signal. The authoritative check is the registered
	// AIH client lookup below, keyed by the validated token's client id.
	const hasClientId =
		Boolean(getPayloadString(payload, "client_id")) ||
		Boolean(getPayloadString(payload, "azp"));
	return hasClientId && Boolean(getPayloadString(payload, "sub"));
}

function normalizeAihM2mClientScopeContext(
	client: AihMcpClientRecord,
): AihM2mClientScopeContext | null {
	if (!client.id) return null;
	const tags = [...new Set(client.tags ?? [])].filter(Boolean);
	const isTediClient = tags.some((tag) => tag.startsWith("tedi:"));
	const isCiReleaseSmokeClient = tags.includes("ci:release-smoke");
	const isExternalAgentClient = tags.includes("external-agent");
	const taggedUuid = (prefix: string): string | null => {
		const matches = tags
			.filter((tag) => tag.startsWith(prefix))
			.map((tag) => tag.slice(prefix.length));
		if (matches.length !== 1) return null;
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			matches[0]!,
		)
			? matches[0]!
			: null;
	};
	let externalAgent: AihM2mClientScopeContext["externalAgent"];
	if (isExternalAgentClient) {
		const organizationId = taggedUuid("external-agent-org:");
		const principalId = taggedUuid("external-agent-principal:");
		const sessionId = taggedUuid("external-agent-session:");
		if (!organizationId || !principalId || !sessionId || isTediClient)
			return null;
		externalAgent = { organizationId, principalId, sessionId };
	}
	if (!isTediClient && !isCiReleaseSmokeClient && !externalAgent) return null;
	const tediTag = tags.find((tag) => tag.startsWith("tedi:"));
	const tediId =
		isTediClient && tediTag ? tediTag.slice("tedi:".length) : undefined;
	return {
		clientRecordId: client.id,
		clientId: getMcpClientId(client) ?? undefined,
		name: client.name,
		scopes: [...new Set(client.scopes ?? [])].filter(Boolean),
		tags,
		tediId: tediId || undefined,
		externalAgent,
	};
}

export async function resolveExternalAgentSessionAuth(
	env: CloudflareEnv,
	identity: NonNullable<AihM2mClientScopeContext["externalAgent"]>,
	clientRecordId: string,
): Promise<ResolvedExternalAgentSessionAuth> {
	if (!env.API_SERVICE) {
		throw new Error("API service binding is required for external-agent auth");
	}
	const resolved = await callRpc<ResolvedExternalAgentSessionAuth>(
		"externalAgentIdentity/resolveSessionAuth",
		{ ...identity, clientRecordId },
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": identity.organizationId,
			},
		},
	);
	if (
		resolved.principal.id !== identity.principalId ||
		resolved.session.id !== identity.sessionId ||
		resolved.principal.organizationId !== identity.organizationId
	) {
		throw new Error(
			"External-agent session validation returned mismatched identity",
		);
	}
	return resolved;
}

async function searchAihMcpServerClientsViaApi(
	env: CloudflareEnv,
	mcpServerId: string,
	clientId: string,
): Promise<AihMcpClientRecord[]> {
	if (!env.API_SERVICE) return [];

	const result = await callRpc<{ clients?: AihMcpClientRecord[] }>(
		"descopeAih/searchMcpClients",
		{ mcpServerId, clientId },
		{
			apiUrl: "https://api",
			fetch: serviceBindingFetch(env.API_SERVICE),
			headers: {
				"X-Service-Binding": "true",
				"X-Tedix-Org-Id": "system",
				// The API intentionally keeps AIH client inventory behind the
				// platform-admin machine boundary. This trusted service binding is
				// the MCP edge's narrow delegation for that exact lookup.
				"X-Tedix-Tedi-Scopes": "platform:admin",
			},
		},
	);
	return result.clients ?? [];
}

/**
 * Invalidate in-process AIH M2M client scope cache entries.
 * Returns the count of deleted entries.
 *
 * NOTE: This invalidates the in-process cache only. The service-binding call
 * from apps/api reaches one MCP isolate; the 5-min TTL covers remaining isolates.
 */
export function invalidateAihM2mClientScopeCache(filter?: {
	mcpServerId?: string;
}): number {
	if (!filter?.mcpServerId) {
		const count = aihM2mClientScopeCache.size;
		aihM2mClientScopeCache.clear();
		return count;
	}
	const segment = `:${filter.mcpServerId}:`;
	let count = 0;
	for (const key of aihM2mClientScopeCache.keys()) {
		if (key.includes(segment)) {
			aihM2mClientScopeCache.delete(key);
			count++;
		}
	}
	return count;
}

export interface ResolveAihM2mClientScopeOptions {
	/**
	 * Resolve a tedi's current live D1 capability-profile scopes at request time.
	 * When supplied and the matched client is a tedi client, the returned
	 * context's `scopes` are intersected with these so a stale-broad registered
	 * client credential can never exceed the tedi's live profile (defense in
	 * depth against a capability downgrade that has not yet propagated to the
	 * Descope client registration). A tedi whose live profile did not resolve
	 * must yield `[]`: registration scopes never stand in for missing D1
	 * authority, and the caller answers that request with a failure response.
	 */
	resolveTediProfileScopes?: (tediId: string) => Promise<readonly string[]>;
}

/**
 * AIH client-credentials tokens do not currently carry the registered MCP
 * client scopes as JWT claims. For tedi M2M callers, hydrate scopes from the
 * verified Descope AIH MCP client registration and let normal edge scope
 * enforcement continue from there.
 *
 * The client lookup itself is cached (see the TTLs above). The optional live
 * tedi-profile intersection is applied after the cache read, at request time,
 * so a capability change is reflected immediately and no profile snapshot is
 * ever stored in the shared client cache.
 */
export async function resolveAihM2mClientScopeContext(
	env: CloudflareEnv,
	payload: Record<string, unknown>,
	mcpServerId: string,
	options?: ResolveAihM2mClientScopeOptions,
): Promise<AihM2mClientScopeContext | null> {
	if (!env.DESCOPE_PROJECT_ID || !env.API_SERVICE || !mcpServerId) {
		return null;
	}

	if (!shouldAttemptAihM2mScopeHydration(payload)) {
		return null;
	}

	const subject = getPayloadString(payload, "sub");
	const authorizedParty =
		getPayloadString(payload, "azp") ?? getPayloadString(payload, "client_id");
	if (!subject && !authorizedParty) return null;

	const cacheKey = [
		env.DESCOPE_PROJECT_ID,
		mcpServerId,
		subject ?? "",
		authorizedParty ?? "",
	].join(":");
	const cached = aihM2mClientScopeCache.get(cacheKey);
	const now = Date.now();
	if (cached && cached.expiresAt > now) {
		return boundTediClientScopesToLiveProfile(cached.value, options);
	}

	let value: AihM2mClientScopeContext | null = null;
	try {
		// Descope's unfiltered search is windowed. Once a busy MCP resource has
		// enough registrations, a freshly issued external-agent client can fall
		// outside that window and be misclassified as ordinary OAuth. Filter by
		// the validated token's exact client id so catalog size cannot affect
		// authentication. `azp` is canonical for AIH client credentials;
		// `client_id` is the SDK-normalized equivalent used by some issuers.
		const clientId = authorizedParty ?? subject!;
		const clients = await searchAihMcpServerClientsViaApi(
			env,
			mcpServerId,
			clientId,
		);
		const client = clients.find((candidate) => {
			const clientId = getMcpClientId(candidate);
			return (
				!!subject &&
				candidate.id === subject &&
				!!authorizedParty &&
				clientId === authorizedParty
			);
		});
		value = client ? normalizeAihM2mClientScopeContext(client) : null;
	} catch (error) {
		aihLog.warn("Failed to hydrate M2M client scopes", {
			event: "aih.m2m_scope_hydration_failed",
			mcpServerId,
			outcome: "unavailable",
			error,
		});
		// Transient search failure — the lookup itself failed, which says nothing
		// about the client. Do not cache: caching null here would poison the
		// isolate for the full TTL and reject valid CLI-minted M2M credentials
		// with tenant_mismatch. Same resolved/unresolved rule as lib/tenant-match.ts.
		return null;
	}

	// A hit keeps the full TTL; a genuine miss caches only briefly to tolerate
	// the Descope client create→search propagation race. The cached value is the
	// raw client context (never the live-profile-intersected copy) so a profile
	// change is reflected on the very next request even while the client lookup
	// is served from cache.
	aihM2mClientScopeCache.set(cacheKey, {
		value,
		expiresAt:
			now +
			(value
				? AIH_M2M_CLIENT_SCOPE_CACHE_TTL_MS
				: AIH_M2M_CLIENT_SCOPE_MISS_TTL_MS),
	});
	if (aihM2mClientScopeCache.size > AIH_M2M_CLIENT_SCOPE_CACHE_MAX_ENTRIES) {
		for (const [key, entry] of aihM2mClientScopeCache) {
			if (entry.expiresAt <= now) aihM2mClientScopeCache.delete(key);
		}
		// TTL alone cannot bound a burst of fresh caller keys. Evict oldest
		// insertions after expired entries; authority is re-read on the next miss.
		while (
			aihM2mClientScopeCache.size > AIH_M2M_CLIENT_SCOPE_CACHE_MAX_ENTRIES
		) {
			const oldestKey = aihM2mClientScopeCache.keys().next().value;
			if (oldestKey === undefined) break;
			aihM2mClientScopeCache.delete(oldestKey);
		}
	}

	return boundTediClientScopesToLiveProfile(value, options);
}

/**
 * Request-time defense in depth for the tedi M2M path: bound a tedi client's
 * baked (registration-time) scopes to its current live D1 capability profile.
 * Non-tedi clients (external agents, CI release-smoke) are returned unchanged —
 * they have no D1 capability profile and their registration is the authority.
 * Returns a shallow copy so the shared cache is never mutated.
 */
async function boundTediClientScopesToLiveProfile(
	value: AihM2mClientScopeContext | null,
	options?: ResolveAihM2mClientScopeOptions,
): Promise<AihM2mClientScopeContext | null> {
	if (!value || !value.tediId || !options?.resolveTediProfileScopes) {
		return value;
	}
	const profileScopes = await options.resolveTediProfileScopes(value.tediId);
	return {
		...value,
		scopes: intersectScopes(value.scopes, profileScopes),
		tediProfileScopes: [...profileScopes],
	};
}

/** Whether the authenticated caller must pass the resolved tools/call scope gate. */
export function shouldEnforceMcpToolScopes(authType: string | null): boolean {
	return (
		authType === "oauth" || authType === "tedi" || authType === "external_agent"
	);
}

/** Extract required scopes for a single tools/call request from MCP app config. */
export async function extractRequiredScopes(
	request: Request,
	toolScopes?: Record<string, string[]>,
	tools?: AppTool[],
	mcpConfig?: Record<string, unknown>,
): Promise<string[] | undefined> {
	if (!toolScopes && !tools?.length) return undefined;

	const contentType = request.headers.get("Content-Type") ?? "";
	if (request.method !== "POST" || !contentType.includes("application/json")) {
		return undefined;
	}

	try {
		const parsed = (await request.clone().json()) as unknown;
		// [security] A JSON-RPC array previously returned `undefined` here, which
		// resolves no required scopes and skips the request-level gate entirely.
		// It was unreachable only because `StatelessMcpTransport` rejects arrays
		// with -32600 before dispatch — i.e. it failed closed by ordering, not by
		// design, and the sibling policy-mode path (`readJsonRpcEnvelope`) already
		// unwraps single-item batches correctly. Resolve the UNION across every
		// entry instead, so the two idioms agree on the same input and this stays
		// fail-closed no matter what the transport admits later.
		const entries = Array.isArray(parsed) ? parsed : [parsed];
		const union = new Set<string>();
		for (const entry of entries) {
			for (const scope of resolveEntryRequiredScopes(
				entry,
				toolScopes,
				tools,
				mcpConfig,
			)) {
				union.add(scope);
			}
		}
		if (union.size > 0) return [...union];
	} catch {
		// Body parse failed
	}

	return undefined;
}

/** Required scopes for ONE JSON-RPC envelope entry. See `extractRequiredScopes`. */
function resolveEntryRequiredScopes(
	entry: unknown,
	toolScopes?: Record<string, string[]>,
	tools?: AppTool[],
	mcpConfig?: Record<string, unknown>,
): string[] {
	const body = entry as {
		method?: string;
		params?: { name?: string; arguments?: unknown };
	} | null;
	const toolName = body?.params?.name;
	if (body?.method !== "tools/call" || !toolName) return [];

	const tool = tools?.find((candidate) => candidate.toolId === toolName);
	if (tool) {
		const namespaceOverrides = mcpConfig?.codeModeNamespaces as
			| Record<string, string>
			| undefined;
		return resolveMcpToolRequiredScopes(
			tool,
			resolveMcpToolNamespace(tool, namespaceOverrides),
			mcpConfig ?? { toolScopes },
			{
				fallbackOnAuthenticatedAuthMode: false,
				toolCall: { arguments: body.params?.arguments },
			},
		);
	}

	return toolScopes?.[toolName] ?? [];
}

// =============================================================================
// VALIDATION
// =============================================================================

export async function validateAuth(
	request: Request,
	env: CloudflareEnv,
	options?: {
		hostname?: string;
		toolScopes?: Record<string, string[]>;
		expectedAudience?: string;
		mcpServerId?: string;
	},
): Promise<AuthContext | Response | null> {
	const authHeader =
		request.headers.get("Authorization") ??
		(request.headers.get("X-API-Key")
			? `Bearer ${request.headers.get("X-API-Key")}`
			: null);

	// Internal service-binding bypass. The service-binding boundary is the
	// trust anchor; PLATFORM_SERVICE_TOKEN remains accepted for Workers that
	// have the shared secret, but service-bound callers no longer need to carry
	// that secret just to probe or call another internal Worker.
	if (
		isServiceBinding(request.headers) &&
		!isTrustedBrowserBridge(request.headers)
	) {
		const match = authHeader?.match(/^Bearer\s+(.+)$/i);
		if (
			authHeader &&
			env.PLATFORM_SERVICE_TOKEN &&
			match?.[1] !== env.PLATFORM_SERVICE_TOKEN
		) {
			return new Response(
				JSON.stringify({ error: "Invalid service binding token" }),
				{ status: 401, headers: { "Content-Type": "application/json" } },
			);
		}

		// Acting user (kernel direct reads): resolve the initiating human's
		// provider connection via userId without setting tediId (which would force
		// the tedi credential path). Falls back to X-Tedix-Tedi-Id for tedi callers.
		const actingUserId =
			request.headers.get("X-Tedix-Acting-User") ??
			request.headers.get("X-Tedix-Tedi-Id") ??
			undefined;
		// Kernel marker: honored only inside this authenticated
		// service-binding branch (security: public ingress strips the
		// service-binding marker, so isServiceBinding() is false for external
		// callers and the header is ignored). Carried as a separate flag — userId stays the
		// acting human and tediId stays absent (never conflated).
		const kernel =
			request.headers.get("X-Tedix-Kernel") === "true" || undefined;
		const delegatedScopes =
			request.headers
				.get("X-Tedix-Tedi-Scopes")
				?.split(/\s+/)
				.filter(Boolean) ?? [];
		const principal = internalPrincipal("service-binding", {
			subject: actingUserId,
			tediId: request.headers.get("X-Tedix-Tedi-Id") ?? undefined,
			orgId: request.headers.get("X-Tedix-Org-Id") ?? undefined,
			scopes: delegatedScopes,
		});
		return {
			type: "service-binding",
			userId: actingUserId,
			organizationId: request.headers.get("X-Tedix-Org-Id") ?? undefined,
			scopes: delegatedScopes,
			principal,
			kernel,
		};
	}

	if (!authHeader) return null;

	const hostname = options?.hostname ?? "unknown";

	const match = authHeader.match(/^Bearer\s+(.+)$/i);
	if (!match?.[1]) {
		return new Response(
			JSON.stringify({ error: "Invalid Authorization header format" }),
			{
				status: 401,
				headers: {
					"Content-Type": "application/json",
					"WWW-Authenticate": buildWwwAuthenticate(
						hostname,
						"invalid_request",
						"Invalid Authorization header format",
					),
				},
			},
		);
	}

	const token = match[1];
	if (isDelegatedMcpToken(token)) {
		try {
			if (!options?.expectedAudience) throw new Error("Missing MCP audience");
			return {
				type: "delegated-mcp",
				claims: await verifyDelegatedMcpToken(token, {
					secret: env.PLATFORM_SERVICE_TOKEN,
					audience: options.expectedAudience,
				}),
			};
		} catch {
			return new Response(
				JSON.stringify({ error: "invalid_delegated_mcp_token" }),
				{
					status: 401,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}
	const localUser = resolveLocalDemoUser({
		environment: env.ENVIRONMENT,
		projectId: env.DESCOPE_PROJECT_ID,
		token,
		// External clients must use the actual loopback URL. Forwarded host
		// headers and the internal demo enable flag do not grant this identity.
		url: request.url,
	});
	if (localUser) {
		return {
			type: "oauth",
			localDemo: true,
			userId: localUser.sub,
			organizationId: getTenantId(localUser),
			email: localUser.email,
			payload: localUser,
			scopes: [...CAPABILITY_SCOPES],
		};
	}

	// Check if it looks like a JWT
	if (token.startsWith("eyJ")) {
		if (!env.DESCOPE_PROJECT_ID) {
			authLog.error("identity provider is not configured for JWT validation", {
				event: "jwt.not_configured",
				outcome: "misconfigured",
				reason: "descope_project_id_missing",
			});
			return new Response(JSON.stringify({ error: "OAuth not configured" }), {
				status: 503,
				headers: { "Content-Type": "application/json" },
			});
		}

		const requiredScopes = await extractRequiredScopes(
			request,
			options?.toolScopes,
		);

		try {
			const validationAudience = resolveMcpTokenValidationAudience({
				token,
				projectId: env.DESCOPE_PROJECT_ID,
				expectedAudience: options?.expectedAudience,
				mcpServerId: options?.mcpServerId,
			});
			const payload = await validateToken(token, {
				projectId: env.DESCOPE_PROJECT_ID,
				baseUrl: env.DESCOPE_BASE_URL,
				audience: validationAudience,
				allowTediJwt: true, // Tedi JWTs are valid callers on MCP endpoints
				// Measure, do not enforce. This is the only site that checks `aud`
				// at all, and even here the check is weaker than it looks:
				// `validateToken` falls back to the bare project ID as the primary
				// audience, so `aud: <projectId>` is accepted. Auditing tells us how
				// much traffic relies on that fallback before we tighten it — see
				// `passedOnlyViaProjectId`.
				...(options?.expectedAudience
					? {
							auditAudience: {
								surface: "mcp:edge",
								expected: [options.expectedAudience],
								// Log only what would CHANGE under enforcement: a token
								// already carrying the right `aud` is the overwhelming
								// majority and would drown the signal.
								report: (event) => {
									if (!event.wouldReject && !event.missingAudienceClaim) {
										return;
									}
									console.warn("[MCP audience-audit]", JSON.stringify(event));
								},
							},
						}
					: {}),
			});

			let scopes = extractJwtScopes(payload);
			if (
				isTrustedBrowserBridge(request.headers) &&
				scopes.length === 0 &&
				!payload.client_id &&
				!payload.azp &&
				payload.entityType !== "tedi"
			) {
				scopes = (request.headers.get("X-Tedix-Browser-Scopes") ?? "")
					.split(/\s+/)
					.filter((scope) => BROWSER_CAPABILITY_SCOPES.has(scope));
			}
			if (
				isTrustedBrowserBridge(request.headers) &&
				!scopes.some((scope) => scope === "*" || scope.startsWith("mcp:"))
			) {
				authLog.warn("Browser session has no MCP capability grant", {
					event: "browser_bridge.scope_unavailable",
					outcome: "denied",
					platformAdmin: isPlatformAdmin(payload),
					scopeCount: scopes.length,
					hasClientId: Boolean(payload.client_id),
					hasAuthorizedParty: Boolean(payload.azp),
					isTedi: payload.entityType === "tedi",
				});
			}

			return {
				type: "oauth",
				userId: payload.sub,
				organizationId: getTenantId(payload),
				email: payload.email,
				clientId: payload.client_id,
				scopes: scopes.length > 0 ? scopes : undefined,
				payload,
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Token validation failed";
			authLog.warn("JWT validation failed", {
				event: "jwt.validation_failed",
				outcome: "denied",
				reason:
					error instanceof TokenValidationError
						? error.code
						: "validation_error",
				...(requiredScopes ? { requiredScopes } : {}),
				error,
			});

			const isScopeError =
				error instanceof TokenValidationError &&
				error.code === "CLAIM_VALIDATION_FAILED" &&
				message.toLowerCase().includes("scope");
			if (isScopeError && requiredScopes) {
				return new Response(
					JSON.stringify({
						error: "insufficient_scope",
						required_scopes: requiredScopes,
					}),
					{
						status: 403,
						headers: {
							"Content-Type": "application/json",
							// SEP-2350: machine-readable scope challenge, not just prose.
							"WWW-Authenticate": buildWwwAuthenticate(
								hostname,
								"insufficient_scope",
								`Missing required scopes: ${requiredScopes.join(" ")}`,
								requiredScopes,
							),
						},
					},
				);
			}

			return new Response(JSON.stringify({ error: "Invalid token", message }), {
				status: 401,
				headers: {
					"Content-Type": "application/json",
					"WWW-Authenticate": buildWwwAuthenticate(
						hostname,
						"invalid_token",
						message,
					),
				},
			});
		}
	}

	// Reject sk_* API keys
	if (token.startsWith("sk_")) {
		return new Response(
			JSON.stringify({
				error: "Invalid token",
				message:
					"API keys (sk_*) are not accepted for MCP access. Use a Descope OAuth token instead.",
			}),
			{
				status: 401,
				headers: {
					"Content-Type": "application/json",
					"WWW-Authenticate": buildWwwAuthenticate(
						hostname,
						"invalid_token",
						"API keys not accepted, use OAuth token",
					),
				},
			},
		);
	}

	// Unknown format
	return new Response(JSON.stringify({ error: "Invalid token" }), {
		status: 401,
		headers: {
			"Content-Type": "application/json",
			"WWW-Authenticate": buildWwwAuthenticate(hostname, "invalid_token"),
		},
	});
}
