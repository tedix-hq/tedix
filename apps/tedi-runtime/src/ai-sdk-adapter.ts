import { requestInferenceOriginGuard } from "./runtime-inference-origin";
import { azureExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
/** Azure serving through authenticated AI Gateway, plus Tedix MCP tool adapters.
 * Agent tool turns use stateless Responses with BYOK and billing admission.
 * The separate observer/Chat helpers remain owned by llm.ts.
 */

import {
	modelRequestTelemetry,
	assertResponsesRequest,
	type ModelRequestTelemetry,
} from "./model-request-telemetry";
import {
	resolveEmbeddedToolSchemas,
	type EmbeddedToolSchemaResolution,
} from "./embedded-tool-schemas";
import { wrapUntrustedInput } from "./untrusted-input";
import { createAzure } from "@ai-sdk/azure";
import {
	AGENT_RUNTIME_AVAILABLE_PROVIDERS,
	buildModelRef,
	type ModelOverride,
	resolveModelSelection,
} from "@tedix/api-contract/schemas/model-catalog";
import type { TedixMcpRuntimeBinding } from "@tedix/mcp-client-core/runtime";
import {
	defaultSettingsMiddleware,
	wrapLanguageModel,
	type LanguageModelMiddleware,
	type ToolSet,
	tool,
} from "ai";
import * as z from "zod";
import { assertAiRequestSize } from "./ai-request-guard";
import { authorizeInferenceEntitlement } from "./billing-reservation-client";
import type { ProviderBeforeDispatch } from "@tedix/workers-ai/gateway-transport";
import type { AigMetadata, AzureChatEnv } from "./llm";
import {
	aigMetadataHeader,
	azureBaseUrl,
	azureGatewayTransport,
	usingAzureGateway,
} from "./llm";
import type { AgentMcpRuntime } from "./mcp-client-runtime";

export const DEFAULT_AI_REQUEST_TIMEOUT_MS = 120_000;
const MIN_AI_REQUEST_TIMEOUT_MS = 5_000;
const MAX_AI_REQUEST_TIMEOUT_MS = 300_000;

export function resolveAiRequestTimeoutMs(value: string | undefined): number {
	if (!value) return DEFAULT_AI_REQUEST_TIMEOUT_MS;
	const parsed = Number(value);
	return Number.isFinite(parsed) &&
		parsed >= MIN_AI_REQUEST_TIMEOUT_MS &&
		parsed <= MAX_AI_REQUEST_TIMEOUT_MS
		? Math.round(parsed)
		: DEFAULT_AI_REQUEST_TIMEOUT_MS;
}

/** Preserve caller cancellation and add an independent upstream deadline. */
export function aiGatewayRequestSignal(
	signals: ReadonlyArray<AbortSignal | null | undefined>,
	timeoutMs: number,
): AbortSignal {
	return AbortSignal.any([
		...signals.filter((signal): signal is AbortSignal => signal != null),
		AbortSignal.timeout(timeoutMs),
	]);
}

/**
 * Resolve the Azure chat DEPLOYMENT for a turn through the shared cognition
 * catalog. With no override (the default + only path today) this returns
 * `env.AZURE_CHAT_DEPLOYMENT` unchanged — byte-for-byte the previous behavior.
 * A valid, allowlisted {@link ModelOverride} naming an Azure catalog model
 * selects that deployment instead; anything unserviceable degrades back to the
 * env default (see {@link resolveModelSelection}). Secrets stay in env — the
 * catalog only selects/validates the deployment name.
 */
export function selectAzureDeployment(
	env: Pick<AzureChatEnv, "AZURE_CHAT_DEPLOYMENT">,
	override?: ModelOverride | { modelRef?: unknown } | null,
): string {
	// BYTE-FOR-BYTE default: with no override, return the env deployment verbatim
	// — NO parse/trim round-trip through the catalog. `parseModelRef` trims the
	// model-id, so routing the default through it would change a deployment value
	// carrying whitespace; the configured deployment is the provider identity
	// and must remain unchanged when no model override is selected.
	if (!override) return env.AZURE_CHAT_DEPLOYMENT;
	const selection = resolveModelSelection({
		defaultRef: buildModelRef("azure-openai", env.AZURE_CHAT_DEPLOYMENT),
		override,
		availableProviders: AGENT_RUNTIME_AVAILABLE_PROVIDERS,
	});
	// Only a VALID, allowlisted Azure override may change the deployment. Every
	// other outcome (rejected override → `source: "default"`, or a non-azure
	// provider this adapter can't serve) falls back to the env deployment
	// verbatim — same byte-for-byte guarantee as the no-override path.
	if (
		selection?.source === "override" &&
		selection.provider === "azure-openai"
	) {
		return selection.modelId;
	}
	return env.AZURE_CHAT_DEPLOYMENT;
}

/** Route recognized Azure SDK endpoints through authenticated Gateway BYOK. */
export function azureGatewayRequest(
	original: string,
	providerRoot: string,
	body: unknown,
) {
	const url = new URL(original);
	const resource = /^([a-zA-Z0-9-]+)\.openai\.azure\.com$/.exec(
		url.hostname,
	)?.[1];
	if (
		url.protocol !== "https:" ||
		!resource ||
		url.port ||
		url.username ||
		url.password ||
		url.hash
	)
		throw new Error(
			"Refusing Azure request that cannot be routed through AI Gateway",
		);
	if (url.pathname === "/openai/v1/responses" && !url.search) {
		const value = typeof body === "string" ? JSON.parse(body) : null;
		if (!value || typeof value.model !== "string" || !value.model.trim())
			throw new Error("Responses request is missing its deployment");
		return {
			api: "responses" as const,
			model: value.model,
			url: `${providerRoot}/${resource}/openai/v1/responses`,
		};
	}
	throw new Error(
		"Refusing Azure request that cannot be routed through AI Gateway",
	);
}

function gatewayFetch(
	env: AzureChatEnv,
	metadata?: AigMetadata,
	inspectRequest?: (request: ModelRequestTelemetry) => void,
	beforeDispatch?: ProviderBeforeDispatch,
): typeof fetch | undefined {
	const transport = azureGatewayTransport(env);
	// The gateway is authenticated; no direct provider fallback is allowed.
	if (!transport) {
		throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
	}
	// On the binding transport this is the pre-authenticated sentinel, not a token.
	const aigToken = transport.authorization;
	return async (input, init) => {
		const requestGuard = requestInferenceOriginGuard(beforeDispatch);
		const original =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const rawBody =
			init?.body ??
			(input instanceof Request && input.body
				? await input.clone().text()
				: undefined);
		const route = azureGatewayRequest(
			original,
			transport.providerRoot,
			rawBody,
		);
		const body = rawBody;
		const rewritten = route.url;
		const model = route.model;
		const wire = modelRequestTelemetry(rewritten, body);
		assertResponsesRequest(wire);

		// The facet validates SDK option serialization before reserving spend.
		inspectRequest?.(wire);
		const signal = aiGatewayRequestSignal(
			[init?.signal, input instanceof Request ? input.signal : undefined],
			resolveAiRequestTimeoutMs(env.TEDI_AI_REQUEST_TIMEOUT_MS),
		);
		const reservedMetadata = await authorizeInferenceEntitlement(env, {
			metadata,
			execution: azureExecutionIdentity({
				url: rewritten,
				model,
				accountId: env.AI_GATEWAY_ACCOUNT_ID,
				gatewayId: env.AI_GATEWAY_LLM_ID,
				transportKind: transport.kind,
			}),
			body,
			beforeDispatch: requestGuard,
			signal,
		});
		const send = azureGatewayTransport(
			env,
			reservedMetadata.beforeDispatch,
		)!.fetch;
		const metaHeader = aigMetadataHeader(reservedMetadata.attribution);
		const headers = azureGatewayByokHeaders(
			init?.headers ?? (input instanceof Request ? input.headers : undefined),
			aigToken,
			metaHeader,
		);
		signal.throwIfAborted();
		// Cloudflare BYOK is authoritative on the authenticated gateway path. The
		// Remove the SDK placeholder so AI Gateway supplies the stored provider key.
		if (typeof input === "string" || input instanceof URL) {
			assertAiRequestSize(body, env.TEDI_MAX_AI_REQUEST_BYTES);
			return send(rewritten, {
				...init,
				headers,
				body,
				signal,
			});
		}
		const request = new Request(rewritten, input);
		const bodyText = typeof body === "string" ? body : null;
		assertAiRequestSize(bodyText, env.TEDI_MAX_AI_REQUEST_BYTES);
		return send(request, { ...init, body, headers, signal });
	};
}

export function azureGatewayByokHeaders(
	source: HeadersInit | undefined,
	aigToken: string,
	metadataHeader?: string | null,
): Headers {
	const headers = new Headers(source);
	if (metadataHeader) headers.set("cf-aig-metadata", metadataHeader);
	headers.set("cf-aig-authorization", `Bearer ${aigToken}`);
	// Missing stored BYOK credentials must fail rather than change the payer.
	headers.set("cf-aig-no-wholesale", "true");
	headers.delete("api-key");
	return headers;
}

// Responses may normalize omitted strictness into required fields. Preserve the
// tool's declared omission semantics unless it explicitly requests strict mode.
const responsesFunctionStrictness: LanguageModelMiddleware = {
	transformParams: async ({ params }) => ({
		...params,
		tools: params.tools?.map((entry) =>
			entry.type === "function" && entry.strict == null
				? { ...entry, strict: false }
				: entry,
		),
	}),
};

export function azureModel(
	env: AzureChatEnv,
	metadata?: AigMetadata,
	inspectRequest?: (request: ModelRequestTelemetry) => void,
	beforeDispatch?: ProviderBeforeDispatch,
) {
	if (!usingAzureGateway(env)) {
		throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
	}
	const common = {
		apiKey: "cloudflare-ai-gateway-byok",
		fetch: gatewayFetch(env, metadata, inspectRequest, beforeDispatch),
	};
	const responses = createAzure({
		...common,
		baseURL: `${azureBaseUrl(env)}/openai/v1`,
	});
	return {
		responses: (deployment: string) =>
			wrapLanguageModel({
				model: responses.responses(deployment),
				middleware: [
					responsesFunctionStrictness,
					defaultSettingsMiddleware({
						settings: {
							providerOptions: {
								azure: {
									store: false,
									include: ["reasoning.encrypted_content"],
								},
							},
						},
					}),
				],
			}),
	};
}

/**
 * Runtimes whose tenant-bound connectors have been refreshed once. A WeakSet so
 * a discarded runtime (a recycled DO) warms up again on its next call.
 */
const warmedRuntimes = new WeakSet<object>();

/**
 * Wrap a `TedixMcpRuntime` (here typed as `AgentMcpRuntime`, the DO-side
 * adapter that wraps the core runtime) as an AI SDK `ToolSet`. Each tool's
 * `execute` delegates straight to `runtime.executeTool(name, args)` — which is
 * the same entry point the legacy `toolCompletion` loop calls — so per-tool
 * timeout, ledger event emission, and result truncation all still live in the
 * runtime.
 *
 * Error handling: each `execute` is wrapped via {@link safeExecuteTool} so a
 * thrown tool/subagent error becomes a structured `{ ok:false, error, tool }`
 * result the model can read, rather than propagating uncaught and aborting the
 * whole turn with an empty assistant message. This makes BOTH the Tedix OS
 * `streamText` path and the MCP `run_tedi_turn`/`generateText` path degrade
 * gracefully — the model acknowledges the failure and answers. The runtime's
 * own `tool.started`/`tool.completed`/`tool.failed` ledger events still fire
 * inside `executeTool`; this wrapper only prevents the turn-level abort.
 */
function safeExecuteTool(
	runtime: AgentMcpRuntime,
	name: string,
	args: unknown,
	binding?: TedixMcpRuntimeBinding | null,
): Promise<unknown> {
	if (binding?.toolArgumentConstraints && name === "tedix_mcp_code") {
		return Promise.resolve({
			ok: false as const,
			error:
				"Arbitrary Code Mode is disabled for this tenant-bound embedded session. Use tedix_mcp_call_tool.",
			tool: name,
		});
	}
	const callable =
		args && typeof args === "object" && "callable" in args
			? String((args as { callable?: unknown }).callable ?? "")
			: "";
	if (
		binding?.toolArgumentConstraints &&
		name === "tedix_mcp_call_tool" &&
		!binding.toolAllowedCallables?.includes(callable)
	) {
		return Promise.resolve({
			ok: false as const,
			error:
				"This tool is not permitted for the tenant-bound embedded session.",
			tool: name,
		});
	}
	const constrainedArgs =
		binding?.toolArgumentConstraints &&
		binding.toolNamespacePrefix &&
		name === "tedix_mcp_call_tool" &&
		callable.startsWith(`${binding.toolNamespacePrefix}.`)
			? {
					...(args as Record<string, unknown>),
					args: {
						...((args as { args?: Record<string, unknown> }).args ?? {}),
						...binding.toolArgumentConstraints,
					},
				}
			: args;
	const execute = () =>
		runtime.executeTool(
			name,
			constrainedArgs as Record<string, unknown>,
			binding ? { binding } : undefined,
		);
	const exactCall = name === "tedix_mcp_call_tool";
	const reconnectableCall = exactCall || name === "tedix_mcp_code";
	const tenantBoundExactCall = binding?.toolArgumentConstraints && exactCall;
	// Embedded attention and chat can arrive together on a freshly deployed DO,
	// so the first tenant-bound dispatch refreshes rather than inherit a
	// poisoned cached connector. Doing it on EVERY call charged that round trip
	// to every question a customer asks — measured at seconds per tool call,
	// twice per turn — for a hazard that only exists while the connector is
	// cold. Later calls go straight to the gateway; a connector that goes bad
	// afterwards still lands in the backoff branch below, which refreshes and
	// retries before anything reaches the model.
	const needsWarmup = tenantBoundExactCall && !warmedRuntimes.has(runtime);
	if (needsWarmup) warmedRuntimes.add(runtime);
	return (needsWarmup ? runtime.refreshConnections().then(execute) : execute())
		.catch(async (err: unknown) => {
			if (
				reconnectableCall &&
				err instanceof Error &&
				err.message.startsWith("MCP sync in failure backoff")
			) {
				// This error is raised before dispatch, so one forced reconnect cannot
				// replay an external effect: both exact calls and Code Mode perform sync
				// before sending a tool/program to the gateway. Home/kernel and embedded
				// turns otherwise inherit a cold sync failure for the whole model step
				// while the gateway may already be healthy again. The core includes the
				// prior connect error after the sentinel, so match its stable prefix.
				await runtime.refreshConnections();
				return execute();
			}
			throw err;
		})
		.catch((err: unknown) => {
			if (binding?.toolArgumentConstraints && exactCall)
				schemaCache.delete(embeddedSchemaCacheKey(binding));
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false as const, error: message, tool: name };
		});
}

/**
 * @param binding — the CALLING turn's ledger binding, captured in each tool
 *   closure and threaded to `executeTool` so tool.started/completed events are
 *   attributed to (and sequenced within) THIS turn even when a concurrent turn
 *   shares the same `AgentMcpRuntime` instance. Omit only for callers with no
 *   turn binding (core then falls back to its shared field).
 */
export function tedixMcpAITools(
	runtime: AgentMcpRuntime,
	binding?: TedixMcpRuntimeBinding | null,
): ToolSet {
	const tools: ToolSet = {
		...(binding
			? {
					mcp_read_result: tool({
						description:
							"Read or search a retained full MCP tool result by its opaque resultId. Call this built-in tool directly; it is not in the Code Mode catalog and never repeats the provider action.",
						inputSchema: z.object({
							resultId: z.string().uuid(),
							offset: z.number().int().nonnegative().optional(),
							limit: z.number().int().positive().max(50_000).optional(),
							query: z.string().min(1).optional(),
						}),
						execute: async (args) => runtime.readRetainedResult(binding, args),
					}),
				}
			: {}),
		...(!binding?.toolArgumentConstraints
			? {
					tedix_mcp_code: tool({
						description:
							"Execute Tedix Unified Code Mode JavaScript as one uninvoked async () => expression. Discover with discover.search({ query, includeParameters: true }); results are metadata, not functions. In a subsequent call, invoke the exact returned namespace.tool(args) directly, or use tedix_mcp_call_tool with its callable string. Namespace bindings are lexical, not properties of globalThis: never resolve callables through globalThis or eval. Do not shadow a namespace with a local variable (use const result = await connections.some_tool(...), never const connections = await connections.some_tool(...)).",
						inputSchema: z.object({
							code: z
								.string()
								.describe(
									"One complete uninvoked async arrow function. Discovery example: async () => { return await discover.search({ query: 'connection status', includeParameters: true }); }. Inspect the returned schema before calling the exact namespace.tool(args); use result variable names distinct from namespace names.",
								),
						}),
						execute: async (args) =>
							safeExecuteTool(runtime, "tedix_mcp_code", args, binding),
					}),
				}
			: {}),
		tedix_mcp_list_namespaces: tool({
			description:
				"Convenience wrapper around Tedix Unified Code Mode discovery. Prefer tedix_mcp_code when multi-step tool use is needed.",
			inputSchema: z.object({
				includeTools: z
					.boolean()
					.optional()
					.describe("Include tool names for each namespace. Use sparingly."),
			}),
			execute: async (args) =>
				safeExecuteTool(runtime, "tedix_mcp_list_namespaces", args, binding),
		}),
		tedix_mcp_search_tools: tool({
			description:
				"Convenience wrapper around discover.search in Tedix Unified Code Mode. Results are metadata only and include callable strings such as cms_tedix.content_list; they are not directly executable objects.",
			inputSchema: z.object({
				query: z
					.string()
					.describe(
						"Search query, usually provider or capability names like cms_tedix, promptwatch, article search, list projects.",
					),
				limit: z.number().optional().describe("Maximum results to return."),
				includeParameters: z
					.boolean()
					.optional()
					.describe("Include parameter schemas for exact calls. More verbose."),
			}),
			execute: async (args) =>
				safeExecuteTool(runtime, "tedix_mcp_search_tools", args, binding),
		}),
		tedix_mcp_call_tool: tool({
			description:
				"Convenience wrapper for a single Tedix Unified Code Mode namespace.tool(args) call, for example promptwatch_tedix.list_projects or cms_tedix.search.",
			inputSchema: z.object({
				callable: z
					.string()
					.describe("Exact callable in namespace.tool format."),
				args: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("JSON arguments for the callable."),
			}),
			execute: async (args) =>
				safeExecuteTool(runtime, "tedix_mcp_call_tool", args, binding),
		}),
		mcp_read_resource: tool({
			description:
				"Read any MCP resource by server ID and URI. Use this to load skill:// resources for full instructions, follow cross-references inside a skill, or read templates listed in the guidance summaries (substitute {placeholders} first).",
			inputSchema: z.object({
				server: z
					.string()
					.describe("Connected MCP server ID (serverId from guidance)."),
				uri: z
					.string()
					.describe("Resource URI, e.g. skill://git-workflow/SKILL.md."),
			}),
			execute: async (args) =>
				safeExecuteTool(runtime, "mcp_read_resource", args, binding),
		}),
		mcp_complete_argument: tool({
			description:
				"Autocomplete an argument value against a connected MCP server that advertises the completions capability — e.g. resolve a partial session_key/conversationId or artifact path before calling a tool that requires it. Returns candidate values only; pick one deliberately and pass it in the actual call — never guess when several candidates remain (narrow with a longer partial instead).",
			inputSchema: z.object({
				server: z
					.string()
					.describe("Connected MCP server ID (serverId from guidance)."),
				argument: z
					.string()
					.describe("Name of the argument to complete, e.g. session_key."),
				partial: z
					.string()
					.optional()
					.describe("Partial value already known; narrows the candidates."),
				resourceUri: z
					.string()
					.optional()
					.describe(
						"Resource URI template for a ref/resource completion, e.g. repo://{branch}/tree. Takes precedence over prompt.",
					),
				prompt: z
					.string()
					.optional()
					.describe(
						"Prompt name for a ref/prompt completion. Defaults to tool_arguments.",
					),
				context: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						"Sibling argument values that scope the completion, e.g. { tediId: 'tedi_42' }.",
					),
			}),
			execute: async (args) =>
				safeExecuteTool(runtime, "mcp_complete_argument", args, binding),
		}),
		mcp_directory_read: tool({
			description:
				"Read direct children of an MCP directory resource by server ID and directory URI. Use this for skill:// directories when a server advertises the Skills extension with directoryRead.",
			inputSchema: z.object({
				server: z
					.string()
					.describe("Connected MCP server ID (serverId from guidance)."),
				uri: z
					.string()
					.describe("Directory resource URI, e.g. skill://git-workflow."),
				cursor: z
					.string()
					.optional()
					.describe("Optional pagination cursor from a prior result."),
			}),
			execute: async (args) =>
				safeExecuteTool(runtime, "mcp_directory_read", args, binding),
		}),
	};
	return binding?.toolArgumentConstraints
		? {
				mcp_read_result: tools.mcp_read_result!,
				tedix_mcp_call_tool: tools.tedix_mcp_call_tool!,
			}
		: tools;
}

/** Hydrate only the signed embedded tools using the turn's existing MCP runtime. */
/**
 * Resolved tool schemas, per runtime and admitted allowlist.
 *
 * Describing the admitted callables runs a Code Mode program against the
 * gateway — measured at 2 to 6.5 seconds — and it ran before EVERY embedded
 * turn, ahead of the model's first token, to fetch metadata that only changes
 * when the tenant's catalog or profile changes. The window is deliberately
 * short: a tool whose schema changed is wrong for minutes, not for the life of
 * the isolate.
 */
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * A partial read is cached only briefly. Never caching it makes a permanently
 * unmounted callable re-describe on every turn (~4s each, forever); caching it
 * for the full window makes a transient miss look permanent for ten minutes.
 */
const PARTIAL_SCHEMA_CACHE_TTL_MS = 60 * 1000;
const SCHEMA_CACHE_MAX_ENTRIES = 64;
/**
 * Module scope, not the runtime instance.
 *
 * The first version of this cache hung off the `AgentMcpRuntime` in a WeakMap,
 * which looked right and never hit: a Durable Object hibernates between turns,
 * so the next question built a new runtime and paid the describe again —
 * measured at 11.4s on a live turn, by then the single largest item in it. The
 * isolate outlives the object, so the cache belongs here, keyed so one tenant
 * can never read another's schemas.
 */
const schemaCache = new Map<
	string,
	{ resolvedAt: number; schemas: string[]; missing: string[] }
>();

/** Same conversation owner, same namespace, same admitted callables — or a miss. */
export function embeddedSchemaCacheKey(
	binding: Pick<
		TedixMcpRuntimeBinding,
		"toolNamespacePrefix" | "toolAllowedCallables" | "conversationId"
	>,
): string {
	// `conversationId` is `${tediRef}:${sessionKey}`; the tedi is the tenant
	// boundary and the session is not, so only the first segment belongs here.
	const owner = String(binding.conversationId ?? "").split(":", 1)[0] ?? "";
	return `${owner}|${binding.toolNamespacePrefix ?? ""}|${[
		...new Set(binding.toolAllowedCallables ?? []),
	]
		.sort()
		.join(",")}`;
}

// Only metadata already being resolved by the same runtime is shared. New
// runtimes keep their own connector/auth preparation; the result TTL is unchanged.
const pendingSchemaReads = new WeakMap<
	object,
	Map<string, Promise<EmbeddedToolSchemaResolution>>
>();

export async function preparedTedixMcpAITools(
	runtime: AgentMcpRuntime,
	binding?: TedixMcpRuntimeBinding | null,
	now: () => number = Date.now,
): Promise<ToolSet> {
	const tools = tedixMcpAITools(runtime, binding);
	if (!binding?.toolArgumentConstraints) return tools;
	const started = performance.now();
	let source = "failed";
	let schemaCount = 0;
	try {
		const key = embeddedSchemaCacheKey(binding);
		const cached = schemaCache.get(key);
		const cachedTtl =
			cached && cached.missing.length
				? PARTIAL_SCHEMA_CACHE_TTL_MS
				: SCHEMA_CACHE_TTL_MS;
		const fresh = cached && now() - cached.resolvedAt < cachedTtl;
		let resolution: EmbeddedToolSchemaResolution;
		if (fresh) {
			source = "cache_hit";
			resolution = { schemas: cached.schemas, missing: cached.missing };
		} else {
			let pending = pendingSchemaReads.get(runtime);
			if (!pending) pendingSchemaReads.set(runtime, (pending = new Map()));
			let read = pending.get(key);
			source = read ? "shared_inflight" : "resolved";
			if (!read) {
				read = resolveEmbeddedToolSchemas(
					binding.toolAllowedCallables ?? [],
					(code) =>
						runtime.executeTool("tedix_mcp_code", { code }, { binding }),
				).finally(() => {
					pending!.delete(key);
				});
				pending.set(key, read);
			}
			resolution = await read;
		}
		const { schemas, missing } = resolution;
		schemaCount = schemas.length;
		// A signed profile admits these, so an operator reading the transcript
		// sees only a model saying "try again later". Name them once per
		// resolution instead: absent here means not mounted on this session's
		// gateway, which no profile republish can fix.
		if (!fresh && missing.length)
			console.warn(
				"[Embedded capabilities] Admitted callables resolved no parameter schema:",
				missing.join(", "),
			);
		// An empty or failed description is never cached: the next turn retries
		// rather than answering without the schemas for ten minutes. A partial
		// read is cached under the short window above, so a transient miss heals
		// in a minute without charging every turn for a permanent one.
		if (schemas.length && !fresh) {
			// Discovery already synchronized this runtime; do not handshake again
			// before its first exact business call. A cache hit alone proves nothing.
			warmedRuntimes.add(runtime);
			schemaCache.set(key, { resolvedAt: now(), schemas, missing });
			// Bounded: drop the oldest insertion rather than grow with tenants.
			while (schemaCache.size > SCHEMA_CACHE_MAX_ENTRIES) {
				const oldest = schemaCache.keys().next().value;
				if (oldest === undefined) break;
				schemaCache.delete(oldest);
			}
		}
		const callTool = tools.tedix_mcp_call_tool;
		if (callTool && schemas.length)
			callTool.description = `${callTool.description}

Exact admitted parameter schemas (metadata only; execution authorization is unchanged):
${wrapUntrustedInput(schemas.join("\n"), "embedded_tool_schemas")}`;
		// The host page's admitted list is not a capability list. Saying so here,
		// next to the schemas, is what stops the model offering a tool it cannot
		// call and then apologizing for it every turn.
		if (callTool && missing.length)
			callTool.description = `${callTool.description}

Not available in this session, despite appearing in the admitted list: ${missing.join(", ")}. Do not call these and do not retry them. If the request needs one, say that capability is unavailable here and offer what the available tools can answer.`;
	} catch (error) {
		source = "failed";
		console.error(
			"[Embedded capabilities] Tool schema read failed:",
			error instanceof Error ? error.message : error,
		);
	} finally {
		try {
			console.log({
				_tr: "embedded_schema_prepare",
				runId: binding.runId ?? null,
				source,
				schemaCount,
				durationMs: Math.round(performance.now() - started),
			});
		} catch {
			/* telemetry must never break tool preparation */
		}
	}
	return tools;
}
