import { summarizeRpcErrorResponse } from "./handler-log-redaction";
import { readToolConfigExtension } from "./tool-config-extensions";
import { buildConnectionSetupUrl } from "@tedix/api-contract/utils/connection-capabilities";
import type { ConnectionCapability } from "@tedix/api-contract/schemas/connections";
import { type ToolConfig } from "@tedix/api-contract/schemas/tools";
import { exchangeClientCredentials } from "@tedix/mcp-shared/auth/client-credentials";
import { delegatedMachineScopes } from "@tedix/mcp-shared/auth/scopes";
import {
	type ConnectionRecovery,
	readConnectionRecovery,
} from "@tedix/mcp-shared/tool-result";
import { getApiClient } from "../lib/api-client";
import { callApiRpc } from "../lib/rpc";
import { contentFreeMcpException, createMcpLogger } from "../log";
import type { ToolExecutionContext } from "./handler";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { applyWorkflowExecutionHeaders } from "./workflow-execution-headers";

/**
 * Connection credentials for tool execution: the isolate-lifetime token cache,
 * OAuth2 client-credentials exchange, the not-connected error and recovery
 * shapes, and the per-tedi / per-organization token fetches through apps/api.
 */

const log = createMcpLogger("mcp.tool_handler");

// =============================================================================
// module-level caches
// Worker isolate persists across requests — cache tokens and tedi lookups to
// avoid hitting rate limits and avoid redundant D1/API round-trips.
// =============================================================================

const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CREDENTIAL_CACHE_MAX_SIZE = 500; // bound memory usage
type CredentialScope = "tenant" | "user";
type CredentialResolutionScope = CredentialScope | "hybrid";
type CredentialPreference = "user-first" | "tenant-first";

/**
 * Result of a credential-fetch attempt. `status`/`detail` are populated only
 * on a genuine upstream failure (non-404 RPC error or thrown exception) so
 * callers can surface the real cause instead of the generic "not connected"
 * message — a 403/500 masked as "credential not found" sends operators to
 * Settings > Connections to fix something that isn't broken there.
 */
interface CredentialFetchResult {
	token: string | null;
	status?: number;
	detail?: string;
}

/** Only an exact account lookup that proved absence can offer continuation. */
export function buildCredentialRecovery(
	result: CredentialFetchResult,
	selection: {
		providerId: string;
		connectionInstanceId?: string;
		scope?: string;
		scopes?: string[];
	},
): ConnectionRecovery | undefined {
	if (result.status !== 404 || result.token) return undefined;
	return (
		readConnectionRecovery({ ...selection, scopes: selection.scopes ?? [] }) ??
		undefined
	);
}

/**
 * The generic "not connected" message is only accurate for a real 404 (no
 * credential on file) or the absence of a status entirely (e.g. missing
 * caller identity). Any other status means the credential exists but the
 * fetch itself failed — surface that instead so operators don't get sent to
 * Settings > Connections to "fix" a connection that was never the problem.
 */
export function buildCredentialErrorMessage(
	result: CredentialFetchResult,
): string {
	const genericMessage =
		"Connection credential not found. Ensure the provider is connected in Settings > Connections.";
	if (
		result.status === 403 &&
		result.detail?.includes("Not granted for this connection")
	) {
		return "This tedi or skill revision is not allowed to use this organization connection. Ask an administrator to grant access in Admin > Connections.";
	}
	if (result.status !== undefined && result.status !== 404) {
		return `Connection credential lookup failed (status ${result.status})${
			result.detail ? `: ${result.detail}` : ""
		}`;
	}
	if (result.detail) {
		return `${genericMessage} (${result.detail})`;
	}
	return genericMessage;
}

/** Missing credentials expose the same capability/setup shape as Connections. */
export function buildCredentialErrorData(
	result: CredentialFetchResult,
	selection: {
		providerId: string;
		connectionInstanceId?: string;
		scope?: string;
		preference?: "user-first" | "tenant-first";
		scopes?: string[];
	},
) {
	const error = buildCredentialErrorMessage(result);
	if (result.status !== 404 || result.token) return { error };
	const scopes = selection.scopes ?? [];
	const setupUrl = buildConnectionSetupUrl({
		...selection,
		scope:
			selection.scope === "user" ||
			(selection.scope === "hybrid" && selection.preference !== "tenant-first")
				? "user"
				: "tenant",
		scopes,
	});
	return {
		error: `${error} Set up: ${setupUrl}`,
		capability: {
			id: selection.providerId,
			label: "Required access",
			state: "not_configured",
			requiredScopes: scopes,
			verified: true,
			setupUrl,
		} satisfies ConnectionCapability,
	};
}

/**
 * Return the verified human whose personal credential may be resolved.
 *
 * Tedi auth can also carry a `userId`, but for AIH M2M and direct-tedi JWTs
 * that value identifies the machine's Descope client/user record. Treating it
 * as an acting human pins a user-scoped lookup to a machine identity and
 * suppresses the owner's valid connection fallback.
 */
function credentialActingUserId<TConfig>(
	ctx: ToolExecutionContext<TConfig>,
): string | undefined {
	const caller = ctx.callerIdentity;
	if (!caller?.userId) return undefined;
	if (caller.authType === "oauth" || caller.authType === "user") {
		return caller.userId;
	}
	if (caller.authType === "service" && caller.kernel === true) {
		return caller.userId;
	}
	return undefined;
}

/** Named accounts verify the installed source tool, including calls through an aggregate. */
function connectionToolIdentity(ctx: ToolExecutionContext<ToolConfig>) {
	const sourceAppId = readToolConfigExtension(ctx.config, "_sourceAppId");
	if (typeof sourceAppId !== "string")
		return { appId: ctx.appId, toolId: ctx.toolId };
	return {
		appId: sourceAppId,
		toolId: ctx.toolId.includes("__")
			? ctx.toolId.slice(ctx.toolId.indexOf("__") + 2)
			: ctx.toolId,
	};
}

function credentialDelegationHeaders(
	ctx: ToolExecutionContext<ToolConfig>,
): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Tedix-Mcp-Tool-Id": connectionToolIdentity(ctx).toolId,
	};
	const caller = ctx.callerIdentity;
	const nativeRunId = ctx.requestMeta?.["io.tedix/kernelRunId"];
	const requestRunId =
		caller?.requestRunId ??
		(caller?.tediId &&
		typeof nativeRunId === "string" &&
		nativeRunId.length <= 256
			? nativeRunId
			: undefined);
	if (requestRunId && !caller?.skillRunId)
		headers["X-Tedix-Request-Run-Id"] = requestRunId;
	if (caller?.requestRootRunId)
		headers["X-Tedix-Request-Root-Run-Id"] = caller.requestRootRunId;
	if (caller?.requestWorkItemId)
		headers["X-Tedix-Request-Work-Item-Id"] = caller.requestWorkItemId;
	if (caller?.scopes?.length) {
		// Delegate the caller's MCP scopes plus their machine-scope
		// translations (mcp:tedis.read → tedis:read, ...): the apps/api
		// two-plane guards speak the machine vocabulary, and an untranslated
		// delegation forbidden-failed every M2M caller on machine-fenced tools.
		headers["X-Tedix-Tedi-Scopes"] = [
			...new Set([...caller.scopes, ...delegatedMachineScopes(caller.scopes)]),
		].join(" ");
	}
	if (
		caller?.tediId &&
		(caller.authType === "tedi" || caller.authType === "service")
	) {
		headers["X-Tedix-Tedi-Id"] = caller.tediId;
	}
	const actingUserId = credentialActingUserId(ctx);
	if (actingUserId) {
		headers["X-Tedix-End-User-Id"] = actingUserId;
	}
	if (
		caller?.authType === "external_agent" &&
		caller.externalAgentPrincipalId &&
		caller.externalAgentSessionId &&
		caller.externalAgentClientRecordId
	) {
		headers["X-Tedix-Caller-Type"] = "mcp-edge-external-agent";
		headers["X-Tedix-External-Agent-Principal-Id"] =
			caller.externalAgentPrincipalId;
		headers["X-Tedix-External-Agent-Session-Id"] =
			caller.externalAgentSessionId;
		headers["X-Tedix-External-Agent-Client-Record-Id"] =
			caller.externalAgentClientRecordId;
	}
	applyWorkflowExecutionHeaders(headers, caller, {
		includeTedixProvenance: true,
	});
	return headers;
}

interface CachedCredential {
	credentialFingerprint: string;
	accessToken: string;
	expiresAt: number;
}

/** Only exchanged client-credentials bearers are cached, never vault credentials. */
const credentialTokenCache = new Map<string, CachedCredential>();

export function selectedConnectionInstanceId(
	ctx: ToolExecutionContext<ToolConfig>,
): string | undefined {
	const id =
		ctx.config.auth?.connectionInstanceId ??
		readToolConfigExtension(ctx.config, "_aggregateConnectionInstanceId");
	if (id === undefined) return undefined;
	if (
		typeof id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		throw new Error("Invalid account binding");
	return id;
}

function getCachedCredential(key: string, fingerprint: string): string | null {
	const entry = credentialTokenCache.get(key);
	if (!entry) return null;
	if (
		entry.expiresAt <= Date.now() ||
		entry.credentialFingerprint !== fingerprint
	) {
		credentialTokenCache.delete(key);
		return null;
	}
	return entry.accessToken;
}

function setCachedCredential(
	key: string,
	accessToken: string,
	credentialFingerprint: string,
	ttlMs?: number,
): void {
	// Evict oldest entries if at capacity
	if (credentialTokenCache.size >= CREDENTIAL_CACHE_MAX_SIZE) {
		const oldest = credentialTokenCache.keys().next().value;
		if (oldest) credentialTokenCache.delete(oldest);
	}
	credentialTokenCache.set(key, {
		credentialFingerprint,
		accessToken,
		expiresAt: Date.now() + (ttlMs ?? CREDENTIAL_CACHE_TTL_MS),
	});
}

// =============================================================================
// OAUTH2 client credentials exchange
// Exchanges a stored client_id:client_secret (base64) for a bearer token
// via the provider's token endpoint. Cached with server-reported TTL.
// =============================================================================

const CLIENT_CREDENTIALS_SAFETY_MARGIN_MS = 60_000; // expire 60s early

/** Cache key for exchanged client-credentials bearer tokens. */
export function getClientCredentialsCacheKey(
	tediOrOrgId: string,
	connectionId: string,
	tokenUrl: string,
	label?: string,
): string {
	return `cc::${tediOrOrgId}::${connectionId}::${tokenUrl}::${label ?? ""}`;
}

/** Exported for tests — production callers go through executeExternal/executeMcp. */
export async function resolveClientCredentialsToken(
	rawCredential: string,
	tokenUrl: string,
	grantType: string,
	cacheKey: string,
	isDev: boolean,
): Promise<{ token: string | null; error?: string }> {
	// The caller has just read the vault. A replacement must not reuse a bearer
	// minted from the previous secret, even while its provider TTL is valid.
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			JSON.stringify([rawCredential, tokenUrl, grantType]),
		),
	);
	const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const cached = getCachedCredential(cacheKey, fingerprint);
	if (cached) return { token: cached };

	const result = await exchangeClientCredentials(rawCredential, tokenUrl, {
		grantType,
		ssrf: { allowHttp: isDev },
	});
	if (!result.ok) {
		return { token: null, error: result.error };
	}

	// Cache with server-reported TTL (minus safety margin), fallback to 5 min
	const ttlMs = result.token.expiresInSeconds
		? result.token.expiresInSeconds * 1000 - CLIENT_CREDENTIALS_SAFETY_MARGIN_MS
		: CREDENTIAL_CACHE_TTL_MS;
	setCachedCredential(
		cacheKey,
		result.token.accessToken,
		fingerprint,
		Math.max(ttlMs, 30_000),
	);

	return { token: result.token.accessToken };
}

export function isOperationalTediRecord(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (
		record.runtimeState === "archived" ||
		record.runtime_state === "archived"
	) {
		return false;
	}
	const status = record.status;
	return !["error", "paused", "provisioning"].includes(
		typeof status === "string" ? status : "",
	);
}

async function resolveFallbackTediIdForOrg(
	ctx: ToolExecutionContext<ToolConfig>,
	organizationId: string,
): Promise<string | null> {
	try {
		const client = getApiClient({
			serviceFetch: ctx.env.API_SERVICE,
			orgId: organizationId,
		});
		const result = await client.tedis.list({});
		const operational = result.data?.find(isOperationalTediRecord);
		return (operational as { id?: string } | undefined)?.id ?? null;
	} catch (err) {
		log.warn("Fallback tedi lookup failed", {
			event: "handler.fallback_tedi_lookup_failed",
			organizationId,
			appId: ctx.appId,
			toolName: ctx.toolId,
			outcome: "unavailable",
			error: contentFreeMcpException(err),
		});
		return null;
	}
}

// =========================================================================
// Credential Resolution — fetch token from Descope Token Vault
// =========================================================================

/**
 * Fetch a connection token from Descope Token Vault via the connections API.
 * Uses service binding to call connections.fetchTediToken internally.
 */
export async function fetchConnectionToken(
	ctx: ToolExecutionContext<ToolConfig>,
	connectionId: string,
	scope?: CredentialResolutionScope,
	authScopes?: string[],
	label?: string,
	preference?: CredentialPreference,
	providerArguments?: Record<string, unknown>,
): Promise<CredentialFetchResult> {
	const tediId = ctx.callerIdentity?.tediId;
	const organizationId =
		ctx.callerIdentity?.organizationId ?? ctx.app?.organizationId;
	const tenantOrganizationId = ctx.app?.organizationId ?? organizationId;
	const resolvedScope = scope ?? "tenant";

	if (!tediId && !organizationId) {
		log.error("Connection token lookup lacks caller identity", {
			event: "handler.credential_identity_missing",
			appId: ctx.appId,
			toolName: ctx.toolId,
			connectionId,
			outcome: "invalid",
		});
		return {
			token: null,
			detail: "no tediId or organizationId in caller identity",
		};
	}

	if (!tediId) {
		if (resolvedScope === "user" && !ctx.callerIdentity?.userId) {
			const fallbackTediId = await resolveFallbackTediIdForOrg(
				ctx,
				organizationId!,
			);
			if (fallbackTediId) {
				return fetchTediConnectionToken(
					ctx,
					fallbackTediId,
					connectionId,
					resolvedScope,
					authScopes,
					label,
					preference,
					providerArguments,
				);
			}
		}
		return fetchOrgConnectionToken(
			ctx,
			connectionId,
			organizationId!,
			resolvedScope,
			authScopes,
			label,
			preference,
			providerArguments,
		);
	}

	if (resolvedScope === "tenant" && tenantOrganizationId) {
		return fetchOrgConnectionToken(
			ctx,
			connectionId,
			tenantOrganizationId,
			resolvedScope,
			authScopes,
			label,
			preference,
			providerArguments,
		);
	}

	return fetchTediConnectionToken(
		ctx,
		tediId,
		connectionId,
		resolvedScope,
		authScopes,
		label,
		preference,
		providerArguments,
	);
}

export async function fetchTediConnectionToken(
	ctx: ToolExecutionContext<ToolConfig>,
	tediId: string,
	connectionId: string,
	scope: CredentialResolutionScope,
	authScopes?: string[],
	_label?: string,
	preference?: CredentialPreference,
	providerArguments?: Record<string, unknown>,
): Promise<CredentialFetchResult> {
	const connectionInstanceId = selectedConnectionInstanceId(ctx);
	const resolvedScope = scope;
	const resolvedScopes = authScopes ?? [];
	const callerUserId = credentialActingUserId(ctx);
	// Read the authoritative vault on every call so revocation and rotation
	// take effect in every isolate without waiting for a local cache TTL.

	const useServiceBinding = !!ctx.env.API_SERVICE;
	try {
		const rpcInput: Record<string, unknown> = {
			tediId,
			providerId: connectionId,
			scope: resolvedScope,
			...(connectionInstanceId ? { connectionInstanceId } : {}),
			delegatedToolUse: {
				appId: connectionToolIdentity(ctx).appId,
				arguments: providerArguments ?? {},
			},
		};
		if (resolvedScope === "hybrid" && preference) {
			rpcInput.preference = preference;
		}
		if (resolvedScopes.length > 0) {
			rpcInput.scopes = resolvedScopes;
		}
		if (callerUserId) {
			rpcInput.userId = callerUserId;
		}

		const orgIdHeader =
			ctx.callerIdentity?.organizationId ?? ctx.app?.organizationId;
		// callerUserId is a claim forwarded in the RPC body (rpcInput.userId);
		// the API's fetchTediToken authz only trusts that claim against an
		// independently-forwarded X-Tedix-Acting-User header (see withAuth in
		// apps/api/src/rpc/orpc.ts) — without it, a delegated tedi run whose
		// caller identity differs from its own tediId (e.g. a kernel/Home
		// delegation, where userId is the delegating human owner) gets rejected
		// as "fetching another user's credential" even when it's the tedi's own
		// owner. Mirrors the existing pattern used for direct Home reads above.
		const headers = credentialDelegationHeaders(ctx);
		if (orgIdHeader) headers["X-Tedix-Org-Id"] = orgIdHeader;
		if (callerUserId) headers["X-Tedix-Acting-User"] = callerUserId;
		const { data, status } = await callApiRpc(
			ctx.env,
			"connections/fetchTediToken",
			rpcInput,
			{
				headers,
				serviceBinding: useServiceBinding,
			},
		);

		if (status >= 400) {
			if (status === 404) {
				console.log(
					`[handler] connection token not found for connectionId="${connectionId}" tediId="${tediId}" scope="${resolvedScope}"`,
				);
				return { token: null, status };
			}
			const { summary } = summarizeRpcErrorResponse(data);
			log.error("Connection token lookup failed", {
				event: "handler.credential_lookup_failed",
				appId: ctx.appId,
				toolName: ctx.toolId,
				connectionId,
				tediId,
				status,
				outcome:
					status >= 500
						? "unavailable"
						: status === 401 || status === 403
							? "denied"
							: "invalid",
			});
			return { token: null, status, detail: summary };
		}

		const accessToken =
			isRecord(data) && typeof data.accessToken === "string"
				? data.accessToken
				: null;
		return { token: accessToken };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		log.error("Connection token lookup threw", {
			event: "handler.credential_lookup_exception",
			appId: ctx.appId,
			toolName: ctx.toolId,
			connectionId,
			tediId,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return { token: null, detail };
	}
}

/**
 * Fetch a connection token using org identity (no tediId required).
 * Resolves the current vault credential directly through connections.fetchOrgToken.
 */
export async function fetchOrgConnectionToken(
	ctx: ToolExecutionContext<ToolConfig>,
	connectionId: string,
	organizationId: string,
	scope?: CredentialResolutionScope,
	authScopes?: string[],
	label?: string,
	preference?: CredentialPreference,
	providerArguments?: Record<string, unknown>,
): Promise<CredentialFetchResult> {
	const connectionInstanceId = selectedConnectionInstanceId(ctx);
	const resolvedScope = scope ?? "tenant";
	const callerUserId = credentialActingUserId(ctx);

	const useServiceBinding = !!ctx.env.API_SERVICE;
	try {
		// Direct scope-aware credential lookup — no tedi proxy required.
		// `connections.fetchOrgToken` resolves either tenant credentials or the
		// caller's personal credential, matching the explicit tool/app scope.
		const rpcInput: Record<string, unknown> = {
			organizationId,
			providerId: connectionId,
			scope: resolvedScope,
			...(connectionInstanceId ? { connectionInstanceId } : {}),
			delegatedToolUse: {
				appId: connectionToolIdentity(ctx).appId,
				arguments: providerArguments ?? {},
			},
		};
		if (resolvedScope === "hybrid" && preference) {
			rpcInput.preference = preference;
		}
		if (authScopes && authScopes.length > 0) {
			rpcInput.scopes = authScopes;
		}
		if (callerUserId) {
			rpcInput.userId = callerUserId;
		}
		// Connection label (X-Tedix-Connection-Label / mcpConfig.connectionLabel /
		// _aggregateConnectionLabel): apps/api prefers the label-scoped credential
		// (e.g. promptwatch-tedix) over the org's default provider key.
		if (label) {
			rpcInput.label = label;
		}

		const orgHeaders: Record<string, string> = {
			...credentialDelegationHeaders(ctx),
			"X-Tedix-Org-Id": organizationId,
		};
		if (callerUserId) orgHeaders["X-Tedix-Acting-User"] = callerUserId;
		const { data, status } = await callApiRpc(
			ctx.env,
			"connections/fetchOrgToken",
			rpcInput,
			{
				headers: orgHeaders,
				serviceBinding: useServiceBinding,
			},
		);

		if (status >= 400) {
			if (status === 404) {
				console.log(
					`[handler] org connection token not found for connectionId="${connectionId}" orgId="${organizationId}" scope="${resolvedScope}"`,
				);
				return { token: null, status };
			}
			const { summary } = summarizeRpcErrorResponse(data);
			log.warn("Organization connection token lookup failed", {
				event: "handler.org_credential_lookup_failed",
				appId: ctx.appId,
				toolName: ctx.toolId,
				connectionId,
				organizationId,
				status,
				outcome: status >= 500 ? "unavailable" : "denied",
			});
			return { token: null, status, detail: summary };
		}

		const accessToken =
			isRecord(data) && typeof data.accessToken === "string"
				? data.accessToken
				: null;
		return { token: accessToken };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		log.error("Organization connection token lookup threw", {
			event: "handler.org_credential_lookup_exception",
			appId: ctx.appId,
			toolName: ctx.toolId,
			connectionId,
			organizationId,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return { token: null, detail };
	}
}
