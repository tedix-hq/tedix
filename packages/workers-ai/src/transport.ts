import {
	ProviderExecutionIdentitySchema,
	type ProviderExecutionIdentity,
} from "@tedix/api-contract/schemas/provider-execution";
/**
 * Workers AI transport.
 *
 * ONE way to call a Cloudflare Workers AI model from a Worker, with a
 * gateway-vs-binding choice made per call:
 *
 *   - PREFERRED — the AI Gateway OpenAI-compatible endpoint
 *     (`…/{gateway}/workers-ai/v1/chat/completions`). This routes Workers AI
 *     through the SAME authenticated AI Gateway the Azure path already uses, so
 *     Workers-AI spend is counted + observable under unified billing. The
 *     transport is resolved by `resolveAiGatewayTransport`: the Workers AI
 *     binding when `AI_GATEWAY_BINDING_PROVIDERS` lists `workers-ai` (no token,
 *     no public hop), otherwise the public HTTPS endpoint with the
 *     authenticated-gateway token (`CF_AI_GATEWAY_TOKEN` →
 *     `cf-aig-authorization`) AND a Workers-AI API token (`CF_WORKERS_AI_TOKEN`
 *     → `Authorization`, BYOK).
 *   - FALLBACK — the token-free `env.AI` binding (`env.AI.run(...)`). Used when
 *     any gateway prerequisite is absent so local dev / a missing secret still
 *     works.
 *
 * Both paths accept the SAME OpenAI-shaped `messages`/`tools` and return a
 * normalized {@link WorkersAiTransportResult}.
 *
 * TWO SEAMS ARE THE CALLER'S, and they are the only ones:
 *
 *   - ATTRIBUTION — {@link WorkersAiTransportRequest.attribution} is a
 *     PRE-NORMALIZED `Record<string, string>`. Each app owns its own encoder
 *     (including the AI-Gateway five-entry cap) because the surface tag and the
 *     defaults around it are app policy. This file only serializes what it is
 *     handed, and emits nothing when handed nothing.
 *   - AUTHORIZATION — {@link WorkersAiClient.authorize} is REQUIRED, never
 *     optional. An optional hook is a hook a caller forgets, and a forgotten
 *     one means UNMETERED inference. A caller that genuinely has no billing
 *     plane passes an explicit no-op.
 *
 * Nothing here branches on which app is calling.
 */

import {
	type AiGatewayTransport,
	type ProviderBeforeDispatch,
	assertProviderDispatchReady,
	resolveAiGatewayTransport,
} from "./gateway-transport";

/** Minimal env surface the transport reads. */
export interface WorkersAiTransportEnv {
	/**
	 * Workers AI binding. OPTIONAL: the HTTPS gateway path needs no binding at
	 * all, and a deployment may run entirely on it.
	 */
	AI?: Ai;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_LLM_ID?: string;
	CF_AI_GATEWAY_TOKEN?: string;
	CF_WORKERS_AI_TOKEN?: string;
	AI_GATEWAY_BINDING_PROVIDERS?: string;
}

/** What {@link WorkersAiClient.authorize} is told about the call it gates. */
export interface WorkersAiAuthorizeInput {
	/** Original request cancellation; authorizers must check after their own awaits. */
	signal?: AbortSignal;
	/** Exact provider route, shared with typed Jev calls so admission stays canonical. */
	execution: Readonly<ProviderExecutionIdentity>;
	/** The resolved Workers AI model id. */
	model: string;
	/** Exact serialized inference payload for sizing. */
	body: string;
	/** The caller-supplied, already-normalized attribution for this call. */
	attribution?: Record<string, string>;
}

/** Private authorization belongs to one request; only attribution reaches the wire. */
export interface WorkersAiAuthorization {
	attribution?: Record<string, string>;
	beforeDispatch?: ProviderBeforeDispatch;
	signal?: AbortSignal;
}

/** Authorize one inference before it leaves the Worker. No attribution-only return. */
export type WorkersAiAuthorize = (
	input: WorkersAiAuthorizeInput,
) => Promise<WorkersAiAuthorization>;

/** Compose request-local authority with the client's existing synchronous wire guard. */
export function authorizedProviderDispatch(
	clientGuard: ProviderBeforeDispatch | undefined,
	authorization: WorkersAiAuthorization,
	requestSignal?: AbortSignal,
): { beforeDispatch: ProviderBeforeDispatch; signal?: AbortSignal } {
	const ownGuard = authorization.beforeDispatch;
	const signals = [requestSignal, authorization.signal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
	return {
		signal,
		beforeDispatch: () => {
			assertProviderDispatchReady(clientGuard);
			assertProviderDispatchReady(ownGuard);
			// Either guard may abort; this is the final check before the real send.
			signal?.throwIfAborted();
		},
	};
}

/**
 * Everything a Workers AI call needs beyond the request itself. `authorize` is
 * required on purpose; see the seam note at the top of this file.
 */
export interface WorkersAiClient {
	env: WorkersAiTransportEnv;
	authorize: WorkersAiAuthorize;
	/** Optional for non-DO clients; supplied authority is checked at every actual wire send. */
	beforeDispatch?: ProviderBeforeDispatch;
}

/**
 * A Workers-AI chat request. `messages`/`tools` are ALREADY OpenAI-shaped (the
 * exact shape both the gateway endpoint and the `env.AI` binding accept), so the
 * transport passes them straight through.
 */
export interface WorkersAiTransportRequest {
	messages: unknown[];
	tools?: unknown[];
	tool_choice?: unknown;
	max_tokens?: number;
	temperature?: number;
	/** e.g. `{ type: "json_object" }` to constrain the model to JSON. */
	response_format?: unknown;
	/** Bounds a stalled call: gateway fetch aborts natively; binding path races. */
	signal?: AbortSignal;
	/**
	 * Pre-normalized AI Gateway attribution, forwarded as `cf-aig-metadata` (or
	 * the binding's `gateway.metadata`). Absent or empty → no tag is emitted at
	 * all, never a blank one.
	 */
	attribution?: Record<string, string>;
}

export interface WorkersAiTransportToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface WorkersAiTransportResult {
	text: string;
	/** Model reasoning remains separate from assistant prose. */
	reasoning?: string;
	toolCalls: WorkersAiTransportToolCall[];
	usage: {
		promptTokens: number | null;
		completionTokens: number | null;
		reasoningTokens?: number;
		cachedInputTokens?: number;
	};
}

/** Resolve the AI Gateway id (the dedicated LLM gateway). */
function gatewayId(env: WorkersAiTransportEnv): string | undefined {
	return env.AI_GATEWAY_LLM_ID?.trim() || undefined;
}

/**
 * Resolve the gateway transport for Workers AI, or `null` when the gateway path
 * is not fully configured (→ the `env.AI.run` binding fallback).
 *
 * Over HTTPS the gateway's workers-ai passthrough additionally needs a
 * Workers-AI BYOK token (`Authorization`); over the Workers AI binding the
 * channel authenticates the account itself, so no token is involved at all.
 */
export function workersAiGatewayTransport(
	env: WorkersAiTransportEnv,
	beforeDispatch?: ProviderBeforeDispatch,
): AiGatewayTransport | null {
	const gateway = gatewayId(env);
	if (!gateway) return null;
	const transport = resolveAiGatewayTransport(
		env,
		gateway,
		"workers-ai",
		beforeDispatch,
	);
	if (transport?.kind === "https" && !env.CF_WORKERS_AI_TOKEN?.trim()) {
		return null;
	}
	return transport;
}

/** True when the AI Gateway path (binding or HTTPS) can serve Workers AI. */
export function usingWorkersAiGateway(env: WorkersAiTransportEnv): boolean {
	return workersAiGatewayTransport(env) !== null;
}

/**
 * The attribution to actually send, or `undefined` when there is none. An EMPTY
 * record is undefined too: a blank `cf-aig-metadata` header is worse than no
 * header — it is an attribution tag that attributes nothing.
 */
function presentAttribution(
	attribution: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!attribution) return undefined;
	return Object.keys(attribution).length > 0 ? attribution : undefined;
}

function numOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Coerce a provider tool-call argument blob (string or object) to an object. */
function toArgsObject(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === "object" && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	if (typeof raw === "string") {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			/* fall through */
		}
	}
	return {};
}

interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	completion_tokens_details?: { reasoning_tokens?: number };
	prompt_tokens_details?: { cached_tokens?: number };
}

interface ReasoningContent {
	reasoning_content?: string | null;
	reasoning?: string | null;
}

function reasoningContent(
	message: ReasoningContent | undefined,
): string | undefined {
	for (const value of [message?.reasoning_content, message?.reasoning]) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function normalizedUsage(
	usage: ChatUsage | undefined,
): WorkersAiTransportResult["usage"] {
	const reasoningTokens = numOrNull(
		usage?.completion_tokens_details?.reasoning_tokens,
	);
	const cachedInputTokens = numOrNull(
		usage?.prompt_tokens_details?.cached_tokens,
	);
	return {
		promptTokens: numOrNull(usage?.prompt_tokens),
		completionTokens: numOrNull(usage?.completion_tokens),
		...(reasoningTokens !== null ? { reasoningTokens } : {}),
		...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
	};
}

// ── Gateway (OpenAI-compatible) response shapes ──────────────────────────────
interface OpenAiChatResponse {
	choices?: Array<{
		message?: ReasoningContent & {
			content?: string | null;
			tool_calls?: Array<{
				id?: string;
				type?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
	usage?: ChatUsage;
}

// ── Binding (unwrapped) response shape ───────────────────────────────────────
interface BindingResponse extends ReasoningContent {
	response?: string | null;
	tool_calls?: Array<{ name?: string; arguments?: unknown }>;
	usage?: ChatUsage;
	/** Some models/proxied binding paths return the OpenAI chat shape instead of
	 * `{response}` (observed live: llama-3.1-8b-fast via the local remote-AI
	 * binding — completion_tokens > 0 but `response` absent). */
	choices?: Array<{ message?: ReasoningContent & { content?: string | null } }>;
}

/** Both transports share fields; only their model/stream envelope differs. */
function chatBody(
	modelId: string,
	req: WorkersAiTransportRequest,
	gateway: boolean,
): Record<string, unknown> {
	const body: Record<string, unknown> = gateway
		? { model: modelId, messages: req.messages }
		: { messages: req.messages, stream: false };
	if (req.tools && req.tools.length > 0) body.tools = req.tools;
	if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
	if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	if (req.response_format !== undefined)
		body.response_format = req.response_format;
	return body;
}

async function callViaGateway(
	env: WorkersAiTransportEnv,
	transport: AiGatewayTransport,
	modelId: string,
	req: WorkersAiTransportRequest,
	serialized: string,
): Promise<WorkersAiTransportResult> {
	// Same provider-native path on either transport; the binding root just omits
	// the account id.
	const url = `${transport.providerRoot}/v1/chat/completions`;

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"cf-aig-authorization": `Bearer ${transport.authorization}`,
	};
	// The HTTPS workers-ai passthrough also needs the Workers-AI BYOK token; the
	// binding channel is already authenticated for this account.
	if (transport.kind === "https") {
		headers.Authorization = `Bearer ${env.CF_WORKERS_AI_TOKEN?.trim()}`;
	}
	const attribution = presentAttribution(req.attribution);
	if (attribution) headers["cf-aig-metadata"] = JSON.stringify(attribution);

	const response = await transport.fetch(url, {
		method: "POST",
		headers,
		body: serialized,
		signal: req.signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		// On 4xx include the REQUEST BODY head: Workers AI's "AiError: Invalid
		// input" (8001) names nothing, and the same-shaped request succeeding
		// from outside the Worker made a body-less error undiagnosable. The body
		// is our own prompt + params — no credentials live in it.
		const bodyHead =
			response.status >= 400 && response.status < 500
				? ` — sent body: ${serialized.slice(0, 500)}`
				: "";
		throw new Error(
			`workers-ai gateway ${modelId}: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}${bodyHead}`,
		);
	}
	const data = (await response.json()) as OpenAiChatResponse;
	const message = data.choices?.[0]?.message;
	const reasoning = reasoningContent(message);
	const toolCalls: WorkersAiTransportToolCall[] = (
		message?.tool_calls ?? []
	).map((tc, i) => ({
		id: tc.id ?? `call_${i}_${tc.function?.name ?? "tool"}`,
		name: tc.function?.name ?? "",
		arguments: toArgsObject(tc.function?.arguments),
	}));
	return {
		text: typeof message?.content === "string" ? message.content : "",
		...(reasoning ? { reasoning } : {}),
		toolCalls,
		usage: normalizedUsage(data.usage),
	};
}

async function callViaBinding(
	env: WorkersAiTransportEnv,
	modelId: string,
	req: WorkersAiTransportRequest,
	inputs: Record<string, unknown>,
	beforeDispatch?: ProviderBeforeDispatch,
): Promise<WorkersAiTransportResult> {
	if (!env.AI) {
		throw new Error("workers-ai transport: env.AI binding is missing");
	}

	// Account id + gateway id alone (no auth tokens) still tag the binding call
	// for gateway observability, even when the full authenticated gateway path
	// (usingWorkersAiGateway) isn't configured. `metadata` mirrors the SAME
	// attribution the HTTP gateway path sends via `cf-aig-metadata` — without
	// it, binding-fallback calls land in the gateway logs with no attribution at
	// all.
	const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
	const gwId = gatewayId(env);
	const attribution = presentAttribution(req.attribution);
	const bindingOptions =
		accountId && gwId
			? {
					gateway: {
						id: gwId,
						...(attribution ? { metadata: attribution } : {}),
					},
				}
			: undefined;

	// env.AI.run is heavily overloaded; a narrow cast keeps the call typed.
	const ai = env.AI;
	const call = () => {
		assertProviderDispatchReady(beforeDispatch);
		return (
			ai.run as unknown as (
				model: string,
				body: Record<string, unknown>,
				options?: {
					gateway: {
						id: string;
						metadata?: Record<string, string | number | boolean>;
					};
				},
			) => Promise<BindingResponse>
		)(modelId, inputs, bindingOptions);
	};

	// The binding cannot cancel work already dispatched. Reject the caller's
	// wait promptly, but never dispatch an already-cancelled request or keep a
	// listener on a completed call's signal.
	const { signal } = req;
	let result: BindingResponse;
	if (signal) {
		signal.throwIfAborted();
		let rejectAbort!: (reason: unknown) => void;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const onAbort = () => rejectAbort(signal.reason ?? new Error("aborted"));
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			// A guard may synchronously abort and throw. Attach the race to both
			// rejections even in that case, without deferring the actual dispatch.
			let dispatched: Promise<BindingResponse>;
			try {
				dispatched = call();
			} catch (error) {
				dispatched = Promise.reject(error);
			}
			result = await Promise.race([dispatched, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	} else {
		result = await call();
	}

	const reasoning =
		reasoningContent(result) || reasoningContent(result.choices?.[0]?.message);
	const toolCalls: WorkersAiTransportToolCall[] = (result.tool_calls ?? []).map(
		(tc, i) => ({
			id: `call_${i}_${tc.name ?? "tool"}`,
			name: tc.name ?? "",
			arguments: toArgsObject(tc.arguments),
		}),
	);
	return {
		// Prefer `{response}`; fall back to the OpenAI chat shape some models /
		// proxied binding paths return (content otherwise silently dropped).
		text:
			typeof result.response === "string" && result.response.length > 0
				? result.response
				: typeof result.choices?.[0]?.message?.content === "string"
					? result.choices[0].message.content
					: "",
		...(reasoning ? { reasoning } : {}),
		toolCalls,
		usage: normalizedUsage(result.usage),
	};
}

const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";
const TOOL_CALL_NAME_RE = /\s*([\w.:-]+)\s*/y;

/**
 * Replace each `BEGIN name ARGUMENT_BEGIN args END` span, as the regex
 * `BEGIN\s*([\w.:-]+)\s*ARGUMENT_BEGIN([\s\S]*?)END` would, in linear time.
 * A lazy-body regex rescans the remainder once per unterminated BEGIN token.
 */
function replaceInlineToolCallTokens(
	text: string,
	replace: (rawName: string, rawArgs: string) => string,
): string {
	let output = "";
	let position = 0;
	let searchFrom = 0;
	// Cached next END position; it only moves forward.
	let endAt = -1;
	for (;;) {
		const begin = text.indexOf(TOOL_CALL_BEGIN, searchFrom);
		if (begin === -1) break;
		TOOL_CALL_NAME_RE.lastIndex = begin + TOOL_CALL_BEGIN.length;
		const name = TOOL_CALL_NAME_RE.exec(text);
		if (
			!name?.[1] ||
			!text.startsWith(TOOL_CALL_ARGUMENT_BEGIN, TOOL_CALL_NAME_RE.lastIndex)
		) {
			searchFrom = begin + 1;
			continue;
		}
		const argsStart =
			TOOL_CALL_NAME_RE.lastIndex + TOOL_CALL_ARGUMENT_BEGIN.length;
		if (endAt < argsStart) endAt = text.indexOf(TOOL_CALL_END, argsStart);
		if (endAt === -1) break;
		output +=
			text.slice(position, begin) +
			replace(name[1], text.slice(argsStart, endAt));
		position = endAt + TOOL_CALL_END.length;
		searchFrom = position;
	}
	return output + text.slice(position);
}

/**
 * Fallback for models that emit their native chat-template tool-call tokens
 * inline in `content` instead of populating the structured `tool_calls` field
 * (observed live: Kimi-K2-style
 * `<|tool_calls_section_begin|><|tool_call_begin|>functions.name:0<|tool_call_argument_begin|>{…}<|tool_call_end|><|tool_calls_section_end|>`).
 * Reconstructs `toolCalls` from the tokens and strips them from `text` so raw
 * special tokens never surface as assistant prose.
 */
export function recoverInlineToolCallTokens(
	result: WorkersAiTransportResult,
): WorkersAiTransportResult {
	if (!result.text.includes("<|tool_call_begin|>")) {
		return result;
	}
	const recovered: WorkersAiTransportToolCall[] = [];
	const text = replaceInlineToolCallTokens(result.text, (rawName, rawArgs) => {
		// `functions.list_skills:0` → `list_skills`
		const name = rawName.replace(/^functions\./, "").replace(/:\d+$/, "");
		recovered.push({
			id: `call_${result.toolCalls.length + recovered.length}_${name || "tool"}`,
			name,
			arguments: toArgsObject(rawArgs.trim()),
		});
		return "";
	})
		.replace(/<\|tool_calls_section_(?:begin|end)\|>/g, "")
		.trim();
	return {
		...result,
		text,
		toolCalls: [...result.toolCalls, ...recovered],
	};
}

/**
 * Leading shape of a bare-JSON attempted tool call emitted as prose. Key
 * variants observed live: `"name"` + `"parameters"|"arguments"` (OpenAI shape)
 * and `"tool"` + `"args"` (the
 * model answered `{"tool": "artifact_write_file", "args": {…}}` as literal text
 * and a name-only regex let it through to the operator — and stripped its
 * truncated siblings to EMPTY assistant messages).
 */
const BARE_JSON_TOOL_CALL_RE =
	/^\s*\{\s*"(?:name|tool)"\s*:\s*"([\w.:-]+)"\s*,\s*"(?:parameters|arguments|args|input)"\s*:/;

/** Strip a ```json …``` / ``` …``` fence so fenced bare calls also recover. */
function stripCodeFence(text: string): string {
	// String scan instead of a lazy-body regex, which is quadratic on long
	// whitespace runs in model output.
	if (!text.startsWith("```")) return text;
	const end = text.trimEnd();
	if (end.length < 6 || !end.endsWith("```")) return text;
	let body = end.slice(3, -3);
	if (body.startsWith("json")) body = body.slice(4);
	return body.trim() || text;
}

/**
 * Fallback for models that emit an OpenAI-shaped tool call as literal TEXT
 * instead of populating the structured `tool_calls` field (observed live: a
 * delegated tedi answered with `{"name": "tedix_mcp_code", "parameters": {…}}`
 * as its final message). Only applied when the request offered tools — a plain
 * JSON ANSWER of coincidentally similar shape is possible, but a tool-offered
 * turn starting with `{"name": "...", "parameters": ...}` is overwhelmingly an
 * attempted call.
 *
 * A parseable blob becomes a real tool call. An UNPARSEABLE one (typically
 * truncated at max_tokens) is stripped to empty text — surfacing nothing lets
 * the caller's empty-round guard retry, instead of showing hallucinated JSON
 * prose to the operator.
 */
export function recoverBareJsonToolCallText(
	result: WorkersAiTransportResult,
): WorkersAiTransportResult {
	if (result.toolCalls.length > 0) return result;
	const text = stripCodeFence(result.text.trim());
	if (!BARE_JSON_TOOL_CALL_RE.test(text)) return result;
	try {
		const parsed = JSON.parse(text) as {
			name?: unknown;
			tool?: unknown;
			parameters?: unknown;
			arguments?: unknown;
			args?: unknown;
			input?: unknown;
		};
		const name =
			typeof parsed.name === "string" && parsed.name.length > 0
				? parsed.name
				: typeof parsed.tool === "string" && parsed.tool.length > 0
					? parsed.tool
					: null;
		if (name) {
			return {
				...result,
				text: "",
				toolCalls: [
					{
						id: `call_0_${name}`,
						name,
						arguments: toArgsObject(
							parsed.parameters ??
								parsed.arguments ??
								parsed.args ??
								parsed.input,
						),
					},
				],
			};
		}
		return result;
	} catch {
		return { ...result, text: "" };
	}
}

/**
 * Call a Workers AI model, preferring the authenticated AI Gateway OpenAI
 * endpoint and falling back to the token-free `env.AI` binding. Returns a
 * normalized `{ text, toolCalls, usage }`.
 *
 * Payload validation precedes `client.authorize` so a locally rejected request
 * never reserves paid inference. Authorization still precedes every dispatch.
 */
export async function callWorkersAi(
	client: WorkersAiClient,
	modelId: string,
	req: WorkersAiTransportRequest,
): Promise<WorkersAiTransportResult> {
	const requestSignal = req.signal;
	requestSignal?.throwIfAborted();
	const { env } = client;
	const transport = workersAiGatewayTransport(env);
	if (!transport && !env.AI) throw new Error("env.AI binding is missing");
	const body = chatBody(modelId, req, transport !== null);
	const serialized = JSON.stringify(body);
	requestSignal?.throwIfAborted();
	const authorization = await client.authorize({
		execution: ProviderExecutionIdentitySchema.parse({
			provider: "workers-ai",
			requestModel: modelId,
			gatewayAccountId: env.AI_GATEWAY_ACCOUNT_ID?.trim(),
			gatewayId: gatewayId(env),
			transportKind: transport
				? transport.kind === "binding"
					? "gateway-binding"
					: "gateway-https"
				: "workers-ai-binding",
			apiKind: "workers-ai-chat",
			providerResource: null,
			providerOrigin: null,
			deployment: null,
		}),
		model: modelId,
		body: serialized,
		attribution: req.attribution,
		signal: requestSignal,
	});
	// Admission can await a reservation; cancellation during it must not send.
	requestSignal?.throwIfAborted();
	const dispatch = authorizedProviderDispatch(
		client.beforeDispatch,
		authorization,
		requestSignal,
	);
	dispatch.signal?.throwIfAborted();
	const authorized: WorkersAiTransportRequest = {
		...req,
		attribution: authorization.attribution,
		signal: dispatch.signal,
	};
	// Keep the resolved transport and its receiver; add only this request's wire guard.
	const authorizedTransport: AiGatewayTransport | null = transport
		? {
				...transport,
				fetch: (input, init) => {
					assertProviderDispatchReady(dispatch.beforeDispatch);
					return transport.fetch(input, init);
				},
			}
		: null;
	const result = authorizedTransport
		? await callViaGateway(
				env,
				authorizedTransport,
				modelId,
				authorized,
				serialized,
			)
		: await callViaBinding(
				env,
				modelId,
				authorized,
				body,
				dispatch.beforeDispatch,
			);
	const recovered = recoverInlineToolCallTokens(result);
	return req.tools && req.tools.length > 0
		? recoverBareJsonToolCallText(recovered)
		: recovered;
}
