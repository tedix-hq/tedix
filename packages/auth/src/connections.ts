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

import type { DescopeClient } from "./descope.ts";
import { guardedFetch } from "@tedix/ssrf-guard";
import { descopeFetch } from "./descope-fetch.ts";
import { DESCOPE_DEFAULT_BASE_URL } from "./types.ts";
import { isRecord } from "@tedix/api-contract/utils/is-record";

import {
	assertDescopeOk,
	postDescopeManagementJson,
	type DescopeConnectionManagementEnv,
} from "./connection-providers.ts";
import type { FetchLike } from "./connection-discovery.ts";

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
	/** The vault could not refresh this grant; never use it for a tool call. */
	reconnectNeeded?: boolean;
	/** OAuth scopes granted, if available */
	scopes?: string[];
	/** Native vault account selector, not a display label. */
	externalIdentifier?: string;
	/** Provider subject observed on this grant; not a Tedix authorization identity. */
	tokenSub?: string;
}

/** Descope documents these fields even though the SDK token type omits them.
 * https://docs.descope.com/api/management/outbound-apps/fetch-outbound-app-user-token
 * Keep the provider's raw refresh error out of returned credentials and logs.
 */
export function connectionRefreshState(
	token: {
		accessTokenExpiry?: unknown;
		lastRefreshTime?: unknown;
		lastRefreshError?: unknown;
	},
	now = Math.floor(Date.now() / 1000),
): { reconnectNeeded?: boolean } {
	const expiresAt = Number(token.accessTokenExpiry);
	const lastRefreshTime = Number(token.lastRefreshTime);
	const refreshFailed =
		typeof token.lastRefreshError === "string" &&
		token.lastRefreshError.trim().length > 0;
	// A fetched token still expired after its last refresh has exhausted that
	// refreshed token's lifetime. No provider-specific lifetime is assumed.
	const staleRefresh =
		Number.isSafeInteger(lastRefreshTime) &&
		lastRefreshTime > 0 &&
		Number.isSafeInteger(expiresAt) &&
		expiresAt > lastRefreshTime &&
		expiresAt <= now;
	return refreshFailed || staleRefresh ? { reconnectNeeded: true } : {};
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
		if (
			(typeof token.accessToken !== "string" || !token.accessToken) &&
			!connectionRefreshState(token).reconnectNeeded
		)
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
			accessToken:
				typeof token.accessToken === "string" ? token.accessToken : "",
			...connectionRefreshState(token),
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
	if (!token || (!token.accessToken && !token.reconnectNeeded)) return false;
	if (requiredScopes.length === 0) return true;
	if (!token.scopes?.length) return false;
	const granted = token.scopes;
	return requiredScopes.every((required) =>
		granted.some((scope) => scopeSatisfies(scope, required)),
	);
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

// =============================================================================
// CONNECTION TOKEN OPERATIONS
// =============================================================================

/**
 * Descope answers a personal-token lookup for a user who never connected the
 * app with 401 E151103 rather than 404, while the same management key keeps
 * serving other users' tokens. That means "not connected", not an outage;
 * every other 401 (such as a rejected management key) stays a lookup failure.
 */
export function isMissingUserToken(
	code: number | undefined,
	errorCode: unknown,
) {
	return code === 404 || (code === 401 && errorCode === "E151103");
}

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
			if (isMissingUserToken(response.code, response.error?.errorCode))
				return null;
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
		if (!accessToken && !connectionRefreshState(token).reconnectNeeded) {
			return null;
		}

		const tokenSub = (token as unknown as Record<string, unknown>).tokenSub;
		return {
			id: token.id,
			accessToken,
			expiresAt: Number(token.accessTokenExpiry) || undefined,
			...connectionRefreshState(token),
			scopes: token.scopes,
			...(typeof tokenSub === "string" && tokenSub ? { tokenSub } : {}),
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
			if (!isMissingUserToken(response.code, response.error?.errorCode))
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

		if (!accessToken && !connectionRefreshState(token).reconnectNeeded)
			return fetchFallback();

		return {
			id: token.id,
			accessToken,
			expiresAt: Number(token.accessTokenExpiry) || undefined,
			...connectionRefreshState(token),
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
		if (!accessToken && !connectionRefreshState(token).reconnectNeeded) {
			return null;
		}

		return {
			id: token.id,
			accessToken,
			expiresAt: Number(token.accessTokenExpiry) || undefined,
			...connectionRefreshState(token),
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

		if (!accessToken && !connectionRefreshState(token).reconnectNeeded) {
			return fetchFallback();
		}

		return {
			id: token.id,
			accessToken,
			expiresAt: Number(token.accessTokenExpiry) || undefined,
			...connectionRefreshState(token),
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
		assertDescopeOk(
			await client.management.outboundApplication.deleteUserTokens(
				appId,
				userId,
			),
			"outboundApplication.deleteUserTokens",
		);
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
