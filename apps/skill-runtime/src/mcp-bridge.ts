/**
 * env.MCP bridge for tenant-loaded skill workflow code.
 *
 * The skill workflow runs inside a Worker isolate loaded via env.LOADER.
 * Its only allowed surface for tool calls is `env.MCP.<namespace>.<method>(args)`,
 * which is a Proxy that:
 *
 *  1. Validates the call against the skill's capability manifest. Calls to
 *     undeclared namespaces or methods throw `CAPABILITY_NOT_DECLARED`.
 *  2. Forwards declared calls to the apps/mcp Worker via service binding,
 *     scoped to the tedi's identity.
 *
 * The loaded worker receives only a loopback RPC stub. Platform service
 * bindings, tokens, and host routing metadata stay in this entrypoint's
 * `ctx.props`, so tenant code can call tools without seeing platform internals.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
	type CapabilityManifest,
	isMethodAllowed,
} from "@tedix/api-contract/utils/skill-manifest";
import { pollMcpTask } from "@tedix/mcp-shared/task-polling";
import { extractMcpTaskId } from "@tedix/mcp-shared/tasks";
import { logSkillRuntimeWarning } from "./control-log";
import {
	McpInputRequiredError,
	McpConnectionRequiredError,
	type ConnectionRecovery,
	readConnectionRecovery,
	stripCodeModeExecutionEnvelope,
	unwrapJsonRpcToolResult,
} from "@tedix/mcp-shared/tool-result";
import {
	AGGREGATE_NAMESPACES,
	buildCodeModeCallSource,
	buildModernMcpBridgeRequest,
	extractPendingTediTaskId,
	injectWorkflowWorkItemMeta,
	injectWorkflowToolIdentity,
	needsAggregateCredentialRecovery,
	requiresAggregateCodeMode,
	resolveCodeModeNamespace,
	resolveMcpTarget,
	selectMcpToolNameFromList,
} from "./mcp-bridge-utils";
import {
	McpUpstreamResponseTooLargeError,
	readBoundedMcpResponseText,
	unwrapMcpResponseBody,
} from "./mcp-response-reader";
import {
	buildWorkflowMcpCallIdentity,
	isWorkflowMcpCallContext,
	type WorkflowMcpCallContext,
} from "./workflow-identity";

// Abort guard, not a latency target: some tedi body tools are legitimately
// slow — git-backed artifact_read/write_file (clone the Artifacts repo) and
// run_tedi_turn (runs a full LLM turn; a report-generating judgment turn
// settles in ~30-90s). The per-step `step.do` timeout still bounds the overall
// step; this only catches a genuinely hung outbound call. Kept just under the
// dispatch-shim BRIDGE_CALL_TIMEOUT_MS (240s) so the inner abort fires first.
const MCP_BRIDGE_TIMEOUT_MS = 180_000;

/** Props attached to a tenant-specific {@link McpBridge} stub. */
export interface McpBridgeProps {
	manifest: CapabilityManifest;
	tediId: string;
	/** Owning organization's Code Mode aggregate app slug. */
	aggregateMcpSlug: string;
	/** Owning tedi's configured namespace within that aggregate. */
	tediNamespace?: string | null;
	orgId: string;
	skillId: string;
	runId: string;
	executionEpoch: number;
	namespaceToSlug: Record<string, string>;
	mcpBaseHost: string;
	/**
	 * Service token / scope to authenticate against apps/mcp. This is the
	 * platform service token — apps/mcp checks `X-Service-Binding` and uses
	 * the supplied tediId/orgId to scope calls.
	 */
	serviceToken: string;
	/**
	 * Run-starter provenance from the admission row. Host-side
	 * props, so tenant workflow code can neither read nor forge it; the
	 * gateway turns "user:*" values into an operator-consent attestation on
	 * tedi-bound dispatches.
	 */
	startedBy?: string | null;
	/** Canonical Work Item admitted with the run; host-owned provenance. */
	workItemId?: string | null;
}

export interface McpCallRequest {
	namespace: string;
	method: string;
	args: unknown;
	/**
	 * Engine-owned step coordinates supplied by the dispatch shim. The bridge
	 * derives all public IDs from these fields and the trusted runId in props;
	 * tenant code never supplies an idempotency key directly.
	 */
	workflow: WorkflowMcpCallContext;
	connectionBinding?: ConnectionRecovery;
}

export class CapabilityNotDeclaredError extends Error {
	readonly code = "CAPABILITY_NOT_DECLARED";
	constructor(namespace: string, method: string) {
		super(
			`CAPABILITY_NOT_DECLARED: ${namespace}.${method} is not declared in the skill's capability manifest`,
		);
	}
}

export class McpUpstreamError extends Error {
	readonly code = "MCP_UPSTREAM_ERROR";
	readonly status: number;
	readonly bodyText: string;
	constructor(status: number, bodyText: string) {
		super(`MCP upstream returned ${status}: ${bodyText.slice(0, 200)}`);
		this.status = status;
		this.bodyText = bodyText;
	}
}

export class McpUpstreamTimeoutError extends Error {
	readonly code = "MCP_UPSTREAM_TIMEOUT";
	readonly timeoutMs = MCP_BRIDGE_TIMEOUT_MS;
	constructor(namespace: string, method: string, url: string) {
		super(
			`MCP_UPSTREAM_TIMEOUT: ${namespace}.${method} did not return within ${MCP_BRIDGE_TIMEOUT_MS}ms (${url})`,
		);
	}
}

/**
 * A recovery call through the organization's Code Mode aggregate found no
 * binding for the namespace. The sandbox only says `<ns> is not defined`,
 * which hides why the direct route failed first: the namespace names no app
 * in the organization (typically a renamed or removed app), or the mapped app
 * exposed no such tool to this run. Name that cause so a scheduled run's
 * failure is actionable without a log search.
 */
export class McpNamespaceUnavailableError extends Error {
	readonly code = "MCP_NAMESPACE_UNAVAILABLE";
	constructor(message: string, cause: unknown) {
		super(message, { cause });
	}
}

/**
 * Rewrite a Code Mode `<namespace> is not defined` recovery failure into the
 * cause the bridge already knows; any other error passes through unchanged.
 */
export function explainCodeModeNamespaceMiss(
	error: unknown,
	input: {
		namespace: string;
		codeModeNamespace: string;
		method: string;
		mappedSlug: string | undefined;
		aggregateMcpSlug: string;
		directFailure: "method_not_found" | "connection_missing";
	},
): unknown {
	if (!(error instanceof Error)) return error;
	if (!error.message.includes(`${input.codeModeNamespace} is not defined`)) {
		return error;
	}
	const call = `env.MCP.${input.namespace}.${input.method}`;
	const gateway = `the organization gateway "${input.aggregateMcpSlug}" has no "${input.codeModeNamespace}" namespace either`;
	if (input.directFailure === "connection_missing") {
		return new McpNamespaceUnavailableError(
			`MCP_NAMESPACE_UNAVAILABLE: ${call} failed because app "${input.mappedSlug ?? input.namespace}" has no connection credential for this run, and ${gateway}. Connect the provider for the organization, then rerun. (${error.message})`,
			error,
		);
	}
	if (!input.mappedSlug) {
		return new McpNamespaceUnavailableError(
			`MCP_NAMESPACE_UNAVAILABLE: ${call} names no app in this organization, and ${gateway}. The app was probably renamed or removed; find its current namespace with discover.search and update the skill's capabilities.mcp and calls. (${error.message})`,
			error,
		);
	}
	return new McpNamespaceUnavailableError(
		`MCP_NAMESPACE_UNAVAILABLE: app "${input.mappedSlug}" exposes no "${input.method}" tool to this run, and ${gateway}. Check the tool name with discover.search, and that the app's tools and connection are enabled for the organization. (${error.message})`,
		error,
	);
}

function isToolNotFoundError(error: unknown, toolName: string): boolean {
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("tool") &&
		message.includes(toolName.toLowerCase()) &&
		message.includes("not found")
	);
}

/**
 * JSON-RPC "method not found" (-32601). A code-mode app exposes only a `code`
 * tool, so a bare `tools/call <method>` returns this generic error (no tool name
 * in the message — distinct from `isToolNotFoundError`). Triggers the Code Mode
 * recovery below.
 */
function isMethodNotFoundError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const m = error.message.toLowerCase();
	return m.includes("-32601") || m.includes("method not found");
}

function unwrapJsonRpcResult(
	text: string,
	contentType: string | null,
): unknown {
	const body = unwrapMcpResponseBody(text, contentType);
	const parsed = JSON.parse(body) as {
		result?: unknown;
		error?: { code?: number; message?: string };
	};
	if (parsed.error) {
		throw new Error(
			`MCP error ${parsed.error.code ?? "unknown"}: ${
				parsed.error.message ?? "unknown"
			}`,
		);
	}
	return parsed.result !== undefined ? parsed.result : parsed;
}

export interface McpBridgeEnv {
	MCP_SERVICE: Fetcher;
}

/**
 * `WorkerEntrypoint` exposed to loaded skill workers as `__MCP_BRIDGE__`.
 * The dispatch shim turns it into the ergonomic `env.MCP` proxy and this
 * method is the only way to invoke MCP tools.
 */
export class McpBridge extends WorkerEntrypoint<McpBridgeEnv, McpBridgeProps> {
	/**
	 * Forward an MCP tool call. Validates against the capability manifest
	 * and proxies to apps/mcp via service binding.
	 */
	async call(request: McpCallRequest): Promise<unknown> {
		return callMcpTool(this.env, this.ctx.props, request);
	}
}

/**
 * The one MCP call path. `McpBridge` exposes it to tenant workflows under the
 * skill's own capability manifest; the platform's {@link EvidenceBridge} reuses
 * it under a platform-owned manifest to fetch the page a citation points at.
 * Both go through the same capability gate, annotation assertion, idempotency
 * identity, and Code Mode recovery — there is no second, weaker way to call a
 * tool from this Worker.
 */
export async function callMcpTool(
	env: McpBridgeEnv,
	props: McpBridgeProps,
	request: McpCallRequest,
): Promise<unknown> {
	try {
		return {
			__tedixMcpResult: true,
			value: await executeMcpTool(env, props, request),
		};
	} catch (error) {
		if (error instanceof McpConnectionRequiredError) {
			// This tagged outcome crosses RPC as data; arbitrary Error properties
			// do not reliably survive the native Workflow/RPC error boundary.
			return { __tedixConnectionRequired: true, recovery: error.recovery };
		}
		throw error;
	}
}

async function executeMcpTool(
	env: McpBridgeEnv,
	props: McpBridgeProps,
	request: McpCallRequest,
): Promise<unknown> {
	const { namespace, method, args, workflow } = request;
	const connectionBinding = request.connectionBinding
		? readConnectionRecovery(request.connectionBinding)
		: null;
	if (request.connectionBinding && !connectionBinding)
		throw new Error(
			"MCP_CONNECTION_RECOVERY_INVALID: invalid connection binding",
		);
	if (!isWorkflowMcpCallContext(workflow)) {
		throw new Error(
			"WORKFLOW_CALL_CONTEXT_INVALID: env.MCP calls require a valid durable step context",
		);
	}

	if (!isMethodAllowed(props.manifest, namespace, method)) {
		throw new CapabilityNotDeclaredError(namespace, method);
	}

	// Resolve the upstream MCP server slug + wire tool name. Per-app namespaces
	// map to a `<slug>.<host>` subdomain with the bare tool name; the kernel/home
	// surface routes to the org-wide aggregate server with a prefixed name
	// (ask) instead of a nonexistent `home.<host>` subdomain. The
	// tools/list retry below still recovers prefixed names for aggregate apps.
	const { slug: resolvedSlug, toolName } = resolveMcpTarget(
		namespace,
		method,
		props.namespaceToSlug,
		props.aggregateMcpSlug,
		props.tediNamespace,
	);
	const identity = await buildWorkflowMcpCallIdentity({
		runId: props.runId,
		executionEpoch: props.executionEpoch,
		namespace,
		method,
		context: workflow,
	});
	const authoritativeArgs = injectWorkflowToolIdentity(
		namespace,
		method,
		args,
		props.tediId,
	);

	// Carry the workflow's expectedAnnotations assertion into the gateway
	// via params._meta. apps/mcp fails closed with ANNOTATION_VIOLATION
	// when the invoked tool's annotations contradict the assertion.
	// See Sam Morrow Part 3 in docs/engineering/cognition/skills.md "External Design Lessons".
	const params: {
		name: string;
		arguments: unknown;
		_meta?: Record<string, unknown>;
	} = {
		name: toolName,
		arguments: authoritativeArgs,
	};
	params._meta = injectWorkflowWorkItemMeta(
		{
			"com.tedix/idempotencyKey": identity.idempotencyKey,
			"com.tedix/workflowStep": {
				runId: props.runId,
				executionEpoch: props.executionEpoch,
				stepId: identity.stepId,
				stepName: workflow.stepName,
				stepCount: workflow.stepCount,
				stepType: workflow.stepType,
				attempt: workflow.attempt,
				phase: workflow.phase,
				callOrdinal: workflow.ordinal,
				callId: identity.callId,
			},
		},
		props.workItemId,
	);
	if (connectionBinding)
		params._meta = {
			...params._meta,
			"tedix/expectedConnection": connectionBinding,
		};
	const expected = props.manifest.expectedAnnotations;
	if (
		expected &&
		(expected.destructive === false || expected.readOnly === true)
	) {
		params._meta = {
			...params._meta,
			"com.tedix/expectedAnnotations": {
				destructive: expected.destructive ?? false,
				readOnly: expected.readOnly ?? false,
			},
		};
	}
	const url = `https://${resolvedSlug}.${props.mcpBaseHost}/mcp`;
	const headers = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		"X-Service-Binding": "true",
		"X-Tedix-Tedi-Id": props.tediId,
		// Every admitted tedi profile carries this connected-provider scope. The
		// trusted bridge supplies only this grant, not tenant-authored scopes.
		"X-Tedix-Tedi-Scopes": "connections.execute",
		"X-Tedix-Org-Id": props.orgId,
		"X-Tedix-Skill-Run-Id": props.runId,
		"X-Tedix-Skill-Id": props.skillId,
		...(props.startedBy ? { "X-Tedix-Run-Created-By": props.startedBy } : {}),
		...(props.workItemId ? { "X-Tedix-Work-Item-Id": props.workItemId } : {}),
		"X-Tedix-Workflow-Step-Id": identity.stepId,
		"X-Tedix-Workflow-Step-Name": encodeURIComponent(workflow.stepName),
		"X-Tedix-Workflow-Step-Count": String(workflow.stepCount),
		"X-Tedix-Workflow-Step-Attempt": String(workflow.attempt),
		"X-Tedix-Workflow-Execution-Epoch": String(props.executionEpoch),
		"X-Tedix-Workflow-Call-Id": identity.callId,
		"Idempotency-Key": identity.idempotencyKey,
		"X-Idempotency-Key": identity.idempotencyKey,
		Authorization: `Bearer ${props.serviceToken}`,
	};

	const postJsonRpc = async (
		body: unknown,
		targetUrl: string = url,
		pendingTediTaskId?: string,
	) => {
		const modernRequest = buildModernMcpBridgeRequest(body);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), MCP_BRIDGE_TIMEOUT_MS);
		try {
			const res = await env.MCP_SERVICE.fetch(targetUrl, {
				method: "POST",
				headers: {
					...headers,
					...modernRequest.headers,
					...(pendingTediTaskId
						? { "X-Tedix-Workflow-Tedi-Task-Id": pendingTediTaskId }
						: {}),
				},
				body: JSON.stringify(modernRequest.body),
				signal: controller.signal,
			});
			const text = await readBoundedMcpResponseText(res);
			if (!res.ok) {
				throw new McpUpstreamError(res.status, text);
			}
			return {
				text,
				contentType: res.headers.get("content-type"),
			};
		} catch (error) {
			if (
				controller.signal.aborted &&
				!(error instanceof McpUpstreamResponseTooLargeError)
			) {
				throw new McpUpstreamTimeoutError(namespace, method, targetUrl);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	};

	const buildCallBody = (name: string) => ({
		jsonrpc: "2.0" as const,
		id: crypto.randomUUID(),
		method: "tools/call",
		params: {
			...params,
			name,
		},
	});

	// MCP 2026-07-28 Tasks (client side, shared detection with mcp-client-core).
	// Await a task-bearing tool result to a terminal state over the same
	// MCP_SERVICE transport, then unwrap the terminal result as if the tool had
	// returned synchronously. Two cases feed this (see invokeTool):
	//  - a protocol-native `resultType: "task"` result (config-driven
	//    `_asyncTask` tools) — the answer only arrives via `tasks/get`;
	//  - the Tedix `task: { id }` linkage that `run_tedi_turn`/`ask` attach, but
	//    Only when the in-band reply is still pending (a settled turn keeps its
	//    in-band shape untouched). The tedi-run task's completed result inlines
	//    the assistant content (apps/mcp aggregate-task-handlers), so the awaited
	//    path returns the same `{ assistant: { content } }` shape.
	// Bounded by the same abort budget; the per-step `step.do` timeout governs.
	const awaitTaskToTerminal = async (
		taskId: string,
		name: string,
		targetUrl?: string,
	) => {
		const outcome = await pollMcpTask({
			taskId,
			request: async (method, taskParams) => {
				const { text, contentType } = await postJsonRpc(
					{
						jsonrpc: "2.0" as const,
						id: crypto.randomUUID(),
						method,
						params: taskParams,
					},
					targetUrl,
					taskId.startsWith("tedi:") ? taskId : undefined,
				);
				return unwrapJsonRpcResult(text, contentType);
			},
			timeoutMs: MCP_BRIDGE_TIMEOUT_MS,
			// Each poll is a service-binding subrequest out of the workflow step's
			// budget, so this caller polls slower than the interactive clients.
			defaultIntervalMs: 1_500,
			minIntervalMs: 750,
			maxIntervalMs: 3_000,
			// A tedi run's `tedi_runtime_events` flush ASYNCHRONOUSLY, so tasks/get
			// can answer "Task not found" right after dispatch even though we hold
			// the run id. Treat it as still working for the whole call budget.
			notFoundGraceMs: MCP_BRIDGE_TIMEOUT_MS,
		});
		if (outcome.status === "completed") {
			return unwrapJsonRpcToolResult(
				JSON.stringify({ result: outcome.result }),
				name,
			);
		}
		if (outcome.status === "failed" || outcome.status === "cancelled") {
			const error = outcome.state.error;
			const detail =
				error && typeof error === "object"
					? ((error as { message?: string }).message ?? JSON.stringify(error))
					: outcome.status;
			throw new Error(`MCP task ${outcome.status}: ${detail}`);
		}
		// The bridge has no human in the loop: fail closed on pending input.
		if (outcome.status === "input_required") {
			throw new McpInputRequiredError(name);
		}
		const lastStatus =
			typeof outcome.state?.status === "string"
				? outcome.state.status
				: "pending_events";
		throw new Error(
			`MCP_TASK_TIMEOUT: ${name} task ${taskId} did not reach a terminal state within ${MCP_BRIDGE_TIMEOUT_MS}ms (last status: ${lastStatus})`,
		);
	};

	// Parse a JSON-RPC tools/call envelope down to the tool result object.
	const parseToolResult = (body: string): unknown => {
		try {
			const parsed = JSON.parse(body) as { result?: unknown };
			return parsed && typeof parsed === "object" && "result" in parsed
				? (parsed as { result?: unknown }).result
				: parsed;
		} catch {
			return null;
		}
	};

	// A pending tedi turn: `run_tedi_turn`/`ask` returned the narrow accepted
	// `{ pending, task: { id, pollWith: "tasks/get" } }` linkage but no in-band
	// assistant content yet. Settled turns retain their in-band shape.
	const pendingTurnTaskId = (
		result: unknown,
		unwrapped: unknown,
	): string | null => {
		if (!result || typeof result !== "object") return null;
		const u =
			unwrapped && typeof unwrapped === "object"
				? (unwrapped as Record<string, unknown>)
				: null;
		const asst =
			u?.assistant && typeof u.assistant === "object"
				? (u.assistant as Record<string, unknown>)
				: null;
		const hasContent =
			(typeof asst?.content === "string" && asst.content.trim().length > 0) ||
			(typeof u?.content === "string" && u.content.trim().length > 0);
		if (hasContent) return null;
		return (
			extractPendingTediTaskId(unwrapped) ??
			extractPendingTediTaskId(result) ??
			extractPendingTediTaskId(
				(result as Record<string, unknown>).structuredContent,
			)
		);
	};

	const invokeTool = async (name: string) => {
		const { text, contentType } = await postJsonRpc(buildCallBody(name));
		const body = unwrapMcpResponseBody(text, contentType);
		const result = parseToolResult(body);
		// Protocol-native async task (config-driven _asyncTask) → always await.
		if (
			result &&
			typeof result === "object" &&
			(result as { resultType?: unknown }).resultType === "task"
		) {
			const id = extractMcpTaskId(result);
			if (id) return await awaitTaskToTerminal(id, name);
		}
		const unwrapped = unwrapJsonRpcToolResult(body, name);
		// Pending tedi turn → await its run task (its completed result inlines
		// the assistant content); settled turns fall through unchanged.
		const pendingId = pendingTurnTaskId(result, unwrapped);
		if (pendingId) return await awaitTaskToTerminal(pendingId, name);
		return unwrapped;
	};

	// Code Mode recovery: a code-mode app (e.g. firecrawl, firecrawl-tedix)
	// exposes only a `code` tool, so a bare `tools/call <method>` 404s. Re-run
	// the call through Code Mode on the aggregate, where the inner tools appear
	// under their gateway namespace (firecrawl_tedix.firecrawl_search). The
	// (namespace, method) capability gate above already authorised it.
	const invokeViaCodeMode = async () => {
		const aggUrl = `https://${props.aggregateMcpSlug}.${props.mcpBaseHost}/mcp`;
		// The aggregate `code` tool evaluates an async ARROW FUNCTION source
		// string (`async () => ...`) — a bare top-level `return` is a syntax
		// error ("Unexpected token 'return'", found live by the kitchen-sink
		// research step).
		// Safe methods use dot notation so apps/mcp's targeted provider hydrator
		// sees the call before sandbox execution. The helper retains a quoted
		// bracket fallback for non-identifier tool names without allowing source
		// injection from manifest-authored names or arguments.
		const codeModeNamespace = resolveCodeModeNamespace(
			namespace,
			props.tediNamespace,
		);
		const wrapper = buildCodeModeCallSource(
			codeModeNamespace,
			method,
			authoritativeArgs,
		);
		const { text, contentType } = await postJsonRpc(
			{
				jsonrpc: "2.0" as const,
				id: crypto.randomUUID(),
				method: "tools/call",
				params: {
					name: "code",
					arguments: { code: wrapper },
					_meta: params._meta,
				},
			},
			aggUrl,
		);
		const codeModeResult = stripCodeModeExecutionEnvelope(
			unwrapJsonRpcToolResult(
				unwrapMcpResponseBody(text, contentType),
				`${codeModeNamespace}.${method}`,
			),
		);
		// Code Mode preserves the inner tool's task linkage. Mirror the direct
		// path's task semantics and poll on the same aggregate that created it so
		// `run_tedi_turn` yields the completed assistant outcome, not merely a
		// queued task receipt.
		if (
			codeModeResult &&
			typeof codeModeResult === "object" &&
			(codeModeResult as { resultType?: unknown }).resultType === "task"
		) {
			const id = extractMcpTaskId(codeModeResult);
			if (id) {
				return await awaitTaskToTerminal(
					id,
					`${codeModeNamespace}.${method}`,
					aggUrl,
				);
			}
		}
		const pendingId = pendingTurnTaskId(codeModeResult, codeModeResult);
		if (pendingId) {
			return await awaitTaskToTerminal(
				pendingId,
				`${codeModeNamespace}.${method}`,
				aggUrl,
			);
		}
		return codeModeResult;
	};

	// Code Mode as a recovery for a failed direct call: keep the direct
	// failure's cause when the aggregate has no binding for the namespace.
	const recoverViaCodeMode = async (
		directFailure: "method_not_found" | "connection_missing",
	) => {
		try {
			return await invokeViaCodeMode();
		} catch (recoveryError) {
			throw explainCodeModeNamespaceMiss(recoveryError, {
				namespace,
				codeModeNamespace:
					namespace === "tedi" ? (props.tediNamespace ?? namespace) : namespace,
				method,
				mappedSlug: props.namespaceToSlug[namespace],
				aggregateMcpSlug: props.aggregateMcpSlug,
				directFailure,
			});
		}
	};

	try {
		// Aggregate-tedi tools are virtual Code Mode providers, not first-class
		// direct tools. Go straight through the configured role namespace (for
		// example `cto.work_items_list`) instead of attempting the unreliable
		// `cto__work_items_list` direct surface first.
		if (requiresAggregateCodeMode(namespace)) {
			return await invokeViaCodeMode();
		}
		const directResult = await invokeTool(toolName);
		if (
			!AGGREGATE_NAMESPACES.has(namespace) &&
			needsAggregateCredentialRecovery(directResult)
		) {
			return await recoverViaCodeMode("connection_missing");
		}
		return directResult;
	} catch (error) {
		// Recovery 1: a bare-name "tool not found" may be exposed under a
		// prefixed aggregate name — recover it via tools/list. A mapped wrapper
		// app (e.g. `planetscale-<tenant>` aggregating `planetscale`) registers
		// only `<prefix>__<tool>` names; a programmatic bare call materializes
		// no tool there, so apps/mcp has no tools/call handler and answers
		// -32601 instead of "tool not found". Resolve that case the same way
		// before the Code Mode fallback below, which cannot see the wrapper's
		// own namespace on the org aggregate ("<namespace> is not defined").
		const mappedAppMissingMethod =
			isMethodNotFoundError(error) &&
			!AGGREGATE_NAMESPACES.has(namespace) &&
			Boolean(props.namespaceToSlug[namespace]);
		if (isToolNotFoundError(error, toolName) || mappedAppMissingMethod) {
			let resolvedToolName: string | null = null;
			try {
				const { text, contentType } = await postJsonRpc({
					jsonrpc: "2.0" as const,
					id: crypto.randomUUID(),
					method: "tools/list",
				});
				resolvedToolName = selectMcpToolNameFromList(
					toolName,
					unwrapJsonRpcResult(text, contentType),
				);
			} catch (listError) {
				logSkillRuntimeWarning("mcp_bridge.tool_list_fallback_failed", {
					caught: listError,
				});
			}
			if (resolvedToolName && resolvedToolName !== toolName) {
				return await invokeTool(resolvedToolName);
			}
		}

		// Recovery 2: JSON-RPC -32601 "method not found" → the target app is
		// code-mode; route the call through Code Mode. Skip aggregate namespaces
		// (home/kernel), where -32601 is a genuine error.
		if (isMethodNotFoundError(error) && !AGGREGATE_NAMESPACES.has(namespace)) {
			return await recoverViaCodeMode("method_not_found");
		}

		throw error;
	}
}
