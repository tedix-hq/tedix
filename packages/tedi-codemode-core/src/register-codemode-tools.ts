/**
 * registerCodeModeTools — runtime-neutral stateless MCP Code Mode wrapper.
 *
 * Wraps an inner McpServer's tool surface into a single outer `code`
 * tool that executes JS in a DynamicWorkerExecutor sandbox with all
 * tools exposed as typed `codemode.*` methods. Adds synthetic
 * `codemode.__tools()` and `codemode.__doc({ name })` introspection
 * functions for progressive discovery.
 *
 * Mounted by the Agent runtime for per-tedi /mcp Code Mode. Durable execution
 * belongs to the Agent runtime facets that own durable state; this wrapper
 * stays request-scoped for stateless MCP transport.
 *
 * @see docs/mcp/codemode.md
 */

import {
	DynamicWorkerExecutor,
	generateTypesFromJsonSchema,
	type ResolvedProvider,
	sanitizeToolName,
} from "@cloudflare/codemode";
import { Client } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
	buildCompletionEvidence,
	withCompletionEvidence,
} from "@tedix/api-contract/schemas/execution-evidence";
import * as z from "zod";
import {
	type CodeModeTruncationOptions,
	boundCodeModeLogs,
	shapeBoundedCodeModeResult,
	stringifyBoundedCodeModeResult,
} from "./bounded-result";
import { buildCodeDescription } from "./code-description";
import {
	buildIdenticalCallKey,
	IdenticalFailureBudget,
} from "./failure-budget";
import { unwrapMcpResult } from "./helpers";
import { runStatelessCodeMode } from "./run-stateless-code";
import { withModelAuthoredCodeIsolation } from "./model-authored-code-loader";
import type {
	CodeModeExecutionContext,
	CodeModeRuntime,
	CodeModeTraceContext,
	RegisterCodeModeToolsOptions,
	ToolSummary,
} from "./types";

const DISCOVERY_TIMEOUT_MS = 10_000;
const IDENTICAL_FAILURE_LIMIT = 2;

/**
 * Bound the model-facing result WITHOUT silent type degradation: an oversized
 * structured result becomes a `__tedix_truncated` envelope (see
 * `bounded-result.ts`) so parsers cannot mistake a partial value for a
 * complete result. Within budget the value passes through
 * byte-identical.
 */
function shapeModelResult(
	value: unknown,
	options: CodeModeTruncationOptions | undefined,
): unknown {
	return shapeBoundedCodeModeResult(value, options);
}

function stringifyModelResult(
	value: unknown,
	options: CodeModeTruncationOptions | undefined,
): string {
	return stringifyBoundedCodeModeResult(value, options);
}

function logContext(
	tediId: string,
	traceContext: CodeModeTraceContext | undefined,
	context: CodeModeExecutionContext,
): Record<string, unknown> {
	return {
		tediId,
		executionId: context.executionId,
		executionKind: context.kind,
		surface: traceContext?.surface ?? "mcp-codemode",
		organizationId: traceContext?.organizationId ?? "",
		traceId: traceContext?.traceId ?? "",
		callerSubject: traceContext?.caller?.subject ?? "",
		callerAuthType: traceContext?.caller?.authType ?? "",
		callerClientId: traceContext?.caller?.clientId ?? "",
	};
}

function createExecutionContext(kind: CodeModeExecutionContext["kind"]) {
	return { executionId: crypto.randomUUID(), kind };
}

/** Dispatch is bounded independently of a command's asynchronous runtime timeout. */
function toolCallTimeoutMs(toolName: string): number | undefined {
	if (
		toolName === "open_computer" ||
		toolName === "close_computer" ||
		toolName === "exec"
	)
		return 60_000;
	if (toolName === "read_execution" || toolName === "cancel_execution")
		return 30_000;
	return undefined;
}

function isSideEffectfulTool(
	annotations:
		| {
				readOnlyHint?: boolean;
		  }
		| null
		| undefined,
): boolean {
	return annotations?.readOnlyHint !== true;
}

function runSerializedSideEffect<T>(
	queueRef: { current: Promise<void> },
	fn: () => Promise<T>,
): Promise<T> {
	const run = queueRef.current.catch(() => undefined).then(fn);
	queueRef.current = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * Register Code Mode on the outer server by wrapping an inner server's tools.
 *
 * Connects to innerServer via InMemoryTransport, discovers all tools via the
 * MCP protocol, builds typed fns with unwrapMcpResult, generates types via
 * generateTypesFromJsonSchema, and registers a single `code` tool on
 * outerServer.
 *
 * Returns true if Code Mode was activated. Returns false when no LOADER is
 * available, when discovery fails, or when no tools are registered — callers
 * should fall back to standard tool registration on the outer server.
 */
export async function registerCodeModeTools(
	outerServer: McpServer,
	innerServer: McpServer,
	options: RegisterCodeModeToolsOptions,
): Promise<boolean> {
	const {
		loader,
		tediId,
		timeoutMs,
		extras,
		extraInstructions,
		traceContext,
		resultMaxTokens,
	} = options;
	const truncationOptions: CodeModeTruncationOptions | undefined =
		resultMaxTokens !== undefined ? { maxTokens: resultMaxTokens } : undefined;

	if (!loader) {
		console.warn(
			"[tedi-codemode] Code Mode requested but LOADER binding not available.",
		);
		return false;
	}

	const executor = new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(loader),
		// Match @cloudflare/codemode 0.4.2's default. Callers can still pass a
		// stricter timeoutMs for tenant/tool-specific policy.
		timeout: timeoutMs ?? 60_000,
		globalOutbound: null,
	});

	type DiscoveryResult = {
		tools: Awaited<ReturnType<Client["listTools"]>>["tools"];
		client: Client;
	};
	let discovery: DiscoveryResult;
	try {
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await innerServer.connect(serverTransport);
		const mcpClient = new Client({ name: "codemode-proxy", version: "1.0.0" });
		await mcpClient.connect(clientTransport);
		// The SDK request timeout rejects with an SdkError (RequestTimeout) and
		// clears its own timer, unlike a Promise.race against a bare setTimeout.
		const { tools } = await mcpClient.listTools(undefined, {
			timeout: DISCOVERY_TIMEOUT_MS,
		});
		discovery = { tools, client: mcpClient };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(
			`[tedi-codemode] Code Mode discovery failed (${msg}). Falling back to standard tool registration.`,
		);
		return false;
	}

	const { tools, client } = discovery;

	if (tools.length === 0) {
		console.warn("[tedi-codemode] No tools discovered on inner server.");
		return false;
	}

	const toolDescriptors: Record<
		string,
		{
			description?: string;
			inputSchema: Record<string, unknown>;
		}
	> = {};
	for (const tool of tools) {
		toolDescriptors[tool.name] = {
			description: tool.description,
			inputSchema: tool.inputSchema,
		};
	}

	const toolSummaries: ToolSummary[] = tools.map((tool) => {
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ type?: string }
		>;
		const required = new Set((tool.inputSchema.required ?? []) as string[]);
		const parts = Object.entries(props).map(([key, prop]) => {
			const opt = required.has(key) ? "" : "?";
			return `${key}${opt}: ${prop.type ?? "any"}`;
		});
		return {
			name: sanitizeToolName(tool.name),
			description: (tool.description ?? "").split("\n")[0]?.slice(0, 200) ?? "",
			paramSummary: `(${parts.join(", ")})`,
		};
	});

	const fullTypes = generateTypesFromJsonSchema(toolDescriptors);

	const perToolDocs: Record<string, string> = {};
	for (const tool of tools) {
		const sanitized = sanitizeToolName(tool.name);
		const single = generateTypesFromJsonSchema({
			[tool.name]: toolDescriptors[tool.name]!,
		});
		perToolDocs[sanitized] = single;
	}

	const extraProviders: ResolvedProvider[] = [];
	const createCodemodeProvider = (
		context: CodeModeExecutionContext,
	): ResolvedProvider => {
		const workstationSideEffectQueue = { current: Promise.resolve() };
		const failureBudget = new IdenticalFailureBudget(IDENTICAL_FAILURE_LIMIT);
		const fns: Record<
			string,
			(args: Record<string, unknown>) => Promise<unknown>
		> = {};
		for (const tool of tools) {
			const toolName = tool.name;
			fns[sanitizeToolName(toolName)] = async (args) => {
				const key = buildIdenticalCallKey(toolName, args);
				const retryState = failureBudget.state(key);
				if (retryState.blocked) {
					return withCompletionEvidence(
						toolName,
						{
							ok: false,
							error:
								"Identical call blocked after repeated failures. Change the arguments or execution plan.",
						},
						{
							key,
							attempts: retryState.attempts,
							limit: retryState.limit,
							blocked: true,
						},
					);
				}
				const runTool = async () => {
					const rpcStart = Date.now();
					let rpcSuccess = true;
					let rpcError: string | undefined;
					try {
						const timeout = toolCallTimeoutMs(toolName);
						const result = await client.callTool(
							{
								name: toolName,
								arguments: args,
							},
							timeout
								? {
										maxTotalTimeout: timeout + 30_000,
										resetTimeoutOnProgress: true,
										timeout,
									}
								: undefined,
						);
						const unwrapped = unwrapMcpResult(
							result as Record<string, unknown>,
						);
						const evidence = buildCompletionEvidence({
							operation: toolName,
							result: unwrapped,
							retryKey: key,
							attempts: retryState.attempts,
							limit: retryState.limit,
						});
						const updatedRetryState =
							evidence.status === "failed" || evidence.status === "partial"
								? failureBudget.recordFailure(key)
								: failureBudget.recordSuccess(key);
						return withCompletionEvidence(toolName, unwrapped, {
							key,
							attempts: updatedRetryState.attempts,
							limit: updatedRetryState.limit,
						});
					} catch (err) {
						rpcSuccess = false;
						rpcError = err instanceof Error ? err.message : String(err);
						const updatedRetryState = failureBudget.recordFailure(key);
						return withCompletionEvidence(
							toolName,
							{ ok: false, error: rpcError },
							{
								key,
								attempts: updatedRetryState.attempts,
								limit: updatedRetryState.limit,
							},
						);
					} finally {
						console.log(
							JSON.stringify({
								_cm: "rpc",
								...logContext(tediId, traceContext, context),
								tool: toolName,
								durationMs: Date.now() - rpcStart,
								success: rpcSuccess,
								...(rpcError && { error: rpcError.slice(0, 200) }),
							}),
						);
					}
				};
				return isSideEffectfulTool(tool.annotations)
					? runSerializedSideEffect(workstationSideEffectQueue, runTool)
					: runTool();
			};
		}
		fns.__tools = async () => toolSummaries;
		fns.__doc = async (args: Record<string, unknown>) => {
			const name = typeof args?.name === "string" ? args.name : "";
			if (!name)
				return { error: "Pass { name: '<toolName>' }", types: fullTypes };
			const sanitized = sanitizeToolName(name);
			const summary = toolSummaries.find((t) => t.name === sanitized);
			if (!summary) return { error: `Unknown tool: ${name}` };
			return {
				name: summary.name,
				description: summary.description,
				paramSummary: summary.paramSummary,
				types: perToolDocs[sanitized] ?? "",
			};
		};
		fns.__runtime = async () => ({
			mode: "stateless",
			tediId,
			toolCount: tools.length,
			...logContext(tediId, traceContext, context),
		});
		return {
			name: "codemode",
			fns: fns as Record<string, (...args: unknown[]) => Promise<unknown>>,
		};
	};

	const runtime: CodeModeRuntime = {
		executor,
		createProviders: (context) => [
			createCodemodeProvider(context),
			...extraProviders,
		],
		addProvider: (provider) => {
			extraProviders.push(provider);
		},
		logContext: (context) => logContext(tediId, traceContext, context),
	};

	const description = [
		buildCodeDescription(toolSummaries, tools[0]),
		"Every operational tool result includes completionEvidence. Claim only supportedClaims, cite evidenceRefs, and never infer a completed build/test/deploy from an exec acceptance receipt. Poll read_execution for terminal evidence. When retry.blocked is true, change the arguments or plan.",
		...(extraInstructions ?? []),
	].join("\n\n");

	outerServer.registerTool(
		"code",
		{
			description,
			inputSchema: z.object({
				code: z.string().describe("JavaScript async arrow function to execute"),
			}),
		},
		async ({ code }) => {
			const execStart = Date.now();
			const context = createExecutionContext("code");
			try {
				const result = await runStatelessCodeMode({
					code,
					executor,
					providers: runtime.createProviders(context),
				});
				// The Cloudflare codemode SDK never throws on a thrown
				// JS/ReferenceError inside executed code — it returns
				// `{ result: undefined, error: <msg> }`. Without this guard the
				// success path below shapes `undefined` into a silent
				// `result: null` and reports the run as succeeded.
				if (result.error) {
					const errorMessage = result.error;
					console.log(
						JSON.stringify({
							_cm: "exec",
							...runtime.logContext(context),
							toolCount: tools.length,
							totalDurationMs: Date.now() - execStart,
							codeLength: code.length,
							success: false,
							error: errorMessage.slice(0, 200),
						}),
					);
					return {
						content: [
							{
								type: "text" as const,
								text: `Execution error: ${errorMessage}`,
							},
						],
						isError: true,
						structuredContent: {
							executionId: context.executionId,
							error: errorMessage,
						},
					};
				}
				const modelResult = shapeModelResult(result.result, truncationOptions);
				console.log(
					JSON.stringify({
						_cm: "exec",
						...runtime.logContext(context),
						toolCount: tools.length,
						totalDurationMs: Date.now() - execStart,
						codeLength: code.length,
						success: true,
					}),
				);

				const output: Record<string, unknown> = {
					executionId: context.executionId,
					result: modelResult ?? null,
				};
				if (result.logs?.length) {
					output.logs = boundCodeModeLogs(result.logs, truncationOptions);
				}

				return {
					content: [
						{
							type: "text" as const,
							text: stringifyModelResult(output, truncationOptions),
						},
					],
					structuredContent: output,
				};
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error);
				console.log(
					JSON.stringify({
						_cm: "exec",
						...runtime.logContext(context),
						toolCount: tools.length,
						totalDurationMs: Date.now() - execStart,
						codeLength: code.length,
						success: false,
						error: errorMessage.slice(0, 200),
					}),
				);
				return {
					content: [
						{
							type: "text" as const,
							text: `Execution error: ${errorMessage}`,
						},
					],
					isError: true,
					structuredContent: {
						executionId: context.executionId,
						error: errorMessage,
					},
				};
			}
		},
	);

	if (extras) {
		await extras(outerServer, runtime);
	}

	console.log(
		`[tedi-codemode] Code Mode enabled: 1 base tool (code) wrapping ${tools.length} inner tools${extras ? " + extras" : ""}`,
	);
	return true;
}
