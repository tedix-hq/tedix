/**
 * Tool Registration Module
 *
 * Handles registering bootstrap tools, D1 app tools, text-only tools,
 * widget tools, and tedi skills as MCP resources.
 *
 * All functions accept a ServerContext for state access.
 *
 * @module @tedix/mcp/mcp/tool-registration
 */

import type {
	CallToolResult,
	StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import {
	ProtocolError,
	ProtocolErrorCode,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";
import {
	parseAdapterScope,
	resolveToolAnnotations,
	type ResultStrategy,
	type ToolAnnotations,
	ToolAnnotationsSchema,
} from "@tedix/api-contract/schemas/tools";
import { clientSupportsTasks } from "@tedix/mcp-shared/tasks";
import {
	GetSkillParamsSchema,
	GetSkillResultSchema,
	ListSkillsParamsSchema,
	ListSkillsResultSchema,
	type McpSkillEntry,
} from "@tedix/mcp-shared/skills";
import {
	MCP_RESULT_CACHE_HINT_META_KEY,
	type McpCompletionRequest,
	type McpCompletionResult,
	type McpDirectoryReadHandler,
} from "@tedix/mcp-shared/transport";
import * as z from "zod";
import { createMcpLogger } from "../log";
import {
	enforceMcpToolScopeAuthorization,
	evaluateMcpToolScopeAuthorization,
} from "./codemode-auth";
import { buildSkillCompletionHandler } from "./completions";
import {
	enforceExpectedAnnotations,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	withDestructiveApprovalSchema,
} from "./governance";
import {
	type PromptCallback,
	wrapPromptGetTelemetry,
} from "./middleware/prompts-telemetry";
import {
	type ToolCallback,
	wrapToolCallTelemetry,
} from "./middleware/telemetry";
import {
	attachPaymentResponseMeta,
	checkToolPayment,
	getToolPaymentPolicy,
	settleToolPayment,
} from "./payments";
import { PLATFORM_OPERATOR_APP_SLUG } from "./platform-operator-tools";
import { resourceNotFound } from "./registration/resource-templates";
import type { AppTool, ServerContext } from "./server-context";
import {
	computeSkillPath,
	renderSkillIndexEntry,
	renderSkillMarkdown,
	SkillResourceLimitError,
	skillToolNames,
	type SkillDocumentEntry,
} from "./skill-document";
import { StepBudgetExceededError } from "../lib/step-budget";
import {
	fetchSkillListWithBudget,
	getCachedSkillSummariesForApps,
	mapWithConcurrency,
	SKILL_INDEX_CACHE_HINT,
} from "./skill-cache";
import {
	readRenderedSkills,
	readSkillSnapshot,
	releaseRenderedSkillsRevalidate,
	releaseSkillSnapshotRevalidate,
	renderedSkillsCacheKey,
	reserveRenderedSkillsRevalidate,
	reserveSkillSnapshotRevalidate,
	type SkillSnapshotRead,
	skillSnapshotCacheKey,
	writeRenderedSkills,
	writeSkillSnapshot,
} from "./skill-snapshot-cache";
import {
	paginateSortedSkillsList,
	sortSkillEntriesDeterministically,
} from "./skills-list-pagination";
import {
	inferToolNamespace,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { executeTool } from "./tool-execution";
import { enforceToolRiskRateLimit } from "./tool-risk-policy";
import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	type McpEvent,
	mergeMcpMetadata,
	trackMcpEvent,
} from "./utils/analytics";

const log = createMcpLogger("mcp.tool_registration");

/**
 * Resolve the original MCP request metadata for a registered tool callback.
 *
 * The SDK callback normally exposes `mcpReq._meta`, but the compact-session
 * direct-tool path may omit it after resolving a deferred aggregate tool. The
 * per-request ServerContext retains the original `params._meta`; merge that
 * fallback first so Tasks, elicitation, payment, and trace capabilities survive
 * deferred dispatch without allowing it to override callback-local metadata.
 */
export function resolveToolRequestMeta(
	callbackMeta: Record<string, unknown> | undefined,
	requestMeta: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!callbackMeta && !requestMeta) return undefined;
	return { ...(requestMeta ?? {}), ...(callbackMeta ?? {}) };
}
import { toMcpDateTime } from "./utils/datetime";
import {
	isExternalOpenApiTool,
	normalizeOpenApiExternalArgs,
} from "./utils/openapi-args";
// ToolExecutionContext no longer needed here — widget tools route through executeTool
import {
	buildResourceUris,
	getWidgetVersion,
	registerWidgetTool,
	WIDGET_MIME_TYPES,
	WIDGET_RESOURCE_CACHE_HINT,
	type WidgetAppContext,
} from "./utils/register-widget";
import {
	getToolLayoutSpec,
	resolveToolWidgetRoute,
} from "./utils/render-widget";
import {
	jsonSchemaToInputSchema,
	jsonSchemaToOutputSchema,
	jsonSchemaToToolInputSchema,
	type ToolInputStandardSchema,
} from "./utils/schema";

/** Bootstrap tool IDs */
const BOOTSTRAP_TOOL_IDS = new Set(["get_info"]);

const GENUI_AUTHORING_APP_SLUGS = new Set([
	"tedix",
	PLATFORM_OPERATOR_APP_SLUG,
]);

function shouldRegisterGenUiAuthoringTools(agent: ServerContext): boolean {
	return GENUI_AUTHORING_APP_SLUGS.has(agent.appSlug);
}

function trackResourceRead(
	agent: ServerContext,
	metadata: NonNullable<McpEvent["metadata"]>,
	toolName?: string,
): void {
	const callerFields = buildCallerTelemetryFields(agent.callerIdentity);
	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "resource_read",
		appId: agent.appId,
		appSlug: agent.appSlug,
		organizationId: agent.app?.organizationId,
		...callerFields,
		traceId: agent.traceId,
		...(toolName ? { toolName } : {}),
		success: true,
		metadata: mergeMcpMetadata(callerFields.metadata, metadata),
	};
	trackMcpEvent(agent.env, event);
	emitMcpAuditEvent(agent.env, event, agent.ctx.waitUntil.bind(agent.ctx));
}

export async function registerGenUiAuthoringTools(
	agent: ServerContext,
): Promise<void> {
	if (!shouldRegisterGenUiAuthoringTools(agent)) return;

	const { registerDesignWidgetUiTool } =
		await import("./tools/design-widget-ui");
	const { registerPreviewWidgetTool } = await import("./tools/preview-widget");
	registerDesignWidgetUiTool(agent);
	registerPreviewWidgetTool(agent);
}

// =============================================================================
// SECURITY SCHEMES — per-tool auth declaration for ChatGPT
// =============================================================================

/**
 * Derive securitySchemes for a tool based on app's authMode and toolScopes.
 * ChatGPT uses this to decide whether to show OAuth UI before calling a tool.
 *
 * - Tools with scope requirements: [{ type: "oauth2", scopes: [...] }]
 * - Tools without scopes on hybrid/public apps: [{ type: "noauth" }]
 * - Both (optional auth): [{ type: "noauth" }, { type: "oauth2", scopes: [...] }]
 */
function deriveSecuritySchemes(
	toolId: string,
	mcpConfig: Record<string, unknown> | undefined,
): Array<{ type: string; scopes?: string[] }> | undefined {
	if (!mcpConfig) return undefined;
	const authMode = mcpConfig.authMode as string | undefined;
	const toolScopes = mcpConfig.toolScopes as
		| Record<string, string[]>
		| undefined;
	const scopes = toolScopes?.[toolId];

	if (authMode === "hybrid") {
		if (scopes && scopes.length > 0) {
			// This tool requires auth — but still callable anonymously with limited results
			return [{ type: "oauth2", scopes }];
		}
		// Public tool on hybrid app
		return [{ type: "noauth" }];
	}

	if (authMode === "authenticated") {
		if (scopes && scopes.length > 0) {
			return [{ type: "oauth2", scopes }];
		}
		// Authenticated but no specific scopes
		return [{ type: "oauth2" }];
	}

	// Public app — no auth needed
	return [{ type: "noauth" }];
}

// =============================================================================
// BOOTSTRAP TOOLS — re-exported from registration/bootstrap.ts
// =============================================================================

export {
	registerBootstrapResources,
	registerBootstrapTools,
} from "./registration/bootstrap";

// =============================================================================
// TEXT-ONLY TOOL
// =============================================================================

function parseToolAnnotations(
	value: unknown,
	toolId: string,
): ToolAnnotations | undefined {
	if (value == null) return undefined;
	const parsed = ToolAnnotationsSchema.safeParse(value);
	if (!parsed.success) {
		console.warn(
			`[registerDynamicTool] Tool ${toolId} annotations are invalid`,
		);
		return undefined;
	}
	return parsed.data;
}

/**
 * Annotations as they go on the wire, with the declared write capability folded
 * in.
 *
 * `app_tools.write_capability` is a D1 column, but every gate that classifies a
 * tool — the Kernel write planner's `isWriteCapable`, `requireDestructiveToolApproval`
 * in governance.ts, Code Mode's side-effect serializer — reads MCP `annotations`
 * off the wire. Without this projection a declared tool whose upstream server
 * sends no annotations would still arrive unclassified at all three.
 *
 * Provider hints win where present; the declaration only fills in what is
 * absent. A row with neither stays `undefined`, which is exactly what keeps
 * undeclared distinguishable from "declared read-only" downstream.
 */
export function resolveWireAnnotations(
	tool: AppTool,
): ToolAnnotations | undefined {
	return resolveToolAnnotations({
		annotations: parseToolAnnotations(tool.annotations, tool.toolId) ?? null,
		writeCapability: tool.writeCapability ?? null,
		meta: tool.meta as Record<string, unknown> | null,
	});
}

/**
 * Native `tools/call` scope gate for code-built home-surface (`home__*`) tools.
 *
 * The `home__*` tools are merged into the per-request tool set after
 * `enforceMcpAccess()` has already evaluated `resolvedApp.tools`
 * (apps/mcp/src/index.ts): the request-level scope gate (`extractRequiredScopes`)
 * never sees them, so on the native dispatch they would otherwise resolve to no
 * required scope and run unguarded. The Code Mode path already gates them via
 * `assertCodeModeInnerToolAuthorized`; this mirrors that exact check on the
 * native path (same `resolveMcpToolRequiredScopes` resolver with
 * `fallbackOnAuthenticatedAuthMode:true`, the same exact-scope semantics via
 * `hasScope`, and the same trusted `authType:"service"` bypass) so a `home__*`
 * write can't bypass its scope. This harmonizes `ask`,
 * `home__cancel_home_run`, `home__retry_delegation`, and the Work Item write
 * tools with the Code Mode + aggregate `cto__*` resolution.
 *
 * Covers the two tool families that are invisible to the request-level edge
 * gate (`enforceMcpAccess`), because both are appended to `cachedData.tools`
 * only after that gate has already resolved scopes against `resolvedApp.tools`:
 *
 *   1. `home__*` surface tools (`meta.source === "homeSurface"`).
 *   2. Aggregate tools (`config._aggregateNamespace`) — aggregated app, tedi
 *      and home surfaces. Gate 1's unknown-name fallback is an exact lookup in
 *      `toolScopes[toolName]`, and a prefixed name like `cto__delete_app` is
 *      never a key there, so `requiredScopes` came back `undefined` and the
 *      scope block was skipped entirely. Reachable on native dispatch two ways:
 *      an `aih-m2m` bearer caller naming an aggregated tool directly (see
 *      `shouldBypassCodeModeForCaller`), and any app with `codeMode !== true`,
 *      which registers every merged aggregate tool natively. For `external`/
 *      `mcp`-transport tools — which inject tenant credentials from the Descope
 *      Token Vault and call a third party — this edge is the only scope
 *      boundary, so the gap was not covered downstream.
 *
 * Still deliberately not applied to plain D1 provider tools: those are enforced
 * at the request level exactly as before, and running this fallback resolver
 * over them would over-gate hybrid/public tools with anonymous callers.
 *
 * Over-gating is bounded for the families it does cover: an empty required-scope
 * set is authorized (`evaluateMcpToolScopeAuthorization`), so a tool that
 * declares no capability stays open, and a trusted service caller bypasses.
 *
 * Returns an `insufficient_scope` CallToolResult to DENY, or null to proceed.
 */
export function enforceNativeToolScopeGate(
	agent: Pick<ServerContext, "appMetadata" | "callerIdentity">,
	tool: AppTool,
): CallToolResult | null {
	const source = (tool.meta as { source?: unknown } | null)?.source;
	const config = tool.config as Record<string, unknown> | null | undefined;
	const isAggregate = typeof config?._aggregateNamespace === "string";
	if (source !== "homeSurface" && !isAggregate) return null;

	// Resolve the namespace the same way Code Mode does, so a tool reachable
	// through both surfaces can never get two different verdicts.
	const namespace =
		source === "homeSurface"
			? "home"
			: resolveMcpToolNamespace(
					tool,
					agent.appMetadata?.mcpConfig?.codeModeNamespaces as
						| Record<string, string>
						| undefined,
				);
	let decision: ReturnType<typeof evaluateMcpToolScopeAuthorization>;
	try {
		decision = evaluateMcpToolScopeAuthorization(agent, tool, namespace);
	} catch (error) {
		// `resolveMcpToolRequiredScopes` throws for a tool with no capability
		// mapping. Mirror the Code Mode handling exactly (`codemode.ts`): an
		// unclassified tool is a configuration defect, not a reason to 500 the
		// dispatch — but it fails closed, and Code Mode already denies these same
		// tools, so native dispatch was simply the more permissive of the two.
		if (
			!(error instanceof Error) ||
			!error.message.startsWith("Missing MCP capability mapping for tool:")
		) {
			throw error;
		}
		return {
			content: [
				{
					type: "text",
					text: `scope_mapping_missing: "${tool.toolId}" has no declared capability.`,
				},
			],
			isError: true,
			structuredContent: {
				error: "scope_mapping_missing",
				toolId: tool.toolId,
			},
		};
	}
	if (decision.authorized) return null;
	return enforceMcpToolScopeAuthorization(
		agent,
		tool,
		namespace,
		decision.requiredScopes,
	);
}

/**
 * Register a text-only tool (no widget, no resources).
 *
 * Uses server.registerTool() (not the deprecated server.tool()) to support
 * the full config object: title, outputSchema, annotations, and _meta.
 *
 * Long-running operations should return workflow/job handles through normal
 * tool output. Do not use SDK v1 `experimental.tasks` here: the current MCP
 * Tasks extension has a different negotiation and polling model.
 */
export async function registerTextOnlyTool(
	agent: ServerContext,
	tool: AppTool,
	inputSchema: ToolInputStandardSchema,
	annotations?: ToolAnnotations,
	outputSchema?: StandardSchemaWithJSON,
): Promise<void> {
	const toolTypeId = tool.toolTypeId;
	if (!toolTypeId) {
		log.error("Skipping tool without a type", {
			event: "tool_registration.missing_type",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "misconfigured",
		});
		return;
	}

	// Build _meta for text-only tools (D1 metadata, invocationStatus, visibility, securitySchemes)
	const meta: Record<string, unknown> =
		tool.meta && typeof tool.meta === "object" && !Array.isArray(tool.meta)
			? { ...(tool.meta as Record<string, unknown>) }
			: {};

	// securitySchemes — per-tool auth declaration for ChatGPT
	const secSchemes = deriveSecuritySchemes(
		tool.toolId,
		agent.appMetadata?.mcpConfig as Record<string, unknown> | undefined,
	);
	if (secSchemes) {
		meta.securitySchemes = secSchemes;
	}

	// Parse invocationStatus from dedicated column, falling back to config
	const invocationStatus = (tool.invocationStatus ??
		(tool.config as Record<string, unknown> | null)?.invocationStatus) as {
		invoking?: string;
		invoked?: string;
	} | null;
	if (invocationStatus?.invoking) {
		meta["openai/toolInvocation/invoking"] = invocationStatus.invoking;
	}
	if (invocationStatus?.invoked) {
		meta["openai/toolInvocation/invoked"] = invocationStatus.invoked;
	}

	// Visibility
	if (tool.visibility) {
		meta["openai/visibility"] = tool.visibility;
	}

	// Tedix namespace — tool provenance metadata for the MCP plugin
	meta["com.tedix/appSlug"] = agent.appSlug ?? "unknown";
	meta["com.tedix/toolTypeId"] = tool.toolTypeId ?? "unknown";
	const paymentPolicy = getToolPaymentPolicy(tool);
	if (paymentPolicy) {
		meta["x-tedix/paymentRequired"] = true;
		// agents-x402 discovery extension: Cloudflare buyer agents read these
		// two keys from tools/list to compare prices before calling.
		meta["agents-x402/paymentRequired"] = true;
		const priceUSD = Number(paymentPolicy.amount);
		if (Number.isFinite(priceUSD)) {
			meta["agents-x402/priceUSD"] = priceUSD;
		}
	}
	if (tool.widgetKey) {
		meta["com.tedix/hasWidget"] = true;
		meta["com.tedix/widgetKey"] = tool.widgetKey;
	}
	const transport = (tool.config as Record<string, unknown> | null)?.transport;
	if (transport === "mcp" || transport === "external") {
		meta["com.tedix/transport"] = transport;
	}

	// Standard synchronous tool registration
	const cb: ToolCallback = async (args, ctx) => {
		// Scope gate first (mirrors the Code Mode inner-tool order): close the
		// gap where code-built home__* tools, merged after enforceMcpAccess,
		// reach the native dispatch with no request-level scope check.
		const scopeDenial = enforceNativeToolScopeGate(agent, tool);
		if (scopeDenial) return scopeDenial;

		const extra = {
			_meta: resolveToolRequestMeta(ctx.mcpReq?._meta, agent.requestMeta),
		};

		const annotationFailure = enforceExpectedAnnotations(
			agent,
			tool,
			annotations,
			extra,
		);
		if (annotationFailure) return annotationFailure;

		const riskRateLimitFailure = await enforceToolRiskRateLimit(agent, tool);
		if (riskRateLimitFailure) return riskRateLimitFailure;

		const approvalFailure = await requireDestructiveToolApproval(
			agent,
			tool,
			annotations,
			{ args, extra },
		);
		if (approvalFailure) return approvalFailure;
		const executionArgs = stripDestructiveApprovalArgs(tool, args);

		const payment = await checkToolPayment({
			agent,
			tool,
			args: executionArgs,
			extra,
		});
		if (!payment.paid) return payment.result;

		const result = await executeTool(agent, tool, executionArgs, {
			adapterScope: parseAdapterScope(tool.adapterScope),
			resultStrategy: (tool.resultStrategy as ResultStrategy) ?? "merge",
			clientSupportsTasks: clientSupportsTasks(extra?._meta),
		});
		if (result.isError) return result;
		const settlement = await settleToolPayment(agent, payment.settlement);
		if (!settlement.settled) return settlement.result;
		return attachPaymentResponseMeta(
			result,
			settlement.paymentResponse ?? payment.paymentResponse,
		);
	};

	const registeredTool = agent.server.registerTool(
		tool.toolId,
		{
			title: tool.title,
			description: tool.description ?? tool.title,
			inputSchema,
			...(outputSchema && { outputSchema }),
			...(tool.icons ? { icons: tool.icons } : {}),
			...(annotations && { annotations }),
			...(Object.keys(meta).length > 0 && { _meta: meta }),
		},
		wrapToolCallTelemetry(
			tool.toolId,
			agent,
			cb,
			tool,
		) as unknown as Parameters<typeof agent.server.registerTool>[2],
	);

	agent.registeredTools.set(tool.toolId, registeredTool);
	agent.appToolIds.add(tool.toolId);
	agent.loadedTools.set(tool.toolId, tool);
	if (tool.authRequired) agent.authRequiredTools.add(tool.toolId);
	if (tool.visibility === "private") agent.authRequiredTools.add(tool.toolId);
}

// =============================================================================
// DYNAMIC (WIDGET) TOOL
// =============================================================================

/**
 * Wrap a D1 tool's stored inputSchema for SDK registration. Native tools
 * (transport rpc/code/undefined) validate strictly against the Tedix-owned
 * schema; upstream-validated tools (external/mcp) are lenient — the vendor is
 * the authoritative validator. External OpenAPI tools additionally get
 * page-size enum normalization before validation.
 */
function buildToolInputSchema(tool: AppTool): ToolInputStandardSchema {
	const transport = tool.config?.transport;
	return jsonSchemaToInputSchema(
		withDestructiveApprovalSchema(tool, resolveWireAnnotations(tool)),
		{
			toolId: tool.toolId,
			lenient: transport === "external" || transport === "mcp",
			...(isExternalOpenApiTool(tool)
				? {
						normalizeArgs: (args: Record<string, unknown>) =>
							normalizeOpenApiExternalArgs(args, tool.inputSchema),
					}
				: {}),
		},
	);
}

/**
 * Register a single tool from D1 configuration.
 * Uses the centralized registerWidgetTool helper for atomic tool + resource registration.
 */
export async function registerDynamicTool(
	agent: ServerContext,
	tool: AppTool,
	registeredResourceUris?: Set<string>,
): Promise<void> {
	const widgetVersion = getWidgetVersion(agent.env);

	// Prompt tools are handled separately by registerAppPrompts
	if (tool.toolTypeId === "prompt") return;

	const widgetRoute = resolveToolWidgetRoute(tool);
	const layoutSpec = getToolLayoutSpec(tool);

	if (!widgetRoute) {
		if (!tool.widgetKey && !tool.outputTemplate) {
			// Text-only tool
			const inputSchema = buildToolInputSchema(tool);
			const textAnn = resolveWireAnnotations(tool);
			const textOutputSchema = jsonSchemaToOutputSchema(tool.outputSchema);
			await registerTextOnlyTool(
				agent,
				tool,
				inputSchema,
				textAnn,
				textOutputSchema,
			);
			return;
		}
		log.error("Skipping widget tool without a resolved route", {
			event: "tool_registration.widget_route_missing",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "misconfigured",
		});
		return;
	}

	// Convert schemas
	const inputSchema = buildToolInputSchema(tool);
	const outputSchema = jsonSchemaToOutputSchema(tool.outputSchema);

	const adapterScope = parseAdapterScope(tool.adapterScope);
	const annotations = resolveWireAnnotations(tool);

	const appContext: WidgetAppContext = {
		id: agent.appId,
		slug: agent.app?.slug ?? "unknown",
		name: agent.app?.name ?? "Unknown App",
		defaultWidgetDomain: agent.getWidgetDomain(),
	};

	const widgetSecSchemes = deriveSecuritySchemes(
		tool.toolId,
		agent.appMetadata?.mcpConfig as Record<string, unknown> | undefined,
	);
	const widgetConfig = z
		.record(z.string(), JsonValueSchema)
		.nullable()
		.safeParse(tool.config);
	if (!widgetConfig.success) {
		log.error("Skipping widget tool with non-JSON configuration", {
			event: "tool_registration.invalid_widget_config",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "invalid",
		});
		return;
	}

	const widgetTool = {
		...tool,
		config: widgetConfig.data,
		authRequired: tool.authRequired ?? false,
		icons: tool.icons ?? null,
		executionTaskSupport: tool.executionTaskSupport ?? null,
		meta: tool.meta ?? null,
		schemaDialect: tool.schemaDialect ?? null,
		schemaSource: tool.schemaSource ?? null,
		schemaSourceRef: tool.schemaSourceRef ?? null,
		schemaSourceHash: tool.schemaSourceHash ?? null,
		schemaSyncedAt: tool.schemaSyncedAt ?? null,
	};

	const result = await registerWidgetTool({
		server: agent.server,
		serverCtx: agent,
		tool: widgetTool,
		widgetRoute,
		widgetVersion,
		appContext,
		annotations,
		inputSchema,
		outputSchema,
		registeredResourceUris,
		securitySchemes: widgetSecSchemes,
		handler: async (args, ctx) => {
			const extra = {
				_meta: resolveToolRequestMeta(ctx.mcpReq?._meta, agent.requestMeta),
			};
			const annotationFailure = enforceExpectedAnnotations(
				agent,
				tool,
				annotations,
				extra,
			);
			if (annotationFailure) return annotationFailure;

			const riskRateLimitFailure = await enforceToolRiskRateLimit(agent, tool);
			if (riskRateLimitFailure) return riskRateLimitFailure;

			const approvalFailure = await requireDestructiveToolApproval(
				agent,
				tool,
				annotations,
				{ args, extra },
			);
			if (approvalFailure) return approvalFailure;
			const executionArgs = stripDestructiveApprovalArgs(tool, args);

			return executeTool(agent, tool, executionArgs, {
				adapterScope,
				resultStrategy: (tool.resultStrategy as ResultStrategy) ?? "merge",
			});
		},
		buildCsp: async (t) => agent.buildAppCsp(t),
		fetchHtml: async (route, description, hostType) => {
			const extraHeaders: Record<string, string> = {};
			if (layoutSpec) {
				extraHeaders["X-Tedix-Layout-Spec"] = JSON.stringify(layoutSpec);
			}
			return agent.fetchWidgetHtml(route, description, hostType, extraHeaders);
		},
		onResourceRead: (event) => {
			trackResourceRead(
				agent,
				{
					resourceUri: event.resourceUri,
					resourceType: event.resourceType,
					widgetKey: event.widgetKey,
					toolId: event.toolId,
				},
				event.toolId,
			);
		},
	});

	if (!result) {
		log.error("Skipping widget tool after registration returned no result", {
			event: "tool_registration.widget_registration_empty",
			appId: agent.appId,
			toolName: tool.toolId,
			outcome: "unavailable",
		});
		return;
	}

	agent.toolOutputTemplates.set(tool.toolId, result.outputTemplate);
	agent.loadedTools.set(tool.toolId, tool);

	if (tool.authRequired) agent.authRequiredTools.add(tool.toolId);
	if (tool.visibility === "private") agent.authRequiredTools.add(tool.toolId);

	agent.appToolIds.add(tool.toolId);

	const appsSdkResourceId = `widget-${tool.toolId}`;
	const mcpAppResourceId = `mcp-app-${tool.toolId}`;
	agent.appResourceIds.add(appsSdkResourceId);
	agent.appResourceIds.add(mcpAppResourceId);
}

// =============================================================================
// TEDI SKILLS
// =============================================================================

/**
 * Skill entry from D1 cognitive skill_entries table.
 */
type SkillIndexEntry = SkillDocumentEntry;

function skillFileMimeType(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".md")) return "text/markdown";
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".yaml") || lower.endsWith(".yml"))
		return "application/yaml";
	if (lower.endsWith(".sh")) return "text/x-shellscript";
	if (lower.endsWith(".py")) return "text/x-python";
	if (lower.endsWith(".js") || lower.endsWith(".ts")) return "text/javascript";
	return "text/plain";
}

function listSkillDirectoryResources(
	skill: SkillIndexEntry,
	agent: ServerContext,
	directoryPath: string,
): Array<Record<string, unknown>> | null {
	const normalized = directoryPath.replace(/^\/+|\/+$/g, "");
	const prefix = normalized ? `${normalized}/` : "";
	const paths = ["SKILL.md", ...Object.keys(skill.files ?? {})];
	const children = new Map<
		string,
		{ filePath: string; name: string; mimeType: string; directory: boolean }
	>();

	for (const filePath of paths) {
		if (prefix && !filePath.startsWith(prefix)) continue;
		const rest = prefix ? filePath.slice(prefix.length) : filePath;
		if (!rest) continue;
		const [first, ...tail] = rest.split("/");
		if (!first) continue;
		const childPath = prefix ? `${prefix}${first}` : first;
		if (tail.length > 0) {
			children.set(first, {
				filePath: childPath,
				name: first,
				mimeType: "inode/directory",
				directory: true,
			});
			continue;
		}
		if (!children.has(first)) {
			children.set(first, {
				filePath: childPath,
				name: first,
				mimeType: skillFileMimeType(childPath),
				directory: false,
			});
		}
	}
	if (normalized && children.size === 0) return null;
	const root = computeSkillPath(skill, agent.appSlug ?? null);
	return [...children.values()]
		.sort((a, b) => {
			if (a.directory !== b.directory) return a.directory ? 1 : -1;
			return a.name.localeCompare(b.name);
		})
		.map((child) => ({
			uri: `skill://${root}/${child.filePath}`,
			name: child.name,
			mimeType: child.mimeType,
		}));
}

async function resolveReadableGuidanceSkillApps(
	agent: ServerContext,
): Promise<Map<string, string>> {
	const mcpConfig = agent.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const guidanceSlugs = mcpConfig?.guidanceSkillApps as string[] | undefined;
	const aggregateApps = mcpConfig?.aggregateApps as
		| Array<{ slug: string; prefix?: string }>
		| undefined;

	if (!guidanceSlugs?.length || !aggregateApps?.length) {
		return new Map();
	}

	const guidanceSet = new Set(guidanceSlugs);
	const prefixToSlug = new Map<string, string>();
	for (const entry of aggregateApps) {
		prefixToSlug.set(entry.prefix ?? entry.slug, entry.slug);
	}

	const sourceAppIdToAggregateSlug = new Map<string, string>();
	for (const [toolId, tool] of agent.loadedTools) {
		const config = tool.config as Record<string, unknown> | null;
		const sourceAppId = config?._sourceAppId as string | undefined;
		if (!sourceAppId) continue;
		const sepIdx = toolId.indexOf("__");
		if (sepIdx < 0) continue;
		const prefix = toolId.slice(0, sepIdx);
		const aggregateSlug = prefixToSlug.get(prefix);
		if (!aggregateSlug) continue;
		if (
			guidanceSet.has(aggregateSlug) &&
			!sourceAppIdToAggregateSlug.has(sourceAppId)
		) {
			sourceAppIdToAggregateSlug.set(sourceAppId, aggregateSlug);
		}
	}

	return sourceAppIdToAggregateSlug;
}

/**
 * Pre-enrich loadedTools descriptions with skill context from aggregated apps.
 * Must run before Code Mode catalog build so discover.search() includes skill guidance.
 * Builds toolSkillMap for both UUID-based and toolId-based lookups.
 */
export async function enrichToolsWithSkills(
	agent: ServerContext,
): Promise<void> {
	if (!agent.apiClient) return;

	// Collect unique source app IDs from aggregated tools
	const sourceAppIds = new Set<string>();
	for (const [, tool] of agent.loadedTools) {
		const config = tool.config as Record<string, unknown> | null;
		const sourceAppId = config?._sourceAppId as string | undefined;
		if (sourceAppId && sourceAppId !== agent.appId) {
			sourceAppIds.add(sourceAppId);
		}
	}
	if (sourceAppIds.size === 0) return;

	// Build UUID → toolId reverse map for skill-to-tool matching
	const uuidToToolId = new Map<string, string>();
	for (const [toolId, tool] of agent.loadedTools) {
		uuidToToolId.set(tool.id, toolId);
	}
	const readableGuidanceApps = await resolveReadableGuidanceSkillApps(agent);

	let enrichedCount = 0;
	// One batched call for every source app, not one `skills.listByApp` per app:
	// a cold apps/api invocation costs seconds of CPU because the `worker-app`
	// graph is evaluated per isolate, so a per-app fan-out creates one cold
	// isolate per app per aggregate rebuild.
	const batchedSummaries = await getCachedSkillSummariesForApps({
		apiClient: agent.apiClient,
		appIds: Array.from(sourceAppIds),
		orgId: agent.app?.organizationId,
		tediId: agent.callerIdentity?.tediId,
		limit: 50,
	});
	const enrichmentCounts = await mapWithConcurrency(
		Array.from(sourceAppIds),
		8,
		async (appId) => {
			let appEnrichedCount = 0;
			try {
				const summaries = batchedSummaries.get(appId) ?? [];
				for (const skill of summaries) {
					if (!skill.toolIds?.length) continue;
					const summary = skill.summary ?? skill.description ?? skill.title;
					const skillSlug = skill.slug ?? skill.id;
					const aggregateSlug = readableGuidanceApps.get(appId);
					const skillUri = aggregateSlug
						? `skill://${aggregateSlug}/${skillSlug}/SKILL.md`
						: null;
					const skillRef = skillUri
						? {
								id: skill.id,
								title: skill.title,
								uri: skillUri,
							}
						: null;

					for (const refId of skill.toolIds) {
						// Resolve: toolIds may contain UUIDs or string toolIds
						const resolvedToolId = uuidToToolId.get(refId) ?? refId;
						const tool = agent.loadedTools.get(resolvedToolId);
						if (!tool) continue;

						// Populate toolSkillMap only with resources this server will
						// actually register. Aggregate app skills are readable only when
						// the app is explicitly listed in guidanceSkillApps.
						if (skillRef) {
							const existing = agent.toolSkillMap.get(resolvedToolId) ?? [];
							existing.push(skillRef);
							agent.toolSkillMap.set(resolvedToolId, existing);
						}

						// Enrich tool description. Only advertise read_skill/resources
						// when the skill resource is registered on this server.
						const currentDesc = tool.description ?? "";
						if (!currentDesc.includes("📋 Skills")) {
							const readHint = skillUri
								? `\n\nUse read_skill({ skillId: "${skill.id}" }) when available, or mcp_read_resource({ uri: "${skillUri}" }) for the skill:// resource.`
								: `\n\nUse get_skill({ id: "${skill.id}" }) when available; this aggregate server does not register a skill:// resource for this source app.`;
							tool.description = `${currentDesc}\n\n📋 Skills (proven procedures for this tool):\n• ${skill.title}: ${summary}${readHint}`;
							appEnrichedCount++;
						}
					}
				}
			} catch (error) {
				console.warn(
					`[MCP] Failed to load skills for aggregated app ${appId}:`,
					error instanceof Error ? error.message : error,
				);
			}
			return appEnrichedCount;
		},
	);
	enrichedCount = enrichmentCounts.reduce((sum, count) => sum + count, 0);
	if (enrichedCount > 0) {
		console.log(
			`[MCP] Enriched ${enrichedCount} aggregated tool(s) with skill context from ${sourceAppIds.size} app(s)`,
		);
	}
}

/** Deployment fingerprint for the skill-snapshot cache key — busts the key on
 * every deploy so a new skill contract never reuses an old snapshot. Mirrors the
 * aggregate-surface cache (`env.WORKER_VERSION?.id ?? env.GIT_SHA`). */
function skillSnapshotFingerprint(env: ServerContext["env"]): string {
	return env.WORKER_VERSION?.id ?? env.GIT_SHA ?? "dev";
}

/**
 * In-flight cap for the per-skill digest render (`renderSkillIndexEntry` runs a
 * SHA-256 over each skill body + every attached file). A serial loop over ~160
 * skills cost multiple seconds on every cache-MISS build — the residual behind
 * the slow `resources/list` that timed out delegated Code-Mode connects. Bounded
 * concurrency overlaps the Web Crypto work without the unbounded `Promise.all`
 * fan-out that "starves the isolate" (the reason the loop was serial).
 */
const SKILL_DIGEST_RENDER_CONCURRENCY = 8;

/**
 * Gather the app + guidance + org-library skill snapshot from D1. This is the
 * uncached, full-content fan-out (per-app list + guidance fan-out + org library)
 * that {@link loadCachedSkillSnapshot} fronts with an L1+L2 SWR cache — the
 * expensive work that used to run on every aggregate-gateway server build.
 */
async function populateSkillIndexFromD1(
	agent: ServerContext,
): Promise<Map<string, SkillIndexEntry>> {
	const skillIndex = new Map<string, SkillIndexEntry>();

	// Fetch D1 cognitive skills for this app (retry once on failure — D1 cold-start
	// can timeout, and a failed load leaves the Worker permanently without resources)
	const appIdsToTry = [agent.appId];
	// Skill inheritance: if the org app has no skills, fall back to the reference app
	if (agent.upstreamAppId) appIdsToTry.push(agent.upstreamAppId);

	const maxAttempts = 2;
	for (const targetAppId of appIdsToTry) {
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				// Skill-cache discipline (budget + breaker) on this direct list call,
				// so a stalled apps/api skills endpoint cannot hang tools/list
				// silently on the request path.
				const d1Result = await fetchSkillListWithBudget(
					"register_app_skills_list",
					targetAppId,
					() =>
						agent.apiClient.skills.listByApp({
							appId: targetAppId,
							tediId: agent.callerIdentity?.tediId,
						}),
				);
				// Breaker open: upstream known-unhealthy — serve without skills.
				if (!d1Result) break;

				for (const skill of d1Result.skills ?? []) {
					skillIndex.set(skill.id, {
						id: skill.id,
						title: skill.title,
						slug: skill.slug ?? null,
						summary: skill.summary ?? null,
						description: skill.description ?? null,
						content: skill.content,
						files:
							(skill as { files?: Record<string, string> | null }).files ??
							null,
						tags: skill.tags ?? null,
						toolIds: skill.toolIds ?? null,
						successCount: skill.successCount,
						revision: skill.revision,
						appId: skill.appId ?? null,
						audience: skill.audience ?? null,
						r2Path: skill.r2Path ?? null,
						updatedAt: skill.updatedAt ?? null,
						createdAt: skill.createdAt ?? null,
						source: "d1",
					});
				}
				break; // Success — exit retry loop
			} catch (error) {
				// A tripped budget already emitted its diagnosis line, and an
				// immediate retry of a full-budget timeout cannot succeed — the 1s
				// backoff below exists for fast D1 cold-start errors, not stalls.
				const budgetExceeded = error instanceof StepBudgetExceededError;
				const isLast = attempt === maxAttempts || budgetExceeded;
				console[isLast ? "warn" : "log"](
					`[MCP] ${isLast ? "Failed" : "Retrying"} D1 skill load (attempt ${attempt}/${maxAttempts}):`,
					error instanceof Error ? error.message : error,
				);
				if (budgetExceeded) break;
				if (!isLast) await new Promise((r) => setTimeout(r, 1000)); // 1s backoff
			}
		}
		if (skillIndex.size > 0) break; // Found skills — skip fallback
	}

	// Load skills from guidanceSkillApps — operator-curated aggregated apps whose
	// skills should surface as skill:// resources (tier 1 guidance) on this server.
	const mcpConfig = agent.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const guidanceSlugs = mcpConfig?.guidanceSkillApps as string[] | undefined;
	const aggregateApps = mcpConfig?.aggregateApps as
		| Array<{ slug: string; prefix?: string }>
		| undefined;

	if (guidanceSlugs?.length && aggregateApps?.length) {
		const prefixToSlug = new Map<string, string>();
		for (const entry of aggregateApps) {
			prefixToSlug.set(entry.prefix ?? entry.slug, entry.slug);
		}

		// Warn on guidanceSlugs that do not match an aggregateApps entry.
		const allKnownSlugs = new Set(aggregateApps.map((entry) => entry.slug));
		for (const guidanceSlug of guidanceSlugs) {
			if (!allKnownSlugs.has(guidanceSlug)) {
				console.warn(
					`[MCP] guidanceSkillApps entry "${guidanceSlug}" matches no aggregateApps slug ` +
						`Known: ${[...allKnownSlugs].join(", ")}`,
				);
			}
		}

		const slugToAppId = new Map<string, string>();
		for (const [toolId, tool] of agent.loadedTools) {
			const config = tool.config as Record<string, unknown> | null;
			const sourceAppId = config?._sourceAppId as string | undefined;
			if (!sourceAppId) continue;
			const sepIdx = toolId.indexOf("__");
			if (sepIdx < 0) continue;
			const prefix = toolId.slice(0, sepIdx);
			const aggregateSlug = prefixToSlug.get(prefix);
			if (!aggregateSlug) continue;
			if (
				guidanceSlugs.includes(aggregateSlug) &&
				!slugToAppId.has(aggregateSlug)
			) {
				slugToAppId.set(aggregateSlug, sourceAppId);
			}
		}

		let guidanceCount = 0;
		await Promise.all(
			Array.from(slugToAppId.entries()).map(async ([slug, appId]) => {
				try {
					// Same budget + breaker as the app-skill load above: guidance skills
					// are optional enrichment and must never stall the surface build.
					const result = await fetchSkillListWithBudget(
						"register_guidance_skills_list",
						appId,
						() =>
							agent.apiClient.skills.listByApp({
								appId,
								tediId: agent.callerIdentity?.tediId,
							}),
					);
					if (!result) return;
					for (const skill of result.skills ?? []) {
						if (skillIndex.has(skill.id)) continue;
						skillIndex.set(skill.id, {
							id: skill.id,
							title: skill.title,
							slug: skill.slug ?? null,
							summary: skill.summary ?? null,
							description: skill.description ?? null,
							content: skill.content,
							files:
								(skill as { files?: Record<string, string> | null }).files ??
								null,
							tags: skill.tags ?? null,
							toolIds: skill.toolIds ?? null,
							successCount: skill.successCount,
							revision: skill.revision,
							appId: skill.appId ?? null,
							audience: skill.audience ?? null,
							r2Path: skill.r2Path ?? null,
							updatedAt: skill.updatedAt ?? null,
							createdAt: skill.createdAt ?? null,
							source: "d1",
							appSlugOverride: slug,
						});
						guidanceCount++;
					}
				} catch (error) {
					console.warn(
						`[MCP] Failed to load guidance skills for ${slug}:`,
						error instanceof Error ? error.message : error,
					);
				}
			}),
		);
		if (guidanceCount > 0) {
			console.log(
				`[MCP] Loaded ${guidanceCount} guidance skill(s) from ${slugToAppId.size} app(s)`,
			);
		}
	}

	// Org-library skills (visibility "org", appId null) are the corpus agents
	// actually record and reuse — without this block the SEP-2640 surface served
	// only app-attached skills and the org library was invisible to conformant
	// hosts. Org skills mount at skill://<slug>/SKILL.md (no app prefix;
	// computeSkillPath already yields the bare slug for appId-null rows, so the
	// final path segment equals the frontmatter name as the SEP requires).
	// Stale/archived lifecycle states stay off the host surface. Draft stays
	// VISIBLE: in this corpus "draft" is the default recorded state and
	// active/proven are earned by usage (skill-promotion gate), so hiding
	// drafts hid nearly the whole org library.
	const ORG_SKILL_HIDDEN_LIFECYCLES = new Set(["stale", "archived"]);
	try {
		// Same budget + breaker: the org library is optional enrichment too.
		const orgResult = await fetchSkillListWithBudget(
			"register_org_skills_list",
			agent.appSlug,
			() =>
				agent.apiClient.skills.listByOrg({
					visibility: "org",
					limit: 200,
				}),
		);
		let orgCount = 0;
		for (const skill of orgResult?.entries ?? []) {
			if (skillIndex.has(skill.id)) continue;
			const lifecycle = (skill as { lifecycleState?: string | null })
				.lifecycleState;
			if (lifecycle && ORG_SKILL_HIDDEN_LIFECYCLES.has(lifecycle)) continue;
			skillIndex.set(skill.id, {
				id: skill.id,
				title: skill.title,
				slug: skill.slug ?? null,
				summary: skill.summary ?? null,
				description: skill.description ?? null,
				content: skill.content,
				files:
					(skill as { files?: Record<string, string> | null }).files ?? null,
				tags: skill.tags ?? null,
				toolIds: skill.toolIds ?? null,
				successCount: skill.successCount,
				revision: skill.revision,
				appId: null,
				audience: skill.audience ?? null,
				r2Path: skill.r2Path ?? null,
				updatedAt: skill.updatedAt ?? null,
				createdAt: skill.createdAt ?? null,
				source: "d1",
			});
			orgCount++;
		}
		if (orgCount > 0) {
			console.log(`[MCP] Loaded ${orgCount} org-library skill(s)`);
		}
	} catch (error) {
		console.warn(
			"[MCP] Failed to load org-library skills:",
			error instanceof Error ? error.message : error,
		);
	}

	return skillIndex;
}

/**
 * The skill snapshot behind an L1+L2 stale-while-revalidate cache
 * (skill-snapshot-cache.ts). On a fresh hit it returns the cached entries with
 * zero D1 I/O; on a stale hit it returns them and schedules one background
 * revalidate; on a miss it runs the live D1 fan-out and writes the cache. The
 * key is org- and tedi-partitioned (skills are personalized per tedi) and busts
 * on deploy. Fail-open: any cache error falls through to the live fan-out.
 */
export async function loadCachedSkillSnapshot(
	agent: ServerContext,
): Promise<Map<string, SkillIndexEntry>> {
	const mcpConfig = agent.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const guidanceSlugs = mcpConfig?.guidanceSkillApps as string[] | undefined;
	const cacheKey = skillSnapshotCacheKey({
		appId: agent.appId,
		upstreamAppId: agent.upstreamAppId,
		appSlug: agent.appSlug,
		orgId: agent.callerIdentity?.organizationId,
		tediId: agent.callerIdentity?.tediId,
		guidanceSlugs,
		fingerprint: skillSnapshotFingerprint(agent.env),
	});

	let cached: SkillSnapshotRead | null = null;
	try {
		cached = await readSkillSnapshot(cacheKey);
	} catch {
		// readSkillSnapshot is already fail-open; guard belt-and-suspenders.
		cached = null;
	}

	if (cached) {
		const skillIndex = new Map<string, SkillIndexEntry>();
		for (const entry of cached.entries) skillIndex.set(entry.id, entry);
		// Stale-while-revalidate: serve the cached snapshot now, refresh once in
		// the background (single-flight per key) so the next build is fresh.
		if (cached.stale && reserveSkillSnapshotRevalidate(cacheKey)) {
			const job = (async () => {
				try {
					const fresh = await populateSkillIndexFromD1(agent);
					await writeSkillSnapshot(cacheKey, [...fresh.values()]);
				} catch (error) {
					console.warn(
						`[MCP] skill snapshot revalidate failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				} finally {
					releaseSkillSnapshotRevalidate(cacheKey);
				}
			})();
			agent.ctx.waitUntil(job);
		}
		return skillIndex;
	}

	const skillIndex = await populateSkillIndexFromD1(agent);
	await writeSkillSnapshot(cacheKey, [...skillIndex.values()]);
	return skillIndex;
}

/**
 * Register app-scoped skills as MCP tools + resources.
 * Progressive disclosure: list_skills returns summaries, read_skill returns full content.
 * Also registers skill:// resources for direct resource access.
 */
export async function registerAppSkills(agent: ServerContext): Promise<void> {
	if (!agent.appId || !agent.apiClient) return;

	const skillIndex = await loadCachedSkillSnapshot(agent);

	// SEP-2640: candidates for skill:// resource-template variable
	// completion (`skill_name` / `app_slug`), derived from the registered skill
	// paths so hosts can autocomplete a skill before reading its resource.
	const skillNameCandidates = new Set<string>();
	const appSlugCandidates = new Set<string>();
	for (const skill of skillIndex.values()) {
		const segments = computeSkillPath(skill, agent.appSlug ?? null).split("/");
		const skillName = segments[segments.length - 1];
		if (skillName) skillNameCandidates.add(skillName);
		if (segments.length > 1 && segments[0]) appSlugCandidates.add(segments[0]);
	}

	// Build UUID → toolId reverse map for human-readable tool names in skill frontmatter
	const uuidToToolId = new Map<string, string>();
	const toolIdToUuid = new Map<string, string>();
	for (const [toolId, tool] of agent.loadedTools) {
		uuidToToolId.set(tool.id, toolId);
		toolIdToUuid.set(toolId, tool.id);
	}

	console.log(
		`[MCP] Registering ${skillIndex.size} app skill(s) (list_skills + read_skill + resources)`,
	);

	// Render the snapshot into McpSkillEntry[] (SHA-256 over each skill body +
	// file), fronted by the rendered-skills cache so a warm build skips the whole
	// digest render. The render is a pure function of the snapshot + appSlug +
	// uuid→toolId map + render code, all captured in the key below, so a hit only
	// serves digests consistent with this request's resource-reads.
	const renderProtocolSkills = async (): Promise<McpSkillEntry[]> => {
		const rendered = await mapWithConcurrency(
			[...skillIndex.values()],
			SKILL_DIGEST_RENDER_CONCURRENCY,
			async (skill) => {
				try {
					return await renderSkillIndexEntry(
						skill,
						agent.appSlug ?? null,
						uuidToToolId,
					);
				} catch (error) {
					if (!(error instanceof SkillResourceLimitError)) throw error;
					console.warn(
						`[MCP] Omitting non-conforming skill ${skill.slug ?? skill.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return null;
				}
			},
		);
		return rendered.filter((entry): entry is McpSkillEntry => entry !== null);
	};
	const renderKey = renderedSkillsCacheKey({
		// Bump when the manifest wire shape or rendering rules change; older
		// cached entries may lack the final SEP-2640 `size` property.
		fingerprint: `skills-manifest-v2:${skillSnapshotFingerprint(agent.env)}`,
		appSlug: agent.appSlug ?? "",
		skillRevisions: [...skillIndex.values()].map(
			(skill) => [skill.id, skill.revision ?? null] as const,
		),
		toolIdMap: [...uuidToToolId.entries()],
	});
	let protocolSkillEntries: McpSkillEntry[];
	let renderedHit: Awaited<ReturnType<typeof readRenderedSkills>> = null;
	try {
		renderedHit = await readRenderedSkills(renderKey);
	} catch {
		renderedHit = null;
	}
	if (renderedHit) {
		protocolSkillEntries = renderedHit.entries;
		// SWR: serve the cached render now, refresh once in the background.
		if (renderedHit.stale && reserveRenderedSkillsRevalidate(renderKey)) {
			agent.ctx.waitUntil(
				(async () => {
					try {
						await writeRenderedSkills(renderKey, await renderProtocolSkills());
					} catch (error) {
						console.warn(
							`[MCP] rendered-skills revalidate failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						releaseRenderedSkillsRevalidate(renderKey);
					}
				})(),
			);
		}
	} else {
		protocolSkillEntries = await renderProtocolSkills();
		await writeRenderedSkills(renderKey, protocolSkillEntries);
	}
	const protocolSkillsByUri = new Map(
		protocolSkillEntries.map((entry) => [entry.uri, entry as McpSkillEntry]),
	);
	const protocolSkillPaths = new Set(
		protocolSkillEntries.map((entry) =>
			entry.uri.slice("skill://".length, -"/SKILL.md".length),
		),
	);
	// Deterministic catalog order for cursor pagination: the skillIndex Map's
	// insertion order derives from D1 read order and is not stable across
	// isolates, so sort by uri once here — a cursor minted on one isolate must
	// anchor the same position on the next.
	const sortedProtocolSkills = sortSkillEntriesDeterministically([
		...protocolSkillsByUri.values(),
	]);
	agent.server.server.setRequestHandler(
		"skills/list",
		{ params: ListSkillsParamsSchema, result: ListSkillsResultSchema },
		async ({ cursor }) => {
			const page = paginateSortedSkillsList(sortedProtocolSkills, cursor);
			if (!page.ok) {
				// Spec (2026-07-28 pagination): invalid cursors SHOULD
				// result in -32602 Invalid params.
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					"Invalid params: unrecognized skills/list cursor",
				);
			}
			return {
				skills: page.skills,
				...(page.nextCursor !== undefined
					? { nextCursor: page.nextCursor }
					: {}),
			};
		},
	);
	agent.server.server.setRequestHandler(
		"skills/get",
		{ params: GetSkillParamsSchema, result: GetSkillResultSchema },
		async ({ uri }) => {
			const skill = protocolSkillsByUri.get(uri);
			if (!skill) {
				throw new ProtocolError(
					ProtocolErrorCode.InvalidParams,
					`Unknown skill URI: ${uri}`,
				);
			}
			return { skill };
		},
	);
	// Declaring the extension commits the server to both methods even when the
	// enumerable catalog is empty. Tool/resource conveniences remain absent.
	if (skillIndex.size === 0) return;

	// Register list_skills tool
	const listSkillsCb: ToolCallback = async (args) => {
		const { toolId } = args as { toolId?: string };
		const entries = Array.from(skillIndex.values()).filter((skill) =>
			protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null)),
		);
		const toolUuid = toolId ? (toolIdToUuid.get(toolId) ?? toolId) : null;
		const filtered = toolId
			? entries.filter((s) => s.toolIds?.includes(toolUuid ?? toolId))
			: entries;

		const items = filtered.map((s) => ({
			id: s.id,
			title: s.title,
			summary: s.summary ?? s.description ?? "No description",
			toolIds: s.toolIds,
			source: s.source,
		}));

		return {
			content: [
				{
					type: "text" as const,
					text:
						items.length > 0
							? items
									.map(
										(i) =>
											`- **${i.title}** (${i.id}): ${i.summary}${i.toolIds?.length ? ` [tools: ${i.toolIds.map((id: string) => uuidToToolId.get(id) ?? id).join(", ")}]` : ""}`,
									)
									.join("\n")
							: "No skills found.",
				},
			],
			structuredContent: { skills: items },
		};
	};

	const listSkillsTool = agent.server.registerTool(
		"list_skills",
		{
			title: "List Skills",
			description:
				"List available skills (proven procedures) for this app. Returns summaries — use read_skill to get the full procedure.",
			inputSchema: z.object({
				toolId: z
					.string()
					.optional()
					.describe("Optional: filter skills related to a specific tool"),
			}),
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		wrapToolCallTelemetry(
			"list_skills",
			agent,
			listSkillsCb,
		) as unknown as Parameters<typeof agent.server.registerTool>[2],
	);
	agent.registeredTools.set("list_skills", listSkillsTool);
	agent.appToolIds.add("list_skills");

	// Register read_skill tool
	const readSkillCb: ToolCallback = async (args) => {
		const { skillId } = args as { skillId: string };
		let skill = skillIndex.get(skillId);
		if (!skill) {
			// Fallback: match by slug
			for (const entry of skillIndex.values()) {
				if (entry.slug === skillId) {
					skill = entry;
					break;
				}
			}
		}
		if (!skill) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Skill not found: ${skillId}. Use list_skills to see available skills.`,
					},
				],
				isError: true,
			};
		}
		if (
			!protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null))
		) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Skill ${skillId} exceeds the MCP Skills extension resource limits.`,
					},
				],
				isError: true,
			};
		}

		trackResourceRead(agent, {
			resourceType: "skill",
			skillId: skill.id,
			skillTitle: skill.title,
			source: skill.source,
		});

		return {
			content: [
				{
					type: "text" as const,
					text: renderSkillMarkdown(skill, agent.appSlug ?? null, uuidToToolId),
				},
			],
		};
	};

	const readSkillTool = agent.server.registerTool(
		"read_skill",
		{
			title: "Read Skill",
			description:
				"Read the full procedure content of a skill. Use list_skills first to discover available skills.",
			inputSchema: z.object({
				skillId: z.string().describe("The skill ID or slug from list_skills"),
			}),
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		wrapToolCallTelemetry(
			"read_skill",
			agent,
			readSkillCb,
		) as unknown as Parameters<typeof agent.server.registerTool>[2],
	);
	agent.registeredTools.set("read_skill", readSkillTool);
	agent.appToolIds.add("read_skill");

	// Register skill:// resources (MCP ext-skills WG convention)
	for (const [, skill] of skillIndex) {
		const skillSlug = skill.slug ?? skill.id;
		const skillPath = computeSkillPath(skill, agent.appSlug ?? null);
		if (!protocolSkillPaths.has(skillPath)) continue;
		const resourceId = `skill:${skillPath}`;
		const skillUri = `skill://${skillPath}/SKILL.md`;
		const skillAudience = skill.audience ?? ["assistant"];
		const resourceName = skill.appSlugOverride
			? `${skill.appSlugOverride}/${skillSlug}`
			: skillSlug;

		if (agent.registeredResources.has(resourceId)) continue;

		// SEP: name SHOULD be from frontmatter name (= slug), description from frontmatter description
		const registeredResource = agent.server.registerResource(
			resourceName,
			skillUri,
			{
				description: skill.description || skill.summary || skill.title,
				mimeType: "text/markdown",
				// MCP spec 2025-11-25: audience / priority / lastModified live at top-level.
				annotations: {
					audience: skillAudience.filter(
						(a): a is "user" | "assistant" => a === "user" || a === "assistant",
					),
					priority: 1.0,
					lastModified: toMcpDateTime(skill.updatedAt ?? skill.createdAt),
				},
				// Custom (non-spec) fields stay under _meta with the
				// io.tedix/ prefix per SEP-2640 § _meta key-name format.
				_meta: {
					"io.tedix/frontmatter": {
						version: skill.revision,
						tags: skill.tags ?? [],
						tools: skillToolNames(skill, uuidToToolId),
						audience: skillAudience,
						provenance: `${agent.appSlug ?? "tedix"}.mcp.tedix.dev`,
					},
					"io.tedix/version": skill.revision,
					"io.tedix/tags": skill.tags,
					"io.tedix/toolIds": skill.toolIds,
					"io.tedix/successCount": skill.successCount,
					"io.tedix/size": new TextEncoder().encode(skill.content).length,
					"io.tedix/provenance": {
						source: "d1",
						skillId: skill.id,
						serverUrl: `https://${agent.appSlug ?? "tedix"}.mcp.tedix.dev`,
					},
				},
			},
			async () => {
				trackResourceRead(agent, {
					resourceUri: skillUri,
					resourceType: "skill",
					skillId: skill.id,
					skillTitle: skill.title,
				});

				return {
					contents: [
						{
							uri: skillUri,
							mimeType: "text/markdown",
							text: renderSkillMarkdown(
								skill,
								agent.appSlug ?? null,
								uuidToToolId,
							),
						},
					],
					// SEP-2549: skill content changes on skill mutations — same
					// freshness window as the index/skill-summary cache
					// (consumed + stripped by the transport).
					_meta: {
						[MCP_RESULT_CACHE_HINT_META_KEY]: SKILL_INDEX_CACHE_HINT,
					},
				};
			},
		);

		agent.registeredResources.set(resourceId, registeredResource);
		agent.appResourceIds.add(resourceId);
	}

	// Shared handler for skill:// resource templates
	const handleSkillTemplate = async (
		uri: URL,
		variables: Record<string, string | string[]>,
	) => {
		const skillName = String(variables.skill_name ?? "");
		const appSlug = variables.app_slug ? String(variables.app_slug) : null;
		const skill = Array.from(skillIndex.values()).find(
			(s) =>
				(s.slug ?? s.id) === skillName &&
				(!appSlug ||
					s.appSlugOverride === appSlug ||
					(!s.appSlugOverride && agent.appSlug === appSlug)),
		);

		if (!skill) {
			resourceNotFound(uri, { resourceType: "skill", skillName });
		}
		if (
			!protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null))
		) {
			resourceNotFound(uri, {
				resourceType: "skill",
				filePath: "SKILL.md",
				detail: "Skill exceeds the MCP Skills extension resource limits",
			});
		}

		trackResourceRead(agent, {
			resourceUri: uri.toString(),
			resourceType: "skill",
			skillId: skill.id,
			skillTitle: skill.title,
		});

		return {
			contents: [
				{
					uri: uri.toString(),
					mimeType: "text/markdown",
					text: renderSkillMarkdown(skill, agent.appSlug ?? null, uuidToToolId),
				},
			],
			// SEP-2549: same freshness window as the registered SKILL.md
			// resources above (consumed + stripped by the transport).
			_meta: {
				[MCP_RESULT_CACHE_HINT_META_KEY]: SKILL_INDEX_CACHE_HINT,
			},
		};
	};

	// Folder-style skills handler — serves any file in the skill directory.
	// SEP-2640 directory model: each file in the skill directory is addressable
	// at skill://<skill-path>/{+filePath}. SKILL.md routes to the existing handler;
	// other paths look up `skill.files[filePath]` from D1.
	const handleSkillFile = async (
		uri: URL,
		variables: Record<string, string | string[]>,
	) => {
		let filePath = String(variables.file_path ?? "");
		let skillName = String(variables.skill_name ?? "");
		let appSlug = variables.app_slug ? String(variables.app_slug) : null;
		// Canonical SKILL.md → reuse the markdown frontmatter handler.
		if (filePath === "SKILL.md") return handleSkillTemplate(uri, variables);
		// Defensive: if the flat template matched but `skill_name` is actually an
		// app slug (because the SDK routed an app-scoped URI to the flat template),
		// re-split — first segment becomes app_slug, second becomes skill_name,
		// remainder becomes file_path.
		if (!appSlug) {
			const directHit = Array.from(skillIndex.values()).find(
				(s) => (s.slug ?? s.id) === skillName,
			);
			if (!directHit && filePath.includes("/")) {
				const slash = filePath.indexOf("/");
				const candidateSkill = filePath.slice(0, slash);
				const candidateRest = filePath.slice(slash + 1);
				const recovered = Array.from(skillIndex.values()).find(
					(s) =>
						(s.slug ?? s.id) === candidateSkill &&
						s.appSlugOverride === skillName,
				);
				if (recovered) {
					appSlug = skillName;
					skillName = candidateSkill;
					filePath = candidateRest;
				}
			}
		}
		const skill = Array.from(skillIndex.values()).find(
			(s) =>
				(s.slug ?? s.id) === skillName &&
				(!appSlug ||
					s.appSlugOverride === appSlug ||
					(!s.appSlugOverride && agent.appSlug === appSlug)),
		);
		// Skill-existence + ownership check first. If the requested skill
		// doesn't exist (or doesn't belong to this app), fail with
		// resource_not_found *before* branching into the runs/ subtree —
		// otherwise an attacker could probe `skill://nonexistent/runs/{anyId}/...`
		// and learn whether a run id maps to *some* skill on the platform via timing.
		if (!skill) {
			resourceNotFound(uri, { resourceType: "skill", skillName, filePath });
		}
		if (
			!protocolSkillPaths.has(computeSkillPath(skill, agent.appSlug ?? null))
		) {
			resourceNotFound(uri, {
				resourceType: "skill",
				filePath,
				detail: "Skill exceeds the MCP Skills extension resource limits",
			});
		}
		// runs/{runId}/... paths are dynamic execution artifacts backed by
		// the `skill_run_artifacts` D1 table (+ R2 for spilled payloads).
		// We route through apps/api's `skills.getRunArtifact` procedure
		// rather than touching D1/R2 directly — apps/mcp is the protocol
		// edge, all data fetches go through apps/api.
		if (filePath.startsWith("runs/")) {
			const stripped = filePath.slice("runs/".length);
			const slash = stripped.indexOf("/");
			if (slash === -1) {
				resourceNotFound(uri, {
					resourceType: "skill",
					filePath,
					expectedTemplate: "runs/{runId}/{path}",
				});
			}
			const runId = stripped.slice(0, slash);
			const artifactPath = stripped.slice(slash + 1);
			try {
				const result = await agent.apiClient.skills.getRunArtifact({
					runId,
					path: artifactPath,
					skillId: skill.id,
				});
				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: result.mimeType,
							text: result.content ?? "",
						},
					],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				resourceNotFound(uri, {
					resourceType: "skill",
					filePath,
					detail: message,
				});
			}
		}
		if (!skill.files || !(filePath in skill.files)) {
			resourceNotFound(uri, { resourceType: "skill", skillName, filePath });
		}
		const text = skill.files[filePath]!;
		const lower = filePath.toLowerCase();
		const mimeType = lower.endsWith(".md")
			? "text/markdown"
			: lower.endsWith(".json")
				? "application/json"
				: lower.endsWith(".yaml") || lower.endsWith(".yml")
					? "application/yaml"
					: lower.endsWith(".sh")
						? "text/x-shellscript"
						: lower.endsWith(".py")
							? "text/x-python"
							: lower.endsWith(".js") || lower.endsWith(".ts")
								? "text/javascript"
								: "text/plain";
		return {
			contents: [{ uri: uri.toString(), mimeType, text }],
			// SEP-2549: skill directory files mutate with the skill row — same
			// freshness window as SKILL.md/index reads. The dynamic runs/ branch
			// above deliberately keeps the transport default.
			_meta: {
				[MCP_RESULT_CACHE_HINT_META_KEY]: SKILL_INDEX_CACHE_HINT,
			},
		};
	};

	// Register flat resource template: skill://{skill_name}/SKILL.md
	agent.server.registerResource(
		"skill-template",
		new ResourceTemplate("skill://{skill_name}/SKILL.md", { list: undefined }),
		{
			description:
				"Skill procedure by name. URI: skill://{skill_name}/SKILL.md",
		},
		handleSkillTemplate,
	);

	// Register hierarchical resource template: skill://{app_slug}/{skill_name}/SKILL.md
	agent.server.registerResource(
		"skill-template-app",
		new ResourceTemplate("skill://{app_slug}/{skill_name}/SKILL.md", {
			list: undefined,
		}),
		{
			description:
				"App-scoped skill procedure. URI: skill://{app_slug}/{skill_name}/SKILL.md",
		},
		handleSkillTemplate,
	);

	// SEP-2640 directory model: skill://{skill_name}/{+file_path} serves any file
	// within the skill directory. SKILL.md is canonical; other files come from
	// skill.files (D1 JSON column). This unlocks references/, scripts/, etc.
	// Register app-scoped first so the SDK prefers the more-specific template
	// when both match (e.g. skill://firecrawl-tedix/single-page/.../example.md).
	agent.server.registerResource(
		"skill-file-app",
		new ResourceTemplate("skill://{app_slug}/{skill_name}/{+file_path}", {
			list: undefined,
		}),
		{
			description: "Any file within an app-scoped skill directory.",
		},
		handleSkillFile,
	);
	agent.server.registerResource(
		"skill-file",
		new ResourceTemplate("skill://{skill_name}/{+file_path}", {
			list: undefined,
		}),
		{
			description:
				"Any file within a skill directory (SEP-2640 directory model).",
		},
		handleSkillFile,
	);

	const directoryReadHandler: McpDirectoryReadHandler = ({ uri }) => {
		let parsed: URL;
		try {
			parsed = new URL(uri);
		} catch {
			throw new Error("Invalid URI");
		}
		if (parsed.protocol !== "skill:") {
			throw new Error("Only skill:// directory URIs are supported");
		}
		const segments = [
			parsed.hostname,
			...parsed.pathname.split("/").filter(Boolean),
		].filter(Boolean);
		if (segments.length < 1 || segments[0] === "index.json") {
			throw new Error("Skill directory URI must include a skill name");
		}
		if (segments.at(-1) === "SKILL.md") {
			throw new Error("Skill directory URI must identify a directory");
		}

		let skillName = decodeURIComponent(segments[0] ?? "");
		let appSlug: string | null = null;
		let directoryPath = segments.slice(1).map(decodeURIComponent).join("/");
		let skill = Array.from(skillIndex.values()).find(
			(s) => (s.slug ?? s.id) === skillName,
		);
		if (!skill && segments.length >= 2) {
			appSlug = decodeURIComponent(segments[0] ?? "");
			skillName = decodeURIComponent(segments[1] ?? "");
			directoryPath = segments.slice(2).map(decodeURIComponent).join("/");
			skill = Array.from(skillIndex.values()).find(
				(s) =>
					(s.slug ?? s.id) === skillName &&
					(s.appSlugOverride === appSlug ||
						(!s.appSlugOverride && agent.appSlug === appSlug)),
			);
		}
		if (!skill) throw new Error("Skill directory not found");

		const resources = listSkillDirectoryResources(skill, agent, directoryPath);
		if (!resources) throw new Error("Resource is not a directory");
		return { resources };
	};
	(
		agent.server as unknown as {
			tedixSkillDirectoryReadHandler?: McpDirectoryReadHandler;
		}
	).tedixSkillDirectoryReadHandler = directoryReadHandler;
	// SEP-2640: expose skill-template variable completion; index.ts merges
	// it into the surface's completion handler and advertises `completions`.
	(
		agent.server as unknown as {
			tedixSkillCompletionHandler?: (
				input: McpCompletionRequest,
			) => McpCompletionResult | null;
		}
	).tedixSkillCompletionHandler = buildSkillCompletionHandler({
		skillNames: [...skillNameCandidates],
		appSlugs: [...appSlugCandidates],
	});

	// Build tool→skill map for coupled skill context
	// Skills with toolIds are linked to specific tools — when the tool is called,
	// its skills provide operational context (like widgets provide UI).
	for (const [, skill] of skillIndex) {
		if (!skill.toolIds?.length) continue;
		const skillRef = {
			id: skill.id,
			title: skill.title,
			uri: `skill://${computeSkillPath(skill, agent.appSlug ?? null)}/SKILL.md`,
		};
		for (const refId of skill.toolIds) {
			const resolvedToolId = uuidToToolId.get(refId) ?? refId;
			const existing = agent.toolSkillMap.get(resolvedToolId) ?? [];
			existing.push(skillRef);
			agent.toolSkillMap.set(resolvedToolId, existing);
		}
	}

	// Enrich tool descriptions with linked skill context
	// Like widgets couple UI to tools, skills couple operational knowledge to tools
	for (const [toolId, skillRefs] of agent.toolSkillMap) {
		const registeredTool = agent.registeredTools.get(toolId);
		if (!registeredTool) continue;

		const linkedSkills = skillRefs
			.map((ref) => skillIndex.get(ref.id))
			.filter(Boolean);

		if (linkedSkills.length === 0) continue;

		// Build skill context to append to tool description
		const skillContext = linkedSkills
			.map((s) => {
				const summary = s!.summary ?? s!.description ?? s!.title;
				return `• ${s!.title}: ${summary}`;
			})
			.join("\n");

		const currentDesc = registeredTool.description ?? "";
		const skillUris = skillRefs.map((ref) => ref.uri).join(", ");
		const enrichedDesc = `${currentDesc}\n\n📋 Skills (proven procedures for this tool):\n${skillContext}\n\nUse read_skill or resources/read (${skillUris}) for full procedures.`;

		registeredTool.update({ description: enrichedDesc });
	}

	const toolLinkedCount = agent.toolSkillMap.size;
	console.log(
		`[MCP] Registered ${skillIndex.size} skill(s): list_skills + read_skill tools + ${skillIndex.size} resource(s) + ${toolLinkedCount} tool-linked skill(s)`,
	);
}

// =============================================================================
// PROMPTS
// =============================================================================

/**
 * Register app prompts from D1 app_tools rows with toolTypeId="prompt".
 *
 * Each prompt tool defines:
 *   - toolId: prompt name
 *   - title / description: shown in the host's prompt picker
 *   - inputSchema: prompt arguments (always rendered as strings per MCP spec)
 *   - config.template: template string with {{argName}} substitution placeholders
 */
export async function registerAppPrompts(agent: ServerContext): Promise<void> {
	const promptTools = Array.from(agent.loadedTools.values()).filter(
		(t) => t.toolTypeId === "prompt",
	);

	if (promptTools.length === 0) return;

	console.log(`[MCP] Registering ${promptTools.length} prompt(s)`);

	for (const tool of promptTools) {
		const config = (tool.config ?? {}) as Record<string, unknown>;
		const template = config.template;
		if (typeof template !== "string") {
			console.warn(
				`[registerAppPrompts] Skipping "${tool.toolId}": missing template string in config`,
			);
			continue;
		}

		// Build argsSchema — MCP prompt args are always strings
		const argsSchema: Record<string, z.ZodString> = {};
		const inputMap = jsonSchemaToToolInputSchema(tool.inputSchema);
		if (inputMap) {
			for (const [key, field] of Object.entries(inputMap)) {
				argsSchema[key] = z.string().describe(field.description ?? key);
			}
		}

		const promptCb: PromptCallback = (args) => {
			let text = template;
			for (const [key, value] of Object.entries(
				args as Record<string, string>,
			)) {
				text = text.replaceAll(`{{${key}}}`, value);
			}

			return {
				messages: [
					{
						role: "user" as const,
						content: { type: "text" as const, text },
					},
				],
			};
		};

		const registered = agent.server.registerPrompt(
			tool.toolId,
			{
				title: tool.title,
				description: tool.description ?? tool.title,
				argsSchema: z.object(argsSchema),
				// SEP-973: surface prompt icons when the D1 row carries them.
				...(tool.icons ? { icons: tool.icons } : {}),
			},
			wrapPromptGetTelemetry(
				tool.toolId,
				agent,
				promptCb,
			) as unknown as Parameters<typeof agent.server.registerPrompt>[2],
		);

		agent.registeredPrompts.set(tool.toolId, registered);
	}
}

// =============================================================================
// SHARED DETAIL RESOURCE — host modal for item detail views
// =============================================================================

/**
 * Register the shared item-detail widget resource for host modal detail views.
 *
 * When inline widgets call `window.openai.requestModal({ template })`, the host
 * opens this resource as a separate iframe. Using a dedicated template avoids
 * the BrowserRouter detection error that occurs when requestModal is called
 * without a template on Astro MPA widgets.
 *
 * Called once per app after widget tools are registered.
 */
async function registerDetailResource(agent: ServerContext): Promise<void> {
	const appSlug = agent.app?.slug;
	if (!appSlug) return;

	const widgetVersion = getWidgetVersion(agent.env);
	const widgetRoute = "/r/item-detail";
	const { appsSdk: appsSdkUri, mcpApp: mcpAppUri } = buildResourceUris(
		appSlug,
		widgetRoute,
		widgetVersion,
	);
	const widgetDomain = agent.getWidgetDomain();

	// Apps SDK resource (ChatGPT)
	const appsSdkId = "widget-item-detail";
	if (!agent.registeredResources.has(appsSdkId)) {
		const res = agent.server.registerResource(
			appsSdkId,
			appsSdkUri,
			{ description: "Item detail modal view" },
			async () => {
				const [html, csp] = await Promise.all([
					agent.fetchWidgetHtml(widgetRoute, "Item detail", "apps-sdk"),
					agent.buildAppCsp(undefined as unknown as AppTool),
				]);

				return {
					contents: [
						{
							uri: appsSdkUri,
							mimeType: WIDGET_MIME_TYPES.APPS_SDK,
							text: html,
							_meta: {
								"openai/widgetDescription": "Item detail view",
								"openai/widgetPrefersBorder": true,
								"openai/widgetDomain": widgetDomain,
								"openai/widgetCSP": csp,
							},
						},
					],
					// Static deploy-versioned template → long public freshness hint
					// (consumed + stripped by the transport).
					_meta: {
						[MCP_RESULT_CACHE_HINT_META_KEY]: WIDGET_RESOURCE_CACHE_HINT,
					},
				};
			},
		);
		if (res) {
			agent.registeredResources.set(appsSdkId, res);
			agent.appResourceIds.add(appsSdkId);
		}
	}

	// MCP-App resource
	const mcpAppId = "mcp-app-item-detail";
	if (!agent.registeredResources.has(mcpAppId)) {
		const res = agent.server.registerResource(
			mcpAppId,
			mcpAppUri,
			{ description: "Item detail modal view (mcp-app)" },
			async () => {
				const [html, csp] = await Promise.all([
					agent.fetchWidgetHtml(widgetRoute, "Item detail", "mcp-app"),
					agent.buildAppCsp(undefined as unknown as AppTool),
				]);

				return {
					contents: [
						{
							uri: mcpAppUri,
							mimeType: WIDGET_MIME_TYPES.MCP_APP,
							text: html,
							_meta: {
								ui: {
									domain: widgetDomain,
									prefersBorder: true,
									csp: {
										resourceDomains: csp.resource_domains,
										connectDomains: csp.connect_domains,
										frameDomains: csp.frame_domains,
										redirectDomains: csp.redirect_domains,
									},
								},
							},
						},
					],
					// Static deploy-versioned template → long public freshness hint
					// (consumed + stripped by the transport).
					_meta: {
						[MCP_RESULT_CACHE_HINT_META_KEY]: WIDGET_RESOURCE_CACHE_HINT,
					},
				};
			},
		);
		if (res) {
			agent.registeredResources.set(mcpAppId, res);
			agent.appResourceIds.add(mcpAppId);
		}
	}

	console.log(`[MCP] Registered item-detail modal resource: ${appsSdkUri}`);
}

// =============================================================================
// APP TOOLS (orchestrator)
// =============================================================================

/**
 * Register all app-specific tools from D1 app_tools table.
 * This is the primary registration method called after app context is loaded.
 */
export async function registerAppTools(agent: ServerContext): Promise<void> {
	if (!agent.appId) {
		console.warn("[MCP] No app ID for tool registration, using bootstrap");
		return;
	}

	// Tools are pre-loaded into loadedTools by server-factory
	const tools = Array.from(agent.loadedTools.values());

	if (tools.length === 0) {
		console.log(`[MCP] No D1 tools found for app: ${agent.appSlug}`);
		return;
	}

	console.log(
		`[MCP] Registering ${tools.length} tools for app ${agent.appSlug}`,
	);

	// Track resource URIs across tools to handle shared widgetKeys
	const registeredResourceUris = new Set<string>();
	const d1ToolIds = new Set(tools.map((t) => t.toolId));
	const keptBootstrapTools: string[] = [];

	for (const bootstrapToolId of BOOTSTRAP_TOOL_IDS) {
		if (!d1ToolIds.has(bootstrapToolId)) {
			keptBootstrapTools.push(bootstrapToolId);
		}
	}

	for (const tool of tools) {
		const existingBootstrap = agent.registeredTools.get(tool.toolId);
		if (existingBootstrap && !agent.appToolIds.has(tool.toolId)) {
			const isKnownBootstrap = BOOTSTRAP_TOOL_IDS.has(tool.toolId);
			try {
				existingBootstrap.remove();
				agent.registeredTools.delete(tool.toolId);
				if (isKnownBootstrap) {
					console.log(`[MCP] D1 tool "${tool.toolId}" replaces bootstrap tool`);
				} else {
					console.log(
						`[MCP] Removed existing tool: ${tool.toolId} (replacing with D1 version)`,
					);
				}
			} catch (error) {
				log.warn("Failed to replace bootstrap tool", {
					event: "tool_registration.bootstrap_removal_failed",
					appId: agent.appId,
					toolName: tool.toolId,
					outcome: "unavailable",
					error,
				});
			}
		}

		try {
			await registerDynamicTool(agent, tool, registeredResourceUris);
		} catch (error) {
			log.error("Failed to register tool", {
				event: "tool_registration.failed",
				appId: agent.appId,
				toolName: tool.toolId,
				outcome: "unavailable",
				error,
			});
		}
	}

	for (const keptToolId of keptBootstrapTools) {
		console.log(`[MCP] Using bootstrap tool "${keptToolId}" (no D1 override)`);
	}

	// GenUI authoring tools are MCP-native bootstrap tools because
	// design_widget_ui uses MCP sampling; expose them on operator surfaces.
	await registerGenUiAuthoringTools(agent);

	// Register shared detail resource for host modal views
	const hasWidgetTools = Array.from(agent.loadedTools.values()).some(
		(t) => resolveToolWidgetRoute(t) !== null,
	);
	if (hasWidgetTools) {
		await registerDetailResource(agent);
	}

	const toolScopes = agent.appMetadata?.mcpConfig?.toolScopes as
		| Record<string, string[]>
		| undefined;
	if (toolScopes) {
		for (const [toolId, scopes] of Object.entries(toolScopes)) {
			if (scopes && scopes.length > 0) {
				agent.authRequiredTools.add(toolId);
			}
		}
	}
}
