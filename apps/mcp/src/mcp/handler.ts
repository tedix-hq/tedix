import { attachExchangedToken } from "./token-exchange-pilot";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { applyMcpCustomHeaders } from "./handler-external-request";
import { buildStructuredContent, buildTextContent } from "./handler-content";
import { readToolConfigExtension } from "./tool-config-extensions";
import { OWNER_HOST_SESSION_HEADER } from "@tedix/api-contract/contracts/external-agent-identity";
import type { AppCapabilities } from "@tedix/api-contract/schemas/app";
import {
	CatalogueTransportConfigSchema,
	CatalogueSearchInputSchema,
	CatalogueDescribeInputSchema,
	type CatalogueTransportCallback,
	type ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import { delegatedMachineScopes } from "@tedix/mcp-shared/auth/scopes";
import {
	resolveMcpToolNamespace,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";
import {
	type ConnectionRecovery,
	readConnectionRecovery,
} from "@tedix/mcp-shared/tool-result";
import { type DocsFileObservationReceipt } from "@tedix/mcp-shared/read-observation-receipt";
import { getApiClient } from "../lib/api-client";
import { tediToolCeilingDenial } from "../tedi-tool-ceiling";
import { callApiRpc } from "../lib/rpc";
import { contentFreeMcpException, createMcpLogger } from "../log";
import { type CallerIdentity } from "./caller-identity";
import { getByPath } from "./handlers/path-utils";
import {
	hasPlatformMcpScope,
	resolveRpcOrganizationId,
} from "./handler-caller-scope";
import { resolveInternalTransportTimeout } from "./handler-transport-timeouts";
import {
	linkOsGadgetTask,
	OS_GADGET_RUN_ENDPOINT,
	type OsGadgetTaskMarker,
} from "./os-gadget-task";
import type { McpApp } from "./types";
import { buildQueryString } from "./utils/query-params";
import { materializeRestRoute, RestRouteInputError } from "./utils/rest-route";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { applyWorkflowExecutionHeaders } from "./workflow-execution-headers";
import {
	fetchConnectionToken,
	fetchOrgConnectionToken,
	isOperationalTediRecord,
	selectedConnectionInstanceId,
} from "./handler-connection-credentials";
import { executeExternalTransport } from "./handler-external-transport";
import { executeMcpTransport } from "./handler-mcp-transport";
import { executeCodeTransport } from "./handler-code-transport";
import {
	TEDIX_KERNEL_RUN_META_KEY,
	TEDIX_WORK_ITEM_META_KEY,
	TEDIX_TRACE_BUNDLE_META_KEY,
	metaString,
} from "./handler-request-context";

/**
 * Tool Handler
 *
 * The universal handler for all config-driven MCP tools.
 * Configured entirely from D1 — no code deploys needed.
 *
 * Supports six transports:
 * - "rpc": POST to {API_URL}/rpc/{endpoint} with oRPC body format (internal)
 * - "rest": {method} to {API_URL}/v1/{endpoint} (internal)
 * - "external": {method} to {baseUrl}/{endpoint} with credential injection from Descope Token Vault
 * - "mcp": Direct stateless call to upstream MCP server via Streamable HTTP
 * - "code": Execute stored JavaScript in a Dynamic Worker sandbox (globalOutbound: null)
 * - "catalog": Request-local, configuration-backed discovery without a sandbox
 *
 * Auth: Internal transports use service binding (API_SERVICE).
 * External + MCP transports resolve credentials from Descope Token Vault via connections.fetchTediToken.
 *
 * Transport implementations live in handler-external-transport.ts,
 * handler-mcp-transport.ts and handler-code-transport.ts. This handler owns
 * dispatch, internal RPC/REST execution and context parameter enforcement.
 *
 * @module @tedix/mcp/handler
 */

const log = createMcpLogger("mcp.tool_handler");

// =============================================================================
// tool execution context
// =============================================================================

/**
 * Context passed to the handler during tool execution
 */
export interface ToolExecutionContext<TConfig = unknown> {
	/** Server-derived connection restriction; never read from tool arguments. */
	noFunds?: boolean;
	/** App ID */
	appId: string;

	/** App entity from API (lighter-weight than full D1 type) */
	app: McpApp;

	/** App capabilities (checkout, cart, etc.) */
	appCapabilities: AppCapabilities;

	/** Environment bindings (includes API_URL for data fetching) */
	env: CloudflareEnv;

	/** Request-local capability; never loaded from tool config or arguments. */
	catalogTransport?: CatalogueTransportCallback;

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
	/** Trusted catalog annotation; caller arguments cannot enable retries. */
	readOnlyHint?: boolean;

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

/** The approved tool's required scopes plus their machine translations. */
function homeApprovedToolScopes(
	toolId: string,
	config: ToolConfig,
	transport: string,
	mcpConfig: Record<string, unknown> | undefined,
	args: Record<string, unknown>,
	readOnlyHint: boolean | undefined,
): string[] {
	const tool = {
		toolId,
		config: config as unknown as Record<string, unknown>,
		toolTypeId: transport,
		...(readOnlyHint !== undefined ? { annotations: { readOnlyHint } } : {}),
	};
	try {
		const required = resolveMcpToolRequiredScopes(
			tool,
			resolveMcpToolNamespace(
				tool,
				mcpConfig?.codeModeNamespaces as Record<string, string> | undefined,
			),
			mcpConfig,
			{ fallbackOnAuthenticatedAuthMode: true, toolCall: { arguments: args } },
		);
		return [...new Set([...required, ...delegatedMachineScopes(required)])];
	} catch {
		// No resolvable mapping: delegate nothing, so apps/api refuses the call.
		return [];
	}
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

function isPublicRpcToolExecution(
	ctx: ToolExecutionContext<ToolConfig>,
	config: ToolConfig,
): boolean {
	const aggregateConfig = {
		_sourceAuthRequired: readToolConfigExtension(config, "_sourceAuthRequired"),
		_sourceVisibility: readToolConfigExtension(config, "_sourceVisibility"),
	};
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

export class ToolHandler {
	readonly type = "rpc";

	async execute(
		input: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
	): Promise<RpcToolResult> {
		const config = ctx.config;
		const expectedConfig = ctx.requestMeta?.["tedix/expectedToolConfig"];
		if (
			expectedConfig !== undefined &&
			expectedConfig !== (await sha256Hex(JSON.stringify(config)))
		) {
			return {
				status: 409,
				data: { error: "Reviewed tool configuration changed" },
			};
		}
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
		if (ctx.callerIdentity?.tediId) {
			const denial = tediToolCeilingDenial(
				ctx.callerIdentity.mcpEndpoints,
				transport,
				endpoint,
			);
			if (denial) return { status: 403, data: { error: denial } };
		}

		if (
			(config.auth?.type === "connection" ||
				selectedConnectionInstanceId(ctx)) &&
			!["mcp", "external"].includes(transport)
		) {
			return {
				status: 403,
				data: {
					error: "Connection credentials are unsupported for this transport",
				},
			};
		}

		if (transport === "catalog") {
			const configured = CatalogueTransportConfigSchema.safeParse(config);
			if (!configured.success || !ctx.catalogTransport) {
				return {
					status: 400,
					data: { error: "Catalog transport unavailable or invalid" },
				};
			}
			const parsed = (
				configured.data.endpoint === "catalog/search"
					? CatalogueSearchInputSchema
					: CatalogueDescribeInputSchema
			).safeParse(input);
			if (!parsed.success)
				return { status: 400, data: { error: "Invalid catalog arguments" } };
			return {
				status: 200,
				data: await ctx.catalogTransport(configured.data, parsed.data),
			};
		}

		// MCP transport — direct stateless call to upstream MCP server
		if (transport === "mcp") {
			return executeMcpTransport(input, ctx, config, {
				fetchConnectionToken: this.fetchConnectionToken.bind(this),
			});
		}

		// Code transport — execute stored JS in a Dynamic Worker sandbox
		if (transport === "code") {
			return executeCodeTransport(input, ctx, config);
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

		const aggregateConfig = {
			_aggregateTediId: readToolConfigExtension(config, "_aggregateTediId"),
			_aggregateTediOrgId: readToolConfigExtension(
				config,
				"_aggregateTediOrgId",
			),
			_aggregateTediSlug: readToolConfigExtension(config, "_aggregateTediSlug"),
			_credentialDerivedTediActor: readToolConfigExtension(
				config,
				"_credentialDerivedTediActor",
			),
			_voiceSubject: readToolConfigExtension(config, "_voiceSubject"),
			tediBooleanParams: readToolConfigExtension(config, "tediBooleanParams"),
		};
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

		if (readToolConfigExtension(config, "_voiceSubject") === "aggregateTedi") {
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
		// act under the user's speaker authority (docs/engineering/product/tedix-os.md). This keeps the
		// service-binding auth/permissions (no forwarded-user RBAC path) and only
		// adds the id so the kernel can resolve the user's own provider connection.
		// A Home/kernel call (trusted service binding, bound to the user's
		// primary tedi) always names the human it acts for, so apps/api can let
		// that member reach their own private Workspace and nobody else's.
		const kernelActingUser =
			ctx.callerIdentity?.authType === "service" &&
			ctx.callerIdentity.kernel === true;
		const forwardActingUser =
			(readToolConfigExtension(config, "_forwardCallerAuth") === true ||
				kernelActingUser) &&
			Boolean(ctx.callerIdentity?.userId);
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
			// Owner-host Agent-Session verified for this Code Mode execution.
			// apps/api re-validates it against the forwarded user on every call.
			if (ctx.callerIdentity?.ownerHostSessionId) {
				headers[OWNER_HOST_SESSION_HEADER] =
					ctx.callerIdentity.ownerHostSessionId;
			}
		}
		if (useServiceBinding && forwardActingUser && ctx.callerIdentity?.userId) {
			headers["X-Tedix-Acting-User"] = ctx.callerIdentity.userId;
		}
		// Only a Home creation carries this provenance to the creator ledger.
		// The API rechecks active tenant membership; service scopes still apply.
		if (
			useServiceBinding &&
			kernelActingUser &&
			ctx.callerIdentity?.userId &&
			endpoint === "workItems/create"
		)
			headers["X-Tedix-Kernel"] = "true";
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
		if (
			useServiceBinding &&
			endpoint === "workInteractions/respond" &&
			ctx.callerIdentity?.authType === "service" &&
			ctx.callerIdentity.kernel &&
			ctx.callerIdentity.approvedWorkResponderUserId
		) {
			headers["X-Tedix-Approved-Work-Responder"] =
				ctx.callerIdentity.approvedWorkResponderUserId;
		}
		if (
			useServiceBinding &&
			ctx.callerIdentity?.authType === "service" &&
			ctx.callerIdentity.kernel &&
			ctx.callerIdentity.approvedFactoryRequestId
		)
			headers["X-Tedix-Approved-Factory-Request"] =
				ctx.callerIdentity.approvedFactoryRequestId;
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
		// Token exchange pilot (off unless TOKEN_EXCHANGE_PILOT is "on"): a
		// tedi's RPC call carries a one-call token narrowed to this tool.
		if (transport === "rpc")
			await attachExchangedToken({
				env: ctx.env,
				endpoint,
				toolId: ctx.toolId,
				config: config as unknown as Record<string, unknown>,
				mcpConfig: ctx.appMetadata?.mcpConfig as
					| Record<string, unknown>
					| undefined,
				readOnlyHint: ctx.readOnlyHint,
				callerOrganizationId: ctx.callerIdentity?.organizationId,
				headers,
				serviceBinding: useServiceBinding,
			});
		// An approved Home write: governance verified the receipt for exactly
		// this tool and these arguments. Delegate only the scopes this tool
		// requires, for this one request; apps/api still runs its guard and
		// tenant and member checks. An exchanged token keeps narrowing instead.
		if (
			useServiceBinding &&
			ctx.callerIdentity?.authType === "service" &&
			ctx.callerIdentity.kernel === true &&
			ctx.callerIdentity.homeApprovedCall === true
		) {
			const approvedScopes = homeApprovedToolScopes(
				ctx.toolId,
				config,
				transport,
				ctx.appMetadata?.mcpConfig as Record<string, unknown> | undefined,
				params,
				ctx.readOnlyHint,
			);
			if (approvedScopes.length > 0)
				headers["X-Tedix-Tedi-Scopes"] = [
					...new Set([
						...(headers["X-Tedix-Tedi-Scopes"]?.split(/\s+/).filter(Boolean) ??
							[]),
						...approvedScopes,
					]),
				].join(" ");
		}

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
				readToolConfigExtension(config, "_emitTaskLinkage") === true &&
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
				const sourceAppId = readToolConfigExtension(config, "_sourceAppId") as
					| string
					| undefined;
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

	private async executeExternal(
		input: Record<string, unknown>,
		ctx: ToolExecutionContext<ToolConfig>,
		config: ToolConfig,
		endpoint: string,
	): Promise<RpcToolResult> {
		return executeExternalTransport(input, ctx, config, endpoint, {
			fetchConnectionToken: this.fetchConnectionToken.bind(this),
			fetchOrgConnectionToken: this.fetchOrgConnectionToken.bind(this),
		});
	}

	private fetchConnectionToken(
		...args: Parameters<typeof fetchConnectionToken>
	): ReturnType<typeof fetchConnectionToken> {
		return fetchConnectionToken(...args);
	}

	private fetchOrgConnectionToken(
		...args: Parameters<typeof fetchOrgConnectionToken>
	): ReturnType<typeof fetchOrgConnectionToken> {
		return fetchOrgConnectionToken(...args);
	}

	buildStructuredContent(
		result: RpcToolResult,
		ctx: ToolExecutionContext<ToolConfig>,
	): Record<string, unknown> {
		return buildStructuredContent(result, ctx);
	}

	buildTextContent(
		result: RpcToolResult,
		ctx: ToolExecutionContext<ToolConfig>,
	): string {
		return buildTextContent(
			result,
			ctx,
			this.buildStructuredContent.bind(this),
		);
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
