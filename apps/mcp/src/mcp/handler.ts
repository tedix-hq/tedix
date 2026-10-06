import { isEphemeralSessionKey } from "@tedix/api-contract/utils/runtime-identity";
/**
 * Tool Handler
 *
 * The universal handler for all config-driven MCP tools.
 * Configured entirely from D1 — no code deploys needed.
 *
 * Supports five transports:
 * - "rpc": POST to {API_URL}/rpc/{endpoint} with oRPC body format (internal)
 * - "rest": {method} to {API_URL}/v1/{endpoint} (internal)
 * - "external": {method} to {baseUrl}/{endpoint} with credential injection from Descope Token Vault
 * - "mcp": Direct stateless call to upstream MCP server via Streamable HTTP
 * - "code": Execute stored JavaScript in a Dynamic Worker sandbox (globalOutbound: null)
 *
 * Auth: Internal transports use service binding (API_SERVICE).
 * External + MCP transports resolve credentials from Descope Token Vault via connections.fetchTediToken.
 *
 * Map — sections below open with a `// ====` banner carrying these names:
 * Module-level caches, upstream MCP protocol negotiation, OAUTH2 client
 * credentials exchange, tool execution context, tool handler interface, tool
 * handler (the universal handler), then one per transport (External, MCP,
 * Code), Security Guard, Slug -> tediId resolution, Credential Resolution,
 * singleton instance.
 *
 * @module @tedix/mcp/handler
 */

import type { AppCapabilities } from "@tedix/api-contract/schemas/app";
import {
	DOCS_TOOL_SCOPES,
	type DocsToolName,
} from "@tedix/api-contract/contracts/docs-tool-scopes";
import { buildMcpUpstreamProtocolDataPoint } from "@tedix/api-contract/schemas/mcp-analytics";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { exchangeClientCredentials } from "@tedix/mcp-shared/auth/client-credentials";
import { isCodeModeAvailable } from "@tedix/mcp-shared/codemode";
import {
	delegatedMachineScopes,
	requiredTediMcpToolScope,
} from "@tedix/mcp-shared/auth/scopes";
import {
	MCP_RESULT_TYPE_INPUT_REQUIRED,
	readInputRequiredResult,
} from "@tedix/mcp-shared/protocol";
import { outboundTraceMeta } from "@tedix/mcp-shared/trace-context";
import {
	unwrapCallToolResult,
	type ConnectionRecovery,
	readConnectionRecovery,
} from "@tedix/mcp-shared/tool-result";
import {
	READ_OBSERVATION_META_KEY,
	parseDocsFileObservationReceipt,
	type DocsFileObservationReceipt,
} from "@tedix/mcp-shared/read-observation-receipt";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { getApiClient } from "../lib/api-client";
import { callApiRpc } from "../lib/rpc";
import { contentFreeMcpException, createMcpLogger } from "../log";

import {
	type CallerIdentity,
	normalizeCallerIdentity,
} from "./caller-identity";
import {
	applyStripField,
	applyToNestedArrays,
	getByPath,
	redactByPath,
	setByPath,
} from "./handlers/path-utils";
import {
	getTedixManagedTediHost,
	isTedixManagedMcpUrl,
	resolveManagedMcpAuthHeaders,
} from "./managed-mcp-auth";
import {
	linkOsGadgetTask,
	OS_GADGET_RUN_ENDPOINT,
	type OsGadgetTaskMarker,
} from "./os-gadget-task";
import { validateUrl } from "@tedix/ssrf-guard";
import {
	resolveEmbeddedHostDelegation,
	redactDelegationResponse,
} from "./embedded-host-delegation";
import type { McpApp } from "./types";
import { buildQueryString } from "./utils/query-params";
import { materializeRestRoute, RestRouteInputError } from "./utils/rest-route";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const log = createMcpLogger("mcp.tool_handler");

/** The upstream CallToolResult fields the MCP transport reads. */
type UpstreamCallToolResult = {
	content?: Array<{ type: string; text: string }>;
	isError?: boolean;
	_meta?: Record<string, unknown>;
	[key: string]: unknown;
};

const DEFAULT_INTERNAL_TIMEOUT_MS = 15_000;
const BROWSER_QUICK_ACTION_ENDPOINTS = new Set([
	"browser/capturePage",
	"browser/extractMarkdown",
	"browser/extractContent",
	"browser/extractLinks",
	"browser/scrapeElements",
	"browser/extractJson",
]);
const RPC_ERROR_LOG_SUMMARY_MAX_CHARS = 300;
const RPC_ERROR_LOG_MAX_DEPTH = 3;
const RPC_ERROR_LOG_MAX_ARRAY_ITEMS = 5;
const RPC_ERROR_LOG_MAX_OBJECT_KEYS = 12;
const REDACTED_LOG_VALUE = "<redacted>";

export function emitUpstreamProtocolMetric(
	env: CloudflareEnv,
	event: Parameters<typeof buildMcpUpstreamProtocolDataPoint>[0],
): void {
	try {
		env.ANALYTICS?.writeDataPoint(buildMcpUpstreamProtocolDataPoint(event));
	} catch {
		// Compatibility telemetry must never break an upstream tool call.
	}
}

export function classifyUpstreamProtocolCaller(
	caller: CallerIdentity | undefined,
): Parameters<typeof buildMcpUpstreamProtocolDataPoint>[0]["callerClass"] {
	if (!caller || caller.authType === "anonymous") return "unknown";
	if (caller.authType === "service" && caller.kernel === true) return "os";
	if (
		caller.authType === "tedi" ||
		(caller.authType === "service" && Boolean(caller.tediId))
	) {
		return "tedi_runtime";
	}
	if (caller.authType === "oauth" || caller.authType === "user") {
		return "human_client";
	}
	if (caller.authType === "apiKey" || caller.authType === "m2m") {
		return "api_client";
	}
	if (caller.authType === "external_agent") return "external_agent";
	return "internal_service";
}

/**
 * A platform-scoped caller may deliberately address a tenant other than the
 * app's own organization. The downstream API independently verifies that
 * platform authority before accepting the target.
 */
export function hasPlatformMcpScope(
	caller: Pick<CallerIdentity, "scopes"> | undefined,
): boolean {
	const scopes = caller?.scopes ?? [];
	return scopes.includes("platform:admin") || scopes.includes("*");
}

/**
 * Resolves the organization sent on the trusted MCP → API hop. Ordinary
 * callers are always pinned to the served app/caller organization. A verified
 * platform operator may deliberately address an explicit organizationId, which
 * the API then checks against its live D1 membership and platform authority.
 */
export function resolveRpcOrganizationId(
	caller: Pick<CallerIdentity, "scopes" | "organizationId"> | undefined,
	appOrganizationId: string | undefined,
	params: Record<string, unknown>,
): string | undefined {
	const requestedOrganizationId =
		typeof params.organizationId === "string" &&
		params.organizationId.length > 0
			? params.organizationId
			: undefined;
	if (requestedOrganizationId && hasPlatformMcpScope(caller)) {
		return requestedOrganizationId;
	}
	return caller?.organizationId ?? appOrganizationId;
}
const INTERNAL_TIMEOUT_FLOORS_MS: Record<string, number> = {
	// Starting CMS cleanup is durable, but a cold API and workflow enqueue may
	// exceed the generic 15s transport deadline before returning the receipt.
	"sites/deprovision": 30_000,
	"tedis/getLogs": 45_000,
	"tedis/syncStorage": 125_000,
	"tedis/wake": 120_000,
	"tedis/triggerCronSync": 180_000,
	"tedis/restart": 60_000,
	"tedis/resetSandbox": 30_000,
	"tedis/getStatus": 30_000,
	"tedis/sendMessage": 145_000, // ACP: 130s wait + 15s headroom
	"widgetTest/run": 60_000,
	"widgetTest/runInteractive": 180_000,
	"mcpEval/run": 30_000,
	"mcpHealth/run": 30_000,
	// The graph steward performs several bounded D1 health scans before it
	// applies links or flags. Even the minimum scan takes longer than the
	// generic 15s RPC ceiling in production, so keep its execution window
	// durable here instead of relying on mutable per-tool config that schema
	// projection intentionally regenerates.
	"workItems/runWorkGraphSteward": 60_000,
	// Home/kernel surface (home__* tools): these aggregate durable run sets,
	// transcripts, and trace bundles, and enqueueMessage can answer a turn
	// inline (LLM route) — all routinely exceed the 15s default and were
	// surfacing exact 15000ms internal-transport timeouts. Floor them like the
	// tedi diagnostic reads so the synchronous lane has real headroom; clients
	// that opt into the Tasks extension still get the async-canary deferral path.
	"kernelRuntime/enqueueMessage": 60_000,
	"kernelRuntime/readMessages": 45_000,
	"kernelRuntime/readRunSet": 45_000,
	"kernelRuntime/readRun": 45_000,
	"kernelRuntime/listConversations": 45_000,
	"kernelRuntime/approvePlanAssignments": 60_000,
	"kernelRuntime/respondApproval": 60_000,
	"kernelRuntime/cancelRun": 30_000,
	"kernelRuntime/steerRun": 30_000,
	"harness/listKernelTraceBundles": 45_000,
	"voice/synthesizeSpokenReply": 45_000,
};

/**
 * Forward the stable identity minted by the trusted skill-runtime bridge.
 *
 * `Idempotency-Key` is the provider-facing contract. The X-Tedix provenance
 * headers are useful inside Tedix service bindings, but are deliberately not
 * sent to arbitrary third-party REST/MCP origins. Forwarding a key proves only
 * that deduplication was requested; it does not prove that an upstream honored
 * it.
 */
export function applyWorkflowExecutionHeaders(
	headers: Record<string, string>,
	caller: CallerIdentity | undefined,
	options: { includeTedixProvenance: boolean },
): void {
	const key = caller?.workflowIdempotencyKey;
	if (key) {
		headers["Idempotency-Key"] = key;
		headers["X-Idempotency-Key"] = key;
	}
	if (!options.includeTedixProvenance || !caller) return;
	if (caller.skillRunId) {
		headers["X-Tedix-Skill-Run-Id"] = caller.skillRunId;
	}
	if (caller.skillId) {
		headers["X-Tedix-Skill-Id"] = caller.skillId;
	}
	if (caller.workflowStepId) {
		headers["X-Tedix-Workflow-Step-Id"] = caller.workflowStepId;
	}
	if (caller.workflowStepName) {
		// Preserve arbitrary Unicode/space-bearing step names as an ASCII-safe
		// header across multiple service-binding hops. The receiving Tedix edge
		// decodes this exactly once for audit metadata.
		headers["X-Tedix-Workflow-Step-Name"] = encodeURIComponent(
			caller.workflowStepName,
		);
	}
	if (caller.workflowStepCount !== undefined) {
		headers["X-Tedix-Workflow-Step-Count"] = String(caller.workflowStepCount);
	}
	if (caller.workflowStepAttempt !== undefined) {
		headers["X-Tedix-Workflow-Step-Attempt"] = String(
			caller.workflowStepAttempt,
		);
	}
	if (caller.workflowExecutionEpoch !== undefined) {
		headers["X-Tedix-Workflow-Execution-Epoch"] = String(
			caller.workflowExecutionEpoch,
		);
	}
	if (caller.workflowCallId) {
		headers["X-Tedix-Workflow-Call-Id"] = caller.workflowCallId;
	}
}

export function resolveInternalTransportTimeout(
	endpoint: string,
	config: ToolConfig,
	input: Record<string, unknown> = {},
): number {
	const configTimeout = config.timeout ?? DEFAULT_INTERNAL_TIMEOUT_MS;
	const timeoutFloor = INTERNAL_TIMEOUT_FLOORS_MS[endpoint] ?? 0;
	if (BROWSER_QUICK_ACTION_ENDPOINTS.has(endpoint)) {
		const navigationMs =
			typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
				? Math.max(1_000, Math.min(input.timeoutMs, 60_000))
				: 30_000;
		const postLoadMs =
			typeof input.waitForTimeoutMs === "number" &&
			Number.isFinite(input.waitForTimeoutMs)
				? Math.max(0, Math.min(input.waitForTimeoutMs, 60_000))
				: 0;
		// The browser may spend its full navigation and post-load waits before
		// the API serializes the result. The generic 15s RPC timer cuts that off.
		return Math.max(configTimeout, navigationMs + postLoadMs + 15_000);
	}
	return Math.max(configTimeout, timeoutFloor);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSensitiveLogKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[-_\s]/g, "");
	return (
		normalized === "authorization" ||
		normalized === "cookie" ||
		normalized === "setcookie" ||
		normalized === "apikey" ||
		normalized === "secret" ||
		normalized === "password" ||
		normalized === "passwd" ||
		normalized === "pwd" ||
		normalized === "token" ||
		normalized === "credential" ||
		normalized === "credentials" ||
		normalized === "privatekey" ||
		normalized === "sessionid" ||
		normalized.endsWith("token") ||
		normalized.endsWith("secret") ||
		normalized.endsWith("password") ||
		normalized.endsWith("apikey") ||
		normalized.endsWith("credential")
	);
}

function scrubSensitiveLogText(value: string): string {
	return value
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 <redacted>")
		.replace(
			/\b(api[-_]?key|secret|password|passwd|pwd|access[-_]?token|refresh[-_]?token|client[-_]?secret)(["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
			`$1$2${REDACTED_LOG_VALUE}`,
		)
		.replace(
			/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
			"<redacted.jwt>",
		);
}

function truncateLogText(
	value: string,
	maxLength = RPC_ERROR_LOG_SUMMARY_MAX_CHARS,
): { value: string; truncated: boolean } {
	if (value.length <= maxLength) return { value, truncated: false };
	return {
		value: `${value.slice(0, Math.max(0, maxLength - 3))}...`,
		truncated: true,
	};
}

function redactLogValue(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === "string") return scrubSensitiveLogText(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (typeof value === "bigint") return value.toString();
	if (Array.isArray(value)) {
		if (depth >= RPC_ERROR_LOG_MAX_DEPTH) {
			return `[array:${value.length}]`;
		}
		const items = value
			.slice(0, RPC_ERROR_LOG_MAX_ARRAY_ITEMS)
			.map((item) => redactLogValue(item, depth + 1));
		if (value.length > RPC_ERROR_LOG_MAX_ARRAY_ITEMS) {
			items.push(
				`... ${value.length - RPC_ERROR_LOG_MAX_ARRAY_ITEMS} more item(s)`,
			);
		}
		return items;
	}
	if (typeof value !== "object") return String(value);

	const record = value as Record<string, unknown>;
	const entries = Object.entries(record);
	if (depth >= RPC_ERROR_LOG_MAX_DEPTH) {
		return `[object:${entries.length} key(s)]`;
	}

	const redacted: Record<string, unknown> = {};
	for (const [key, entryValue] of entries.slice(
		0,
		RPC_ERROR_LOG_MAX_OBJECT_KEYS,
	)) {
		redacted[key] = isSensitiveLogKey(key)
			? REDACTED_LOG_VALUE
			: redactLogValue(entryValue, depth + 1);
	}
	if (entries.length > RPC_ERROR_LOG_MAX_OBJECT_KEYS) {
		redacted._truncatedKeys = entries.length - RPC_ERROR_LOG_MAX_OBJECT_KEYS;
	}
	return redacted;
}

function summarizeRpcErrorResponse(data: unknown): {
	type: string;
	summary: string;
	truncated: boolean;
} {
	const type = Array.isArray(data)
		? "array"
		: data === null
			? "null"
			: typeof data;
	try {
		const redacted = redactLogValue(data);
		const serialized =
			typeof redacted === "string" ? redacted : JSON.stringify(redacted);
		const summary = truncateLogText(serialized ?? "");
		return { type, summary: summary.value, truncated: summary.truncated };
	} catch {
		return {
			type,
			summary: "[unserializable error response]",
			truncated: false,
		};
	}
}

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
function buildCredentialErrorMessage(result: CredentialFetchResult): string {
	const genericMessage =
		"Connection credential not found. Ensure the provider is connected in Settings > Connections.";
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

function credentialDelegationHeaders<TConfig>(
	ctx: ToolExecutionContext<TConfig>,
): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Tedix-Mcp-Tool-Id": ctx.toolId,
	};
	const caller = ctx.callerIdentity;
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
	accessToken: string;
	expiresAt: number;
}

/** Module-level cache: `{tediId|orgId}::{connectionId}::{scope}::{scopes}` → token */
const credentialTokenCache = new Map<string, CachedCredential>();

function getCredentialCacheKey(
	tediOrOrgId: string,
	connectionId: string,
	scope: string,
	authScopes: string[],
	label?: string,
	userId?: string,
	connectionInstanceId?: string,
): string {
	return `${tediOrOrgId}::${connectionId}::${scope}::${userId ?? ""}::${[...authScopes].sort().join(",")}::${label ?? ""}::${connectionInstanceId ?? ""}`;
}

function selectedConnectionInstanceId(
	ctx: ToolExecutionContext<ToolConfig>,
): string | undefined {
	const id =
		ctx.config.auth?.connectionInstanceId ??
		(ctx.config as unknown as Record<string, unknown>)
			._aggregateConnectionInstanceId;
	if (id === undefined) return undefined;
	if (
		typeof id !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		throw new Error("Invalid account binding");
	return id;
}

function getCachedCredential(key: string): string | null {
	const entry = credentialTokenCache.get(key);
	if (!entry) return null;
	if (entry.expiresAt <= Date.now()) {
		credentialTokenCache.delete(key);
		return null;
	}
	return entry.accessToken;
}

function setCachedCredential(
	key: string,
	accessToken: string,
	ttlMs?: number,
): void {
	// Evict oldest entries if at capacity
	if (credentialTokenCache.size >= CREDENTIAL_CACHE_MAX_SIZE) {
		const oldest = credentialTokenCache.keys().next().value;
		if (oldest) credentialTokenCache.delete(oldest);
	}
	credentialTokenCache.set(key, {
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

/** Cache key for client-credentials bearer tokens (separate namespace from raw creds) */
function getClientCredentialsCacheKey(
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
	const cached = getCachedCredential(cacheKey);
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
		Math.max(ttlMs, 30_000),
	);

	return { token: result.token.accessToken };
}

// =============================================================================
// tool execution context
// =============================================================================

/**
 * Context passed to the handler during tool execution
 */
export interface ToolExecutionContext<TConfig = unknown> {
	/** App ID */
	appId: string;

	/** App entity from API (lighter-weight than full D1 type) */
	app: McpApp;

	/** App capabilities (checkout, cart, etc.) */
	appCapabilities: AppCapabilities;

	/** Environment bindings (includes API_URL for data fetching) */
	env: CloudflareEnv;

	/** Tool-specific configuration from D1 */
	config: TConfig;

	/** Tool ID (e.g., "search_listings") */
	toolId: string;

	/** Canonical server-projected Code Mode callable, never caller input. */
	callable?: string;

	/**
	 * Raw tool input JSON Schema (D1 `app_tools.input_schema`). The upstream
	 * MCP transport scans it for SEP-2243 `x-mcp-header` bindings to derive
	 * `Mcp-Param-*` request headers on 2026-07-28-negotiated upstream calls.
	 */
	toolInputSchema?: Record<string, unknown>;

	/** Unique request ID for tracing */
	requestId: string;

	/** Per-request trace ID for cross-layer correlation (propagated via X-Trace-Id header) */
	traceId?: string;

	/** Optional W3C tracestate chain preserved for outbound MCP hops. */
	tracestate?: string;

	/** Inbound MCP request _meta. Carries trace context plus Tedix run linkage. */
	requestMeta?: Record<string, unknown>;

	/** Parent Code Mode execution ID when this call is part of a multi-tool run. */
	executionId?: string;

	/**
	 * Adapter scope: controls which adapters to query (from tool config)
	 * - "all": Query all configured adapters
	 * - "primary": Query only the primary adapter
	 * - string[]: Query specific adapters by ID
	 */
	adapterScope?: "all" | "primary" | string[];

	/**
	 * Result strategy: controls how to combine results from multiple adapters (from tool config)
	 * - "merge": Combine all results from all adapters
	 * - "first_success": Return first successful result
	 * - "parallel_all": Run all adapters in parallel and return all results
	 */
	resultStrategy?: "merge" | "first_success" | "parallel_all";

	/** App metadata (mcpConfig, blogConfig, etc.) */
	appMetadata?: Record<string, unknown> | null;

	/** Caller identity from auth context (if authenticated) */
	callerIdentity?: CallerIdentity;

	/** Legacy per-project routing hint from X-Tedix-Connection-Label. */
	connectionLabel?: string;

	/** Original bearer token from the authenticated request. Forwarded to
	 *  upstream service bindings via X-Forwarded-Authorization so they can
	 *  proxy authenticated calls to third-party services. */
	bearerToken?: string;

	/**
	 * Whether the caller opted into the MCP Tasks extension
	 * (`io.modelcontextprotocol/tasks`) via request
	 * `_meta.io.modelcontextprotocol/clientCapabilities.extensions`.
	 *
	 * Per the 2026-07-28 protocol, a server returns a task only when the client
	 * explicitly declared support. Unknown callers, callers without
	 * `clientCapabilities`, and clients that omit the Tasks extension are not
	 * task-capable.
	 */
	clientSupportsTasks?: boolean;
}

const TEDIX_KERNEL_RUN_META_KEY = "io.tedix/kernelRunId";
const TEDIX_WORK_ITEM_META_KEY = "io.tedix/workItemId";
const TEDIX_TRACE_BUNDLE_META_KEY = "io.tedix/traceBundleId";

function metaString(
	meta: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = meta?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// =============================================================================
// tool handler (the universal handler)
// =============================================================================

export interface RpcToolResult {
	data: unknown;
	status: number;
	tokensUsed?: number;
	/** Trusted adapter-only signal; never synthesized from generic result data. */
	providerConfirmation?: string;
	/** Internal-only marker rewritten to a protocol-native MCP Task result. */
	osGadgetTask?: OsGadgetTaskMarker;
	/** Trusted first-party observation accepted at the Docs service-binding boundary. */
	readObservation?: DocsFileObservationReceipt;
	/** Host-generated only; a pinned credential lookup failed before execution. */
	connectionRecovery?: ConnectionRecovery;
}

async function verifiedDocsReadObservation(input: {
	serviceBinding: unknown;
	docsBinding: unknown;
	toolName: string;
	requestedSiteId: unknown;
	expectedOrganizationSlug: string | undefined;
	result: Record<string, unknown> | undefined;
	data: unknown;
}): Promise<DocsFileObservationReceipt | undefined> {
	if (
		!input.serviceBinding ||
		input.serviceBinding !== input.docsBinding ||
		input.toolName !== "get_docs_file"
	)
		return;
	const receipt = parseDocsFileObservationReceipt(
		input.result?._meta &&
			(input.result._meta as Record<string, unknown>)[
				READ_OBSERVATION_META_KEY
			],
	);
	const data = isRecord(input.data) ? input.data : null;
	if (!receipt || !data || typeof data.content !== "string") return;
	const bytes = new TextEncoder().encode(data.content);
	const digest = [
		...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
	]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	if (
		receipt.resource.siteId !== input.requestedSiteId ||
		!input.expectedOrganizationSlug ||
		receipt.resource.organizationSlug !== input.expectedOrganizationSlug ||
		receipt.resource.path !== data.path ||
		receipt.evidence.observedGitRevision !== data.revision ||
		receipt.evidence.contentSha256 !== digest ||
		receipt.evidence.byteLength !== bytes.byteLength ||
		data.contentSha256 !== digest ||
		data.byteLength !== bytes.byteLength
	)
		return;
	return receipt;
}

/** Only allow safe path characters in endpoint — no traversal, query strings, or fragments.
 * Allows : for path params (e.g., monitors/:id) which are interpolated before the request. */
const SAFE_ENDPOINT_RE = /^[a-zA-Z0-9_\-/.:]+$/;

/** Max text content length before truncation */
const MAX_TEXT_LENGTH = 4000;

const CHAR_COUNT_FORMAT = new Intl.NumberFormat("en-US");

/**
 * Head-truncate model-visible text at MAX_TEXT_LENGTH with a machine-actionable
 * hint that teaches the caller how to get a smaller result on the next call.
 * Display text only — structuredContent is never truncated here.
 */
function truncateTextContent(text: string): string {
	if (text.length <= MAX_TEXT_LENGTH) return text;
	return `${text.slice(0, MAX_TEXT_LENGTH)}\n[Truncated: showing first ${CHAR_COUNT_FORMAT.format(MAX_TEXT_LENGTH)} of ${CHAR_COUNT_FORMAT.format(text.length)} chars. Narrow the query with this tool's pagination/filter parameters, or call it via Code Mode and select only the fields you need.]`;
}

/**
 * Render a `modelSummaryTemplate` against the shaped structured payload.
 * Same `{field.path}` placeholder syntax as responseTransforms, plus a
 * `{count:field.path}` helper that renders the length of the array at that
 * path (`0` when the path is missing or not an array).
 */
function renderModelSummaryTemplate(
	template: string,
	payload: Record<string, unknown>,
): string {
	return template.replace(/\{([^{}]+)\}/g, (_match, expr: string) => {
		if (expr.startsWith("count:")) {
			const value = getByPath(payload, expr.slice("count:".length));
			return Array.isArray(value) ? String(value.length) : "0";
		}
		const value = getByPath(payload, expr);
		if (value == null) return "";
		return typeof value === "object" ? JSON.stringify(value) : String(value);
	});
}

/** Validate external URL — prevents SSRF against internal services */
function validateExternalUrl(baseUrl: string, isDev: boolean): string | null {
	// In dev, also allow tedix-owned hosts (e.g. retail-bench.tedix.tech) so
	// external tools can reach our own tunnel'd dev services; prod stays locked
	// (allowInternalHosts is false unless isDev). Private/loopback IPs always blocked.
	return validateUrl(baseUrl, { allowHttp: isDev, allowInternalHosts: isDev });
}

/**
 * Does the endpoint template spend `field` as a path placeholder
 * (`:field`, `{field}`, `{+field}`)? `materializeRestRoute()` consumes such
 * params into the route, so they never travel as body/query keys and the
 * schema-acceptance guard must not block their injection.
 */
function endpointConsumesPathParam(endpoint: string, field: string): boolean {
	return new RegExp(`(?:\\{\\+?${field}\\}|:${field}(?!\\w))`).test(endpoint);
}

function namespaceAggregateTediTaskLinkage(
	data: unknown,
	config: ToolConfig,
): unknown {
	const aggregateTediId = (config as unknown as Record<string, unknown>)
		._aggregateTediId;
	if (
		typeof aggregateTediId !== "string" ||
		!aggregateTediId ||
		!isRecord(data)
	) {
		return data;
	}

	if (
		typeof data.session_key === "string" &&
		isEphemeralSessionKey(data.session_key)
	)
		return data;
	const task = data.task;
	if (
		isRecord(task) &&
		typeof task.id === "string" &&
		!task.id.startsWith("tedi:")
	) {
		return {
			...data,
			task: { ...task, id: `tedi:${aggregateTediId}:${task.id}` },
		};
	}
	if (
		!task &&
		data.pending === true &&
		typeof data.run_id === "string" &&
		data.run_id
	) {
		return {
			...data,
			task: {
				id: `tedi:${aggregateTediId}:${data.run_id}`,
				pollWith: "tasks/get",
			},
		};
	}
	return data;
}

class ExternalRequestInputError extends Error {
	override name = "ExternalRequestInputError";
}

function expandExternalBodyTemplate(
	template: unknown,
	params: Record<string, unknown>,
): unknown {
	if (typeof template === "string") {
		const placeholder = template.match(/^\{([A-Za-z_]\w*)\}$/)?.[1];
		if (!placeholder) return template;
		const value = params[placeholder];
		if (
			value === undefined ||
			value === null ||
			(typeof value !== "string" &&
				typeof value !== "number" &&
				typeof value !== "boolean")
		) {
			throw new ExternalRequestInputError(
				`Missing scalar request-body template value: ${placeholder}`,
			);
		}
		return value;
	}
	if (Array.isArray(template)) {
		return template.map((value) => expandExternalBodyTemplate(value, params));
	}
	if (isRecord(template)) {
		return Object.fromEntries(
			Object.entries(template).map(([key, value]) => [
				key,
				expandExternalBodyTemplate(value, params),
			]),
		);
	}
	return template;
}

function normalizedContentType(contentType: string): string {
	return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
	const normalized = name.toLowerCase();
	return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

function setHeaderIfMissing(
	headers: Record<string, string>,
	name: string,
	value: string,
): void {
	if (!hasHeader(headers, name)) headers[name] = value;
}

function appendScalarFormValue(
	append: (value: string) => void,
	value: unknown,
): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		for (const item of value) appendScalarFormValue(append, item);
		return;
	}
	if (typeof value === "object") {
		append(JSON.stringify(value));
		return;
	}
	append(String(value));
}

function base64ToBytes(base64: string): Uint8Array {
	const compact = base64.replace(/\s/g, "");
	const binary = atob(compact);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 32_766; // Multiple of 3 so chunked base64 can be concatenated.
	let encoded = "";
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const chunk = bytes.subarray(offset, offset + chunkSize);
		let binary = "";
		for (let index = 0; index < chunk.length; index++) {
			binary += String.fromCharCode(chunk[index]!);
		}
		encoded += btoa(binary);
	}
	return encoded;
}

function parseDataUrl(
	value: string,
): { mimeType?: string; base64: string } | null {
	if (!value.startsWith("data:")) return null;
	const commaIndex = value.indexOf(",");
	if (commaIndex === -1) return null;
	const meta = value.slice(5, commaIndex);
	if (!meta.toLowerCase().includes(";base64")) return null;
	const mimeType = meta.split(";")[0] || undefined;
	return { mimeType, base64: value.slice(commaIndex + 1) };
}

function fileParamToBlob(
	paramName: string,
	value: unknown,
): { blob: Blob; filename: string } {
	let rawContent: unknown = value;
	let filename = paramName;
	let mimeType = "application/octet-stream";

	if (isRecord(value)) {
		rawContent = value.content ?? value.data ?? value.base64;
		const candidateFilename = value.filename ?? value.name;
		if (typeof candidateFilename === "string" && candidateFilename.trim()) {
			filename = candidateFilename.trim();
		}
		const candidateMimeType = value.mimeType ?? value.type;
		if (typeof candidateMimeType === "string" && candidateMimeType.trim()) {
			mimeType = candidateMimeType.trim();
		}
	}

	if (typeof rawContent !== "string" || rawContent.trim() === "") {
		throw new ExternalRequestInputError(
			`File parameter "${paramName}" must be a data URL, base64 string, or object with content/data/base64.`,
		);
	}

	const dataUrl = parseDataUrl(rawContent.trim());
	const base64 = dataUrl?.base64 ?? rawContent;
	if (dataUrl?.mimeType) mimeType = dataUrl.mimeType;

	try {
		const bytes = base64ToBytes(base64);
		return {
			blob: new Blob([bytes], { type: mimeType }),
			filename,
		};
	} catch {
		throw new ExternalRequestInputError(
			`File parameter "${paramName}" is not valid base64 file content.`,
		);
	}
}

function buildMultipartBody(
	params: Record<string, unknown>,
	fileParams: string[],
): FormData {
	const form = new FormData();
	const fileParamSet = new Set(fileParams);

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null) continue;
		if (fileParamSet.has(key)) {
			const file = fileParamToBlob(key, value);
			form.append(key, file.blob, file.filename);
			continue;
		}
		appendScalarFormValue((next) => form.append(key, next), value);
	}

	return form;
}

function buildUrlEncodedBody(params: Record<string, unknown>): URLSearchParams {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		appendScalarFormValue((next) => body.append(key, next), value);
	}
	return body;
}

function isPublicRpcToolExecution(
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
): boolean {
	const aggregateConfig = config as unknown as Record<string, unknown>;
	if (
		aggregateConfig._sourceAuthRequired === false &&
		aggregateConfig._sourceVisibility === "public"
	) {
		return true;
	}

	const mcpConfig = ctx.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	if (mcpConfig?.authMode === "public") return true;

	const toolScopes = mcpConfig?.toolScopes as
		| Record<string, string[]>
		| undefined;
	const configuredScopes = toolScopes?.[ctx.toolId];
	return Array.isArray(configuredScopes) && configuredScopes.length === 0;
}

function delegatedDocsScope(toolName: string): string | undefined {
	return DOCS_TOOL_SCOPES[toolName as DocsToolName];
}

function fileParamsFromConfig(config: ToolConfig): string[] {
	const raw = (config as unknown as Record<string, unknown>).fileParams;
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string");
}

function stringParamsFromConfig(
	config: ToolConfig,
	key: "headerParams" | "queryParams" | "runtimeOnlyParams",
): string[] {
	const raw = (config as unknown as Record<string, unknown>)[key];
	if (!Array.isArray(raw)) return [];
	return raw.filter((item): item is string => typeof item === "string");
}

/**
 * Tedix-private `x-mcp-header`: a tool config can declare a static map of
 * custom headers forwarded on the upstream/rpc/external request. Values support
 * `{paramName}` placeholders resolved from (and consumed out of) tool input,
 * mirroring `staticHeaders`. Header names are normalized so a tool cannot
 * override Tedix-managed `X-Tedix-*`/`Authorization` headers.
 *
 * This is intentionally not SEP-2243's schema-level `x-mcp-header`, which maps
 * tool input properties to `Mcp-Param-*` request headers.
 */
function applyMcpCustomHeaders(
	headers: Record<string, string>,
	config: ToolConfig,
	params: Record<string, unknown>,
): void {
	const raw = (config as unknown as Record<string, unknown>)["x-mcp-header"];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "string") continue;
		const lower = name.toLowerCase();
		// Do not let config-declared headers clobber Tedix-managed identity/auth.
		if (lower === "authorization" || lower.startsWith("x-tedix-")) continue;
		const resolved = value.replace(/\{(\w+)\}/g, (_, key: string) => {
			const v = params[key];
			if (v !== undefined && v !== null) {
				delete params[key];
				return String(v);
			}
			return "";
		});
		if (resolved) headers[name] = resolved;
	}
}

function consumeNamedParams(
	params: Record<string, unknown>,
	names: string[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const name of names) {
		const value = params[name];
		if (value === undefined || value === null) continue;
		out[name] = value;
		delete params[name];
	}
	return out;
}

function filenameFromContentDisposition(
	contentDisposition: string | null,
): string | null {
	if (!contentDisposition) return null;
	const encoded = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition)?.[1];
	if (encoded) {
		try {
			return decodeURIComponent(encoded.replace(/^"|"$/g, ""));
		} catch {
			return encoded.replace(/^"|"$/g, "");
		}
	}
	return /filename="?([^";]+)"?/i.exec(contentDisposition)?.[1]?.trim() ?? null;
}

function isTextResponseContentType(contentType: string): boolean {
	const normalized = normalizedContentType(contentType);
	return (
		normalized.startsWith("text/") ||
		normalized.includes("xml") ||
		normalized.includes("html") ||
		normalized.includes("csv") ||
		normalized.includes("yaml")
	);
}

function textExternalRequestBody(value: unknown): string {
	if (typeof value === "string") return value;
	if (
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, "body")
	) {
		const body = (value as Record<string, unknown>).body;
		return typeof body === "string" ? body : JSON.stringify(body ?? "");
	}
	return JSON.stringify(value ?? "");
}

async function parseExternalResponse(
	response: Response,
	config: ToolConfig,
): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	const normalizedType = normalizedContentType(contentType);
	const responseMode = config.responseMode ?? "auto";
	const isJsonResponse =
		normalizedType === "application/json" || normalizedType.endsWith("+json");

	if (
		(response.status >= 400 && isJsonResponse) ||
		responseMode === "json" ||
		(responseMode === "auto" && isJsonResponse)
	) {
		return response.json();
	}
	if (
		responseMode === "text" ||
		(responseMode === "auto" && isTextResponseContentType(contentType))
	) {
		return response.text();
	}

	const buffer = await response.arrayBuffer();
	return {
		filename: filenameFromContentDisposition(
			response.headers.get("content-disposition"),
		),
		mimeType: contentType || "application/octet-stream",
		base64encoded: true,
		content: arrayBufferToBase64(buffer),
	};
}

function isOperationalTediRecord(value: unknown): boolean {
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

function filterOperationalTedisResult(
	endpoint: string,
	data: unknown,
): unknown {
	if (endpoint !== "tedis/list" || !data || typeof data !== "object") {
		return data;
	}
	const record = data as Record<string, unknown>;
	if (!Array.isArray(record.data)) return data;
	const filtered = record.data.filter(isOperationalTediRecord);
	const pagination =
		record.pagination && typeof record.pagination === "object"
			? {
					...(record.pagination as Record<string, unknown>),
					total: filtered.length,
					hasMore: false,
				}
			: record.pagination;
	return { ...record, data: filtered, ...(pagination ? { pagination } : {}) };
}

function attachExternalSourceProvenance(
	data: unknown,
	requestUrl: string,
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
): unknown {
	const declared = config.sourceProvenance;
	if (!declared) return data;

	const provenance = {
		provider: declared.provider ?? new URL(requestUrl).hostname,
		sourceUrl: requestUrl,
		...(declared.documentationUrl
			? { documentationUrl: declared.documentationUrl }
			: {}),
		queriedAt: new Date().toISOString(),
		appId: ctx.app.id,
		appSlug: ctx.app.slug,
		organizationId:
			ctx.callerIdentity?.organizationId ?? ctx.app.organizationId ?? null,
		tediId: ctx.callerIdentity?.tediId ?? null,
		userId: ctx.callerIdentity?.userId ?? null,
		toolId: ctx.toolId,
		traceId: ctx.traceId ?? null,
		executionId: ctx.executionId ?? ctx.requestId,
		...(declared.rateBudget ? { rateBudget: declared.rateBudget } : {}),
	};

	if (data && typeof data === "object" && !Array.isArray(data)) {
		return {
			...(data as Record<string, unknown>),
			_tedixProvenance: provenance,
		};
	}
	return { data, _tedixProvenance: provenance };
}

/**
 * Gateway attestation of operator consent.
 *
 * Returns the JSON envelope for `X-Tedix-Operator-Consent` on internal
 * tedi-bound dispatches, or null when no attestation is warranted. The rule is
 * deliberately narrow: only a skill-workflow caller whose admission row says a
 * human started the run (`createdBy: "user:<descopeUserId>"`) attests.
 * Agent-, tedi-, schedule-, and M2M-started runs return null — the fail-closed
 * negative control — and prompt text claiming consent never reaches this
 * function at all: the inputs come from service-binding headers the bridge
 * builds from host-side props.
 */
export function buildOperatorConsentHeader(
	caller:
		| { skillRunId?: string; skillRunCreatedBy?: string; skillId?: string }
		| undefined
		| null,
): string | null {
	if (!caller?.skillRunId) return null;
	if (!caller.skillRunCreatedBy?.startsWith("user:")) return null;
	return JSON.stringify({
		v: 1,
		runId: caller.skillRunId,
		...(caller.skillId ? { skillId: caller.skillId } : {}),
		createdBy: caller.skillRunCreatedBy,
		attestedBy: "tedix-mcp-gateway",
	});
}

export class ToolHandler {
	readonly type = "rpc";

	async execute(
		input: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
	): Promise<RpcToolResult> {
		const config = ctx.config;
		const expectedRaw = ctx.requestMeta?.["tedix/expectedConnection"];
		if (expectedRaw !== undefined) {
			const expected = readConnectionRecovery(expectedRaw);
			const auth = config.auth;
			if (
				!expected ||
				auth?.type !== "connection" ||
				expected.providerId !== auth.connectionId ||
				expected.connectionInstanceId !== selectedConnectionInstanceId(ctx) ||
				expected.scope !== (auth.credentialScope ?? auth.scope ?? "tenant") ||
				JSON.stringify([...expected.scopes].sort()) !==
					JSON.stringify([...(auth.scopes ?? [])].sort())
			) {
				return {
					status: 409,
					data: {
						error:
							"Selected account or scopes changed while awaiting reconnect; start a new reviewed run",
					},
				};
			}
		}
		const endpoint = config.endpoint;
		const transport = config.transport ?? "rpc";

		// MCP transport — direct stateless call to upstream MCP server
		if (transport === "mcp") {
			return this.executeMcp(input, ctx, config);
		}

		// Code transport — execute stored JS in a Dynamic Worker sandbox
		if (transport === "code") {
			return this.executeCode(input, ctx, config);
		}

		if (endpoint === undefined || endpoint === null) {
			return { data: { error: "No endpoint configured" }, status: 400 };
		}
		if (endpoint === "" && transport !== "external") {
			return { data: { error: "No endpoint configured" }, status: 400 };
		}

		// Path traversal defense — applies to all transports
		if (endpoint.includes("..")) {
			return { data: { error: "Invalid endpoint path" }, status: 400 };
		}

		// External transport — direct REST call to third-party API
		if (transport === "external") {
			return this.executeExternal(input, ctx, config, endpoint);
		}

		const timeout = resolveInternalTransportTimeout(endpoint, config, input);
		const isDev = ctx.env.ENVIRONMENT === "development";

		// Build request params from input via paramMap + staticParams
		// paramMap direction: { inputFieldName: apiFieldName }
		const params: Record<string, unknown> = { ...config.staticParams };
		if (config.paramMap) {
			for (const [inputKey, targetKey] of Object.entries(config.paramMap)) {
				const value = input[inputKey];
				// Skip undefined and empty arrays — AI hosts often send [] for optional array params
				if (value === undefined) continue;
				if (Array.isArray(value) && value.length === 0) continue;
				params[targetKey] = value;
			}
		} else {
			// No paramMap — pass all input through
			Object.assign(params, input);
		}

		const aggregateConfig = config as unknown as Record<string, unknown>;
		const omitAggregateTediId =
			config.staticParams?.__tedixOmitAggregateTediId === true;
		delete params.__tedixOmitAggregateTediId;
		const credentialDerivedTediActor =
			aggregateConfig._credentialDerivedTediActor === true;
		const selectedAggregateTediId =
			typeof aggregateConfig._aggregateTediId === "string"
				? aggregateConfig._aggregateTediId
				: null;
		// The opt-out sentinel rides inside staticParams because that field survives
		// catalog normalization and durable aggregate caches. It is consumed above
		// and never reaches the API contract. Voice synthesis is the one explicit
		// transform that consumes tediId locally and replaces it with a typed subject.
		const includeAggregateTediIdParam =
			!omitAggregateTediId || aggregateConfig._voiceSubject === "aggregateTedi";
		let verifiedCredentialTediActor: string | null = null;
		if (credentialDerivedTediActor) {
			// An aggregate namespace is a routing/read projection, never an identity
			// credential. Lifecycle writes may act as a tedi only when authentication
			// already established that exact actor. `service` covers the explicit,
			// trusted delegation hop: its caller identity is populated only after the
			// service-binding auth rewrite. Human OAuth, external-agent credentials,
			// anonymous callers, and a different tedi all fail closed here.
			const caller = ctx.callerIdentity;
			const credentialCanActAsTedi =
				(caller?.authType === "tedi" || caller?.authType === "service") &&
				typeof caller.tediId === "string" &&
				caller.tediId.length > 0;
			const aggregateOrgId =
				typeof aggregateConfig._aggregateTediOrgId === "string"
					? aggregateConfig._aggregateTediOrgId
					: null;
			const organizationMatches =
				!aggregateOrgId ||
				!caller?.organizationId ||
				caller.organizationId === aggregateOrgId;

			if (
				!credentialCanActAsTedi ||
				!selectedAggregateTediId ||
				caller.tediId !== selectedAggregateTediId ||
				!organizationMatches
			) {
				return {
					data: {
						error:
							"This mutation requires a verified credential for the selected tedi",
					},
					status: 403,
				};
			}
			verifiedCredentialTediActor = caller.tediId;
		}
		if (credentialDerivedTediActor) delete params.tediId;
		if (
			!credentialDerivedTediActor &&
			includeAggregateTediIdParam &&
			config.allowExplicitTediId === false &&
			typeof aggregateConfig._aggregateTediId === "string"
		) {
			// A tedi-prefixed curated surface is an ownership boundary, not a
			// caller-selectable default. Establish it before derived tedi transforms,
			// then reassert it after the generic caller-context guard below.
			params.tediId = aggregateConfig._aggregateTediId;
		}
		if (
			!credentialDerivedTediActor &&
			includeAggregateTediIdParam &&
			!params.tediId &&
			typeof aggregateConfig._aggregateTediId === "string" &&
			config.allowExplicitTediId
		) {
			params.tediId = aggregateConfig._aggregateTediId;
		}

		const hasTrustedAggregateTediBinding =
			includeAggregateTediIdParam &&
			typeof aggregateConfig._aggregateTediId === "string" &&
			aggregateConfig._aggregateTediId.length > 0 &&
			(config.allowExplicitTediId === true ||
				// Curated owner-bound tools hide tediId from caller input while
				// supplying it in server-generated config. That public schema must
				// not erase the required owner or an optional ownership filter.
				(config.allowExplicitTediId === false &&
					config.staticParams?.tediId === aggregateConfig._aggregateTediId));
		let tediIdFromTrustedAggregate = hasTrustedAggregateTediBinding;
		if (
			!credentialDerivedTediActor &&
			!params.tediId &&
			typeof aggregateConfig._aggregateTediSlug === "string" &&
			config.allowExplicitTediId
		) {
			const resolved = await this.resolveTediSlug(
				ctx,
				aggregateConfig._aggregateTediSlug,
			);
			if (resolved) {
				params.tediId = resolved;
				tediIdFromTrustedAggregate = true;
			}
		}

		// Resolve slug → tediId before security enforcement. When the caller
		// passes a slug instead of a UUID tediId, look up the tedi record via the
		// API so that enforceContextParams sees a real tediId. Only runs for tools
		// that opt into cross-tedi operations (allowExplicitTediId).
		if (params.slug && !params.tediId && config.allowExplicitTediId) {
			const resolved = await this.resolveTediSlug(ctx, String(params.slug));
			if (resolved) {
				params.tediId = resolved;
				delete params.slug;
			}
		}

		const tediBooleanParams = aggregateConfig.tediBooleanParams;
		if (
			params.tediId &&
			tediBooleanParams &&
			typeof tediBooleanParams === "object" &&
			!Array.isArray(tediBooleanParams)
		) {
			for (const [inputKey, targetKey] of Object.entries(
				tediBooleanParams as Record<string, string>,
			)) {
				if (input[inputKey] === true) {
					params[targetKey] = params.tediId;
				}
				delete params[inputKey];
			}
		}

		// Security: Force-set appId and tediId from the authenticated context
		// for internal transports (rest/rpc) to prevent cross-app/cross-tedi
		// data access. The API layer enforces org-scoped access as the primary
		// guard — this is defense-in-depth.
		//
		// Config-driven: tools opt into cross-entity operations by setting
		// `allowExplicitAppId` or `allowExplicitTediId` in their D1 config.
		// No hardcoded endpoint lists — tedis self-configure without code deploys.
		this.enforceContextParams(
			params,
			ctx,
			config,
			endpoint,
			ctx.toolInputSchema,
		);
		if (
			!credentialDerivedTediActor &&
			includeAggregateTediIdParam &&
			config.allowExplicitTediId === false &&
			typeof aggregateConfig._aggregateTediId === "string"
		) {
			// `_aggregateTediId` is minted by aggregateAndPrefixTools(), not accepted
			// from tool input. It therefore represents the selected aggregate tool's
			// trusted owner and must win over both caller input and caller identity.
			params.tediId = aggregateConfig._aggregateTediId;
		}

		if (
			!credentialDerivedTediActor &&
			!ctx.callerIdentity?.tediId &&
			!params.tediId
		) {
			// Fallback: human callers (OAuth without tediId in JWT) or unauthenticated
			// public access — resolve from app's tediPolicy config. This handles cases
			// where index.ts resolution didn't fire or silently failed.
			if (ctx.appMetadata) {
				const mcpConfig = ctx.appMetadata.mcpConfig as
					| Record<string, unknown>
					| undefined;
				const policyTediId = (
					mcpConfig?.tediPolicy as Record<string, unknown> | undefined
				)?.tediId;
				if (typeof policyTediId === "string" && policyTediId) {
					console.log(
						`[handler] Resolved tediId from tediPolicy: ${policyTediId} for endpoint: ${endpoint}`,
					);
					params.tediId = policyTediId;
				} else {
					log.warn("Tedi identity missing from policy", {
						event: "handler.tedi_identity_missing_policy",
						appId: ctx.appId,
						toolName: ctx.toolId,
						outcome: "misconfigured",
					});
				}
			} else {
				log.warn("Tedi identity missing from app metadata", {
					event: "handler.tedi_identity_missing_metadata",
					appId: ctx.appId,
					toolName: ctx.toolId,
					outcome: "misconfigured",
				});
			}
		}

		if (
			(config as unknown as Record<string, unknown>)._voiceSubject ===
			"aggregateTedi"
		) {
			if (typeof params.tediId !== "string" || params.tediId.length === 0) {
				return {
					data: {
						error: "Unable to resolve tedi subject for spoken-reply synthesis",
					},
					status: 400,
				};
			}
			params.subject = { type: "tedi", tediId: params.tediId };
			delete params.tediId;
		}
		if (credentialDerivedTediActor) delete params.tediId;
		// Final chokepoint for every tediId injection above (ownership reassert,
		// aggregate defaults, tediPolicy fallback): a strict oRPC contract that
		// does not declare tediId rejects the whole call on the unknown key, and a
		// procedure that cannot read the field gains no defence-in-depth from it.
		// Enforcement has already run with the injected value; org-scoped
		// home-mirror tools on tedi-prefixed surfaces (cto.create_work_item and
		// siblings) were 100% unreachable without this.
		if (
			omitAggregateTediId ||
			(!tediIdFromTrustedAggregate &&
				!this.schemaAccepts(ctx.toolInputSchema, "tediId", endpoint))
		) {
			delete params.tediId;
		}

		// Build fetch options
		const apiUrl = ctx.env.API_URL;
		const useServiceBinding = !!ctx.env.API_SERVICE;
		const baseUrl = useServiceBinding ? "https://api" : apiUrl;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (useServiceBinding) {
			headers["X-Service-Binding"] = "true";
			const lineageHeaders = [
				[TEDIX_KERNEL_RUN_META_KEY, "X-Tedix-Kernel-Run-Id"],
				[TEDIX_WORK_ITEM_META_KEY, "X-Tedix-Work-Item-Id"],
				[TEDIX_TRACE_BUNDLE_META_KEY, "X-Tedix-Trace-Bundle-Id"],
			] as const;
			for (const [metaKey, headerName] of lineageHeaders) {
				const value = metaString(ctx.requestMeta, metaKey);
				if (value) headers[headerName] = value.slice(0, 512);
			}
		}
		if (ctx.traceId) headers["X-Tedix-Trace-Id"] = ctx.traceId;
		if (ctx.executionId) {
			headers["X-Tedix-Mcp-Execution-Id"] = ctx.executionId;
		}
		headers["X-Tedix-Mcp-Tool-Id"] = ctx.toolId;
		const forwardCallerUser =
			!isPublicRpcToolExecution(ctx, config) &&
			ctx.bearerToken &&
			(ctx.callerIdentity?.authType === "oauth" ||
				ctx.callerIdentity?.authType === "user");
		// Tools may opt into forwarding the authenticated caller's user ID (a
		// claim, not the JWT) on the service-binding call — e.g. Home direct reads
		// act under the user's speaker authority (docs/product/tedix-os.md). This keeps the
		// service-binding auth/permissions (no forwarded-user RBAC path) and only
		// adds the id so the kernel can resolve the user's own provider connection.
		const forwardActingUser =
			(config as unknown as Record<string, unknown>)._forwardCallerAuth ===
				true && Boolean(ctx.callerIdentity?.userId);
		if (useServiceBinding && forwardCallerUser) {
			headers["X-Forwarded-Authorization"] = `Bearer ${ctx.bearerToken}`;
			headers["X-Tedix-Caller-Type"] = "mcp-edge-user";
			// The edge just validated these capability scopes. Carry them over the
			// trusted binding so apps/api can evaluate platform authority for a
			// human operator without confusing that person with a tedi identity.
			const callerScopes = ctx.callerIdentity?.scopes ?? [];
			if (callerScopes.length > 0) {
				headers["X-Tedix-Mcp-Caller-Scopes"] = callerScopes.join(" ");
			}
		}
		if (useServiceBinding && forwardActingUser && ctx.callerIdentity?.userId) {
			headers["X-Tedix-Acting-User"] = ctx.callerIdentity.userId;
		}
		if (
			useServiceBinding &&
			ctx.callerIdentity?.tediId &&
			(ctx.callerIdentity.authType === "tedi" ||
				ctx.callerIdentity.authType === "service")
		) {
			headers["X-Tedix-Tedi-Id"] = ctx.callerIdentity.tediId;
			// Carry the tedi's capability scopes across the MCP→API hop. A tedi's
			// Descope roles are not in its JWT, so apps/api cannot re-derive its
			// authority from the token; the edge already resolved these scopes from
			// D1 `tedis.mcp_capability_profile` (resolveTediScopes), which is the
			// platform's source of truth. Without this, a `platform_admin` tedi
			// arrives at apps/api as a bare service binding with no principal and is
			// rejected by every `isPlatformPrincipal()` gate. Spoofing is not a
			// concern: these headers only exist on the trusted Worker-to-Worker
			// binding (public ingress strips the marker — see
			// `isServiceBinding`), and the tedi never supplies them itself.
			const tediScopes = ctx.callerIdentity.scopes ?? [];
			if (tediScopes.length > 0) {
				headers["X-Tedix-Tedi-Scopes"] = tediScopes.join(" ");
			}
		}
		if (
			useServiceBinding &&
			!headers["X-Tedix-Tedi-Scopes"] &&
			(ctx.callerIdentity?.scopes?.length ?? 0) > 0
		) {
			// Fallback delegation for callers with no other authority path at
			// apps/api: tedis get source "mcp-tool" trust and interactive users
			// get X-Forwarded-Authorization, but a machine credential (AIH M2M
			// clients present as authType "oauth" with credentialMode "aih-m2m";
			// plain m2m likewise) arrived as a bare service binding and
			// forbidden-failed every machine-fenced guard. Delegate the
			// machine-vocabulary translation of the edge-validated granular MCP
			// capability scopes (mcp:tedis.read → tedis:read); platform:admin
			// deliberately does not expand into machine authority. For callers
			// that do authenticate at the API (forwarded user auth), that plane
			// wins and this header is inert.
			// Forward the originals plus the translation: some API guards demand
			// mcp:-vocabulary machine scopes (mcp:memory.read), which the original
			// grants satisfy by exact scope matching.
			const callerScopes = ctx.callerIdentity?.scopes ?? [];
			const machineScopes = delegatedMachineScopes(callerScopes);
			if (machineScopes.length > 0) {
				headers["X-Tedix-Tedi-Scopes"] = [
					...new Set([...callerScopes, ...machineScopes]),
				].join(" ");
			}
		}
		if (
			useServiceBinding &&
			ctx.callerIdentity?.authType === "external_agent" &&
			ctx.callerIdentity.externalAgentPrincipalId &&
			ctx.callerIdentity.externalAgentSessionId &&
			ctx.callerIdentity.externalAgentClientRecordId
		) {
			headers["X-Tedix-Caller-Type"] = "mcp-edge-external-agent";
			headers["X-Tedix-External-Agent-Principal-Id"] =
				ctx.callerIdentity.externalAgentPrincipalId;
			headers["X-Tedix-External-Agent-Session-Id"] =
				ctx.callerIdentity.externalAgentSessionId;
			headers["X-Tedix-External-Agent-Client-Record-Id"] =
				ctx.callerIdentity.externalAgentClientRecordId;
		}
		if (
			useServiceBinding &&
			credentialDerivedTediActor &&
			verifiedCredentialTediActor
		) {
			// Authentication established this actor before aggregate routing. The
			// selected namespace was checked only for equality and cannot mint it.
			headers["X-Tedix-Tedi-Id"] = verifiedCredentialTediActor;
		}
		// Operator provenance for skill-run admission.
		// When a human OAuth caller invokes an RPC tool through the gateway,
		// apps/api sees only the service binding — the person vanishes. Forward
		// the end-user id on the trusted hop so admission paths (run_skill_workflow)
		// can record who started the run. Same spoofing argument as the tedi
		// headers above: this header only exists Worker-to-Worker.
		if (
			useServiceBinding &&
			ctx.callerIdentity?.authType === "oauth" &&
			ctx.callerIdentity.userId
		) {
			headers["X-Tedix-End-User-Id"] = ctx.callerIdentity.userId;
		}
		// Pass org context for scoped API calls. Platform operators may explicitly
		// address another tenant; all other callers stay pinned to their served app.
		const orgId = resolveRpcOrganizationId(
			ctx.callerIdentity,
			ctx.app?.organizationId,
			params,
		);
		if (orgId) {
			headers["X-Tedix-Org-Id"] = orgId;
		}
		if (ctx.app?.id) {
			headers["X-Tedix-Mcp-App-Id"] = ctx.app.id;
		}
		if (ctx.app?.slug) {
			headers["X-Tedix-Mcp-App-Slug"] = ctx.app.slug;
		}
		if (ctx.app?.organizationId) {
			headers["X-Tedix-Mcp-App-Org-Id"] = ctx.app.organizationId;
		}
		// Forward skill workflow run identity so the API layer can default
		// `source` URIs on memory writes (skill://runs/{runId}) and cascade
		// cleanup on revoke. Skill-runner sets these on inbound requests;
		// they ride along the entire skill-runtime → mcp → api chain.
		if (ctx.callerIdentity?.skillRunId) {
			headers["X-Tedix-Skill-Run-Id"] = ctx.callerIdentity.skillRunId;
		}
		if (ctx.callerIdentity?.skillId) {
			headers["X-Tedix-Skill-Id"] = ctx.callerIdentity.skillId;
		}
		// Tedix-private x-mcp-header: config-declared custom headers (rpc/rest).
		applyMcpCustomHeaders(headers, config, params);
		applyWorkflowExecutionHeaders(headers, ctx.callerIdentity, {
			includeTedixProvenance: true,
		});

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);

		try {
			let url: string;
			let status: number;
			let data: unknown;
			let osGadgetTask: OsGadgetTaskMarker | null = null;

			if (transport === "rest") {
				let fetchInit: RequestInit;
				const method = config.method ?? "POST";
				const route = materializeRestRoute(endpoint, params);
				if (method === "GET") {
					const queryString = buildQueryString(route.params);
					url = `${baseUrl}/v1/${route.endpoint}${queryString ? `?${queryString}` : ""}`;
					fetchInit = { method, headers, signal: controller.signal };
				} else {
					url = `${baseUrl}/v1/${route.endpoint}`;
					fetchInit = {
						method,
						headers,
						body: JSON.stringify(route.params),
						signal: controller.signal,
					};
				}
				const fetcher = useServiceBinding
					? ctx.env.API_SERVICE!.fetch.bind(ctx.env.API_SERVICE!)
					: globalThis.fetch;
				const response = await fetcher(url, fetchInit);
				status = response.status;
				const contentType = response.headers.get("content-type") ?? "";
				data = contentType.includes("application/json")
					? await response.json()
					: await response.text();
			} else {
				url = `${baseUrl}/rpc/${endpoint}`;
				const result = await callApiRpc(ctx.env, endpoint, params, {
					headers,
					timeoutMs: timeout,
				});
				status = result.status;
				// Keep existing responsePath configuration stable while the official
				// client owns the transport envelope.
				data = { json: result.data };
			}

			if (isDev) {
				console.log(`[rpc-handler] ${url} → ${status}`);
			}

			if (status >= 400) {
				log.warn("RPC upstream returned error", {
					event: "handler.rpc_upstream_error",
					appId: ctx.appId,
					toolName: ctx.toolId,
					status,
					...(ctx.traceId ? { traceId: ctx.traceId } : {}),
					...(ctx.executionId ? { executionId: ctx.executionId } : {}),
					outcome:
						status >= 500
							? "unavailable"
							: status === 401 || status === 403
								? "denied"
								: "invalid",
				});
			}

			// Extract via responsePath
			const responsePath =
				config.responsePath ?? (transport === "rpc" ? "json" : undefined);
			if (responsePath && data != null && typeof data === "object") {
				const extracted = getByPath(data, responsePath);
				if (extracted !== undefined) data = extracted;
			}
			data = filterOperationalTedisResult(endpoint, data);

			// MCP tasks extension linkage (io.modelcontextprotocol/tasks): tools
			// that enqueue a Home run opt in via `_emitTaskLinkage` (home-surface.ts)
			// so the result carries `task: { id: homeRunId, pollWith: "tasks/get" }`.
			// Callers that hit short client timeouts recover the outcome by polling
			// tasks/get — served org-scoped by home-task-handlers.ts.
			if (
				status < 400 &&
				(config as unknown as Record<string, unknown>)._emitTaskLinkage ===
					true &&
				ctx.clientSupportsTasks !== false &&
				isRecord(data)
			) {
				const run = data.run;
				if (isRecord(run) && typeof run.id === "string" && run.id) {
					data = { ...data, task: { id: run.id, pollWith: "tasks/get" } };
				}
			}

			// Governed OS Gadget dispatch: persist the aggregate task-routing row
			// beside the schema-valid API receipt. Tool execution emits its internal
			// marker through the native MCP Task transport; structuredContent never
			// gains a compatibility task field. Admission-only receipts remain
			// synchronous.
			if (
				status < 400 &&
				endpoint === OS_GADGET_RUN_ENDPOINT &&
				ctx.clientSupportsTasks !== false &&
				isRecord(data) &&
				orgId
			) {
				const linked = await linkOsGadgetTask({
					db: ctx.env.DB,
					appId: ctx.app?.id ?? ctx.appId,
					organizationId: orgId,
					toolId: ctx.toolId,
					requestId: ctx.requestId,
					data,
				});
				data = linked.data;
				osGadgetTask = linked.task;
			}

			return {
				data,
				status,
				...(osGadgetTask ? { osGadgetTask } : {}),
			};
		} catch (error) {
			if (error instanceof RestRouteInputError) {
				return { data: { error: error.message }, status: 400 };
			}
			if (
				(error instanceof DOMException && error.name === "AbortError") ||
				(error instanceof Error && error.message.includes("timed out"))
			) {
				return {
					data: { error: `Request timed out after ${timeout}ms` },
					status: 408,
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			return { data: { error: message }, status: 500 };
		} finally {
			clearTimeout(timer);
		}
	}

	// =========================================================================
	// External Transport — REST proxy with credential injection
	// =========================================================================

	private async executeExternal(
		input: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
		config: ToolConfig,
		endpoint: string,
	): Promise<RpcToolResult> {
		const isDev = ctx.env.ENVIRONMENT === "development";
		const timeout = config.timeout ?? 15000;

		if (!config.baseUrl) {
			return {
				data: { error: "No baseUrl configured for external transport" },
				status: 400,
			};
		}

		// Validate endpoint characters — external endpoints hit third-party APIs
		// so we restrict to safe path characters only
		const endpointTemplate = endpoint.replace(
			/\{[a-zA-Z_][\w-]*\}/g,
			"path_parameter",
		);
		if (endpoint !== "" && !SAFE_ENDPOINT_RE.test(endpointTemplate)) {
			return {
				data: { error: "Invalid endpoint path characters" },
				status: 400,
			};
		}

		// SSRF protection
		const urlError = validateExternalUrl(config.baseUrl, isDev);
		if (urlError) {
			return {
				data: { error: `Invalid external URL: ${urlError}` },
				status: 400,
			};
		}

		let delegation: Awaited<ReturnType<typeof resolveEmbeddedHostDelegation>>;
		try {
			delegation = await resolveEmbeddedHostDelegation(ctx, config);
		} catch {
			return {
				data: { error: "Embedded host delegation denied" },
				status: 403,
			};
		}

		// Build params
		const params: Record<string, unknown> = { ...config.staticParams };
		if (config.paramMap) {
			for (const [inputKey, targetKey] of Object.entries(config.paramMap)) {
				const value = input[inputKey];
				if (value !== undefined) params[targetKey] = value;
			}
		} else {
			Object.assign(params, input);
		}

		// Signed host constraints and other runtime-only inputs belong to Tedix
		// policy, not the provider's REST contract. Remove them before any path,
		// header, query, or body projection can forward them.
		for (const name of stringParamsFromConfig(config, "runtimeOnlyParams")) {
			delete params[name];
		}

		// OpenAPI uses {parameter-name}; hand-authored tools also use :paramName.
		// Consumed path params are removed from the params object so they don't appear in query string or body
		let resolvedEndpoint = endpoint;
		const pathParamRe = /\{([a-zA-Z_][\w-]*)\}|:([a-zA-Z_]\w*)/g;
		for (const m of endpoint.matchAll(pathParamRe)) {
			const paramName = (m[1] ?? m[2]) as string;
			const value = params[paramName];
			if (value !== undefined && value !== null) {
				const caseRule = config.pathParamCase?.[paramName];
				const pathValue =
					caseRule === "lower"
						? String(value).toLowerCase()
						: caseRule === "upper"
							? String(value).toUpperCase()
							: String(value);
				resolvedEndpoint = resolvedEndpoint.replace(
					m[0],
					encodeURIComponent(pathValue),
				);
				delete params[paramName];
			} else if (m[1]) {
				return {
					data: { error: `Missing REST path parameter: ${paramName}` },
					status: 400,
				};
			}
		}
		endpoint = resolvedEndpoint;

		// NOTE: Do not call enforceContextParams() here. External transport sends
		// params directly to third-party REST APIs (Neo4j, accounting APIs, etc.) which
		// may reject or misroute on unknown fields like appId/tediId.
		// Cross-scope security is handled by the auth layer (connection tokens are
		// org-scoped via callerIdentity) — same rationale as MCP transport.

		// Build headers, then let the request body encoder set Content-Type.
		const headers: Record<string, string> = {};
		let delegatedTransportToken: string | undefined;

		if (delegation) {
			const credentialResult = await this.fetchOrgConnectionToken(
				{
					...ctx,
					// The API has verified this exact source/installation/callable.
					// Carry only its bounded credential-read capability and worker
					// provenance, never the caller's broader scopes or human identity.
					callerIdentity: {
						...ctx.callerIdentity!,
						authType: "service",
						scopes: ["connections.execute"],
						userId: undefined,
						kernel: false,
					},
				},
				delegation.connectionProviderId,
				delegation.providerOrganizationId,
				"tenant",
				delegation.connectionScopes,
			);
			if (!credentialResult.token)
				return {
					data: { error: buildCredentialErrorMessage(credentialResult) },
					status: 401,
				};
			delegatedTransportToken = credentialResult.token;
		} else if (config.auth) {
			if (config.auth.type === "connection" && config.auth.connectionId) {
				// _aggregateConnectionLabel is a legacy routing hint for stored
				// aggregator metadata. New apps should use project-specific outbound
				// app IDs in auth.connectionId.
				const effectiveLabel =
					((config as unknown as Record<string, unknown>)
						._aggregateConnectionLabel as string | undefined) ??
					ctx.connectionLabel;
				const credentialResult = await this.fetchConnectionToken(
					ctx,
					config.auth.connectionId,
					config.auth.credentialScope ?? config.auth.scope,
					config.auth.scopes,
					effectiveLabel,
					config.auth.credentialPreference,
					params,
				);
				if (!credentialResult.token) {
					return {
						data: { error: buildCredentialErrorMessage(credentialResult) },
						status: 401,
						connectionRecovery: buildCredentialRecovery(credentialResult, {
							providerId: config.auth.connectionId,
							connectionInstanceId: selectedConnectionInstanceId(ctx),
							scope:
								config.auth.credentialScope ?? config.auth.scope ?? "tenant",
							scopes: config.auth.scopes,
						}),
					};
				}

				let token = credentialResult.token;

				// OAuth2 client credentials exchange: stored credential is base64(client_id:client_secret),
				// exchange it for a bearer token via the provider's token endpoint.
				if (config.auth.clientCredentials?.tokenUrl) {
					const ccCacheKey = getClientCredentialsCacheKey(
						ctx.callerIdentity?.tediId ??
							ctx.callerIdentity?.organizationId ??
							"",
						config.auth.connectionId,
						config.auth.clientCredentials.tokenUrl,
						effectiveLabel,
					);
					const result = await resolveClientCredentialsToken(
						credentialResult.token,
						config.auth.clientCredentials.tokenUrl,
						config.auth.clientCredentials.grantType ?? "client_credentials",
						ccCacheKey,
						isDev,
					);
					if (!result.token) {
						return {
							data: {
								error: result.error ?? "Client credentials exchange failed",
							},
							status: 401,
						};
					}
					token = result.token;
				}

				const headerName = config.auth.header ?? "Authorization";
				const template = config.auth.template ?? "Bearer {token}";
				const finalToken =
					config.auth.encoding === "base64" ? btoa(token) : token;
				headers[headerName] = template.replace("{token}", finalToken);
			} else if (config.auth.type === "header" && config.auth.value) {
				const headerName = config.auth.header ?? "Authorization";
				headers[headerName] = config.auth.value;
			}
		}

		// Merge static headers — support {paramName} placeholders resolved from input
		if (config.staticHeaders) {
			for (const [name, value] of Object.entries(config.staticHeaders)) {
				const resolved = value.replace(/\{(\w+)\}/g, (_, key: string) => {
					const v = params[key];
					if (v !== undefined && v !== null) {
						delete params[key]; // consume like path params
						return String(v);
					}
					return "";
				});
				if (resolved) headers[name] = resolved;
			}
		}

		const headerParams = consumeNamedParams(
			params,
			stringParamsFromConfig(config, "headerParams"),
		);
		for (const [name, value] of Object.entries(headerParams)) {
			headers[name] = String(value);
		}
		// Tedix-private x-mcp-header: config-declared custom headers (external).
		applyMcpCustomHeaders(headers, config, params);
		// A provider header is exclusively derived from verified private metadata.
		for (const name of Object.keys(headers)) {
			if (name.toLowerCase() === "x-tedix-host-delegation")
				delete headers[name];
		}
		if (delegation) {
			headers["X-Tedix-Host-Delegation"] = delegation.token;
			headers[delegation.authHeader] = delegation.authTemplate.replace(
				"{token}",
				delegatedTransportToken!,
			);
		}
		applyWorkflowExecutionHeaders(headers, ctx.callerIdentity, {
			includeTedixProvenance: false,
		});
		const explicitQueryParams = consumeNamedParams(
			params,
			stringParamsFromConfig(config, "queryParams"),
		);

		const method = config.method ?? "POST";
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);

		// Gmail RFC 5322 encoding transform — supports send, reply, reply_all, forward.
		// For reply/reply_all/forward: auto-resolves To, Subject, threadId, In-Reply-To,
		// and References by fetching the original message when params.messageId is set.
		if (config.bodyEncoding === "gmail-rfc2822") {
			const isDraft = Boolean(params.draft);
			const isHtml = Boolean(params.html);
			const inputMessageId = params.messageId ? String(params.messageId) : null;
			const authHeader = headers.Authorization ?? "";

			// Mutable reply metadata — overridden from original message lookup when messageId present
			let toAddr = String(params.to ?? "");
			let ccAddr = params.cc ? String(params.cc) : null;
			const fromAddr = params.from ? String(params.from) : null;
			let subject = String(params.subject ?? "");
			let inReplyTo: string | null = null;
			let references: string | null = null;
			let threadId = params.threadId ? String(params.threadId) : null;

			if (inputMessageId) {
				// Fetch original message metadata to auto-populate reply headers
				try {
					const metadataResp = await globalThis.fetch(
						`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(inputMessageId)}?format=metadata&metadataHeaders=From,To,Cc,Subject,Message-ID,References,Reply-To`,
						{
							headers: { Authorization: authHeader },
							signal: controller.signal,
						},
					);
					if (metadataResp.ok) {
						const msgData = (await metadataResp.json()) as {
							threadId?: string;
							payload?: { headers?: Array<{ name: string; value: string }> };
						};
						// Normalize headers to lowercase map
						const hdrs: Record<string, string> = {};
						for (const h of msgData.payload?.headers ?? []) {
							hdrs[h.name.toLowerCase()] = h.value;
						}

						// Thread ID
						if (!threadId && msgData.threadId) threadId = msgData.threadId;

						// Reply target: prefer Reply-To, fall back to From
						if (!toAddr) toAddr = hdrs["reply-to"] ?? hdrs.from ?? "";

						// Subject: add Re: prefix if not already present
						if (!subject && hdrs.subject) {
							const orig = hdrs.subject;
							subject = /^re:\s/i.test(orig) ? orig : `Re: ${orig}`;
						}

						// In-Reply-To + References chain
						const origMsgId = hdrs["message-id"] ?? "";
						if (origMsgId) {
							inReplyTo = origMsgId;
							const origRefs = hdrs.references ?? "";
							references = origRefs ? `${origRefs} ${origMsgId}` : origMsgId;
						}

						// gmail_reply_all: include original To + Cc in recipient list
						if (ctx.toolId === "gmail_reply_all") {
							const origTo = hdrs.to ?? "";
							const origCc = hdrs.cc ?? "";
							const combined = [toAddr, origTo, origCc, ccAddr]
								.filter(Boolean)
								.join(", ");
							// Deduplicate by lowercased address
							const seen = new Set<string>();
							const deduped = combined.split(/,\s*/).filter((addr) => {
								const norm = addr.trim().toLowerCase();
								if (!norm || seen.has(norm)) return false;
								seen.add(norm);
								return true;
							});
							toAddr = deduped.join(", ");
							ccAddr = null; // merged into To
						}
					}
				} catch {
					// Non-fatal: proceed with whatever caller-supplied values we have
				}
			}

			const body = String(params.body ?? "");
			const bcc = params.bcc ? String(params.bcc) : null;

			const lines: string[] = [
				...(fromAddr ? [`From: ${fromAddr}`] : []),
				`To: ${toAddr}`,
				`Subject: ${subject}`,
				`MIME-Version: 1.0`,
				`Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
			];
			if (ccAddr) lines.push(`Cc: ${ccAddr}`);
			if (bcc) lines.push(`Bcc: ${bcc}`);
			if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
			if (references) lines.push(`References: ${references}`);
			lines.push("", body);

			const raw = btoa(unescape(encodeURIComponent(lines.join("\r\n"))))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");

			let gmailUrl: string;
			let gmailBody: string;
			if (method === "PUT" && endpoint.includes("/drafts/")) {
				gmailUrl = `${config.baseUrl}/${endpoint}`;
				gmailBody = JSON.stringify({
					message: { raw, ...(threadId ? { threadId } : {}) },
				});
			} else if (isDraft) {
				gmailUrl = `${config.baseUrl}/gmail/v1/users/me/drafts`;
				gmailBody = JSON.stringify({
					message: { raw, ...(threadId ? { threadId } : {}) },
				});
			} else {
				gmailUrl = `${config.baseUrl}/gmail/v1/users/me/messages/send`;
				gmailBody = JSON.stringify({ raw, ...(threadId ? { threadId } : {}) });
			}

			const resp = await globalThis.fetch(gmailUrl, {
				method:
					method === "PUT" && endpoint.includes("/drafts/") ? "PUT" : "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: gmailBody,
				signal: controller.signal,
			});
			clearTimeout(timer);
			const respData = await resp.json().catch(() => ({}));
			const providerMessageId =
				ctx.toolId === "gmail_send" &&
				!isDraft &&
				resp.ok &&
				respData !== null &&
				typeof respData === "object" &&
				!Array.isArray(respData) &&
				typeof (respData as Record<string, unknown>).id === "string" &&
				/^[A-Za-z0-9_-]{1,128}$/.test(
					(respData as Record<string, unknown>).id as string,
				)
					? ((respData as Record<string, unknown>).id as string)
					: null;
			return {
				data: respData,
				status: resp.status,
				...(providerMessageId
					? { providerConfirmation: `gmail-message:${providerMessageId}` }
					: {}),
			};
		}

		// Gmail draft send — POSTs {id} in body alongside path param.
		// The drafts.send endpoint requires Content-Type: application/json
		// with {"id": draftId} in the body; pure path-param POST returns 404.
		if (config.bodyEncoding === "gmail-draft-send") {
			// Gmail drafts.send: POST to /gmail/v1/users/me/drafts/send with {"id": draftId} body.
			// The Discovery spec has no path param — id goes in body only.
			const draftId = String(params.id ?? "");
			if (!draftId) {
				return {
					data: { error: "Missing required parameter: id" },
					status: 400,
				};
			}
			const sendUrl = `${config.baseUrl}/gmail/v1/users/me/drafts/send`;
			const sendResp = await globalThis.fetch(sendUrl, {
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ id: draftId }),
				signal: controller.signal,
			});
			clearTimeout(timer);
			const sendStatus = sendResp.status;
			const sendContentType = sendResp.headers.get("content-type") ?? "";
			let sendData: unknown;
			if (sendContentType.includes("application/json")) {
				sendData = await sendResp.json().catch(() => ({}));
			} else {
				// Return status + raw text snippet for debugging non-JSON responses
				const text = await sendResp.text().catch(() => "");
				sendData = {
					error: `HTTP ${sendStatus}`,
					contentType: sendContentType,
					snippet: text.slice(0, 300),
				};
			}
			return { data: sendData, status: sendStatus };
		}

		try {
			let url: string;
			let fetchInit: RequestInit;

			if (method === "GET") {
				const queryString = buildQueryString(
					{
						...explicitQueryParams,
						...params,
					},
					config.queryArrayFormats,
				);
				url = `${config.baseUrl}/${endpoint}${queryString ? `?${queryString}` : ""}`;
				fetchInit = { method, headers, signal: controller.signal };
			} else {
				const requestBodyParam =
					typeof config.requestBodyParam === "string"
						? config.requestBodyParam
						: null;
				if (config.requestBodyTemplate !== undefined) {
					if (!requestBodyParam) {
						throw new ExternalRequestInputError(
							"requestBodyTemplate requires requestBodyParam",
						);
					}
					if (params[requestBodyParam] !== undefined) {
						throw new ExternalRequestInputError(
							`Input must not override fixed request body: ${requestBodyParam}`,
						);
					}
					params[requestBodyParam] = expandExternalBodyTemplate(
						config.requestBodyTemplate,
						params,
					);
					for (const name of config.requestBodyTemplateParams ?? []) {
						delete params[name];
					}
				}
				const bodyParams =
					requestBodyParam && Object.hasOwn(params, requestBodyParam)
						? params[requestBodyParam]
						: params;
				if (requestBodyParam) {
					delete params[requestBodyParam];
				}
				const queryString = buildQueryString(
					{
						...explicitQueryParams,
						...(requestBodyParam ? params : {}),
					},
					config.queryArrayFormats,
				);
				url = `${config.baseUrl}/${endpoint}${queryString ? `?${queryString}` : ""}`;
				const requestContentType =
					config.requestContentType ?? "application/json";
				let body: BodyInit;
				if (requestContentType === "multipart/form-data") {
					body = buildMultipartBody(
						isPlainRecord(bodyParams) ? bodyParams : params,
						fileParamsFromConfig(config),
					);
				} else if (requestContentType === "application/x-www-form-urlencoded") {
					body = buildUrlEncodedBody(
						isPlainRecord(bodyParams) ? bodyParams : params,
					);
					setHeaderIfMissing(
						headers,
						"Content-Type",
						"application/x-www-form-urlencoded",
					);
				} else if (
					requestContentType === "text/markdown" ||
					requestContentType === "text/plain"
				) {
					body = textExternalRequestBody(bodyParams);
					setHeaderIfMissing(headers, "Content-Type", requestContentType);
				} else {
					body = JSON.stringify(bodyParams);
					setHeaderIfMissing(headers, "Content-Type", requestContentType);
				}
				fetchInit = {
					method,
					headers,
					body,
					signal: controller.signal,
				};
			}

			if (isDev) {
				console.log(`[external-handler] ${method} ${url}`);
			}

			// Retry transient upstream-unreachable failures: gateway/connection
			// codes where the request did not reach the origin (502/504 + the
			// Cloudflare tunnel family 520-524). Common when an external origin
			// sits behind a flaky tunnel. Safe to replay because the origin never
			// processed the request; 4xx and 500 are not retried (they won't
			// recover / may have taken effect).
			const RETRYABLE_UPSTREAM = new Set([502, 504, 520, 521, 522, 523, 524]);
			let response = await globalThis.fetch(url, {
				...fetchInit,
				redirect: "manual",
			});
			for (
				let attempt = 0;
				attempt < 2 && RETRYABLE_UPSTREAM.has(response.status);
				attempt++
			) {
				if (isDev) {
					console.log(
						`[external-handler] ${url} → ${response.status}, retry ${attempt + 1}/2`,
					);
				}
				await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
				response = await globalThis.fetch(url, {
					...fetchInit,
					redirect: "manual",
				});
			}
			const status = response.status;

			// Block redirects — prevents SSRF via open redirect
			if (status >= 300 && status < 400) {
				const location = response.headers.get("Location");
				if (location) {
					const redirectError = validateUrl(location, { allowHttp: isDev });
					if (redirectError) {
						return {
							data: {
								error: `Redirect blocked by SSRF protection: ${redirectError}`,
							},
							status: 403,
						};
					}
				}
				return {
					data: {
						error: `External API returned redirect (${status}) — not followed for security`,
					},
					status: 403,
				};
			}

			if (isDev) {
				console.log(`[external-handler] ${url} → ${status}`);
			}

			let data = await parseExternalResponse(response, config);
			if (delegation) data = redactDelegationResponse(data, delegation.token);

			if (isDev && status >= 400) {
				console.log(`[external-handler] Error response from ${url}:`, data);
			}

			// Extract via responsePath
			if (config.responsePath && data != null && typeof data === "object") {
				data = getByPath(data, config.responsePath) ?? data;
			}
			if (status < 400) {
				data = attachExternalSourceProvenance(data, url, ctx, config);
			}

			return { data, status };
		} catch (error) {
			if (error instanceof ExternalRequestInputError) {
				return { data: { error: error.message }, status: 400 };
			}
			if (error instanceof DOMException && error.name === "AbortError") {
				return {
					data: { error: `External request timed out after ${timeout}ms` },
					status: 408,
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			return {
				data: {
					error: delegation
						? redactDelegationResponse(message, delegation.token)
						: message,
				},
				status: 502,
			};
		} finally {
			clearTimeout(timer);
		}
	}

	// =========================================================================
	// MCP Transport — direct stateless call to upstream MCP server
	// =========================================================================

	private resolveServiceBinding(
		mcpServerUrl: string,
		env: CloudflareEnv,
	): Fetcher | null {
		try {
			const host = new URL(mcpServerUrl).hostname;
			if (getTedixManagedTediHost(mcpServerUrl) && env.TEDI_SERVICE) {
				return env.TEDI_SERVICE;
			}
			if (host === "builder.tedix.dev" && env.CMS) {
				return env.CMS;
			}
			if (
				["docs-admin.tedix.dev", "docs-admin.tedix.tech"].includes(host) &&
				env.DOCS
			) {
				return env.DOCS;
			}
		} catch {
			/* invalid URL */
		}
		return null;
	}

	private async executeMcp(
		input: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
		config: ToolConfig,
	): Promise<RpcToolResult> {
		if (!config.mcpServerUrl || !config.mcpToolName) {
			return {
				data: {
					error: "mcpServerUrl and mcpToolName are required for MCP transport",
				},
				status: 400,
			};
		}
		const mcpToolName = config.mcpToolName;

		const isDev = ctx.env.ENVIRONMENT === "development";
		const timeout = config.timeout ?? 30000;

		// _forwardedQueryParams: inherited from app metadata during materialized
		// tool aggregation. Tenant-scoped apps (e.g. a per-tenant CMS app) append
		// these params to mcpServerUrl so the upstream sees ?org=<tenant> on every
		// request even when the caller's JWT carries a different orgSlug claim.
		let mcpServerUrl = config.mcpServerUrl;
		const forwardedQueryParams = (config as unknown as Record<string, unknown>)
			._forwardedQueryParams as Record<string, string> | undefined;
		if (forwardedQueryParams && Object.keys(forwardedQueryParams).length > 0) {
			try {
				const url = new URL(mcpServerUrl);
				for (const [key, value] of Object.entries(forwardedQueryParams)) {
					if (typeof value === "string") {
						url.searchParams.set(key, value);
					}
				}
				mcpServerUrl = url.toString();
			} catch {
				/* invalid base URL — fall through with original */
			}
		}

		// Service binding: use internal Worker-to-Worker RPC for known internal MCP servers
		const serviceBinding = this.resolveServiceBinding(mcpServerUrl, ctx.env);
		const fetcher: typeof globalThis.fetch = serviceBinding
			? serviceBinding.fetch.bind(serviceBinding)
			: globalThis.fetch.bind(globalThis);
		const managedMcpUrl = isTedixManagedMcpUrl(mcpServerUrl);

		if (!serviceBinding) {
			// SSRF protection — service bindings are trusted Worker-to-Worker RPC
			// and never touch the network. Managed `*.mcp.tedix.dev`-style origins
			// are same-org config, so the internal-host blocklist is relaxed for
			// them (allowInternalHosts), but private-IP/localhost targets and http
			// downgrades stay blocked for these credentialed calls outside dev.
			const urlError = validateUrl(mcpServerUrl, {
				allowHttp: isDev,
				allowInternalHosts: isDev || managedMcpUrl,
			});
			if (urlError) {
				return {
					data: { error: `Invalid MCP server URL: ${urlError}` },
					status: 400,
				};
			}
		}

		// Build params (same paramMap logic as other transports)
		let params: Record<string, unknown> = { ...config.staticParams };
		if (config.paramMap) {
			for (const [inputKey, targetKey] of Object.entries(config.paramMap)) {
				const value = input[inputKey];
				if (value !== undefined) params[targetKey] = value;
			}
		} else {
			Object.assign(params, input);
		}

		// NOTE: Do not call enforceContextParams() here. MCP transport proxies
		// params directly to external MCP servers (Tavily, Firecrawl, etc.) which
		// reject unknown fields like appId/tediId via strict schema validation.
		// Cross-scope security is handled by the auth layer (connection tokens are
		// org-scoped) — the upstream server never sees our internal identifiers.
		const aggregateTediRemoteName = (
			config as unknown as Record<string, unknown>
		)._aggregateTediRemoteName;
		if (typeof aggregateTediRemoteName === "string") {
			// Dynamic import for the same reason as index.ts: the
			// aggregate-tedis tree builds ~130 Zod→JSON schemas at module
			// scope and must stay off the Worker startup path.
			const { buildTediCodeInvocation } = await import("./aggregate-tedis");
			params = {
				code: buildTediCodeInvocation(aggregateTediRemoteName, params),
			};
		}

		// Build headers — resolve auth from Descope Token Vault if configured
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const managedTediHost = getTedixManagedTediHost(mcpServerUrl);
		const usesInternalTediServiceBinding = Boolean(
			serviceBinding && managedTediHost,
		);
		const usesModernOnlyDocsServiceBinding = Boolean(
			serviceBinding && serviceBinding === ctx.env.DOCS,
		);
		if (serviceBinding && managedTediHost) {
			headers["X-Tedix-Host"] = managedTediHost;
			headers["X-Service-Binding"] = "true";
			const aggregateRemoteName = (config as unknown as Record<string, unknown>)
				._aggregateTediRemoteName;
			const namespacedRemoteName = ctx.toolId.includes("__")
				? ctx.toolId.slice(ctx.toolId.indexOf("__") + 2)
				: ctx.toolId.includes(":")
					? ctx.toolId.slice(ctx.toolId.lastIndexOf(":") + 1)
					: ctx.toolId.includes(".")
						? ctx.toolId.slice(ctx.toolId.lastIndexOf(".") + 1)
						: null;
			const delegatedToolName =
				typeof aggregateRemoteName === "string"
					? aggregateRemoteName
					: namespacedRemoteName
						? namespacedRemoteName
						: typeof config.mcpToolName === "string"
							? config.mcpToolName
							: ctx.toolId;
			headers["X-Tedix-Tedi-Scopes"] =
				requiredTediMcpToolScope(delegatedToolName);
			headers["X-Tedix-Mcp-Delegated-Tool"] = delegatedToolName;
			// Operator-consent attestation. When this tedi
			// dispatch originates from a skill-workflow run that a human operator
			// started (run row createdBy "user:<descopeUserId>", carried on the
			// authenticated skill-runtime -> mcp hop), attach a gateway-attested
			// consent envelope on this internal service-binding hop — as a header
			// and as params._meta below. Tenant workflow code cannot author
			// either: the bridge builds its headers from host-side props, and this
			// block only fires on the trusted binding. The tedi runtime decides
			// what the attestation authorizes; the gateway only vouches for who
			// started the run. Prompt text claiming consent stays worthless.
			const consent = buildOperatorConsentHeader(ctx.callerIdentity);
			if (consent) {
				headers["X-Tedix-Operator-Consent"] = consent;
				console.log(
					`[MCP] operator-consent attached: run=${ctx.callerIdentity?.skillRunId} createdBy=${ctx.callerIdentity?.skillRunCreatedBy} tedi=${managedTediHost}`,
				);
			}
			const aggregateTediOrgId = (config as unknown as Record<string, unknown>)
				._aggregateTediOrgId;
			const orgId =
				typeof aggregateTediOrgId === "string"
					? aggregateTediOrgId
					: (ctx.app.organizationId ?? ctx.callerIdentity?.organizationId);
			if (orgId) {
				headers["X-Tedix-Org-Id"] = orgId;
			}
		}

		// Forward connection label as a routing hint to upstream MCP servers
		// (independent of auth path). Used by multi-tenant upstreams like
		// builder.tedix.dev/mcp to dispatch to the right org's isolate. Comes
		// either from this tool's _aggregateConnectionLabel (set by
		// aggregateAndPrefixTools when the tool was loaded from a materialized
		// tenant/project app) or from the inbound request's own header.
		const forwardLabel =
			((config as unknown as Record<string, unknown>)
				._aggregateConnectionLabel as string | undefined) ??
			ctx.connectionLabel;
		if (forwardLabel) {
			headers["X-Tedix-Connection-Label"] = forwardLabel;
		}

		// Managed MCP auth is only needed for remote managed MCP endpoints. Tedix
		// tedi MCP calls routed through TEDI_SERVICE are authenticated by the
		// service-binding headers above, so they do not require per-tedi AIH
		// registration or an mcpCredentials lookup.
		if (managedMcpUrl && !usesInternalTediServiceBinding) {
			const aggregateTediId = (config as unknown as Record<string, unknown>)
				._aggregateTediId;
			const aggregateTediOrgId = (config as unknown as Record<string, unknown>)
				._aggregateTediOrgId;
			Object.assign(
				headers,
				await resolveManagedMcpAuthHeaders({
					serverUrl: mcpServerUrl,
					env: ctx.env,
					tediId:
						typeof aggregateTediId === "string"
							? aggregateTediId
							: (ctx.callerIdentity?.tediId ?? null),
					orgId:
						typeof aggregateTediOrgId === "string"
							? aggregateTediOrgId
							: (ctx.app.organizationId ??
								ctx.callerIdentity?.organizationId ??
								null),
				}),
			);
		} else if (serviceBinding && ctx.env.PLATFORM_SERVICE_TOKEN) {
			headers.Authorization = `Bearer ${ctx.env.PLATFORM_SERVICE_TOKEN}`;
			if (
				serviceBinding === ctx.env.CMS &&
				(ctx.callerIdentity?.scopes?.includes("mcp:content.admin") ||
					(ctx.callerIdentity?.scopes?.includes("mcp:content.write") &&
						ctx.callerIdentity?.scopes?.includes("mcp:settings.admin")))
			) {
				// CMS trusts this edge-resolved capability only on its
				// PLATFORM_SERVICE_TOKEN path, after tenant routing is authorized.
				headers["X-Tedix-Cms-Maintenance-Authorized"] = "true";
			}
			if (serviceBinding === ctx.env.DOCS) {
				const delegatedScope = delegatedDocsScope(config.mcpToolName);
				if (delegatedScope) {
					headers["X-Tedix-Delegated-Scope"] = delegatedScope;
				}
			}
			// Forward the user's original JWT so the upstream service can proxy
			// authenticated calls to third-party services (e.g., CMS User Workers).
			if (
				ctx.bearerToken &&
				(ctx.callerIdentity?.authType === "oauth" ||
					ctx.callerIdentity?.authType === "user" ||
					ctx.callerIdentity?.authType === "external_agent")
			) {
				headers["X-Forwarded-Authorization"] = `Bearer ${ctx.bearerToken}`;
			}
			if (ctx.callerIdentity) {
				const actor = normalizeCallerIdentity(ctx.callerIdentity);
				headers["X-Tedix-Actor-Type"] = actor.actorType;
				headers["X-Tedix-Actor-Id"] = actor.actorId;
				if (
					serviceBinding === ctx.env.CMS &&
					ctx.callerIdentity.authType === "tedi" &&
					ctx.callerIdentity.tediId &&
					actor.actorType === "tedi" &&
					actor.actorId === ctx.callerIdentity.tediId
				) {
					// Carry the edge-resolved capability profile, as on MCP→API.
					// CMS reads these only after verifying PLATFORM_SERVICE_TOKEN.
					headers["X-Tedix-Tedi-Id"] = ctx.callerIdentity.tediId;
					headers["X-Tedix-Tedi-Scopes"] = (
						ctx.callerIdentity.scopes ?? []
					).join(" ");
				}
				if (actor.externalAgentSessionId) {
					headers["X-Tedix-Agent-Session-Id"] = actor.externalAgentSessionId;
				}
			}
			// First-party services authenticate this hop with the platform token, so a
			// tenant provider credential cannot replace Authorization. Docs may still
			// need the caller tenant's governed Git credential for a private checkout.
			// Resolve it at the gateway and forward it on a dedicated internal header;
			// it never enters MCP arguments, Workflow state, D1, or build metadata.
			if (
				serviceBinding === ctx.env.DOCS &&
				config.auth?.type === "connection" &&
				config.auth.connectionId
			) {
				const effectiveLabel =
					((config as unknown as Record<string, unknown>)
						._aggregateConnectionLabel as string | undefined) ??
					ctx.connectionLabel;
				const credentialResult = await this.fetchConnectionToken(
					ctx,
					config.auth.connectionId,
					config.auth.credentialScope ?? config.auth.scope,
					config.auth.scopes,
					effectiveLabel,
					config.auth.credentialPreference,
					params,
				);
				if (!credentialResult.token) {
					return {
						data: { error: buildCredentialErrorMessage(credentialResult) },
						status: 401,
						connectionRecovery: buildCredentialRecovery(credentialResult, {
							providerId: config.auth.connectionId,
							connectionInstanceId: selectedConnectionInstanceId(ctx),
							scope:
								config.auth.credentialScope ?? config.auth.scope ?? "tenant",
							scopes: config.auth.scopes,
						}),
					};
				}
				const finalToken =
					config.auth.encoding === "base64"
						? btoa(credentialResult.token)
						: credentialResult.token;
				const template = config.auth.template ?? "Bearer {token}";
				headers["X-Tedix-Provider-Authorization"] = template.replace(
					"{token}",
					finalToken,
				);
			}
		} else if (config.auth) {
			if (config.auth.type === "connection" && config.auth.connectionId) {
				// _aggregateConnectionLabel: set by aggregateAndPrefixTools() for org-wide aggregation.
				const effectiveLabel =
					((config as unknown as Record<string, unknown>)
						._aggregateConnectionLabel as string | undefined) ??
					ctx.connectionLabel;
				const credentialResult = await this.fetchConnectionToken(
					ctx,
					config.auth.connectionId,
					config.auth.credentialScope ?? config.auth.scope,
					config.auth.scopes,
					effectiveLabel,
					config.auth.credentialPreference,
					params,
				);
				if (!credentialResult.token) {
					return {
						data: { error: buildCredentialErrorMessage(credentialResult) },
						status: 401,
						connectionRecovery: buildCredentialRecovery(credentialResult, {
							providerId: config.auth.connectionId,
							connectionInstanceId: selectedConnectionInstanceId(ctx),
							scope:
								config.auth.credentialScope ?? config.auth.scope ?? "tenant",
							scopes: config.auth.scopes,
						}),
					};
				}

				let token = credentialResult.token;

				if (config.auth.clientCredentials?.tokenUrl) {
					const ccCacheKey = getClientCredentialsCacheKey(
						ctx.callerIdentity?.tediId ??
							ctx.callerIdentity?.organizationId ??
							"",
						config.auth.connectionId,
						config.auth.clientCredentials.tokenUrl,
						effectiveLabel,
					);
					const result = await resolveClientCredentialsToken(
						credentialResult.token,
						config.auth.clientCredentials.tokenUrl,
						config.auth.clientCredentials.grantType ?? "client_credentials",
						ccCacheKey,
						isDev,
					);
					if (!result.token) {
						return {
							data: {
								error: result.error ?? "Client credentials exchange failed",
							},
							status: 401,
						};
					}
					token = result.token;
				}

				const headerName = config.auth.header ?? "Authorization";
				const template = config.auth.template ?? "Bearer {token}";
				const finalToken =
					config.auth.encoding === "base64" ? btoa(token) : token;
				headers[headerName] = template.replace("{token}", finalToken);
			} else if (config.auth.type === "header" && config.auth.value) {
				const headerName = config.auth.header ?? "Authorization";
				headers[headerName] = config.auth.value;
			}
		}

		if (serviceBinding && managedTediHost) {
			headers["X-Tedix-Host"] = managedTediHost;
			headers["X-Service-Binding"] = "true";
			const orgId =
				ctx.app.organizationId ?? ctx.callerIdentity?.organizationId;
			if (orgId) {
				headers["X-Tedix-Org-Id"] = orgId;
			}
		}

		if (ctx.traceId) {
			headers["X-Trace-Id"] = ctx.traceId;
		}
		// W3C/SEP-414 trace propagation: one trace context for this outbound hop,
		// shared by the HTTP headers (HTTP transport) and request `_meta` (SEP-414,
		// for MCP servers that read trace context from `params._meta`).
		const outboundTrace = outboundTraceMeta(ctx.traceId, ctx.tracestate);
		const outboundTraceparent = outboundTrace.traceparent;
		if (outboundTraceparent) {
			headers.traceparent = outboundTraceparent;
		}
		if (outboundTrace.tracestate) {
			headers.tracestate = outboundTrace.tracestate;
		}
		// Tedix-private x-mcp-header: config-declared custom headers (upstream mcp).
		applyMcpCustomHeaders(headers, config, params);
		applyWorkflowExecutionHeaders(headers, ctx.callerIdentity, {
			includeTedixProvenance: Boolean(serviceBinding || managedMcpUrl),
		});

		if (isDev) {
			console.log(
				`[mcp-handler] Proxying to ${mcpServerUrl} tool=${mcpToolName}`,
			);
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);

		try {
			// Durable turns acknowledge through the existing inject hook before the
			// gateway deadline. Native Tasks polls top-level calls; nested Code Mode
			// calls receive the stable pending receipt without holding the gateway.
			if (usesInternalTediServiceBinding && mcpToolName === "run_tedi_turn") {
				const injectUrl = new URL(mcpServerUrl);
				injectUrl.pathname = "/hooks/inject";
				injectUrl.search = "";
				const explicitClientRequestId =
					typeof params.client_request_id === "string"
						? params.client_request_id.trim()
						: "";
				const injectResponse = await fetcher(injectUrl.toString(), {
					method: "POST",
					headers,
					body: JSON.stringify({
						...params,
						...(ctx.traceId ? { trace_id: ctx.traceId } : {}),
						async: true,
						client_request_id:
							explicitClientRequestId || ctx.executionId || ctx.requestId,
					}),
					signal: controller.signal,
				});
				const bodyText = await injectResponse.text();
				let data: unknown;
				try {
					data = JSON.parse(bodyText);
				} catch {
					return {
						data: {
							error: `Invalid response from tedi inject hook: ${bodyText.slice(0, 500)}`,
						},
						status: injectResponse.ok ? 502 : injectResponse.status,
					};
				}
				if (!injectResponse.ok) {
					return { data, status: injectResponse.status };
				}
				const normalizedData =
					injectResponse.status === 202 &&
					isRecord(data) &&
					data.accepted === true
						? { ...data, ok: true, pending: true, assistant: null }
						: data;
				return {
					data: namespaceAggregateTediTaskLinkage(normalizedData, config),
					status: 200,
				};
			}

			// Detect legacy SSE transport (URL path ends with /sse)
			const isLegacySse = (() => {
				try {
					return new URL(mcpServerUrl).pathname.endsWith("/sse");
				} catch {
					return false;
				}
			})();
			if (isLegacySse) {
				return {
					data: {
						error:
							"Unsupported MCP transport: Tedix requires sessionless MCP 2026-07-28 Streamable HTTP",
					},
					status: 400,
				};
			}

			// The SDK v2 client negotiates the era (2026-07-28 sessionless, else
			// the November 2025 initialize/session flow) and owns the wire;
			// see ./upstream-mcp-client. Loaded on first proxied call so the
			// client stays off the Worker startup path.
			const { callUpstreamMcpTool } = await import("./upstream-mcp-client");
			const upstream = await callUpstreamMcpTool({
				url: mcpServerUrl,
				fetcher,
				headers,
				toolName: mcpToolName,
				args: params,
				toolInputSchema: ctx.toolInputSchema,
				modernMeta: {
					...(outboundTraceparent ? outboundTrace : {}),
					...(managedTediHost
						? Object.fromEntries(
								[
									TEDIX_KERNEL_RUN_META_KEY,
									TEDIX_WORK_ITEM_META_KEY,
									TEDIX_TRACE_BUNDLE_META_KEY,
								].flatMap((key) => {
									const value = metaString(ctx.requestMeta, key);
									return value ? [[key, value.slice(0, 512)]] : [];
								}),
							)
						: {}),
				},
				legacyMeta: outboundTraceparent ? outboundTrace : undefined,
				// TEDI_SERVICE is a first-party binding to the one certified tedi
				// runtime, whose MCP edge is always deployed with the current modern
				// protocol. Docs is likewise a first-party modern-only MCP service:
				// its entrypoint rejects initialize before auth dispatch.
				modernOnly:
					usesInternalTediServiceBinding || usesModernOnlyDocsServiceBinding,
				signal: controller.signal,
				timeoutMs: timeout,
			});
			if (!upstream.ok) {
				return { data: { error: upstream.error }, status: upstream.status };
			}
			const upstreamProtocol = upstream.era;
			const rpcResult = { result: upstream.result as UpstreamCallToolResult };

			// This is compatibility-removal evidence, so record only calls whose
			// transport and JSON-RPC layers both succeeded. Negotiation probes and
			// upstream tool errors must not look like active successful consumers.
			const sourceAppSlug = (ctx.config as unknown as Record<string, unknown>)
				._sourceAppSlug;
			emitUpstreamProtocolMetric(ctx.env, {
				protocolEra: upstreamProtocol,
				appSlug:
					typeof sourceAppSlug === "string" ? sourceAppSlug : ctx.app.slug,
				toolName: mcpToolName,
				boundary:
					usesInternalTediServiceBinding || managedMcpUrl
						? "first_party"
						: "external",
				callerClass: classifyUpstreamProtocolCaller(ctx.callerIdentity),
			});

			// An input_required result the edge could not fulfil agent-in-the-loop
			// (e.g. a sampling request that needs a model, or a booleans-only
			// confirm the filler fails closed on) surfaces as 428 so a capable
			// caller can still resolve it. Nothing executed upstream.
			const inputRequired = readInputRequiredResult(rpcResult.result);
			if (inputRequired) {
				return {
					data: {
						error: `Upstream tool "${mcpToolName}" requires caller-provided input before it will execute (resultType "input_required"); the call was NOT executed. Retry echoing inputResponses + requestState to resolve it.`,
						resultType: MCP_RESULT_TYPE_INPUT_REQUIRED,
						...(inputRequired.inputRequests
							? { inputRequests: inputRequired.inputRequests }
							: {}),
						...(inputRequired.requestState
							? { requestState: inputRequired.requestState }
							: {}),
					},
					status: 428,
				};
			}
			// Transform MCP content array to our result format
			const content = Array.isArray(rpcResult.result?.content)
				? rpcResult.result.content
				: [];
			const textParts = content
				.filter((c) => c.type === "text")
				.map((c) => c.text);
			const textContent = textParts.join("\n");

			if (rpcResult.result?.isError) {
				return {
					data: { error: textContent || "Remote MCP tool returned an error" },
					status: 500,
				};
			}

			// Normalize the upstream CallToolResult through the shared host/client
			// boundary. Preserve the proxy's explanatory-text envelope for plain
			// prose while allowing canonical JSON spread across text blocks.
			const resultRecord = rpcResult.result as
				| Record<string, unknown>
				| undefined;
			const hasStructuredContent = resultRecord?.structuredContent != null;
			const normalizedResult = unwrapCallToolResult(
				rpcResult.result,
				mcpToolName,
			);

			let data: unknown;
			if (hasStructuredContent) {
				// Upstream structuredContent is the schema-validated tool payload.
				// Keep explanatory text in MCP content, not mixed into the JSON object.
				data = normalizedResult;
			} else if (
				textParts.length > 0 &&
				content.every((part) => part.type === "text") &&
				typeof normalizedResult !== "string"
			) {
				data = normalizedResult;
			} else {
				data = { content, text: textContent };
			}

			// Extract via responsePath if configured
			if (config.responsePath && data != null && typeof data === "object") {
				data = getByPath(data, config.responsePath) ?? data;
			}

			// Optional response-side redaction. config.responseRedact is a list of
			// dotted/bracketed paths into the response object whose string values
			// are replaced with "<redacted>". Supports `[*]` wildcard for arrays.
			// Used to scrub credential leaks from upstream MCP responses (e.g.
			// firecrawl_browser_list returning tokenized session URLs even for
			// destroyed sessions).
			const redactPaths = (config as unknown as Record<string, unknown>)
				.responseRedact;
			if (
				Array.isArray(redactPaths) &&
				data != null &&
				typeof data === "object"
			) {
				for (const path of redactPaths) {
					if (typeof path === "string") {
						redactByPath(data as Record<string, unknown>, path);
					}
				}
			}

			// Aggregate tedi tools (e.g. `cto.run_tedi_turn`) emit a tedi-run task
			// linkage (`task: { id: runId, pollWith: "tasks/get" }`). A bare tedi-run
			// id is indistinguishable from a kernel run at the aggregate, so namespace
			// it with the owning tedi (`tedi:<tediId>:<runId>`) — the aggregate's
			// tasks/get then routes it to the per-tedi run projection.
			data = namespaceAggregateTediTaskLinkage(data, config);

			const meta = (rpcResult.result as Record<string, unknown> | undefined)
				?._meta as Record<string, unknown> | undefined;
			const usage = meta?.usage as { totalTokens?: number } | undefined;
			const readObservation = await verifiedDocsReadObservation({
				serviceBinding,
				docsBinding: ctx.env.DOCS,
				toolName: mcpToolName,
				requestedSiteId: params.siteId,
				// Match Docs auth routing: header first, then the server-configured
				// URL tenant. The enclosing app may be an aggregate; the exact docs
				// binding (not an app alias) attests the provider identity.
				expectedOrganizationSlug:
					forwardLabel ??
					new URL(mcpServerUrl).searchParams.get("org") ??
					undefined,
				result: resultRecord,
				data,
			});
			return {
				data,
				status: 200,
				tokensUsed: usage?.totalTokens,
				...(readObservation ? { readObservation } : {}),
			};
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") {
				return {
					data: { error: `Upstream MCP server timed out after ${timeout}ms` },
					status: 408,
				};
			}
			const message = error instanceof Error ? error.message : String(error);
			return { data: { error: `MCP proxy failed: ${message}` }, status: 502 };
		} finally {
			clearTimeout(timer);
		}
	}

	// =========================================================================
	// Code Transport — execute stored JS in a Dynamic Worker sandbox
	// =========================================================================

	private async executeCode(
		input: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
		config: ToolConfig,
	): Promise<RpcToolResult> {
		if (!config.codeModule) {
			return {
				data: { error: "codeModule is required for code transport" },
				status: 400,
			};
		}

		if (!isCodeModeAvailable(ctx.env as unknown as Record<string, unknown>)) {
			return {
				data: {
					error: "Code transport requires LOADER binding (Dynamic Workers)",
				},
				status: 501,
			};
		}

		const { DynamicWorkerExecutor } = await import("@cloudflare/codemode");
		// Loader binding is a WorkerLoader (internal codemode type, not exported)
		const loader = ctx.env.LOADER as any;
		const timeout = config.timeout ?? 30_000;

		const executor = new DynamicWorkerExecutor({
			loader: withModelAuthoredCodeIsolation(loader),
			timeout,
			globalOutbound: null, // Network-isolated sandbox
		});
		const startTime = Date.now();

		// Wrap stored code to receive `args` and return a result
		const wrappedCode = `
const args = ${JSON.stringify(input)};
const __mod = (() => {
	${config.codeModule}
})();
const __fn = typeof __mod === "function" ? __mod
	: __mod && typeof __mod.default === "function" ? __mod.default
	: null;
return __fn ? await __fn(args) : __mod;
`;

		try {
			// Empty providers — code transport tools run standalone JS, not Code Mode with tool namespaces
			const result = await executor.execute(wrappedCode, []);

			// Emit structured log for Tail Worker
			console.log(
				JSON.stringify({
					_cm: "exec",
					appId: ctx.appId,
					appSlug: ctx.app.slug,
					orgId: ctx.app.organizationId ?? "",
					organizationId: ctx.app.organizationId ?? "",
					userId: ctx.callerIdentity?.userId ?? "",
					tediId: ctx.callerIdentity?.tediId ?? "",
					authType: ctx.callerIdentity?.authType ?? "anonymous",
					executionId: ctx.executionId ?? ctx.requestId,
					traceId: ctx.traceId ?? ctx.requestId,
					toolCount: 0, // code transport doesn't use providers
					namespaceCount: 0,
					totalDurationMs: Date.now() - startTime,
					codeLength: config.codeModule.length,
					success: !result.error,
					transport: "code",
					toolId: ctx.toolId,
					...(result.error && { error: String(result.error).slice(0, 200) }),
				}),
			);

			if (result.error) {
				return {
					data: {
						error: `Code execution failed: ${String(result.error).slice(0, 500)}`,
					},
					status: 500,
				};
			}

			let data: unknown = result.result;

			// Extract via responsePath if configured
			if (config.responsePath && data != null && typeof data === "object") {
				data = getByPath(data, config.responsePath) ?? data;
			}

			return { data, status: 200 };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.log(
				JSON.stringify({
					_cm: "exec",
					appId: ctx.appId,
					appSlug: ctx.app.slug,
					orgId: ctx.app.organizationId ?? "",
					organizationId: ctx.app.organizationId ?? "",
					userId: ctx.callerIdentity?.userId ?? "",
					tediId: ctx.callerIdentity?.tediId ?? "",
					authType: ctx.callerIdentity?.authType ?? "anonymous",
					executionId: ctx.executionId ?? ctx.requestId,
					traceId: ctx.traceId ?? ctx.requestId,
					toolCount: 0,
					namespaceCount: 0,
					totalDurationMs: Date.now() - startTime,
					codeLength: config.codeModule.length,
					success: false,
					transport: "code",
					toolId: ctx.toolId,
					error: message.slice(0, 200),
				}),
			);
			return {
				data: { error: `Code transport failed: ${message}` },
				status: 500,
			};
		}
	}

	// =========================================================================
	// Security Guard — enforce appId / tediId context params
	// =========================================================================

	/**
	 * Enforce appId and tediId on the outgoing params object.
	 *
	 * For both values the logic is:
	 * - If the tool config opts in via `allowExplicit*` and the caller already
	 *   supplied the field, leave it alone (API layer enforces org-scoped authz).
	 * - Otherwise, overwrite with the authenticated context value, logging a
	 *   warning when the caller tried to send a different value.
	 *
	 * `label` is the configured endpoint template (also used in warning
	 * messages): schemaAccepts() reads it to keep injecting fields the route
	 * spends as path placeholders.
	 */
	/**
	 * Does this tool's input schema actually accept `field`?
	 *
	 * A tool whose schema sets `additionalProperties: false` and does not
	 * declare the field will have the whole call rejected downstream when we
	 * inject it — the oRPC contract validates strictly. Injecting is also
	 * pointless there: a procedure that does not declare the field cannot read
	 * it, so the defence-in-depth value is nil while the breakage is total.
	 *
	 * Many destructive tools declare a strict schema. Every one would be
	 * unreachable by an agent, because the confirmed-destructive path
	 * requires a `reason`, and supplying it drove this injection into a strict
	 * contract that answered "Unrecognized key: appId" — an error naming a key
	 * the caller never sent. This is the same reasoning already applied to
	 * external and MCP transports above, which deliberately skip enforcement
	 * because upstreams "may reject or misroute on unknown fields".
	 *
	 * Laxness is not acceptance. This guard runs only on the internal
	 * rest/rpc transports, whose target is our own oRPC/zod router: a
	 * non-strict zod object strips undeclared keys (the injection is inert)
	 * and a strict one rejects the whole call on the unknown key. The stored
	 * D1 schema can also lag a contract that turned strict: gateway rows still
	 * advertising the lax pre-strict schema would make every call die on
	 * "Unrecognized key: appId" — a key the caller never sent and the
	 * advertised schema never showed. So a
	 * schema that declares a property map accepts only declared fields;
	 * explicit passthrough (`additionalProperties: true` or a catchall
	 * schema) and schemas with no property map at all keep the permissive
	 * read. A field the endpoint consumes as a path placeholder is always
	 * accepted: it is spent on the route and never reaches the body.
	 */
	private schemaAccepts(
		schema: Record<string, unknown> | undefined,
		field: string,
		endpoint?: string,
	): boolean {
		if (endpoint && endpointConsumesPathParam(endpoint, field)) return true;
		if (!schema) return true;
		const properties = schema.properties;
		const hasPropertyMap = isRecord(properties);
		if (hasPropertyMap && Object.hasOwn(properties, field)) return true;
		const additional = schema.additionalProperties;
		if (additional === true || isRecord(additional)) return true;
		if (additional === false) return false;
		// additionalProperties unspecified: only a schema without a property map
		// keeps the legacy permissive read (hand-authored free-form rows).
		return !hasPropertyMap;
	}

	private enforceContextParams(
		params: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
		config: ToolConfig,
		label: string,
		toolInputSchema?: Record<string, unknown>,
	): void {
		if (ctx.appId && this.schemaAccepts(toolInputSchema, "appId", label)) {
			if (config.allowExplicitAppId && params.appId) {
				// Allow explicit appId — API layer handles org-scoped authorization
			} else if (config.allowExplicitAppId && !params.appId) {
				// Tool expects an explicit appId but caller didn't provide one.
				// Do not inject ctx.appId — that would silently target the calling
				// app itself (e.g. delete_app without appId would self-destruct).
				// Leave params.appId undefined so the API layer rejects the request.
			} else {
				// _sourceAppId: set by aggregateAndPrefixTools() — routes RPC calls to the
				// source app so adapter lookup, content queries, etc. resolve correctly.
				const sourceAppId = (config as unknown as Record<string, unknown>)
					?._sourceAppId as string | undefined;
				if (sourceAppId) {
					params.appId = sourceAppId;
				} else {
					if (params.appId && params.appId !== ctx.appId) {
						log.warn("Caller app identifier overridden", {
							event: "handler.caller_app_id_overridden",
							appId: ctx.appId,
							toolName: ctx.toolId,
							outcome: "invalid",
							reason: "caller_app_id_mismatch",
						});
					}
					params.appId = ctx.appId;
				}
			}
		}
		if (
			config.staticParams?.__tedixOmitAggregateTediId !== true &&
			ctx.callerIdentity?.tediId &&
			this.schemaAccepts(toolInputSchema, "tediId", label)
		) {
			if (config.allowExplicitTediId && params.tediId) {
				// Allow explicit tediId — API layer handles org-scoped authorization
			} else if (config.allowExplicitTediId && !params.tediId) {
				// Same guard as appId: leave undefined for API-layer rejection.
			} else {
				if (params.tediId && params.tediId !== ctx.callerIdentity.tediId) {
					log.warn("Caller tedi identifier overridden", {
						event: "handler.caller_tedi_id_overridden",
						appId: ctx.appId,
						toolName: ctx.toolId,
						outcome: "invalid",
						reason: "caller_tedi_id_mismatch",
					});
				}
				params.tediId = ctx.callerIdentity.tediId;
			}
		}
		// Opt-in: inject the caller's org into a required organizationId input so
		// tenant-scoped callers don't pass (or spoof) their own org UUID. A verified
		// platform caller keeps its explicit target; apps/api independently checks
		// its platform authority before accepting a cross-org request.
		//
		// Prefer ctx.app.organizationId: it is always a D1 org UUID (the served
		// root app's org = the caller's org for a per-tenant server). For a
		// forwarded human OAuth user, ctx.callerIdentity.organizationId is the
		// Descope tenant id (org_*), not a D1 UUID, so it must not win — the API
		// resolves org by UUID. Mirrors the ctx.app-first pattern used elsewhere
		// in this handler (e.g. the RPC orgId header).
		if (
			config.injectOrganizationId &&
			!hasPlatformMcpScope(ctx.callerIdentity) &&
			// Same acceptance rule as appId/tediId: a contract that does not
			// declare organizationId strips (lax) or rejects (strict) the key, so
			// injecting it is inert at best and fatal on a strict contract whose
			// D1 row lags the schema sync. Path-placeholder endpoints stay exempt.
			this.schemaAccepts(toolInputSchema, "organizationId", label)
		) {
			const orgId =
				ctx.app?.organizationId ?? ctx.callerIdentity?.organizationId;
			if (orgId) {
				if (params.organizationId && params.organizationId !== orgId) {
					log.warn("Caller organization identifier overridden", {
						event: "handler.caller_organization_id_overridden",
						appId: ctx.appId,
						toolName: ctx.toolId,
						outcome: "invalid",
						reason: "caller_organization_id_mismatch",
					});
				}
				params.organizationId = orgId;
			}
		}
	}

	// =========================================================================
	// Slug → tediId resolution
	// =========================================================================

	/**
	 * Resolve a tedi slug to its UUID via the typed oRPC client.
	 * Returns null if the slug can't be resolved.
	 */
	private async resolveTediSlug(
		ctx: ToolExecutionContext<ToolConfig>,
		slug: string,
	): Promise<string | null> {
		try {
			const orgId =
				ctx.callerIdentity?.organizationId ?? ctx.app?.organizationId;
			const client = getApiClient({
				serviceFetch: ctx.env.API_SERVICE,
				orgId: orgId ?? undefined,
			});
			const result = await client.tedis.list({});
			const match = result.data?.find(
				(t: { slug?: string }) => t.slug === slug && isOperationalTediRecord(t),
			);
			return (match as { id?: string })?.id ?? null;
		} catch (err) {
			log.warn("Tedi slug lookup failed", {
				event: "handler.tedi_slug_lookup_failed",
				appId: ctx.appId,
				toolName: ctx.toolId,
				outcome: "unavailable",
				error: contentFreeMcpException(err),
			});
			return null;
		}
	}

	private async resolveFallbackTediIdForOrg(
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
	private async fetchConnectionToken(
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
				const fallbackTediId = await this.resolveFallbackTediIdForOrg(
					ctx,
					organizationId!,
				);
				if (fallbackTediId) {
					return this.fetchTediConnectionToken(
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
			return this.fetchOrgConnectionToken(
				ctx,
				connectionId,
				organizationId!,
				resolvedScope,
				authScopes,
				label,
				preference,
			);
		}

		if (resolvedScope === "tenant" && tenantOrganizationId) {
			return this.fetchOrgConnectionToken(
				ctx,
				connectionId,
				tenantOrganizationId,
				resolvedScope,
				authScopes,
				label,
				preference,
			);
		}

		return this.fetchTediConnectionToken(
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

	private async fetchTediConnectionToken(
		ctx: ToolExecutionContext<ToolConfig>,
		tediId: string,
		connectionId: string,
		scope: CredentialResolutionScope,
		authScopes?: string[],
		label?: string,
		preference?: CredentialPreference,
		providerArguments?: Record<string, unknown>,
	): Promise<CredentialFetchResult> {
		const connectionInstanceId = selectedConnectionInstanceId(ctx);
		const resolvedScope = scope;
		const resolvedScopes = authScopes ?? [];
		const callerUserId = credentialActingUserId(ctx);
		const cacheKey = getCredentialCacheKey(
			tediId,
			connectionId,
			resolvedScope,
			resolvedScopes,
			label,
			callerUserId,
			connectionInstanceId,
		);
		// Named slots bypass credential caching so reconnect/disconnect takes
		// effect on the next call without an isolate-wide invalidation race.
		const backgroundRun = Boolean(ctx.callerIdentity?.skillRunId);
		const cached =
			connectionInstanceId || backgroundRun
				? null
				: getCachedCredential(cacheKey);
		if (cached) return { token: cached };

		const useServiceBinding = !!ctx.env.API_SERVICE;
		try {
			const rpcInput: Record<string, unknown> = {
				tediId,
				providerId: connectionId,
				scope: resolvedScope,
				...(connectionInstanceId ? { connectionInstanceId } : {}),
				...(backgroundRun
					? {
							delegatedToolUse: {
								appId: ctx.appId,
								arguments: providerArguments ?? {},
							},
						}
					: {}),
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
			if (accessToken && !connectionInstanceId && !backgroundRun)
				setCachedCredential(cacheKey, accessToken);
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
	 * Finds any tedi in the org and uses it to fetch the connection token.
	 */
	private async fetchOrgConnectionToken(
		ctx: ToolExecutionContext<ToolConfig>,
		connectionId: string,
		organizationId: string,
		scope?: CredentialResolutionScope,
		authScopes?: string[],
		label?: string,
		preference?: CredentialPreference,
	): Promise<CredentialFetchResult> {
		const connectionInstanceId = selectedConnectionInstanceId(ctx);
		const resolvedScope = scope ?? "tenant";
		const resolvedScopes = authScopes ?? [];
		const callerUserId = credentialActingUserId(ctx);
		const cacheKey = getCredentialCacheKey(
			organizationId,
			connectionId,
			resolvedScope,
			resolvedScopes,
			label,
			callerUserId,
			connectionInstanceId,
		);
		const cached = connectionInstanceId ? null : getCachedCredential(cacheKey);
		if (cached) return { token: cached };

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
			// _aggregateConnectionLabel) — already part of the credential cache key
			// above; forward it so apps/api prefers the label-scoped credential
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
			if (accessToken && !connectionInstanceId)
				setCachedCredential(cacheKey, accessToken);
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

	buildStructuredContent(
		result: RpcToolResult,
		ctx: ToolExecutionContext<ToolConfig>,
	): Record<string, unknown> {
		let output: Record<string, unknown>;
		if (
			result.data != null &&
			typeof result.data === "object" &&
			!Array.isArray(result.data)
		) {
			output = { ...(result.data as Record<string, unknown>) };
		} else {
			output = { data: result.data };
		}

		// Apply responseMap: rename/extract fields for widget consumption
		// Supports "[]" suffix for array-wrapping: { "source[]": "sources" }
		// wraps a scalar value in an array for the target field
		const responseMap = ctx.config.responseMap;
		if (responseMap) {
			for (const [sourceExpr, targetKey] of Object.entries(responseMap)) {
				const wrapArray = sourceExpr.endsWith("[]");
				const sourcePath = wrapArray ? sourceExpr.slice(0, -2) : sourceExpr;
				let value = getByPath(output, sourcePath);
				if (value !== undefined) {
					if (wrapArray && !Array.isArray(value)) {
						value = [value];
					}
					output[targetKey] = value;
					// Remove original key if it differs and is a top-level key
					if (
						!sourcePath.includes(".") &&
						sourcePath !== targetKey &&
						sourcePath in output
					) {
						delete output[sourcePath];
					}
				}
			}
		}

		// Apply responseTransforms: compute derived fields on array items
		const transforms = ctx.config.responseTransforms;
		if (transforms) {
			for (const rule of transforms) {
				const arr = getByPath(output, rule.arrayPath);
				if (!Array.isArray(arr)) continue;
				for (const item of arr) {
					if (item == null || typeof item !== "object") continue;
					const value = rule.template.replace(
						/\{([^{}]+)\}/g,
						(_m, path: string) => {
							const v = getByPath(item, path);
							return v != null ? String(v) : "";
						},
					);
					setByPath(item as Record<string, unknown>, rule.set, value);
				}
			}
		}

		// Apply arrayLimits: truncate nested arrays to max length
		const arrayLimits = ctx.config.arrayLimits;
		if (arrayLimits) {
			for (const [pathExpr, maxLen] of Object.entries(arrayLimits)) {
				applyToNestedArrays(output, pathExpr, (arr) => {
					arr.length = Math.min(arr.length, maxLen);
				});
			}
		}

		// Apply stripFields: remove unwanted fields from output
		const stripFields = ctx.config.stripFields;
		if (stripFields) {
			for (const pathExpr of stripFields) {
				applyStripField(output, pathExpr);
			}
		}

		// Apply staticOutput: constant fields for widget context (doesn't overwrite API data)
		const staticOutput = ctx.config.staticOutput;
		if (staticOutput) {
			for (const [key, value] of Object.entries(staticOutput)) {
				if (!(key in output)) {
					output[key] = value;
				}
			}
		}

		return output;
	}

	buildTextContent(
		result: RpcToolResult,
		ctx: ToolExecutionContext<ToolConfig>,
	): string {
		if (result.status >= 400) {
			const errorData = result.data as Record<string, unknown> | undefined;
			if (errorData && typeof errorData === "object") {
				// REST-style: { error: "..." } — Google-style APIs nest an object
				// ({ code, message, status }) here; String() renders that as the
				// useless "Error: [object Object]", so stringify objects instead.
				if ("error" in errorData) {
					const inner = errorData.error;
					const detail =
						inner && typeof inner === "object"
							? JSON.stringify(inner).slice(0, 500)
							: String(inner);
					return `Error: ${detail}`;
				}
				// oRPC-style: { code: "BAD_REQUEST", message: "...", data?: {...} }
				if ("code" in errorData && "message" in errorData) {
					const detail =
						errorData.data && typeof errorData.data === "object"
							? ` — ${JSON.stringify(errorData.data).slice(0, 300)}`
							: "";
					return `${errorData.code}: ${errorData.message}${detail}`;
				}
			}
			return `Request failed with status ${result.status}`;
		}
		// Dual-audience projection: when the tool config carries a
		// modelSummaryTemplate, the model-visible text becomes the rendered
		// template while structuredContent keeps the full shaped payload for
		// widgets/hosts. Paths resolve against the shaped structured output so
		// the projection and structuredContent always describe the same data.
		// Fail-soft: a malformed template row must never turn a successful
		// result into an error — fall back to the default JSON text instead.
		const modelSummaryTemplate = ctx.config.modelSummaryTemplate;
		if (modelSummaryTemplate) {
			if (typeof modelSummaryTemplate === "string") {
				try {
					// Shape an isolated deep copy: buildStructuredContent only
					// shallow-copies the top level, and responseTransforms /
					// arrayLimits / stripFields mutate nested objects shared with
					// the structuredContent the caller already built. Cloning keeps
					// this second shaping pass from double-applying transforms onto
					// that payload.
					const shaped = this.buildStructuredContent(
						{ ...result, data: structuredClone(result.data) },
						ctx,
					);
					return truncateTextContent(
						renderModelSummaryTemplate(modelSummaryTemplate, shaped),
					);
				} catch (error) {
					log.error("Model summary rendering failed; using JSON text", {
						event: "handler.model_summary_render_failed",
						appId: ctx.appId,
						toolName: ctx.toolId,
						outcome: "invalid",
						error: contentFreeMcpException(error),
					});
				}
			} else {
				log.error("Model summary template is not a string", {
					event: "handler.model_summary_template_invalid",
					appId: ctx.appId,
					toolName: ctx.toolId,
					outcome: "invalid",
				});
			}
		}
		return truncateTextContent(JSON.stringify(result.data, null, 2));
	}
}

// =============================================================================
// singleton instance
// =============================================================================

/**
 * Create the tool handler.
 *
 * Previously this went through a ToolHandlerRegistry class that mapped
 * type strings to handler instances. With only one handler type ("rpc"),
 * the registry was unnecessary indirection. Now we just export the handler
 * directly and use it in McpAgent.
 */
export function createToolHandler(): ToolHandler {
	return new ToolHandler();
}
