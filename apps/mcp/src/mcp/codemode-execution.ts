import {
	type CatalogToolAnnotations,
	codeModeCollisionOwners,
	projectedToolIdentity,
	CODEMODE_NAMESPACE,
	CODEMODE_CATALOG_TOOLS,
} from "./codemode-catalog-entries";
import {
	CodeModeAuthorizationError,
	assertCodeModeInnerToolAuthorized,
} from "./codemode-auth";
import { type CallToolResult } from "@modelcontextprotocol/server";
import {
	IdenticalFailureBudget,
	buildIdenticalCallKey,
} from "@tedix/tedi-codemode-core/failure-budget";
import {
	type CompletionEvidence,
	withCompletionEvidence,
	buildCompletionEvidence,
} from "@tedix/api-contract/schemas/execution-evidence";
import {
	type ActionReceipt,
	ACTION_RECEIPT_META_KEY,
} from "@tedix/api-contract/utils/action-receipt";
import {
	type OwnedReadObservation,
	type OwnedConnectedCollectionRead,
} from "@tedix/mcp-shared/read-observation-receipt";
import { recordFrom } from "./codemode-ui";
import { type ServerContext, type AppTool } from "./server-context";
import { createTelemetryWriter } from "@tedix/worker-kit/telemetry";
import {
	type McpCodeModeAnalyticsDataPointEvent,
	buildMcpCodeModeAnalyticsDataPoint,
} from "@tedix/api-contract/schemas/mcp-analytics";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import {
	type McpEvent,
	getJsonSize,
	truncateErrorMessage,
	buildCallerAuditMetadata,
	trackMcpEvent,
	emitMcpAuditEvent,
} from "./utils/analytics";
import {
	toolRiskAuditMetadata,
	enforceToolRiskRateLimit,
} from "./tool-risk-policy";
import { type NamespaceGroup } from "@tedix/mcp-shared/compact-types";
import { isToolDeniedForConnection } from "./no-funds-policy";
import {
	CONNECT_PAYMENT_DENIED,
	isNonPayingConnection,
	hasPaymentProof,
} from "./connect-payment-policy";
import {
	resolveToolAnnotations,
	parseAdapterScope,
	type ResultStrategy,
} from "@tedix/api-contract/schemas/tools";
import {
	enforceExpectedAnnotations,
	callToolResultText,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	withDestructiveApprovalSchema,
} from "./governance";
import { isModernMcpRequest } from "@tedix/mcp-shared/protocol";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { INPUT_REQUIRED_META_KEY } from "./mrtr";
import {
	checkToolPayment,
	settleToolPayment,
	attachPaymentResponseMeta,
} from "./payments";
import { executeTool } from "./tool-execution";
import {
	collectCodeModeCollectionRead,
	collectCodeModeReadObservation,
	attachCodeModeWidgetMetadata,
} from "./codemode-results";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import {
	type JsonSchemaToolDescriptors,
	type ToolProvider,
	type ResolvedProvider,
} from "@cloudflare/codemode";

function isSideEffectfulTool(
	annotations: CatalogToolAnnotations | null,
): boolean {
	return annotations?.readOnlyHint !== true;
}

function innerToolError(result: CallToolResult): Error {
	const detail = recordFrom(result._meta?.["tedix/error"]);
	return Object.assign(new Error(callToolResultText(result)), {
		...(typeof detail?.code === "string" ? { code: detail.code } : {}),
		...(typeof detail?.status === "number" ? { status: detail.status } : {}),
	});
}

export function runSerializedSideEffect<T>(
	executionRefs: CodeModeExecutionRefs,
	fn: () => Promise<T>,
): Promise<T> {
	const run = executionRefs.sideEffectQueue.catch(() => undefined).then(fn);
	executionRefs.sideEffectQueue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

export const CODEMODE_PROVIDER_TYPES = [
	"declare namespace codemode {",
	"  /** Inspect this Code Mode execution context for live proof, audit correlation, and current gateway/tool counts. */",
	'  function __runtime(): Promise<{ mode: "stateless"; surface: "mcp-gateway"; executionId: string | null; appId: string; appSlug: string; organizationId: string | null; traceId: string; actor: { authType: string; userId: string | null; tediId: string | null; clientId: string | null; externalAgentPrincipalId: string | null; externalAgentSessionId: string | null; externalAgentHarness: string | null; externalAgentModel: string | null }; toolCount: number; namespaceCount: number; modules: string[]; executionSurface: { kind: "mcp-gateway"; surfaceId: string; sessionIds: string[]; participantIds: string[] } }>; ',
	"}",
].join("\n");

export interface CodeModeExecutionRefs {
	authorizationDenial: CodeModeAuthorizationError | undefined;
	approvalResult: CallToolResult | undefined;
	approvalExtra: { _meta?: Record<string, unknown> } | undefined;
	approvalSource: string | undefined;
	replayUnsafeBuiltinCalls: number;
	executionId: string | undefined;
	paymentExtra: { _meta?: Record<string, unknown> } | undefined;
	paymentResponses: Record<string, unknown>[];
	rpcCallCount: number;
	rpcNamespaces: Set<string>;
	sideEffectQueue: Promise<void>;
	failureBudget: IdenticalFailureBudget;
	/** Discovery-option telemetry: how the model actually discovers. */
	discoverCalls: number;
	discoverParameterRequests: number;
	/**
	 * EXECUTION RECEIPTS the executor observed itself, one per namespaced tool
	 * call this program made. Every inner call is already wrapped with
	 * `completionEvidence`, but a program returns a hand-built PROJECTION and
	 * routinely drops it — so the receipt has to travel out-of-band, beside the
	 * program's return value, or the delegation proof gate reads execution
	 * evidence as unknown for work that demonstrably ran.
	 */
	toolReceipts: {
		operation: string;
		status: CompletionEvidence["status"];
		error?: string;
		actionReceipt?: ActionReceipt;
	}[];
	/** Exact inner workflow run identities, retained even if JS returns a summary. */
	skillWorkflowRunIds: Set<string>;
	readObservations: OwnedReadObservation[];
	collectionReads: OwnedConnectedCollectionRead[];
	/** Verified owner-host Agent-Session for the current execution only. */
	ownerHostSessionId: string | undefined;
}

function skillWorkflowRunId(value: unknown): string | null {
	const result = recordFrom(value);
	if (!result) return null;
	const candidates = [
		result.runId,
		recordFrom(result.data)?.runId,
		recordFrom(result.structuredContent)?.runId,
	];
	const runId = candidates.find(
		(candidate) =>
			typeof candidate === "string" &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				candidate,
			),
	);
	return typeof runId === "string" ? runId : null;
}

export function callerOrganizationMetadata(
	serverCtx: ServerContext,
): Record<string, string> {
	const callerOrganizationId = serverCtx.callerIdentity?.organizationId;
	if (
		!callerOrganizationId ||
		callerOrganizationId === serverCtx.app.organizationId
	) {
		return {};
	}
	return { callerOrganizationId };
}

export function codeModeTailContext(
	serverCtx: ServerContext,
	executionId: string | undefined,
): Record<string, string> {
	return {
		appId: serverCtx.appId,
		appSlug: serverCtx.appSlug,
		orgId: serverCtx.app.organizationId ?? "",
		userId: serverCtx.callerIdentity?.userId ?? "",
		tediId: serverCtx.callerIdentity?.tediId ?? "",
		authType: serverCtx.callerIdentity?.authType ?? "anonymous",
		executionId: executionId ?? "",
		traceId: serverCtx.traceId,
	};
}

export const writeCodeModeLog = createTelemetryWriter("mcp.codemode.log");

const writeCodeModeTelemetry = createTelemetryWriter("mcp.codemode.analytics");

export function writeCodeModeAnalytics(
	serverCtx: ServerContext,
	event: McpCodeModeAnalyticsDataPointEvent,
): void {
	const dataset = serverCtx.env.CODEMODE_ANALYTICS;
	if (!dataset) return;
	writeCodeModeTelemetry(
		() => dataset.writeDataPoint(buildMcpCodeModeAnalyticsDataPoint(event)),
		serverCtx.ctx.waitUntil.bind(serverCtx.ctx),
	);
}

function splitToolArgs(args: Record<string, unknown>): {
	toolArgs: Record<string, unknown>;
	inlineExtra: { _meta?: Record<string, unknown> } | undefined;
} {
	const { _meta, ...toolArgs } = args;
	return {
		toolArgs,
		inlineExtra: isRecord(_meta) ? { _meta } : undefined,
	};
}

function emitCodeModeAuthorizationDenied(
	serverCtx: ServerContext,
	tool: AppTool,
	namespace: string,
	args: Record<string, unknown>,
	error: CodeModeAuthorizationError,
	executionId: string | undefined,
): void {
	if (!executionId) return;

	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "tool_call",
		appId: serverCtx.appId,
		appSlug: serverCtx.appSlug,
		organizationId: serverCtx.app?.organizationId,
		toolName: tool.toolId,
		toolInputSize: getJsonSize(args),
		userId: serverCtx.callerIdentity?.userId,
		tediId: serverCtx.callerIdentity?.tediId,
		clientId: serverCtx.callerIdentity?.clientId,
		authType: serverCtx.callerIdentity?.authType,
		traceId: serverCtx.traceId,
		executionId,
		success: false,
		durationMs: 0,
		errorCode: error.name,
		errorMessage: truncateErrorMessage(error.message),
		metadata: {
			...buildCallerAuditMetadata(serverCtx.callerIdentity),
			...toolRiskAuditMetadata(tool),
			namespace,
			requiredScopes: error.requiredScopes.join(","),
			missingScopes: error.missingScopes.join(","),
		},
	};

	trackMcpEvent(serverCtx.env, event);
	emitMcpAuditEvent(
		serverCtx.env,
		event,
		serverCtx.ctx.waitUntil.bind(serverCtx.ctx),
	);
}

export function buildNamespaceGroups(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
	executionRefs: CodeModeExecutionRefs,
	collisionKeys: ReadonlySet<string> = new Set(
		codeModeCollisionOwners(serverCtx, namespaceOverrides).keys(),
	),
): Map<string, NamespaceGroup> {
	const groups = new Map<string, NamespaceGroup>();
	const toolOwners = new Map<string, string>();

	for (const [toolId, tool] of serverCtx.loadedTools) {
		const {
			namespace: ns,
			safeName,
			ownerKey,
		} = projectedToolIdentity(toolId, tool, namespaceOverrides);
		if (collisionKeys.has(ownerKey)) continue;
		toolOwners.set(ownerKey, toolId);

		if (!groups.has(ns)) {
			groups.set(ns, { fns: {}, schemas: {} });
		}
		const group = groups.get(ns)!;
		if (isToolDeniedForConnection(serverCtx, tool)) {
			group.fns[safeName] = async () => {
				throw new Error(CONNECT_PAYMENT_DENIED);
			};
			continue;
		}

		// Executable function — routes through the full ToolHandler pipeline
		group.fns[safeName] = async (args: Record<string, unknown>) => {
			const retryKey = buildIdenticalCallKey(ownerKey, args);
			const retryState = executionRefs.failureBudget.state(retryKey);
			if (retryState.blocked) {
				throw new Error(
					"Identical call blocked after repeated failures. Change the arguments or execution plan.",
				);
			}
			let actionReceipt: ActionReceipt | undefined;
			const runTool = async () => {
				if (executionRefs.approvalResult)
					throw new Error("Destructive approval pending");
				const { toolArgs, inlineExtra } = splitToolArgs(args);
				if (
					isNonPayingConnection(
						serverCtx.connectionAppSlug ?? serverCtx.appSlug,
					) &&
					hasPaymentProof(undefined, inlineExtra?._meta)
				) {
					throw new Error(CONNECT_PAYMENT_DENIED);
				}
				try {
					assertCodeModeInnerToolAuthorized(serverCtx, tool, ns, toolArgs);
				} catch (error) {
					if (error instanceof CodeModeAuthorizationError) {
						executionRefs.authorizationDenial ??= error;
						emitCodeModeAuthorizationDenied(
							serverCtx,
							tool,
							ns,
							args ?? {},
							error,
							executionRefs.executionId,
						);
					}
					throw error;
				}
				// The declared capability folded in, exactly as `buildCatalogProvider`
				// does for discovery. Passing raw `tool.annotations` here meant
				// discovery and ENFORCEMENT disagreed inside this one file: a row
				// declared `destructive` with no upstream annotations was advertised
				// by `discover.search()` as `destructiveHint: true` and then executed
				// with no approval and no elicitation, because
				// `requireDestructiveToolApproval` keys on
				// `annotations?.destructiveHint !== true`.
				//
				// That row shape is the PRIMARY PRODUCT of declared capability —
				// `updateAppTool` sets `writeCapability` while leaving `annotations`
				// untouched, for the ~52 third-party tools whose upstream never sends
				// annotations at all. So the declaration was inert on the one path
				// tedis actually execute on, which is the gateway-native default.
				const declaredAnnotations = resolveToolAnnotations({
					annotations: tool.annotations ?? null,
					writeCapability: tool.writeCapability ?? null,
					meta: tool.meta as Record<string, unknown> | null,
				});
				const annotationFailure = enforceExpectedAnnotations(
					serverCtx,
					tool,
					declaredAnnotations,
					inlineExtra,
				);
				if (annotationFailure) {
					throw new Error(callToolResultText(annotationFailure));
				}
				const riskRateLimitFailure = await enforceToolRiskRateLimit(
					serverCtx,
					tool,
				);
				if (riskRateLimitFailure) {
					throw new Error(callToolResultText(riskRateLimitFailure));
				}
				const approvalFailure = await requireDestructiveToolApproval(
					serverCtx,
					tool,
					declaredAnnotations,
					{
						// Replaying a partially executed program could repeat writes.
						allowSyncMrtr:
							isModernMcpRequest(executionRefs.approvalExtra?._meta) &&
							executionRefs.rpcCallCount === 0 &&
							executionRefs.replayUnsafeBuiltinCalls === 0,
						autoConfirmAgent:
							serverCtx.callerIdentity?.authType === "tedi" ||
							serverCtx.callerIdentity?.authType === "service",
						args: toolArgs,
						extra: executionRefs.approvalExtra,
						requestBinding: executionRefs.approvalSource
							? await sha256Hex(
									JSON.stringify([executionRefs.approvalSource, toolArgs]),
								)
							: undefined,
					},
				);
				if (approvalFailure) {
					if (approvalFailure._meta?.[INPUT_REQUIRED_META_KEY]) {
						executionRefs.approvalResult = approvalFailure;
					}
					throw new Error(callToolResultText(approvalFailure));
				}
				const executionArgs = stripDestructiveApprovalArgs(tool, toolArgs);

				const payment = await checkToolPayment({
					agent: serverCtx,
					tool,
					args: executionArgs,
					extra: executionRefs.paymentExtra ?? inlineExtra,
				});
				if (!payment.paid) return payment.result;

				const adapterScope = parseAdapterScope(tool.adapterScope);
				const resultStrategy = (tool.resultStrategy ??
					"text") as ResultStrategy;

				const rpcStart = Date.now();
				const innerCallOrdinal = executionRefs.rpcCallCount++;
				let rpcSuccess = true;
				try {
					const result = await executeTool(serverCtx, tool, executionArgs, {
						adapterScope,
						resultStrategy,
						executionId: executionRefs.executionId,
						ownerHostSessionId: executionRefs.ownerHostSessionId,
					});
					if (result.isError) {
						rpcSuccess = false;
						throw innerToolError(result);
					}
					collectCodeModeCollectionRead({
						meta: result._meta,
						executionId: executionRefs.executionId,
						innerCallOrdinal,
						into: executionRefs.collectionReads,
					});
					const settlement = await settleToolPayment(
						serverCtx,
						payment.settlement,
					);
					if (!settlement.settled) {
						rpcSuccess = false;
						throw new Error(callToolResultText(settlement.result));
					}
					const paymentResponse =
						settlement.paymentResponse ?? payment.paymentResponse;
					const paidResult = attachPaymentResponseMeta(result, paymentResponse);
					collectCodeModeReadObservation({
						meta: paidResult._meta,
						executionId: executionRefs.executionId,
						innerCallOrdinal,
						into: executionRefs.readObservations,
					});
					if (paymentResponse) {
						executionRefs.paymentResponses.push(paymentResponse);
					}
					if (paidResult.isError) {
						// An inner MCP failure must fail the Code Mode program. Merely
						// recording failed telemetry and then returning the text lets
						// `await namespace.tool()` resolve to an error-looking string;
						// the outer `code` tool and callers such as Home write settlement
						// then record a provider failure as successful execution.
						rpcSuccess = false;
						throw innerToolError(paidResult);
					}

					const normalizedResult = unwrapCallToolResult(
						paidResult,
						tool.toolId,
					);
					if (declaredAnnotations?.readOnlyHint === false)
						actionReceipt = recordFrom(
							recordFrom(paidResult._meta)?.[ACTION_RECEIPT_META_KEY],
						) as unknown as ActionReceipt | undefined;
					const normalizedRecord = recordFrom(normalizedResult);
					if (normalizedRecord) {
						const {
							appCapabilities: _appCapabilities,
							layoutSpec,
							...data
						} = normalizedRecord;
						return attachCodeModeWidgetMetadata(
							actionReceipt
								? { ...data, actionReceipt }
								: Object.keys(data).length > 0
									? data
									: normalizedRecord,
							serverCtx,
							tool,
							recordFrom(layoutSpec) ?? undefined,
						);
					}
					return normalizedResult;
				} catch (err) {
					rpcSuccess = false;
					throw err;
				} finally {
					const durationMs = Date.now() - rpcStart;
					executionRefs.rpcNamespaces.add(ns);
					writeCodeModeLog(() =>
						console.log(
							JSON.stringify({
								_cm: "rpc",
								...codeModeTailContext(serverCtx, executionRefs.executionId),
								ns,
								tool: safeName,
								durationMs,
								success: rpcSuccess,
							}),
						),
					);
					writeCodeModeAnalytics(serverCtx, {
						eventType: "rpc",
						appId: serverCtx.appId,
						appSlug: serverCtx.appSlug,
						organizationId: serverCtx.app.organizationId,
						toolName: `${ns}.${safeName}`,
						userId: serverCtx.callerIdentity?.userId,
						tediId: serverCtx.callerIdentity?.tediId,
						authType: serverCtx.callerIdentity?.authType,
						executionId: executionRefs.executionId,
						traceId: serverCtx.traceId,
						durationMs,
						success: rpcSuccess,
					});
				}
			};
			const runWithEvidence = async () => {
				try {
					const result = await runTool();
					const evidence = buildCompletionEvidence({
						operation: safeName,
						result,
						retryKey,
						attempts: retryState.attempts,
						limit: retryState.limit,
					});
					const updatedRetryState =
						evidence.status === "failed" || evidence.status === "partial"
							? executionRefs.failureBudget.recordFailure(retryKey)
							: executionRefs.failureBudget.recordSuccess(retryKey);
					const resultRecord = recordFrom(result);
					if (
						safeName === "run_skill_workflow" &&
						evidence.status === "succeeded"
					) {
						const runId = skillWorkflowRunId(result);
						if (runId && executionRefs.skillWorkflowRunIds.size < 40)
							executionRefs.skillWorkflowRunIds.add(runId);
					}
					const resultError =
						evidence.status === "failed" || evidence.status === "partial"
							? typeof resultRecord?.error === "string"
								? resultRecord.error
								: typeof resultRecord?.message === "string"
									? resultRecord.message
									: undefined
							: undefined;
					executionRefs.toolReceipts.push({
						operation: `${ns}.${safeName}`,
						status: evidence.status,
						...(actionReceipt ? { actionReceipt } : {}),
						...(resultError ? { error: resultError.slice(0, 300) } : {}),
					});
					return withCompletionEvidence(safeName, result, {
						key: retryKey,
						attempts: updatedRetryState.attempts,
						limit: updatedRetryState.limit,
					});
				} catch (error) {
					executionRefs.failureBudget.recordFailure(retryKey);
					executionRefs.toolReceipts.push({
						operation: `${ns}.${safeName}`,
						status: "failed",
						error: (error instanceof Error
							? error.message
							: String(error)
						).slice(0, 300),
					});
					throw error;
				}
			};
			return isModernMcpRequest(executionRefs.approvalExtra?._meta) ||
				isSideEffectfulTool(tool.annotations)
				? runSerializedSideEffect(executionRefs, runWithEvidence)
				: runWithEvidence();
		};

		// JSON Schema descriptor for type generation.
		group.schemas[safeName] = {
			description: tool.description ?? toolId,
			inputSchema: {
				type: "object",
				properties: (withDestructiveApprovalSchema(
					tool,
					resolveToolAnnotations({
						annotations: tool.annotations ?? null,
						writeCapability: tool.writeCapability ?? null,
						meta: tool.meta as Record<string, unknown> | null,
					}),
				).properties ??
					{}) as JsonSchemaToolDescriptors[string]["inputSchema"]["properties"],
			},
		};
	}

	return groups;
}

export function buildRuntimeProvider(
	serverCtx: ServerContext,
	executionRefs: CodeModeExecutionRefs,
	getCounts: () => {
		modules: string[];
		namespaceCount: number;
		toolCount: number;
	},
): ToolProvider {
	return {
		name: CODEMODE_NAMESPACE,
		tools: {
			__runtime: {
				description: CODEMODE_CATALOG_TOOLS.__runtime.description,
				execute: async () => {
					const executionId = executionRefs.executionId ?? null;
					const counts = getCounts();
					const userId = serverCtx.callerIdentity?.userId ?? null;
					const tediId = serverCtx.callerIdentity?.tediId ?? null;
					const externalAgentPrincipalId =
						serverCtx.callerIdentity?.externalAgentPrincipalId ?? null;
					const externalAgentSessionId =
						serverCtx.callerIdentity?.externalAgentSessionId ?? null;
					const participantIds = [
						tediId,
						externalAgentPrincipalId,
						userId,
					].filter(
						(value): value is string =>
							typeof value === "string" && value.length > 0,
					);
					return {
						mode: "stateless" as const,
						surface: "mcp-gateway" as const,
						executionId,
						appId: serverCtx.appId,
						appSlug: serverCtx.appSlug,
						organizationId: serverCtx.app.organizationId ?? null,
						traceId: serverCtx.traceId,
						actor: {
							authType: serverCtx.callerIdentity?.authType ?? "anonymous",
							userId,
							tediId,
							clientId: serverCtx.callerIdentity?.clientId ?? null,
							externalAgentPrincipalId,
							externalAgentSessionId,
							externalAgentHarness:
								serverCtx.callerIdentity?.externalAgentHarness ?? null,
							externalAgentModel:
								serverCtx.callerIdentity?.externalAgentModel ?? null,
						},
						toolCount: counts.toolCount,
						namespaceCount: counts.namespaceCount,
						modules: counts.modules,
						executionSurface: {
							kind: "mcp-gateway" as const,
							surfaceId: `mcp-gateway:${serverCtx.appId}`,
							sessionIds: [externalAgentSessionId, executionId].filter(
								(value): value is string => Boolean(value),
							),
							participantIds,
						},
					};
				},
			},
		},
		types: CODEMODE_PROVIDER_TYPES,
	};
}

// =============================================================================
// PROVIDER RESOLUTION
// =============================================================================

/**
 * Execution-only aliases for tools that moved out of a flat namespace.
 *
 * Connect once served every app of an organization as `<org>_unified.<tool>`;
 * each app now has its own namespace. Code written against the flat name keeps
 * working when exactly one moved tool answers to it and the flat namespace has
 * no tool of its own by that name. Aliases are callable but never enumerated,
 * so discovery only teaches the current names.
 */
export function legacyNamespaceAliases(
	serverCtx: ServerContext,
	namespaceOverrides: Record<string, string> | undefined,
	namespaceGroups: Map<string, NamespaceGroup>,
	collisionKeys: ReadonlySet<string>,
): Map<string, Record<string, NamespaceGroup["fns"][string]>> {
	const candidates = new Map<
		string,
		Map<string, Array<NamespaceGroup["fns"][string]>>
	>();
	for (const [toolId, tool] of serverCtx.loadedTools) {
		const legacy = tool.config?._aggregateLegacyNamespace;
		if (typeof legacy !== "string") continue;
		const { namespace, safeName, ownerKey } = projectedToolIdentity(
			toolId,
			tool,
			namespaceOverrides,
		);
		const legacyNamespace = legacy.replace(/[^a-zA-Z0-9_]/g, "_");
		const fn = namespaceGroups.get(namespace)?.fns[safeName];
		if (!fn || collisionKeys.has(ownerKey) || legacyNamespace === namespace)
			continue;
		const names = candidates.get(legacyNamespace) ?? new Map();
		names.set(safeName, [...(names.get(safeName) ?? []), fn]);
		candidates.set(legacyNamespace, names);
	}
	const aliases = new Map<
		string,
		Record<string, NamespaceGroup["fns"][string]>
	>();
	for (const [legacyNamespace, names] of candidates) {
		const own = namespaceGroups.get(legacyNamespace)?.fns ?? {};
		const fns: Record<string, NamespaceGroup["fns"][string]> = {};
		for (const [name, owners] of names) {
			if (owners.length === 1 && !Object.hasOwn(own, name)) {
				fns[name] = owners[0]!;
			}
		}
		if (Object.keys(fns).length > 0) aliases.set(legacyNamespace, fns);
	}
	return aliases;
}

export function withLegacyNamespaceAliases(
	providers: ResolvedProvider[],
	aliases: Map<string, Record<string, NamespaceGroup["fns"][string]>>,
): ResolvedProvider[] {
	const merged = providers.map((provider) => {
		const extra = aliases.get(provider.name);
		return extra
			? {
					...provider,
					fns: { ...(extra as ResolvedProvider["fns"]), ...provider.fns },
				}
			: provider;
	});
	for (const [name, fns] of aliases) {
		if (!providers.some((provider) => provider.name === name)) {
			merged.push({ name, fns: fns as ResolvedProvider["fns"] });
		}
	}
	return merged.map(withInnerErrorTransport);
}

// The SDK dispatcher preserves only Error.message. Encode structured errors
// on that channel and reconstruct an Error inside the sandbox, after RPC.
const INNER_ERROR_PREFIX = "tedix:inner-tool-error:";
function withInnerErrorTransport(provider: ResolvedProvider): ResolvedProvider {
	const names = Object.keys(provider.fns);
	return {
		...provider,
		fns: Object.fromEntries(
			names.map((name) => [
				name,
				async (...args: unknown[]) => {
					try {
						return await provider.fns[name]!(...args);
					} catch (error) {
						const detail = error as { code?: unknown; status?: unknown } | null;
						if (
							error instanceof Error &&
							(typeof detail?.code === "string" ||
								typeof detail?.status === "number")
						) {
							throw new Error(
								INNER_ERROR_PREFIX +
									JSON.stringify({
										message: error.message,
										code: detail.code,
										status: detail.status,
									}),
							);
						}
						throw error;
					}
				},
			]),
		),
		prelude: [
			provider.prelude,
			`
    for (const name of ${JSON.stringify(names)}) {
      const call = ${provider.name}[name];
      Object.defineProperty(${provider.name}, name, { value: async (...args) => {
        try { return await call(...args); }
        catch (error) {
          if (!error.message?.startsWith(${JSON.stringify(INNER_ERROR_PREFIX)})) throw error;
          const detail = JSON.parse(error.message.slice(${INNER_ERROR_PREFIX.length}));
          throw Object.assign(new Error(detail.message), { code: detail.code, status: detail.status });
        }
      } });
    }`,
		]
			.filter(Boolean)
			.join("\n"),
	};
}

/**
 * Sandbox code that exposes every provider namespace on `globalThis`. Each
 * property is a getter that returns the namespace binding on first access, so
 * `globalThis[ns]` and `const api = globalThis["ns"]` reach the same proxy as a
 * literal `ns.tool()` call. Names are identifiers the executor has validated.
 */
export function namespaceGlobalsPrelude(names: readonly string[]): string {
	const identifiers = [...new Set(names)].filter((name) =>
		/^[A-Za-z_$][\w$]*$/.test(name),
	);
	if (identifiers.length === 0) return "";
	const getters = identifiers
		.map((name) => `[${JSON.stringify(name)}, () => ${name}]`)
		.join(", ");
	return `    for (const [__tedixName, __tedixGet] of [${getters}]) {
      try {
        Object.defineProperty(globalThis, __tedixName, { configurable: true, enumerable: false, get: __tedixGet });
      } catch {}
    }`;
}

/**
 * Convert namespace groups into resolved providers for the executor.
 */
export function buildProviders(
	namespaceGroups: Map<string, NamespaceGroup>,
): ResolvedProvider[] {
	const providers: ResolvedProvider[] = [];

	for (const [ns, group] of namespaceGroups) {
		providers.push({
			name: ns,
			fns: group.fns as Record<
				string,
				(...args: unknown[]) => Promise<unknown>
			>,
		});
	}

	return providers;
}
