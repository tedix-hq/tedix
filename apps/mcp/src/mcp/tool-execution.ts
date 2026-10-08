import { sanitizeToolName } from "@cloudflare/codemode";
import { tracing } from "cloudflare:workers";
import { resolveMcpToolNamespace } from "@tedix/mcp-shared/auth/tool-scopes";
import { isOrganizationMountNamespace } from "./aggregate-namespaces";
import { contentFreeMcpException, createMcpLogger } from "../log";
/**
 * Tool Execution Module
 *
 * Handles executing tools through the handler pipeline. Builds widget
 * metadata.
 *
 * Telemetry layering:
 * - Standard `tools/call` dispatch is wrapped by wrapToolCallTelemetry
 *   (`apps/mcp/src/mcp/middleware/telemetry.ts`) at registration time —
 *   fires once per protocol tool call. executeTool does not emit in that
 *   path.
 * - Code Mode inner sandbox calls reach executeTool via Workers RPC, not
 *   through the SDK protocol layer, so middleware never sees them. When
 *   `options.executionId` is set (only codemode.ts sets it), we emit a
 *   per-inner-call `tool_call` event keyed by `executionId` so observability
 *   drilldown can JOIN code_exec ↔ inner tool_calls.
 *
 * The gate is `options.executionId` — non-Code-Mode callers never set it,
 * so middleware remains the only emitter for them.
 *
 * @module @tedix/mcp/mcp/tool-execution
 */

import {
	type AdapterScope,
	parseAdapterScope,
	resolveToolAnnotations,
	type ResultStrategy,
	type ToolConfig,
} from "@tedix/api-contract/schemas/tools";
import { buildCompletionEvidence } from "@tedix/api-contract/schemas/execution-evidence";
import {
	mcpInventoryListChangedKinds,
	publishMcpInventoryListChanged,
	publishMcpTaskNotification,
} from "../subscription-publisher";
import {
	createGenericTask,
	GENERIC_TASK_POLL_INTERVAL_MS,
	GENERIC_TASK_TTL_MS,
	newGenericTaskId,
	setGenericTaskWorkflowId,
} from "./generic-task-store";
import type { ToolExecutionContext } from "./handler";
import {
	READ_COLLECTION_META_KEY,
	READ_OBSERVATION_META_KEY,
	parseConnectedCollectionRead,
} from "@tedix/mcp-shared/read-observation-receipt";
import { homeQueuedAckText } from "./home-surface";
import {
	OS_GADGET_RUN_ENDPOINT,
	OS_GADGET_TASK_PREFIX,
} from "./os-gadget-task";
import type { AppTool, ServerContext } from "./server-context";
import {
	buildEnrichmentRequest,
	invokeTediEnrichment,
} from "./tedi-enrichment";
import type { OpenAiWidgetMeta } from "./types";
import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	getJsonSize,
	type McpEvent,
	normalizeMcpErrorCode,
	trackMcpEvent,
	truncateErrorMessage,
} from "./utils/analytics";
import { toolRiskAuditMetadata } from "./tool-risk-policy";
import { normalizeOpenApiExternalArgs } from "./utils/openapi-args";
import { normalizeOpenApiStructuredContent } from "./utils/openapi-output";
import {
	capturePayloadRecord,
	redactAndTruncate,
} from "./utils/payload-capture";
import { getWidgetVersion } from "./utils/register-widget";
import { resolveToolWidgetRoute } from "./utils/render-widget";
import { validateStructuredContentAgainstOutputSchema } from "./utils/schema";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const log = createMcpLogger("mcp.tool_execution");

function connectedCollectionRead(agent: ServerContext, tool: AppTool) {
	const config = tool.config;
	if (!config) return null;
	const auth = isRecord(config.auth) ? config.auth : null;
	const connectionProviderId =
		typeof config._aggregateConnectionProviderId === "string"
			? config._aggregateConnectionProviderId
			: auth?.type === "connection" && typeof auth.connectionId === "string"
				? auth.connectionId
				: null;
	if (!connectionProviderId) return null;
	const annotations = resolveToolAnnotations({
		annotations: tool.annotations,
		writeCapability: tool.writeCapability ?? null,
		meta: tool.meta,
	});
	if (annotations?.readOnlyHint !== true) return null;
	const source = {
		appId:
			typeof config._sourceAppId === "string"
				? config._sourceAppId
				: agent.appId,
		appSlug:
			typeof config._sourceAppSlug === "string"
				? config._sourceAppSlug
				: agent.appSlug,
		toolName: tool.toolId,
		connectionProviderId,
	};
	const base = {
		version: 1,
		kind: "connected_collection_read",
		source,
		observedAt: new Date().toISOString(),
	};
	// Only D1 app-tool configuration may name a collection. Missing or invalid
	// declarations stay explicit unknowns; a tool name is not a resource type.
	return (
		parseConnectedCollectionRead({
			...base,
			collection: config.readCollection,
		}) ?? parseConnectedCollectionRead({ ...base, collection: null })
	);
}

function buildWidgetUiMeta(
	agent: ServerContext,
	resourceUri: string,
): Record<string, unknown> {
	const app = {
		id: agent.appId,
		slug: agent.appSlug,
		name: agent.app?.name ?? agent.appSlug,
		...(agent.app?.logoUrl ? { logoUrl: agent.app.logoUrl } : {}),
	};

	return {
		resourceUri,
		app,
	};
}

async function traceToolExecution<T>(
	agent: ServerContext,
	tool: AppTool,
	executionId: string | undefined,
	run: () => Promise<T>,
): Promise<T> {
	// Workers custom spans are beta: diagnostic timing only, never an SLO
	// gate or proof artifact. Tool identity is enough; arguments and results
	// may contain tenant data and must stay out of span attributes.
	return tracing.enterSpan("tedix.mcp.tool_call", async (span) => {
		span.setAttribute("tedix.trace_id", agent.traceId);
		span.setAttribute("tedix.app_id", agent.appId);
		span.setAttribute("tedix.tool_id", tool.toolId);
		if (executionId) span.setAttribute("tedix.execution_id", executionId);
		return run();
	});
}

/**
 * Execute a tool using the handler registry.
 *
 * When a tool has a toolTypeId, we use the corresponding ToolHandler.
 * For non-Code-Mode dispatch, errors propagate to the wrapToolCallTelemetry
 * wrapper which records the failed event. For Code Mode inner calls
 * (executionId set), we emit success/failure events here keyed by the
 * code_exec parent's executionId.
 */
export async function executeTool(
	agent: ServerContext,
	tool: AppTool,
	args: Record<string, unknown>,
	options: {
		adapterScope: AdapterScope;
		resultStrategy: ResultStrategy;
		executionId?: string;
		clientSupportsTasks?: boolean;
		/** Verified owner-host Agent-Session for this Code Mode execution. */
		ownerHostSessionId?: string;
	},
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	structuredContent: unknown;
	_meta: OpenAiWidgetMeta;
	/** MCP convention — set on handler-thrown errors and upstream status >= 400. */
	isError?: boolean;
}> {
	if (options.ownerHostSessionId && agent.callerIdentity) {
		agent = {
			...agent,
			callerIdentity: {
				...agent.callerIdentity,
				ownerHostSessionId: options.ownerHostSessionId,
			},
		};
	}
	const toolTypeId = tool.toolTypeId;
	const toolConfig = tool.config;
	if (
		agent.appSlug === "connect" &&
		agent.appMetadata?.mcpConfig?.multiOrgConsent === true
	) {
		const verified = agent.callerIdentity?.verifiedMultiOrgOrganizations;
		if (agent.callerIdentity?.authType !== "oauth" || !verified?.length) {
			throw new Error("A live multi-organization consent is required");
		}
		if (tool.toolId !== "code") {
			const target = (toolConfig as Record<string, unknown> | null)
				?._multiOrgOrganizationId;
			const selected = verified.find((org) => org.organizationId === target);
			const toolNamespace = tool.toolId.split("__", 1)[0] ?? "";
			if (
				!selected ||
				!tool.toolId.includes("__") ||
				!isOrganizationMountNamespace(
					selected.gatewaySlug,
					toolNamespace.replace(/[^a-zA-Z0-9_]/g, "_"),
				)
			) {
				throw new Error("Tool is outside the selected organizations");
			}
			agent = {
				...agent,
				callerIdentity: {
					...agent.callerIdentity,
					organizationId: selected.organizationId,
					// A Connect grant is human authority. A hosting-org tedi must
					// not select credentials or audit identity in the target org.
					tediId: undefined,
				},
			};
		}
	}

	if (!toolTypeId) {
		throw new Error(
			`Tool "${tool.toolId}" has no registered handler. All tools must have a toolTypeId that maps to a ToolHandler.`,
		);
	}

	// Code Mode inner-call telemetry — see module docstring. The middleware
	// owns non-Code-Mode telemetry and never sees inner sandbox dispatches.
	if (!options.executionId) {
		return traceToolExecution(agent, tool, undefined, () =>
			executeWithHandler(
				agent,
				tool,
				(toolConfig ?? {}) as unknown as ToolConfig,
				args,
				undefined,
				options.clientSupportsTasks,
			),
		);
	}

	const startTime = Date.now();
	const callerFields = buildCallerTelemetryFields(agent.callerIdentity);
	const baseEvent: Partial<McpEvent> = {
		timestamp: new Date().toISOString(),
		eventType: "tool_call",
		appId: agent.appId,
		appSlug: agent.appSlug,
		organizationId: agent.app?.organizationId,
		toolName: tool.toolId,
		toolInputSize: getJsonSize(args),
		...callerFields,
		traceId: agent.traceId,
		executionId: options.executionId,
		metadata: {
			...callerFields.metadata,
			...toolRiskAuditMetadata(tool),
		},
	};
	const waitUntil = agent.ctx.waitUntil.bind(agent.ctx);
	const capturePayloads = (
		agent.appMetadata?.mcpConfig as
			| { capturePayloads?: boolean }
			| null
			| undefined
	)?.capturePayloads;

	try {
		const result = await traceToolExecution(
			agent,
			tool,
			options.executionId,
			() =>
				executeWithHandler(
					agent,
					tool,
					(toolConfig ?? {}) as unknown as ToolConfig,
					args,
					options.executionId,
					options.clientSupportsTasks,
				),
		);
		const errorMessage = result.isError
			? truncateErrorMessage(
					result.content.find((content) => content.type === "text")?.text ??
						"Tool returned isError without text content",
				)
			: undefined;
		const event: McpEvent = {
			...baseEvent,
			success: !result.isError,
			durationMs: Date.now() - startTime,
			toolOutputSize: getJsonSize(result),
			...(typeof result.tokensUsed === "number"
				? { tokensUsed: result.tokensUsed }
				: {}),
			...(errorMessage ? { errorMessage } : {}),
		} as McpEvent;
		trackMcpEvent(agent.env, event);
		emitMcpAuditEvent(agent.env, event, waitUntil);
		const inputCap = redactAndTruncate(args);
		const outputCap = redactAndTruncate(result);
		capturePayloadRecord(
			agent.env,
			agent.ctx,
			{
				traceId: agent.traceId ?? "",
				executionId: options.executionId ?? "",
				appId: agent.appId ?? "",
				appSlug: agent.appSlug ?? "",
				organizationId: agent.app?.organizationId ?? "",
				toolName: tool.toolId,
				eventType: "tool_call",
				success: result.isError ? 0 : 1,
				errorCode: "",
				durationMs: event.durationMs ?? 0,
				timestamp: event.timestamp,
				userId: event.userId ?? "",
				tediId: event.tediId ?? "",
				authType: event.authType ?? "",
				inputArgs: inputCap.json,
				inputBytes: inputCap.bytes,
				outputBody: outputCap.json,
				outputBytes: outputCap.bytes,
				truncated: inputCap.truncated || outputCap.truncated ? 1 : 0,
			},
			capturePayloads,
		);
		return result;
	} catch (error) {
		const event: McpEvent = {
			...baseEvent,
			success: false,
			durationMs: Date.now() - startTime,
			errorCode: normalizeMcpErrorCode(error),
			errorMessage: truncateErrorMessage(
				error instanceof Error ? error.message : String(error),
			),
		} as McpEvent;
		trackMcpEvent(agent.env, event);
		emitMcpAuditEvent(agent.env, event, waitUntil);
		const inputCap = redactAndTruncate(args);
		capturePayloadRecord(
			agent.env,
			agent.ctx,
			{
				traceId: agent.traceId ?? "",
				executionId: options.executionId ?? "",
				appId: agent.appId ?? "",
				appSlug: agent.appSlug ?? "",
				organizationId: agent.app?.organizationId ?? "",
				toolName: tool.toolId,
				eventType: "tool_call",
				success: 0,
				errorCode: normalizeMcpErrorCode(error),
				durationMs: event.durationMs ?? 0,
				timestamp: event.timestamp,
				userId: event.userId ?? "",
				tediId: event.tediId ?? "",
				authType: event.authType ?? "",
				inputArgs: inputCap.json,
				inputBytes: inputCap.bytes,
				outputBody: "",
				outputBytes: 0,
				truncated: inputCap.truncated ? 1 : 0,
			},
			capturePayloads,
		);
		throw error;
	}
}

/**
 * Execute a tool using the ToolHandler registry.
 *
 * ── PLANNED MIGRATION: structuredContent → _meta split ──
 *
 * Currently, `structuredContent` carries all data — both model-relevant
 * summaries and heavy widget-rendering payloads (items array, pagination,
 * listingGroups, raw adapter data). This means the model context window
 * receives large item arrays it doesn't need.
 *
 * Target state:
 *   structuredContent: {
 *     query, totalResults, summary, sources (top 5), appCapabilities
 *   }
 *   _meta: {
 *     items, pagination, query, batchMode, listingGroups, layoutSpec,
 *     ...all fields the widget needs for rendering
 *   }
 *
 * Widget-side impact:
 *   - Widgets currently read from `toolInfo.output` (maps to structuredContent)
 *   - After migration, widgets must also read from `toolInfo.responseMetadata`
 *     (maps to _meta) for heavy data (items, pagination, etc.)
 *   - Both `toolInfo.output` and `toolInfo.responseMetadata` must be populated
 *     during the transition so existing widgets don't break
 *
 * Coordination required:
 *   - packages/widget-ui hooks (useWidgetProps, useWidgetState) must be
 *     updated to merge data from both sources
 *   - apps/mcp-ui pages that destructure from toolInfo.output need updating
 *   - This change should be done atomically with the widget-side changes
 *
 * See: MCP Apps extension standard for _meta usage guidance.
 * ────────────────────────────────────────────────────────────
 */
async function executeWithHandler(
	agent: ServerContext,
	tool: AppTool,
	toolConfig: ToolConfig,
	args: Record<string, unknown>,
	executionId?: string,
	clientSupportsTasks?: boolean,
): Promise<{
	content: Array<{ type: "text"; text: string }>;
	structuredContent: unknown;
	_meta: OpenAiWidgetMeta;
	tokensUsed?: number;
	/** MCP convention — set on handler-thrown errors and upstream status >= 400. */
	isError?: boolean;
}> {
	// ── Capability-gated generic async task (io.modelcontextprotocol/tasks) ──
	// A tool config can opt into out-of-band execution with `_asyncTask: true`.
	// When the caller also opted into the Tasks extension, create an mcp_tasks
	// row, kick the GenericTasksWorkflow, and return a protocol-native task
	// envelope (the resultTransform in index.ts rewrites the `tedix/genericTask`
	// _meta marker into McpCreateTaskResult). Without client opt-in, fall through
	// to synchronous execution (unchanged). Code Mode inner calls (executionId
	// set) always run synchronously — the gate only applies to top-level calls.
	if (
		toolConfig.transport === "catalog" &&
		(toolConfig as unknown as Record<string, unknown>)._asyncTask === true
	) {
		throw new Error("Catalog transport cannot run as an async task");
	}
	const asyncTaskRequested =
		(toolConfig as unknown as Record<string, unknown>)._asyncTask === true &&
		// The generic task workflow replays a service identity later and cannot
		// recheck this human's Descope consent at execution time.
		!agent.callerIdentity?.verifiedMultiOrgOrganizations;
	const genericTaskOrgId =
		agent.callerIdentity?.organizationId ?? agent.app?.organizationId;
	// ── [security] Block destructive _asyncTask deferral ──
	// A destructive tool deferred out-of-band would run later under replayed (and
	// possibly since-revoked) authority with no live confirmation channel. Refuse
	// deferral for `annotations.destructiveHint === true` so destructive tools run
	// synchronously under live authority, unless a per-tool config opt-in
	// (`allowDestructiveAsync === true`) explicitly accepts the risk.
	// The declared capability counts here too. A tool declared destructive with
	// no upstream annotations was deferrable — it would run asynchronously under
	// replayed, possibly-since-revoked authority with no live confirmation
	// channel, which is exactly the risk this block exists to refuse. The
	// declaration is the authority on what a tool does; `annotations` is just
	// one way it can be expressed.
	const destructiveAsyncBlocked =
		(tool.writeCapability === "destructive" ||
			tool.annotations?.destructiveHint === true) &&
		(toolConfig as unknown as Record<string, unknown>).allowDestructiveAsync !==
			true;
	// ── [correctness] Block _asyncTask for transports/auth the Workflow can't replay ──
	// GenericTasksWorkflow snapshots only the rpc/rest dispatch config (transport,
	// endpoint, method, responsePath) and runs under the service-binding identity.
	// So two opt-in combinations would silently fail if deferred:
	//   • transport "external"/"mcp" — the Workflow has no ServerContext to inject
	//     the outbound credential, so the dispatch returns method-not-found.
	//   • `_forwardCallerAuth: true` — the tool needs the live caller's user/oauth
	//     authority (e.g. send-as-user); the Workflow cannot replay it, so the
	//     dispatch loses the speaker and fails closed (401) or acts as the wrong
	//     principal. Refuse deferral and run synchronously under live authority.
	const asyncTransport = String(
		(toolConfig as unknown as Record<string, unknown>).transport ?? "",
	);
	const asyncTaskUnsupportedForTool =
		asyncTransport === "external" ||
		asyncTransport === "mcp" ||
		(toolConfig as unknown as Record<string, unknown>)._forwardCallerAuth ===
			true;
	if (asyncTaskRequested && asyncTaskUnsupportedForTool) {
		console.warn(
			JSON.stringify({
				_cm: "asyncGuard",
				tool: tool.toolId,
				transport: asyncTransport,
				forwardsCallerAuth:
					(toolConfig as unknown as Record<string, unknown>)
						._forwardCallerAuth === true,
				action: "ran_synchronously",
				reason:
					"_asyncTask not supported for external/mcp transport or caller-auth-forwarding tools; GenericTasksWorkflow cannot replay the credential",
			}),
		);
	}
	// ── Async-task deferral gate (DO NOT "simplify" the `!executionId` clause) ──
	// `clientSupportsTasks === true` requires the caller opted into the Tasks
	// extension. `!executionId` requires this be a TOP-LEVEL call: Code Mode
	// inner tool invocations always carry an `executionId` (set by the codemode
	// sandbox dispatch path). Inner calls must not defer into an out-of-band
	// task — they run synchronously inside the sandbox turn by design, because
	// an inner call has no protocol channel to emit/poll a task envelope back to
	// the originating Code Mode script. So async-task deferral intentionally
	// applies only to top-level (non-Code-Mode) calls. Dropping `!executionId`
	// would let inner calls strand work in mcp_tasks rows no inner caller polls.
	if (
		asyncTaskRequested &&
		clientSupportsTasks === true &&
		!executionId &&
		genericTaskOrgId &&
		!destructiveAsyncBlocked &&
		!asyncTaskUnsupportedForTool
	) {
		const taskId = newGenericTaskId();
		const nowIso = new Date().toISOString();
		const workflow = (
			agent.env as unknown as {
				GENERIC_TASKS_WORKFLOW?: {
					create(opts: { params: { taskId: string } }): Promise<{
						id: string;
					}>;
				};
			}
		).GENERIC_TASKS_WORKFLOW;
		try {
			// Snapshot the minimal execution config so the GenericTasksWorkflow can
			// dispatch the tool out-of-band (rpc/rest transport) without rebuilding
			// a ServerContext. Other transports are recorded but reported as a seam.
			const cfg = toolConfig as unknown as Record<string, unknown>;
			const execConfig = {
				...(typeof cfg.transport === "string"
					? { transport: cfg.transport }
					: {}),
				...(typeof cfg.endpoint === "string" ? { endpoint: cfg.endpoint } : {}),
				...(typeof cfg.method === "string" ? { method: cfg.method } : {}),
				...(typeof cfg.responsePath === "string"
					? { responsePath: cfg.responsePath }
					: {}),
			};
			// Capture durable caller-IDENTITY REFERENCES (never a token/scopes/
			// credentialMode) so the workflow can replay the caller's authority on
			// the dispatch and apps/api re-derives the credential leg + re-validates
			// authority server-side. With no caller identity (anonymous/app-only),
			// degrade to a bare service caller scoped to the resolved org — this
			// preserves today's service-binding-only behavior (no regression).
			const ci = agent.callerIdentity;
			const caller = ci
				? {
						...(ci.authType ? { authType: ci.authType } : {}),
						...(ci.userId ? { userId: ci.userId } : {}),
						...(ci.tediId ? { tediId: ci.tediId } : {}),
						organizationId: ci.organizationId ?? genericTaskOrgId,
						...(ci.clientId ? { clientId: ci.clientId } : {}),
						...(ci.kernel === true ? { kernel: true as const } : {}),
						...(agent.connectionLabel
							? { connectionLabel: agent.connectionLabel }
							: {}),
					}
				: { authType: "service" as const, organizationId: genericTaskOrgId };
			await createGenericTask({
				db: agent.env.DB,
				taskId,
				orgId: genericTaskOrgId,
				appId: agent.appId,
				toolName: tool.toolId,
				toolId: tool.id ?? null,
				inputArgs: args,
				caller,
				...(Object.keys(execConfig).length > 0 ? { execConfig } : {}),
			});
			agent.ctx.waitUntil?.(
				publishMcpTaskNotification({
					env: agent.env,
					appId: agent.appId,
					organizationId: genericTaskOrgId,
					state: {
						taskId,
						status: "working",
						createdAt: nowIso,
						lastUpdatedAt: nowIso,
						ttlMs: GENERIC_TASK_TTL_MS,
						pollIntervalMs: GENERIC_TASK_POLL_INTERVAL_MS,
					},
				}),
			);
			if (workflow) {
				const instance = await workflow.create({ params: { taskId } });
				// The workflow instance id only exists after `workflow.create`, so
				// persist it as a follow-up update on the row we just inserted. This
				// populates the indexed `mcp_tasks.workflow_id` column for
				// task↔instance correlation.
				await setGenericTaskWorkflowId(
					agent.env.DB,
					taskId,
					genericTaskOrgId,
					instance.id,
				);
			} else {
				console.warn(
					`[executeWithHandler] GENERIC_TASKS_WORKFLOW binding absent; task ${taskId} created without an executor (deploy-gated).`,
				);
			}
		} catch (error) {
			log.error("Generic task creation failed; executing synchronously", {
				event: "tool_execution.task_create_failed",
				appId: agent.appId,
				toolName: tool.toolId,
				traceId: agent.traceId,
				taskId,
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
			// Fall through to synchronous execution on task-setup failure.
		}

		return {
			content: [
				{
					type: "text" as const,
					text: `Started "${tool.title}" as a background task (id ${taskId}). Poll tasks/get for the result.`,
				},
			],
			structuredContent: { taskId, status: "working" },
			_meta: {
				"tedix/genericTask": {
					taskId,
					status: "working",
					createdAt: nowIso,
					lastUpdatedAt: nowIso,
					ttlMs: GENERIC_TASK_TTL_MS,
					pollIntervalMs: GENERIC_TASK_POLL_INTERVAL_MS,
				},
			} as unknown as OpenAiWidgetMeta,
		};
	}

	const widgetVersion = getWidgetVersion(agent.env);
	// All tool types route to the unified ToolHandler (transport dispatch inside execute())

	const handler = agent.toolHandler;

	const adapterScope = parseAdapterScope(tool.adapterScope);
	const resultStrategy = tool.resultStrategy as
		| "merge"
		| "first_success"
		| "parallel_all"
		| undefined;

	const ctx: ToolExecutionContext<ToolConfig> = {
		appId: agent.appId,
		app: agent.app,
		appCapabilities: agent.appCapabilities,
		env: agent.env,
		config: toolConfig,
		catalogTransport: agent.catalogTransport,
		toolId: tool.toolId,
		callable: `${resolveMcpToolNamespace(tool, agent.appMetadata?.mcpConfig?.codeModeNamespaces as Record<string, string> | undefined)}.${sanitizeToolName(tool.toolId.includes("__") ? tool.toolId.split("__").slice(1).join("__") : tool.toolId)}`,
		toolInputSchema: tool.inputSchema,
		requestId: crypto.randomUUID(),
		traceId: agent.traceId,
		tracestate: agent.tracestate,
		requestMeta: agent.requestMeta,
		executionId,
		adapterScope,
		resultStrategy,
		appMetadata: agent.appMetadata as Record<string, unknown> | null,
		callerIdentity: agent.callerIdentity,
		connectionLabel: agent.connectionLabel,
		bearerToken: agent.bearerToken,
		clientSupportsTasks,
	};

	try {
		// Tedi enrichment policy
		const mcpConfig = agent.appMetadata?.mcpConfig as
			| Record<string, unknown>
			| undefined;
		const tediPolicy =
			toolConfig.transport === "catalog"
				? undefined
				: (mcpConfig?.tediPolicy as
						| {
								enabled?: boolean;
								tediId?: string;
								allowedTools?: string[];
								blockedTools?: string[];
								maxTokens?: number;
								timeoutMs?: number;
						  }
						| undefined);

		// When tedi enrichment is enabled, skip built-in AI generation —
		// the tedi generates answers with domain expertise instead of generic Workers AI.
		// Only affects tools that accept a `generateAnswer` param (e.g., content_answer).
		let effectiveArgs = { ...args };
		if (tediPolicy?.enabled && tediPolicy.tediId) {
			if (
				"generateAnswer" in effectiveArgs ||
				toolConfig.endpoint === "content/answer"
			) {
				effectiveArgs.generateAnswer = false;
			}
		}
		if (
			toolConfig.transport === "external" &&
			tool.schemaSource === "openapi"
		) {
			effectiveArgs = normalizeOpenApiExternalArgs(
				effectiveArgs,
				tool.inputSchema,
			);
		}

		const result = await handler.execute(effectiveArgs, ctx);
		let structuredContent: unknown = handler.buildStructuredContent(
			result,
			ctx,
		);
		let textContent = handler.buildTextContent(result, ctx);

		let tediLayoutSpec: Record<string, unknown> | undefined;
		if (tediPolicy?.enabled && tediPolicy.tediId && result != null) {
			try {
				// Skip the 25KB layout catalog for text-only enrichment (content_answer, search_content)
				const isContentTool =
					toolConfig.endpoint === "content/answer" ||
					toolConfig.endpoint === "content/search";
				const enrichmentReq = buildEnrichmentRequest({
					tediId: tediPolicy.tediId,
					appId: agent.appId,
					toolId: tool.toolId,
					toolTitle: tool.title,
					args,
					rawResult: result,
					appSlug: agent.appSlug ?? "",
					vertical: agent.appMetadata?.vertical as string | undefined,
					skipCatalogPrompt: isContentTool,
					traceId: agent.traceId,
					callerIdentity: agent.callerIdentity
						? {
								authType:
									(agent.callerIdentity.authType as "oauth" | "anonymous") ??
									"anonymous",
								userId: agent.callerIdentity.userId,
								scopes: agent.callerIdentity.scopes,
							}
						: undefined,
					policy: {
						allowedEnrichmentTools: tediPolicy.allowedTools ?? [],
						blockedEnrichmentTools: tediPolicy.blockedTools ?? [],
						maxEnrichmentTokens: tediPolicy.maxTokens ?? 4096,
						enrichmentTimeoutMs: tediPolicy.timeoutMs ?? 60000,
					},
				});

				const enrichmentResult = await invokeTediEnrichment(
					agent.env,
					enrichmentReq,
				);

				if (enrichmentResult) {
					if (enrichmentResult.enrichedData != null) {
						structuredContent = enrichmentResult.enrichedData;
					}
					if (enrichmentResult.textContent) {
						textContent = enrichmentResult.textContent;
					}
					if (enrichmentResult.layoutSpec) {
						tediLayoutSpec = enrichmentResult.layoutSpec as Record<
							string,
							unknown
						>;
					}
				}
			} catch (err) {
				log.error("Tedi enrichment failed; using raw result", {
					event: "tool_execution.enrichment_failed",
					appId: agent.appId,
					toolName: tool.toolId,
					traceId: agent.traceId,
					outcome: "unavailable",
					error: contentFreeMcpException(err),
				});
			}
		}

		if (
			toolConfig.transport === "external" &&
			tool.schemaSource === "openapi"
		) {
			structuredContent = normalizeOpenApiStructuredContent(
				structuredContent,
				tool.outputSchema,
			);
		}

		// Widget-only metadata — not included in text content (model context)
		const utmParams = agent.appCapabilities?.externalCta?.utmParams;
		// Detail template URI for host modal views (requestModal({ template }))
		const detailTemplateUri = agent.appSlug
			? `ui://widgets/apps-sdk/${agent.appSlug}/r/item-detail.html`
			: undefined;
		// Detect upstream RPC failure (status >= 400) so the telemetry
		// middleware records success: false. Without this, executeWithHandler's
		// success path returns {content, structuredContent} with isError
		// undefined, and middleware reads that as success.
		const resultStatus =
			result && typeof result === "object" && "status" in result
				? (result as { status?: unknown }).status
				: undefined;
		const isErrorResult =
			typeof resultStatus === "number" && resultStatus >= 400;
		const collectionRead = isErrorResult
			? null
			: connectedCollectionRead(agent, tool);

		// Honest ack on the Home soft-deadline shape (home-surface enqueue tools
		// only, gated by `_emitTaskLinkage`): a queued turn returns no
		// assistantMessage, so prepend a presentation-layer text block telling
		// the caller how to recover the outcome. structuredContent (the run
		// object) is never touched — the do writes the real ledger message later.
		const homeAckText =
			!isErrorResult &&
			(toolConfig as unknown as Record<string, unknown>)._emitTaskLinkage ===
				true
				? homeQueuedAckText(
						result && typeof result === "object" && "data" in result
							? (result as { data?: unknown }).data
							: undefined,
					)
				: null;

		if (!isErrorResult) {
			validateStructuredContentAgainstOutputSchema(
				tool.outputSchema,
				structuredContent,
				tool.toolId,
			);

			// ── Inventory list_changed nudges ──
			// A successful dispatch of a tool whose endpoint mutates an app's
			// tool/prompt/resource inventory (operator appTools CRUD, catalog tool
			// sync, OpenAPI import) publishes `notifications/{kind}/list_changed` through
			// the MCP subscription do so subscribed clients refresh without polling.
			// Target app = `args.appId` (every mapped endpoint carries the target app
			// uuid); the serving app is included too because aggregate surfaces
			// re-export the mutated inventory. Without the `MCP_SUBSCRIPTIONS`
			// binding the publish is a no-op.
			//
			// [security] `organizationId` is required here. The subscription do is
			// sharded by appId, so one instance holds subscribers from every org on
			// a shared/aggregate app, and `subscriptionTenancyMatches` treats a
			// missing org as a distinct value rather than a wildcard. Omitting it
			// (as this call site previously did) published every `*_list_changed`
			// nudge to every org on the app. `args.appId` stays caller-supplied, but
			// the event now carries the caller's own org, so a forged target app can
			// only nudge subscribers already inside the caller's tenant.
			const inventoryEndpoint =
				typeof toolConfig.endpoint === "string"
					? toolConfig.endpoint
					: undefined;
			if (mcpInventoryListChangedKinds(inventoryEndpoint).length > 0) {
				agent.ctx.waitUntil?.(
					publishMcpInventoryListChanged({
						env: agent.env,
						endpoint: inventoryEndpoint,
						organizationId: genericTaskOrgId ?? null,
						appIds: [
							typeof args.appId === "string" ? args.appId : undefined,
							agent.appId,
						],
					}),
				);
			}
		}

		const structuredMetadata = {
			...(tediLayoutSpec ? { layoutSpec: tediLayoutSpec } : {}),
			appCapabilities: agent.appCapabilities,
			...(utmParams ? { _utmParams: utmParams } : {}),
			...(detailTemplateUri ? { _detailTemplate: detailTemplateUri } : {}),
		};
		const projectedStructuredContent = tool.outputSchema
			? structuredContent
			: isRecord(structuredContent)
				? {
						...structuredContent,
						...structuredMetadata,
					}
				: structuredContent;
		const fullStructuredContent =
			!isErrorResult &&
			result.providerConfirmation &&
			isRecord(projectedStructuredContent)
				? {
						...projectedStructuredContent,
						completionEvidence: buildCompletionEvidence({
							operation: tool.toolId,
							result: projectedStructuredContent,
							retryKey: tool.toolId,
							providerConfirmation: result.providerConfirmation,
						}),
					}
				: projectedStructuredContent;
		const graphTaskMarker = (() => {
			if (
				isErrorResult ||
				executionId ||
				clientSupportsTasks !== true ||
				toolConfig.endpoint !== "memoryGraph/graph/maintenance" ||
				!isRecord(fullStructuredContent)
			) {
				return null;
			}
			const task = fullStructuredContent.task;
			if (
				!isRecord(task) ||
				typeof task.id !== "string" ||
				!task.id.startsWith("graph-gds-") ||
				(task.status !== "queued" &&
					task.status !== "running" &&
					task.status !== "cancel_requested")
			) {
				return null;
			}
			return {
				taskId: task.id,
				status: "working",
				createdAt:
					typeof task.createdAt === "string" ? task.createdAt : undefined,
				lastUpdatedAt:
					typeof task.lastUpdatedAt === "string"
						? task.lastUpdatedAt
						: undefined,
				ttlMs: null,
				pollIntervalMs:
					typeof task.pollIntervalMs === "number" ? task.pollIntervalMs : 2_500,
			};
		})();
		const aggregateTediTaskMarker = (() => {
			const aggregateTediId = (toolConfig as unknown as Record<string, unknown>)
				._aggregateTediId;
			if (
				isErrorResult ||
				executionId ||
				clientSupportsTasks !== true ||
				typeof aggregateTediId !== "string" ||
				!aggregateTediId ||
				!isRecord(fullStructuredContent)
			) {
				return null;
			}
			const task = fullStructuredContent.task;
			if (
				!isRecord(task) ||
				typeof task.id !== "string" ||
				!task.id.startsWith(`tedi:${aggregateTediId}:`) ||
				task.pollWith !== "tasks/get"
			) {
				return null;
			}
			return {
				taskId: task.id,
				status: "working",
				createdAt:
					typeof task.createdAt === "string" ? task.createdAt : undefined,
				lastUpdatedAt:
					typeof task.lastUpdatedAt === "string"
						? task.lastUpdatedAt
						: undefined,
				ttlMs: null,
				pollIntervalMs:
					typeof task.pollIntervalMs === "number" ? task.pollIntervalMs : 2_500,
			};
		})();
		// Governed OS gadget dispatch: handler.ts persists the routing row and
		// returns an internal marker beside (never inside) the API result. Surface
		// it protocol-natively like the graph/tedi markers above. Receipts without
		// a durable routing row stay synchronous by construction.
		const osGadgetTaskMarker = (() => {
			if (
				isErrorResult ||
				executionId ||
				clientSupportsTasks !== true ||
				toolConfig.endpoint !== OS_GADGET_RUN_ENDPOINT ||
				!result.osGadgetTask
			) {
				return null;
			}
			const task = result.osGadgetTask;
			if (!task.taskId.startsWith(OS_GADGET_TASK_PREFIX)) {
				return null;
			}
			return task;
		})();

		const outputTemplate =
			agent.toolOutputTemplates.get(tool.toolId) ??
			(tool.outputTemplate
				? `${tool.outputTemplate}?v=${widgetVersion}`
				: undefined);
		const resolvedWidgetRoute = resolveToolWidgetRoute(tool);
		const widgetRoute = (
			resolvedWidgetRoute ??
			tool.widgetRoute ??
			tool.toolId
		).replace(/^\//, "");
		// Resource URIs are version-agnostic (no ?v=) to avoid stale-hash mismatches
		const mcpAppResourceUri = `ui://widgets/mcp-app/${agent.appSlug}/${widgetRoute}.html`;

		return {
			content: [
				...(homeAckText ? [{ type: "text" as const, text: homeAckText }] : []),
				{ type: "text" as const, text: textContent },
			],
			structuredContent: fullStructuredContent,
			...(isErrorResult ? { isError: true as const } : {}),
			_meta: {
				"openai/outputTemplate": outputTemplate,
				"openai/widgetAccessible": tool.widgetAccessible ?? true,
				"openai/toolInvocation/invoking": `Processing ${tool.title}...`,
				"openai/toolInvocation/invoked": textContent.substring(0, 50),
				...structuredMetadata,
				...(isErrorResult && result.connectionRecovery
					? { "tedix/connectionRecovery": result.connectionRecovery }
					: {}),
				...(result.readObservation
					? { [READ_OBSERVATION_META_KEY]: result.readObservation }
					: {}),
				...(collectionRead
					? { [READ_COLLECTION_META_KEY]: collectionRead }
					: {}),
				...(graphTaskMarker || aggregateTediTaskMarker || osGadgetTaskMarker
					? {
							"tedix/genericTask":
								graphTaskMarker ??
								aggregateTediTaskMarker ??
								osGadgetTaskMarker,
						}
					: {}),
				ui: buildWidgetUiMeta(agent, mcpAppResourceUri),
			} as OpenAiWidgetMeta,
			tokensUsed: result.tokensUsed,
		};
	} catch (error) {
		log.error("Tool handler execution failed", {
			event: "tool_execution.handler_failed",
			appId: agent.appId,
			toolName: tool.toolId,
			traceId: agent.traceId,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});

		const outputTemplate =
			agent.toolOutputTemplates.get(tool.toolId) ??
			(tool.outputTemplate
				? `${tool.outputTemplate}?v=${widgetVersion}`
				: undefined);
		const resolvedWidgetRoute = resolveToolWidgetRoute(tool);
		const errorWidgetRoute = (
			resolvedWidgetRoute ??
			tool.widgetRoute ??
			tool.toolId
		).replace(/^\//, "");
		const mcpAppResourceUri = `ui://widgets/mcp-app/${agent.appSlug}/${errorWidgetRoute}.html`;

		return {
			content: [
				{
					type: "text" as const,
					text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
				},
			],
			structuredContent: {
				error: error instanceof Error ? error.message : "Unknown error",
			},
			// MCP convention: surfaces handler failures so the telemetry
			// middleware can log success: false, and clients can branch on
			// the failure shape. Without this flag, exceptions caught here
			// look like normal returns to anything downstream.
			isError: true,
			_meta: {
				"openai/outputTemplate": outputTemplate,
				"openai/widgetAccessible": tool.widgetAccessible ?? true,
				"openai/toolInvocation/invoking": `Processing ${tool.title}...`,
				"openai/toolInvocation/invoked": "Failed",
				ui: buildWidgetUiMeta(agent, mcpAppResourceUri),
			},
		};
	}
}
