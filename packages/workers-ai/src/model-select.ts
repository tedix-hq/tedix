/** Shared fixed Workers AI selection and Cloudflare Auto Router adapter. */

import {
	adaptiveRoutingEligible,
	CLOUDFLARE_AUTO_MODEL_REF,
	findCatalogEntry,
	type AdaptiveRoutingContext,
	parseModelRef,
} from "@tedix/api-contract/schemas/model-catalog";
import { ProviderExecutionIdentitySchema } from "@tedix/api-contract/schemas/provider-execution";
import type { LanguageModel } from "ai";
import {
	cloudflareAutoRouterCandidateHeaders,
	openCloudflareAutoRouterResponse,
} from "./gateway-transport";
import { autoRouterSdkStream } from "./auto-router-stream";
import { authorizedProviderDispatch, type WorkersAiClient } from "./transport";

/**
 * Default model: in an agentic bench (tool compliance, multi-step round-trip,
 * JSON mode, zero empty turns) gpt-oss-120b passed every case with cheaper
 * output than llama-3.3-70b, which failed multi-step tool loops and produced
 * rogue-tool/empty turns.
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/openai/gpt-oss-120b";
export { CLOUDFLARE_AUTO_MODEL_REF };
export const CLOUDFLARE_AUTO_PROVIDER_METADATA_KEY = "cloudflareAutoRouter";

export interface CloudflareAutoRouterReceipt {
	routedModel: string | null;
	routingReason: string | null;
	routingDecisionId: string | null;
	requestId: string | null;
}

/** Read only the bounded, documented Auto Router response receipts. */
export function cloudflareAutoRouterReceipt(
	providerMetadata: unknown,
): CloudflareAutoRouterReceipt | null {
	const record = (value: unknown): Record<string, unknown> =>
		value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	const receipt = record(
		record(providerMetadata)[CLOUDFLARE_AUTO_PROVIDER_METADATA_KEY],
	);
	if (Object.keys(receipt).length === 0) return null;
	const value = (input: unknown, maxLength = 300): string | null => {
		if (typeof input !== "string") return null;
		const normalized = input.trim();
		return normalized ? normalized.slice(0, maxLength) : null;
	};
	const normalized = {
		routedModel: value(receipt.routedModel),
		routingReason: value(receipt.routingReason, 500),
		routingDecisionId: value(receipt.routingDecisionId),
		requestId: value(receipt.requestId),
	};
	return Object.values(normalized).some((entry) => entry !== null)
		? normalized
		: null;
}

/**
 * Resolve the Workers AI model id for a turn: a valid `workers-ai/<slug>`
 * catalog ref (the per-role model slot) selects that model id; anything else
 * (absent, malformed, non-catalog, or a non-workers-ai provider) falls back to
 * the caller's default.
 */
export function selectWorkersAiModel(
	defaultModel: string,
	modelRef?: string | null,
): string {
	if (!modelRef) return defaultModel;
	const parsed = parseModelRef(modelRef);
	if (parsed?.provider === "workers-ai" && findCatalogEntry(modelRef)) {
		return parsed.modelId;
	}
	return defaultModel;
}

export function cloudflareAutoRouterEligible(
	modelRef: string | null | undefined,
	context: AdaptiveRoutingContext | null | undefined,
): boolean {
	return (
		modelRef === CLOUDFLARE_AUTO_MODEL_REF && adaptiveRoutingEligible(context)
	);
}

type LanguageModelV2 = Extract<LanguageModel, { specificationVersion: "v2" }>;
type CallOptions = Parameters<LanguageModelV2["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>;
type ModelContent = GenerateResult["content"][number];
type StreamResult = Awaited<ReturnType<LanguageModelV2["doStream"]>>;
type StreamPart =
	StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

function stringifyToolOutput(output: {
	type: string;
	value?: unknown;
}): string {
	return typeof output.value === "string"
		? output.value
		: JSON.stringify(output.value ?? output);
}

function autoRouterMessages(prompt: CallOptions["prompt"]): unknown[] {
	const messages: Array<Record<string, unknown>> = [];
	for (const message of prompt) {
		if (message.role === "system") {
			messages.push({ role: "system", content: message.content });
		} else if (message.role === "user") {
			messages.push({
				role: "user",
				content: message.content.map((part) => {
					if (part.type === "text") return { type: "text", text: part.text };
					if (part.type !== "file" || !part.mediaType.startsWith("image/"))
						throw new Error("Auto Router input media type is unsupported");
					let url: string;
					if (part.data instanceof URL) url = part.data.href;
					else {
						let base64: string;
						if (typeof part.data === "string") base64 = part.data;
						else {
							let binary = "";
							for (const byte of part.data) binary += String.fromCharCode(byte);
							base64 = btoa(binary);
						}
						url = `data:${part.mediaType};base64,${base64}`;
					}
					return { type: "image_url", image_url: { url } };
				}),
			});
		} else if (message.role === "assistant") {
			const text: string[] = [];
			const toolCalls: Array<Record<string, unknown>> = [];
			for (const part of message.content) {
				if (part.type === "text") text.push(part.text);
				else if (part.type === "tool-call") {
					toolCalls.push({
						id: part.toolCallId,
						type: "function",
						function: {
							name: part.toolName,
							arguments:
								typeof part.input === "string"
									? part.input
									: JSON.stringify(part.input),
						},
					});
				}
			}
			messages.push({
				role: "assistant",
				content: text.join("\n"),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
		} else if (message.role === "tool") {
			for (const part of message.content) {
				messages.push({
					role: "tool",
					tool_call_id: part.toolCallId,
					content: stringifyToolOutput(part.output),
				});
			}
		}
	}
	return messages;
}

function autoRouterTools(tools: CallOptions["tools"]): unknown[] | undefined {
	const mapped = (tools ?? []).flatMap((tool) =>
		tool.type === "function"
			? [
					{
						type: "function",
						function: {
							name: tool.name,
							description: tool.description,
							parameters: tool.inputSchema,
						},
					},
				]
			: [],
	);
	return mapped.length > 0 ? mapped : undefined;
}

function autoRouterToolChoice(choice: CallOptions["toolChoice"]): unknown {
	if (!choice) return undefined;
	return choice.type === "tool"
		? { type: "function", function: { name: choice.toolName } }
		: choice.type;
}

interface AutoRouterWireResponse {
	choices?: Array<{
		finish_reason?: string;
		message?: {
			reasoning_content?: string;
			content?: string | null;
			tool_calls?: Array<{
				id?: string;
				function?: { name?: string; arguments?: string };
			}>;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		prompt_tokens_details?: { cached_tokens?: number };
		completion_tokens_details?: { reasoning_tokens?: number };
	};
}

export interface CloudflareAutoRouterModelOptions {
	gatewayId: string;
	attribution?: Record<string, string>;
	sessionId?: string;
	turnId?: string;
}

/** Authenticated, metered LanguageModelV2 for Cloudflare's adaptive router. */
export function cloudflareAutoRouterModel(
	client: WorkersAiClient,
	options: CloudflareAutoRouterModelOptions,
): LanguageModelV2 {
	if (
		!client.env.AI_GATEWAY_ACCOUNT_ID?.trim() ||
		!client.env.CF_AI_GATEWAY_TOKEN?.trim() ||
		!options.gatewayId.trim()
	) {
		throw new Error("Cloudflare Auto Router gateway is not configured");
	}

	const dispatch = async (call: CallOptions, stream = false) => {
		const requestSignal = call.abortSignal;
		requestSignal?.throwIfAborted();
		const body: Record<string, unknown> = {
			model: CLOUDFLARE_AUTO_MODEL_REF,
			messages: autoRouterMessages(call.prompt),
		};
		const tools = autoRouterTools(call.tools);
		if (tools) body.tools = tools;
		const toolChoice = autoRouterToolChoice(call.toolChoice);
		if (toolChoice !== undefined) body.tool_choice = toolChoice;
		if (call.maxOutputTokens !== undefined)
			body.max_completion_tokens = call.maxOutputTokens;
		if (call.temperature !== undefined) body.temperature = call.temperature;
		if (call.responseFormat?.type === "json") {
			const format = call.responseFormat;
			body.response_format = format.schema
				? {
						type: "json_schema",
						json_schema: {
							name: format.name ?? "response",
							...(format.description
								? { description: format.description }
								: {}),
							schema: format.schema,
							strict: true,
						},
					}
				: { type: "json_object" };
		}
		const reasoningEffort =
			call.providerOptions?.cloudflareAutoRouter?.reasoningEffort;
		if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;
		if (stream) {
			body.stream = true;
			body.stream_options = { include_usage: true };
		}
		const serialized = JSON.stringify(body);
		cloudflareAutoRouterCandidateHeaders(client.env, body.messages);
		const execution = ProviderExecutionIdentitySchema.parse({
			provider: "workers-ai",
			requestModel: CLOUDFLARE_AUTO_MODEL_REF,
			gatewayAccountId: client.env.AI_GATEWAY_ACCOUNT_ID,
			gatewayId: options.gatewayId,
			transportKind: "gateway-https",
			apiKind: "workers-ai-chat",
			providerResource: null,
			providerOrigin: null,
			deployment: null,
		});
		requestSignal?.throwIfAborted();
		const authorization = await client.authorize({
			execution,
			model: CLOUDFLARE_AUTO_MODEL_REF,
			body: serialized,
			attribution: options.attribution,
			signal: requestSignal,
		});
		const dispatch = authorizedProviderDispatch(
			client.beforeDispatch,
			authorization,
			requestSignal,
		);
		dispatch.signal?.throwIfAborted();
		return openCloudflareAutoRouterResponse(
			client.env,
			options.gatewayId,
			{
				body: serialized,
				attribution: authorization.attribution,
				sessionId: options.sessionId,
				turnId: options.turnId,
				signal: dispatch.signal,
			},
			dispatch.beforeDispatch,
		);
	};
	const responseMetadata = (response: Response) => ({
		[CLOUDFLARE_AUTO_PROVIDER_METADATA_KEY]: {
			routedModel: response.headers.get("cf-aig-routed-model"),
			routingReason: response.headers.get("cf-aig-routing-reason"),
			routingDecisionId: response.headers.get("cf-aig-routing-decision-id"),
			requestId: response.headers.get("cf-aig-request-id"),
		},
	});
	const generate = async (call: CallOptions) => {
		const response = await dispatch(call);
		const data = (await response.json()) as AutoRouterWireResponse;
		const providerMetadata = responseMetadata(response);
		const message = data.choices?.[0]?.message;
		const content: ModelContent[] = [];
		if (message?.reasoning_content)
			content.push({ type: "reasoning", text: message.reasoning_content });
		if (typeof message?.content === "string" && message.content.length > 0)
			content.push({ type: "text", text: message.content });
		for (const [index, toolCall] of (message?.tool_calls ?? []).entries()) {
			content.push({
				type: "tool-call",
				toolCallId: toolCall.id ?? `call_${index}`,
				toolName: toolCall.function?.name ?? "",
				input: toolCall.function?.arguments ?? "{}",
			});
		}
		return {
			content,
			finishReason:
				data.choices?.[0]?.finish_reason === "length"
					? ("length" as const)
					: data.choices?.[0]?.finish_reason === "tool_calls"
						? ("tool-calls" as const)
						: data.choices?.[0]?.finish_reason === "content_filter"
							? ("content-filter" as const)
							: data.choices?.[0]?.finish_reason === "stop"
								? ("stop" as const)
								: ("unknown" as const),
			usage: {
				inputTokens: data.usage?.prompt_tokens,
				outputTokens: data.usage?.completion_tokens,
				cachedInputTokens: data.usage?.prompt_tokens_details?.cached_tokens,
				reasoningTokens:
					data.usage?.completion_tokens_details?.reasoning_tokens,
				totalTokens:
					typeof data.usage?.prompt_tokens === "number" &&
					typeof data.usage?.completion_tokens === "number"
						? data.usage.prompt_tokens + data.usage.completion_tokens
						: undefined,
			},
			providerMetadata,
			warnings: [],
		};
	};

	return {
		specificationVersion: "v2",
		provider: "cloudflare-auto",
		modelId: CLOUDFLARE_AUTO_MODEL_REF,
		supportedUrls: {},
		doGenerate: generate,
		async doStream(call) {
			if (call.responseFormat?.type !== "json") {
				const response = await dispatch(call, true);
				if (
					!response.body ||
					!response.headers.get("content-type")?.includes("text/event-stream")
				) {
					await response.body?.cancel();
					throw new Error("Auto Router did not return an event stream");
				}
				return {
					stream: autoRouterSdkStream(
						response.body,
						responseMetadata(response),
					),
				};
			}
			// Workers AI structured JSON requires a complete validated response.
			const result = await generate(call);
			const stream = new ReadableStream<StreamPart>({
				start(controller) {
					controller.enqueue({
						type: "stream-start",
						warnings: result.warnings,
					});
					let textIndex = 0;
					for (const part of result.content) {
						if (part.type === "text") {
							const id = `txt-${textIndex++}`;
							controller.enqueue({ type: "text-start", id });
							controller.enqueue({ type: "text-delta", id, delta: part.text });
							controller.enqueue({ type: "text-end", id });
						} else if (part.type === "reasoning") {
							const id = `reasoning-${textIndex++}`;
							controller.enqueue({ type: "reasoning-start", id });
							controller.enqueue({
								type: "reasoning-delta",
								id,
								delta: part.text,
							});
							controller.enqueue({ type: "reasoning-end", id });
						} else if (part.type === "tool-call") {
							controller.enqueue({
								type: "tool-input-start",
								id: part.toolCallId,
								toolName: part.toolName,
							});
							controller.enqueue({
								type: "tool-input-delta",
								id: part.toolCallId,
								delta: part.input,
							});
							controller.enqueue({
								type: "tool-input-end",
								id: part.toolCallId,
							});
							controller.enqueue(part);
						}
					}
					controller.enqueue({
						type: "finish",
						finishReason: result.finishReason,
						usage: result.usage,
						providerMetadata: result.providerMetadata,
					});
					controller.close();
				},
			});
			return { stream };
		},
	};
}
