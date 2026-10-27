/**
 * Code Mode for Tedix MCP
 *
 * Collapses all app tools into a single `code` tool using
 * @cloudflare/codemode ToolProvider namespaces.
 *
 * Namespaces are auto-derived from endpoint prefixes and can be
 * overridden per-app via mcpConfig.codeModeNamespaces in D1.
 * Works for any MCP app on the platform — fully config-driven.
 *
 * Registration lives here; provider execution, catalog discovery, flows and
 * result shaping live in the sibling codemode-*.ts modules.
 *
 * @see docs/engineering/mcp/codemode.md
 * @module @tedix/mcp/mcp/codemode
 */
import {
	type McpServer,
	type ServerContext as McpCtx,
} from "@modelcontextprotocol/server";
import { type ServerContext } from "./server-context";
import {
	isCodeModeAvailable,
	CODE_MODE_TOOL_ANNOTATIONS,
} from "@tedix/mcp-shared/codemode";
import {
	writeCodeModeLog,
	type CodeModeExecutionRefs,
	buildNamespaceGroups,
	runSerializedSideEffect,
	buildRuntimeProvider,
	withLegacyNamespaceAliases,
	buildProviders,
	legacyNamespaceAliases,
	namespaceGlobalsPrelude,
	codeModeTailContext,
	writeCodeModeAnalytics,
	callerOrganizationMetadata,
} from "./codemode-execution";
import { TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS } from "@tedix/api-contract/schemas/tedi-durable-code";
import { boundCodeModeLogs } from "@tedix/tedi-codemode-core/bounded-result";
import {
	codeModeResultOwner,
	createCodeModeResultStore,
} from "./codemode-result-store";
import {
	DynamicWorkerExecutor,
	resolveProvider,
	type ResolvedProvider,
} from "@cloudflare/codemode";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { IdenticalFailureBudget } from "@tedix/tedi-codemode-core/failure-budget";
import {
	codeModeCollisionOwners,
	CODEMODE_TOOL_COUNT,
	CODEMODE_NAMESPACE,
	projectedToolIdentity,
} from "./codemode-catalog-entries";
import {
	FLOW_TOOL_COUNT,
	FLOW_NAMESPACE,
	buildFlowProvider,
} from "./codemode-flow";
import { UI_NAMESPACE, buildUiProvider } from "./codemode-ui";
import { resolveLazyCatalogProvider } from "./codemode-catalog";
import { configuredAggregateNamespaces } from "./aggregate-namespaces";
import { evaluateMcpToolScopeAuthorization } from "./codemode-auth";
import { buildCompactTypes } from "@tedix/mcp-shared/compact-types";
import {
	buildCodeModeDescription,
	MAX_CODEMODE_DESCRIPTION_CHARS,
} from "./codemode-guidance";
import {
	isNonPayingConnection,
	CONNECT_PAYMENT_DENIED,
	codeModeInputSchema,
	codeModeOutputSchema,
	hasPaymentProof,
} from "./connect-payment-policy";
import { codeModeToolMeta } from "./codemode-security";
import { resolveToolRequestMeta } from "./tool-registration";
import {
	type McpEvent,
	buildCallerAuditMetadata,
	trackMcpEvent,
	emitMcpAuditEvent,
} from "./utils/analytics";
import {
	attachCodeModeReadObservations,
	buildPaymentExtra,
	findPaymentRequiredMeta,
	stripUpstreamCodeFailurePrefix,
	serializeCodeModeResult,
	shapeCodeModeResultWithHandle,
	resolveCodeModeResultBudget,
	codeModeResultMeta,
	codeModeReadObservationMeta,
	codeModeCollectionReadMeta,
} from "./codemode-results";
import {
	ownerHostAuditMetadata,
	resolveCodeModeOwnerHostSession,
	OwnerHostSessionError,
} from "./owner-host-session";
import { runWithTelemetrySpan } from "@tedix/worker-kit/telemetry";
import {
	type StatelessCodeModeRunResult,
	runStatelessCodeMode,
} from "@tedix/tedi-codemode-core/run-stateless-code";
import { tracing } from "cloudflare:workers";
import {
	buildPaymentRequiredResult,
	X402_PAYMENT_RESPONSE_META_KEY,
} from "@tedix/mcp-shared/payment";
import {
	enrichUnmountedNamespaceError,
	enrichToolNotFoundError,
} from "./codemode-discovery";
import {
	structuredResultIdentity,
	structuredUiResultProjection,
} from "@tedix/mcp-shared/result-identity";
import { buildCodeModeExecutionReceipt } from "@tedix/api-contract/schemas/execution-evidence";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	READ_OBSERVATION_META_KEY,
	READ_OBSERVATIONS_META_KEY,
	READ_COLLECTION_META_KEY,
	READ_COLLECTIONS_META_KEY,
} from "@tedix/mcp-shared/read-observation-receipt";

const UI_TOOL_COUNT = 5;

const MAX_INLINE_COMPACT_TYPE_TOOLS = 300;

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Register the unified Code Mode `code` tool on an McpServer.
 *
 * All app tools are grouped by namespace and exposed as typed
 * methods in a single sandbox execution. A `catalog.*` namespace
 * provides tool discovery.
 *
 * Namespaces are auto-derived from endpoint prefixes. Per-app
 * overrides via mcpConfig.codeModeNamespaces in D1.
 *
 * Returns false if LOADER binding is not available (fallback to standard tools).
 */
export async function registerCodeModeTools(
	server: McpServer,
	serverCtx: ServerContext,
): Promise<boolean> {
	const env = serverCtx.env;

	if (!isCodeModeAvailable(env as unknown as Record<string, unknown>)) {
		writeCodeModeLog(() =>
			console.warn(
				"[MCP] Code Mode requested but LOADER binding not available. Falling back to standard tools.",
			),
		);
		return false;
	}

	const loader = env.LOADER as WorkerLoader;
	const mcpConfig = serverCtx.appMetadata?.mcpConfig as
		| Record<string, unknown>
		| undefined;
	const timeout =
		(mcpConfig?.codeModeTimeout as number | undefined) ??
		TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS;
	// Per-app override for the model-facing result token budget (D1
	// mcpConfig.codeModeResultMaxTokens). Defaults to the @cloudflare/codemode
	// 6,000-token cap; an oversized result is kept whole behind a
	// `__tedix_result_handle` envelope (paged via discover.read_result), or
	// comes back as a detectable `__tedix_truncated` envelope when it cannot be
	// stored — never a bare clipped string.
	const resultTruncationOptions = resolveCodeModeResultBudget(serverCtx);
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const modules = mcpConfig?.codeModeModules as
		| Record<string, string>
		| undefined;

	const executor = new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(loader, {
			surface: "gateway_model_code",
			reason: "gateway_model_authored_invocation",
		}),
		timeout,
		globalOutbound: null,
		modules,
	});

	// Mutable refs for correlating code_exec → inner tool_calls and forwarding
	// outer MCP payment proofs into inner Code Mode tool calls.
	const executionRefs: CodeModeExecutionRefs = {
		authorizationDenial: undefined,
		approvalResult: undefined,
		approvalExtra: undefined,
		approvalSource: undefined,
		replayUnsafeBuiltinCalls: 0,
		executionId: undefined,
		paymentExtra: undefined,
		paymentResponses: [],
		rpcCallCount: 0,
		rpcNamespaces: new Set(),
		sideEffectQueue: Promise.resolve(),
		failureBudget: new IdenticalFailureBudget(),
		discoverCalls: 0,
		discoverParameterRequests: 0,
		toolReceipts: [],
		skillWorkflowRunIds: new Set(),
		readObservations: [],
		collectionReads: [],
		ownerHostSession: undefined,
	};

	const collisionOwners = codeModeCollisionOwners(
		serverCtx,
		namespaceOverrides,
	);
	for (const [ownerKey, owners] of collisionOwners) {
		writeCodeModeLog(() =>
			console.warn(
				JSON.stringify({
					component: "mcp.codemode",
					event: "tool_collision_quarantined",
					ownerKey,
					owners,
				}),
			),
		);
	}
	const collisionKeys = new Set(collisionOwners.keys());

	// Build namespace groups from D1 tools. Every owner of an ambiguous
	// projected key is quarantined; choosing one by insertion order would route
	// a model call to the wrong installed app.
	const namespaceGroups = buildNamespaceGroups(
		serverCtx,
		namespaceOverrides,
		executionRefs,
		collisionKeys,
	);
	const appToolCount = serverCtx.loadedTools.size;
	const quarantinedToolCount = [...collisionOwners.values()].reduce(
		(sum, owners) => sum + owners.length,
		0,
	);
	const exposedToolCount =
		appToolCount -
		quarantinedToolCount +
		UI_TOOL_COUNT +
		CODEMODE_TOOL_COUNT +
		FLOW_TOOL_COUNT;
	const namespaceCount = new Set([
		...namespaceGroups.keys(),
		UI_NAMESPACE,
		CODEMODE_NAMESPACE,
		FLOW_NAMESPACE,
	]).size;
	const moduleNames = modules ? Object.keys(modules) : [];

	// Build catalog provider (search + describe + list_namespaces)
	const resolvedCatalog = resolveLazyCatalogProvider(
		serverCtx,
		namespaceOverrides,
		executionRefs,
		collisionKeys,
	);
	const resolvedUiProvider = resolveProvider(buildUiProvider(serverCtx));
	for (const name of ["create_view", "create_mcp_app", "create_health_sweep"]) {
		const execute = resolvedUiProvider.fns[name];
		if (!execute) continue;
		resolvedUiProvider.fns[name] = (...args: unknown[]) =>
			runSerializedSideEffect(executionRefs, async () => {
				if (executionRefs.approvalResult)
					throw new Error("Destructive approval pending");
				executionRefs.replayUnsafeBuiltinCalls++;
				return execute(...args);
			});
	}
	const resolvedRuntimeProvider = resolveProvider(
		buildRuntimeProvider(serverCtx, executionRefs, () => ({
			modules: moduleNames,
			namespaceCount,
			toolCount: exposedToolCount,
		})),
	);

	// Build tool providers per namespace
	const toolProviders = withLegacyNamespaceAliases(
		buildProviders(namespaceGroups),
		legacyNamespaceAliases(
			serverCtx,
			namespaceOverrides,
			namespaceGroups,
			collisionKeys,
		),
	);

	// Potential namespaces from aggregate config vs bindings actually mounted.
	// The difference supports discovery guidance, but does not identify why a
	// namespace is absent (for example, explicit filters or resolution failure).
	const knownAggregateNamespaces = configuredAggregateNamespaces(
		mcpConfig ?? null,
	);
	const mountedNamespaces = new Set<string>([
		...namespaceGroups.keys(),
		resolvedCatalog.name,
		CODEMODE_NAMESPACE,
		UI_NAMESPACE,
		FLOW_NAMESPACE,
	]);

	const resolvedFlowProvider = resolveProvider(
		buildFlowProvider(namespaceGroups, (namespace, toolName) => {
			const owner = [...serverCtx.loadedTools].find(([toolId, tool]) => {
				const identity = projectedToolIdentity(
					toolId,
					tool,
					namespaceOverrides,
				);
				return (
					identity.safeName === toolName && identity.namespace === namespace
				);
			});
			if (!owner)
				throw new Error(`flow: ${namespace}.${toolName} has no mounted owner`);
			const decision = evaluateMcpToolScopeAuthorization(
				serverCtx,
				owner[1],
				namespace,
			);
			if (!decision.authorized)
				throw new Error(
					`flow: ${namespace}.${toolName} is not authorized; missing scopes: ${decision.missingScopes.join(", ")}`,
				);
		}),
	);

	// All providers: catalog + built-ins + per-namespace tool providers
	const providersWithoutPrelude: ResolvedProvider[] = [
		resolvedCatalog,
		resolvedRuntimeProvider,
		resolvedUiProvider,
		resolvedFlowProvider,
		...toolProviders,
	];
	// Namespace bindings are block-scoped constants in the sandbox, so
	// `globalThis[ns]` would otherwise be undefined even for a mounted namespace.
	const allProviders: ResolvedProvider[] = [
		{
			...resolvedCatalog,
			prelude: [
				resolvedCatalog.prelude,
				namespaceGlobalsPrelude(
					providersWithoutPrelude.map((provider) => provider.name),
				),
			]
				.filter(Boolean)
				.join("\n"),
		},
		...providersWithoutPrelude.slice(1),
	];

	// Full callable inventory ("ns.tool_name") — fuels tool-not-found
	// suggestions on execution errors. Never shipped in the description.
	const allCallables: string[] = allProviders.flatMap((provider) =>
		Object.keys(provider.fns).map((toolName) => `${provider.name}.${toolName}`),
	);

	// Namespace summary for the tool description, largest first.
	const namespaceSummaryEntries: Array<readonly [string, number]> = [
		...Array.from(namespaceGroups.entries())
			.sort(
				([, a], [, b]) => Object.keys(b.fns).length - Object.keys(a.fns).length,
			)
			.map(([ns, g]) => [ns, Object.keys(g.fns).length] as const),
		[CODEMODE_NAMESPACE, CODEMODE_TOOL_COUNT],
		[UI_NAMESPACE, UI_TOOL_COUNT],
		[FLOW_NAMESPACE, FLOW_TOOL_COUNT],
	];

	// Per-tool compact types are inlined only when they fit the description
	// budget. Large aggregate servers rely on discovery, so skip generating
	// types that would be discarded.
	const shouldInlineCompactTypes =
		exposedToolCount <= MAX_INLINE_COMPACT_TYPE_TOOLS;
	const compactTypes = shouldInlineCompactTypes
		? buildCompactTypes(namespaceGroups)
		: "";

	const { description, compactTypesInlined } = buildCodeModeDescription({
		toolCount: exposedToolCount,
		namespaceCount,
		namespaces: namespaceSummaryEntries,
		moduleNames,
		compactTypes,
		connectionAppSlug: serverCtx.connectionAppSlug ?? serverCtx.appSlug,
		timeoutMs: timeout,
	});

	writeCodeModeLog(() =>
		console.log(
			`[MCP] Code Mode description: compactTypes=${compactTypes.length} compactTypesInlined=${compactTypesInlined} total=${description.length} budget=${MAX_CODEMODE_DESCRIPTION_CHARS}`,
		),
	);

	// Register single unified code tool
	server.registerTool(
		"code",
		{
			description,
			annotations: CODE_MODE_TOOL_ANNOTATIONS,
			_meta: codeModeToolMeta(mcpConfig),
			outputSchema: codeModeOutputSchema,
			inputSchema: codeModeInputSchema(
				serverCtx.connectionAppSlug ?? serverCtx.appSlug,
			),
		},
		async ({ code, payment, agentSessionId }, ctx?: McpCtx) => {
			const extra = {
				_meta: resolveToolRequestMeta(
					ctx?.mcpReq?._meta,
					serverCtx.requestMeta,
				),
			};
			if (
				isNonPayingConnection(
					serverCtx.connectionAppSlug ?? serverCtx.appSlug,
				) &&
				hasPaymentProof(payment, extra._meta)
			) {
				return {
					isError: true,
					content: [{ type: "text" as const, text: CONNECT_PAYMENT_DENIED }],
				};
			}
			const execStart = Date.now();
			const executionId = crypto.randomUUID();
			const waitUntil = serverCtx.ctx.waitUntil.bind(serverCtx.ctx);
			const organizationId = serverCtx.app.organizationId;

			const emitExecTelemetry = (
				success: boolean,
				errorMsg?: string,
				resultMetrics?: {
					resultChars: number;
					resultTokensApprox: number;
					resultTruncated: boolean;
				},
			) => {
				const durationMs = Date.now() - execStart;
				const toolCount = executionRefs.rpcCallCount;
				const accessedNamespaceCount = executionRefs.rpcNamespaces.size;
				const discoverCalls = executionRefs.discoverCalls;
				const discoverParameterRequests =
					executionRefs.discoverParameterRequests;
				writeCodeModeLog(() =>
					console.log(
						JSON.stringify({
							_cm: "exec",
							...codeModeTailContext(serverCtx, executionId),
							toolCount,
							namespaceCount: accessedNamespaceCount,
							totalDurationMs: durationMs,
							codeLength: code.length,
							// Cost-shape telemetry: what the model
							// actually re-reads, and how it discovered. Without these payload
							// amplification is invisible server-side.
							discoverCalls,
							discoverParameterRequests,
							// Spreading undefined is a no-op, so no fallback object needed.
							...resultMetrics,
							success,
							...(errorMsg && { error: errorMsg.slice(0, 200) }),
						}),
					),
				);
				writeCodeModeAnalytics(serverCtx, {
					eventType: "exec",
					appId: serverCtx.appId,
					appSlug: serverCtx.appSlug,
					organizationId,
					toolName: "code",
					errorCode: errorMsg?.slice(0, 200),
					userId: serverCtx.callerIdentity?.userId,
					tediId: serverCtx.callerIdentity?.tediId,
					authType: serverCtx.callerIdentity?.authType,
					executionId,
					traceId: serverCtx.traceId,
					durationMs,
					codeLength: code.length,
					toolCount,
					namespaceCount: accessedNamespaceCount,
					discoverCalls,
					discoverParameterRequests,
					resultChars: resultMetrics?.resultChars,
					resultTokensApprox: resultMetrics?.resultTokensApprox,
					resultTruncated: resultMetrics?.resultTruncated,
					success,
				});

				const event: McpEvent = {
					timestamp: new Date().toISOString(),
					eventType: "code_exec",
					appId: serverCtx.appId,
					appSlug: serverCtx.appSlug,
					organizationId,
					toolName: "code",
					traceId: serverCtx.traceId,
					executionId,
					userId: serverCtx.callerIdentity?.userId,
					tediId: serverCtx.callerIdentity?.tediId,
					clientId: serverCtx.callerIdentity?.clientId,
					authType: serverCtx.callerIdentity?.authType,
					durationMs,
					success,
					toolInputSize: code.length,
					...(errorMsg && { errorMessage: errorMsg.slice(0, 500) }),
					metadata: {
						...buildCallerAuditMetadata(serverCtx.callerIdentity),
						...ownerHostAuditMetadata(executionRefs.ownerHostSession),
						...callerOrganizationMetadata(serverCtx),
						toolCount: exposedToolCount,
						namespaceCount,
					},
				};
				trackMcpEvent(serverCtx.env, event);
				emitMcpAuditEvent(serverCtx.env, event, waitUntil);
			};

			// This receipt comes from the trusted dispatch gate, never sandbox text.
			// Only an untouched program may be replayed by the host after OAuth.
			const authorizationFailure = () => {
				const denial = executionRefs.authorizationDenial;
				if (!denial) return undefined;
				const canChallenge =
					executionRefs.rpcCallCount === 0 &&
					executionRefs.replayUnsafeBuiltinCalls === 0 &&
					denial.missingScopes.length > 0 &&
					denial.requiredScopes.every((scope) =>
						/^mcp:[a-z][a-z0-9_.:-]*$/.test(scope),
					);
				return attachCodeModeReadObservations(
					{
						isError: true,
						content: [
							{
								type: "text" as const,
								text:
									denial.message +
									(canChallenge
										? " Authorize the required access before retrying."
										: " Review the execution receipts before retrying; this program may have dispatched earlier calls."),
							},
						],
						structuredContent: {
							executionId,
							error: denial.message,
							requiredScopes: denial.requiredScopes,
							missingScopes: denial.missingScopes,
							toolReceipts: executionRefs.toolReceipts,
							dispatchedCalls: executionRefs.rpcCallCount,
							replayUnsafeBuiltinCalls: executionRefs.replayUnsafeBuiltinCalls,
						},
						...(canChallenge
							? {
									_meta: {
										"mcp/www_authenticate": [
											`Bearer error="insufficient_scope", error_description="Additional Tedix access is required.", scope="${denial.requiredScopes.join(" ")}"`,
										],
									},
								}
							: {}),
					},
					executionRefs.readObservations,
					executionRefs.collectionReads,
				);
			};

			try {
				executionRefs.ownerHostSession = undefined;
				try {
					executionRefs.ownerHostSession =
						await resolveCodeModeOwnerHostSession({
							agentSessionId,
							caller: serverCtx.callerIdentity,
							bearerToken: serverCtx.bearerToken,
							env: serverCtx.env,
							appOrganizationId: organizationId,
						});
				} catch (error) {
					const message =
						error instanceof OwnerHostSessionError
							? error.message
							: "agentSessionId could not be verified";
					emitExecTelemetry(false, message);
					return {
						content: [
							{ type: "text" as const, text: `Execution error: ${message}` },
						],
						isError: true,
						structuredContent: { executionId, error: message },
					};
				}
				executionRefs.authorizationDenial = undefined;
				executionRefs.replayUnsafeBuiltinCalls = 0;
				executionRefs.executionId = executionId;
				executionRefs.approvalResult = undefined;
				executionRefs.approvalExtra = extra;
				executionRefs.approvalSource = code;
				executionRefs.paymentExtra = buildPaymentExtra(extra, payment);
				executionRefs.paymentResponses = [];
				executionRefs.rpcCallCount = 0;
				executionRefs.rpcNamespaces.clear();
				executionRefs.discoverCalls = 0;
				executionRefs.discoverParameterRequests = 0;
				executionRefs.failureBudget = new IdenticalFailureBudget();
				executionRefs.toolReceipts = [];
				executionRefs.skillWorkflowRunIds.clear();
				executionRefs.readObservations = [];
				executionRefs.collectionReads = [];
				// Workers custom spans are beta: diagnostic timing only, never an
				// SLO gate or proof artifact. IDs identify the execution; code and
				// returned values stay out of span attributes.
				const result = await runWithTelemetrySpan<StatelessCodeModeRunResult>(
					(callback) => tracing.enterSpan("tedix.mcp.code_exec", callback),
					async (span) => {
						span.setAttribute("tedix.trace_id", serverCtx.traceId);
						span.setAttribute("tedix.app_id", serverCtx.appId);
						span.setAttribute("tedix.execution_id", executionId);
						return runStatelessCodeMode({
							code,
							executor,
							providers: allProviders,
						});
					},
				);
				if (executionRefs.approvalResult) return executionRefs.approvalResult;
				const scopeFailure = authorizationFailure();
				if (scopeFailure) {
					emitExecTelemetry(false, executionRefs.authorizationDenial!.message);
					return scopeFailure;
				}
				const paymentResponses = executionRefs.paymentResponses;

				const paymentRequired = findPaymentRequiredMeta(result.result);
				if (paymentRequired) {
					emitExecTelemetry(
						false,
						`Payment required for inner tool "${paymentRequired.toolId}"`,
					);
					return attachCodeModeReadObservations(
						buildPaymentRequiredResult(paymentRequired),
						executionRefs.readObservations,
						executionRefs.collectionReads,
					);
				}

				// The Cloudflare codemode SDK never throws on a thrown
				// JS/ReferenceError inside executed code — it returns
				// `{ result: undefined, error: <msg> }`. Without this guard the
				// success path below shapes `undefined` into a silent
				// `result: null` and reports the run as succeeded.
				if (result.error) {
					const enrichedError = enrichUnmountedNamespaceError(
						enrichToolNotFoundError(
							stripUpstreamCodeFailurePrefix(result.error),
							allCallables,
						),
						knownAggregateNamespaces,
						mountedNamespaces,
						serverCtx.requestedCodeModeNamespaces,
					);
					emitExecTelemetry(false, enrichedError);
					return attachCodeModeReadObservations(
						{
							content: [
								{
									type: "text" as const,
									text: `Execution error: ${enrichedError}`,
								},
							],
							isError: true,
							structuredContent: {
								executionId,
								error: enrichedError,
							},
						},
						executionRefs.readObservations,
						executionRefs.collectionReads,
					);
				}

				// The result token budget (default 6k tokens ≈ 24k indented chars) is
				// a MODEL prompt bound. A skill-runtime service-binding caller
				// (skillRunId identity) is a machine consumer whose transport already
				// enforces its own byte cap — clipping here would bound a bound.
				// Model-facing callers get a `__tedix_result_handle` envelope on
				// overflow (full value kept, paged via discover.read_result), or the
				// detectable `__tedix_truncated` envelope when it cannot be stored.
				const modelResult = serverCtx.callerIdentity?.skillRunId
					? serializeCodeModeResult(result.result)
					: await shapeCodeModeResultWithHandle(result.result, {
							store: createCodeModeResultStore(
								serverCtx.env,
								codeModeResultOwner(serverCtx),
							),
							executionId,
							options: resultTruncationOptions,
						});
				const baseIdentity = structuredResultIdentity(result.result);
				const resultIdentity =
					executionRefs.skillWorkflowRunIds.size > 0
						? {
								...(baseIdentity ?? {}),
								skillWorkflowRuns: [...executionRefs.skillWorkflowRunIds],
							}
						: baseIdentity;
				const resultProjection = structuredUiResultProjection(result.result);
				const executionReceipt = buildCodeModeExecutionReceipt(
					executionRefs.toolReceipts,
				);
				// Failed inner calls surface by name and cause on the outer result:
				// programs return hand-built projections that swallow ok:false inner
				// envelopes, so without this an audit has to stringify every inner
				// result to find (e.g.) a scope denial.
				const failedReceipts = executionRefs.toolReceipts.filter(
					(receipt) =>
						receipt.status === "failed" || receipt.status === "canceled",
				);
				const innerFailures = failedReceipts.slice(0, 10).map((receipt) => ({
					tool: receipt.operation,
					...(receipt.error ? { error: receipt.error } : {}),
				}));
				// A plausible-looking `result` read first hides failed inner calls
				// (agents report "0 items" or success). Failures therefore precede
				// the result, `partial` flags the run, and a run where every inner
				// call failed is an MCP error.
				const allInnerCallsFailed =
					failedReceipts.length > 0 &&
					failedReceipts.length === executionRefs.toolReceipts.length;
				const output: Record<string, unknown> = {
					executionId,
					...(innerFailures.length > 0
						? { partial: true, failures: innerFailures }
						: {}),
					result: modelResult ?? null,
					...(resultIdentity ? { resultIdentity } : {}),
					...(resultProjection ? { resultProjection } : {}),
					...(executionReceipt ? { completionEvidence: executionReceipt } : {}),
					...(executionRefs.toolReceipts.some(
						(receipt) => receipt.actionReceipt,
					)
						? {
								actionReceipts: executionRefs.toolReceipts.flatMap((receipt) =>
									receipt.actionReceipt ? [receipt.actionReceipt] : [],
								),
							}
						: {}),
				};
				if (result.logs?.length) {
					output.logs = boundCodeModeLogs(result.logs, resultTruncationOptions);
				}
				// Serialized ONCE: this exact text is both the returned content and
				// the measured response size, so telemetry can never drift from what
				// the model was actually sent.
				const outputText = JSON.stringify(output, null, 2);
				emitExecTelemetry(true, undefined, {
					resultChars: outputText.length,
					// Same chars-per-token heuristic as the truncation budget.
					resultTokensApprox: Math.ceil(outputText.length / 4),
					// Either bound replaced the full value in the model's view.
					resultTruncated:
						isRecord(modelResult) &&
						(modelResult.__tedix_truncated === true ||
							modelResult.__tedix_result_handle === true),
				});
				const paymentResponseMeta =
					paymentResponses.length === 0
						? undefined
						: paymentResponses.length === 1
							? paymentResponses[0]
							: { settled: true, payments: paymentResponses };
				const projectedMeta = codeModeResultMeta(result.result) ?? {};
				delete projectedMeta[READ_OBSERVATION_META_KEY];
				delete projectedMeta[READ_OBSERVATIONS_META_KEY];
				delete projectedMeta[READ_COLLECTION_META_KEY];
				delete projectedMeta[READ_COLLECTIONS_META_KEY];
				const resultMeta = {
					...projectedMeta,
					...codeModeReadObservationMeta(executionRefs.readObservations),
					...codeModeCollectionReadMeta(executionRefs.collectionReads),
					...(paymentResponseMeta
						? { [X402_PAYMENT_RESPONSE_META_KEY]: paymentResponseMeta }
						: {}),
				};

				return {
					content: [
						{
							type: "text" as const,
							text: outputText,
						},
					],
					structuredContent: output,
					...(allInnerCallsFailed ? { isError: true } : {}),
					...(Object.keys(resultMeta).length > 0 ? { _meta: resultMeta } : {}),
				};
			} catch (error) {
				if (executionRefs.approvalResult) return executionRefs.approvalResult;
				const scopeFailure = authorizationFailure();
				if (scopeFailure) {
					emitExecTelemetry(false, executionRefs.authorizationDenial!.message);
					return scopeFailure;
				}
				const rawError = error instanceof Error ? error.message : String(error);
				// "Tool not found" guesses get nearest-callable suggestions so the
				// model self-corrects instead of retrying name variants.
				const enrichedError = enrichUnmountedNamespaceError(
					enrichToolNotFoundError(
						stripUpstreamCodeFailurePrefix(rawError),
						allCallables,
					),
					knownAggregateNamespaces,
					mountedNamespaces,
					serverCtx.requestedCodeModeNamespaces,
				);
				emitExecTelemetry(false, enrichedError);
				return attachCodeModeReadObservations(
					{
						content: [
							{
								type: "text" as const,
								text: `Execution error: ${enrichedError}`,
							},
						],
						isError: true,
						structuredContent: {
							executionId,
							error: enrichedError,
						},
					},
					executionRefs.readObservations,
					executionRefs.collectionReads,
				);
			} finally {
				executionRefs.ownerHostSession = undefined;
				executionRefs.approvalResult = undefined;
				executionRefs.approvalExtra = undefined;
				executionRefs.approvalSource = undefined;
				executionRefs.authorizationDenial = undefined;
				executionRefs.replayUnsafeBuiltinCalls = 0;
				executionRefs.executionId = undefined;
				executionRefs.paymentExtra = undefined;
				executionRefs.paymentResponses = [];
				executionRefs.rpcCallCount = 0;
				executionRefs.rpcNamespaces.clear();
				executionRefs.discoverCalls = 0;
				executionRefs.discoverParameterRequests = 0;
				executionRefs.toolReceipts = [];
				executionRefs.readObservations = [];
				executionRefs.collectionReads = [];
				executionRefs.skillWorkflowRunIds.clear();
				executionRefs.sideEffectQueue = Promise.resolve();
			}
		},
	);

	writeCodeModeLog(() =>
		console.log(
			`[MCP] Code Mode enabled: 1 code tool wrapping ${appToolCount} app tools plus ${UI_TOOL_COUNT} ui tools across ${namespaceCount} namespaces`,
		),
	);

	return true;
}
