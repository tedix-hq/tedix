/**
 * Workers AI `LanguageModelV2` adapter.
 *
 * Adapts explicit Workers AI model selections to the shared AI SDK paths.
 * The caller owns model selection and billing admission; this adapter preserves
 * the gateway-or-binding transport, reasoning and usage observations.
 *
 * Types are derived from the LanguageModel union re-exported by the installed
 * AI SDK. V2 remains supported by AI SDK 7 without a transitive provider import.
 *
 * Workers AI binding I/O contract (binding is UNWRAPPED — no `.result`):
 *   env.AI.run(modelId, { messages, tools?, tool_choice?, max_tokens?,
 *     temperature?, stream:false })
 *   → { response: string|null,
 *       tool_calls?: Array<{ name: string, arguments: object }>,  // parsed obj
 *       usage?: { prompt_tokens, completion_tokens, total_tokens? } }
 * When tool calls are emitted, `response` is null and `tool_calls` is populated.
 */

import type { LanguageModel } from "ai";
import {
	callWorkersAi,
	usingWorkersAiGateway,
	type WorkersAiClient,
} from "./transport";

// `@ai-sdk/provider` (where the model-spec types live) is a transitive dep and
// is not directly importable here, and `ai` does not re-export the spec types by
// name. But `ai`'s `LanguageModel` IS the union `LanguageModelV4 |
// LanguageModelV3 | LanguageModelV2 | string`, so extract the exact installed
// `LanguageModelV2` by its discriminant. A V2
// model is a valid `LanguageModel`, so `streamText`/`generateText`/`getModel`
// accept it unchanged.
type LanguageModelV2 = Extract<LanguageModel, { specificationVersion: "v2" }>;

// --- Spec shapes derived from the installed LanguageModelV2 ---------
type CallOptions = Parameters<LanguageModelV2["doGenerate"]>[0];
type PromptMessage = CallOptions["prompt"][number];
type ToolMessage = Extract<PromptMessage, { role: "tool" }>;
type ToolResultPart = ToolMessage["content"][number];
type ToolResultOutput = ToolResultPart["output"];
type GenerateResult = Awaited<ReturnType<LanguageModelV2["doGenerate"]>>;
type ModelContent = GenerateResult["content"][number];
type Usage = GenerateResult["usage"];
type FinishReason = GenerateResult["finishReason"];
type CallWarning = GenerateResult["warnings"][number];
type StreamResult = Awaited<ReturnType<LanguageModelV2["doStream"]>>;
type StreamPart =
	StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

// --- Workers AI binding wire shapes -----------------------------------------
export interface WorkersAiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	/** OpenAI-style structured tool calls on an assistant turn (Llama accepts these). */
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}>;
	/** Correlates a `tool` turn back to the assistant `tool_calls[i].id`. */
	tool_call_id?: string;
}
interface WorkersAiTool {
	type: "function";
	function: {
		name: string;
		description?: string;
		parameters: unknown;
	};
}
type WorkersAiToolChoice =
	| "auto"
	| "none"
	| "required"
	| { type: "function"; function: { name: string } };

/** Flatten a tool-result output part into a string for a Llama `tool` turn. */
function stringifyToolOutput(output: ToolResultOutput): string {
	switch (output.type) {
		case "text":
		case "error-text":
			return output.value;
		case "json":
		case "error-json":
			return JSON.stringify(output.value);
		case "content":
			return output.value
				.map((part) => (part.type === "text" ? part.text : "[media]"))
				.join("\n");
		default:
			return JSON.stringify(output);
	}
}

/**
 * Map LanguageModelV2 prompt messages → Workers AI `{role, content}` messages.
 *
 * Llama's chat template is text-first for content: multimodal file parts are
 * dropped (text-only fallback). Tool calls use the OpenAI-style STRUCTURED shape
 * — assistant turns carry a `tool_calls` array and results come back as `tool`
 * turns keyed by `tool_call_id` — so multi-step tool loops keep strict call↔result
 * correlation (verified: given a prior tool result, Llama proceeds to the next
 * call rather than re-calling or hallucinating).
 */
function toWorkersAiMessages(
	prompt: CallOptions["prompt"],
): WorkersAiMessage[] {
	const messages: WorkersAiMessage[] = [];
	for (const message of prompt) {
		switch (message.role) {
			case "system":
				messages.push({ role: "system", content: message.content });
				break;
			case "user": {
				const text = message.content
					.map((part) => (part.type === "text" ? part.text : "[file]"))
					.join("");
				messages.push({ role: "user", content: text });
				break;
			}
			case "assistant": {
				const textChunks: string[] = [];
				const toolCalls: NonNullable<WorkersAiMessage["tool_calls"]> = [];
				for (const part of message.content) {
					if (part.type === "text") {
						textChunks.push(part.text);
					} else if (part.type === "tool-call") {
						toolCalls.push({
							id: part.toolCallId,
							type: "function",
							function: {
								name: part.toolName,
								// LanguageModelV2 tool-call `input` is already a stringified
								// JSON object; pass it through (defensively re-stringify if not).
								arguments:
									typeof part.input === "string"
										? part.input
										: JSON.stringify(part.input ?? {}),
							},
						});
					} else if (part.type === "tool-result") {
						// Rare: a tool-result nested on an assistant turn. Fold it in.
						textChunks.push(
							`[result ${part.toolName}: ${stringifyToolOutput(part.output)}]`,
						);
					}
				}
				const msg: WorkersAiMessage = {
					role: "assistant",
					content: textChunks.join("\n"),
				};
				if (toolCalls.length > 0) msg.tool_calls = toolCalls;
				messages.push(msg);
				break;
			}
			case "tool": {
				for (const part of message.content) {
					messages.push({
						role: "tool",
						tool_call_id: part.toolCallId,
						content: stringifyToolOutput(part.output),
					});
				}
				break;
			}
		}
	}
	return messages;
}

/** Map LanguageModelV2 function tools → OpenAI-style Workers AI tools. */
function toWorkersAiTools(tools: CallOptions["tools"]): {
	tools?: WorkersAiTool[];
	warnings: CallWarning[];
} {
	const warnings: CallWarning[] = [];
	if (!tools || tools.length === 0) return { warnings };
	const mapped: WorkersAiTool[] = [];
	for (const t of tools) {
		if (t.type !== "function") {
			warnings.push({ type: "unsupported-tool", tool: t });
			continue;
		}
		mapped.push({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.inputSchema,
			},
		});
	}
	return { tools: mapped.length > 0 ? mapped : undefined, warnings };
}

function toWorkersAiToolChoice(
	toolChoice: CallOptions["toolChoice"],
): WorkersAiToolChoice | undefined {
	if (!toolChoice) return undefined;
	switch (toolChoice.type) {
		case "auto":
			return "auto";
		case "none":
			return "none";
		case "required":
			return "required";
		case "tool":
			return { type: "function", function: { name: toolChoice.toolName } };
		default:
			return undefined;
	}
}

function toUsage(usage: {
	promptTokens: number | null;
	completionTokens: number | null;
	reasoningTokens?: number;
	cachedInputTokens?: number;
}): Usage {
	const inputTokens = usage.promptTokens ?? undefined;
	const outputTokens = usage.completionTokens ?? undefined;
	const totalTokens =
		inputTokens !== undefined && outputTokens !== undefined
			? inputTokens + outputTokens
			: undefined;
	return {
		inputTokens,
		outputTokens,
		totalTokens,
		...(usage.reasoningTokens !== undefined
			? { reasoningTokens: usage.reasoningTokens }
			: {}),
		...(usage.cachedInputTokens !== undefined
			? { cachedInputTokens: usage.cachedInputTokens }
			: {}),
	};
}

/**
 * Shared generate: run once through the shared Workers AI transport (AI Gateway
 * when configured, else the `env.AI` binding) and shape the normalized result
 * into ordered LanguageModelV2 content. Prompt/tool mapping to the OpenAI wire
 * shape stays here; the transport owns gateway-vs-binding + abort handling.
 */
async function generateOnce(
	client: WorkersAiClient,
	modelId: string,
	options: CallOptions,
	attribution?: Record<string, string>,
): Promise<{
	content: ModelContent[];
	finishReason: FinishReason;
	usage: Usage;
	warnings: CallWarning[];
}> {
	const { tools, warnings } = toWorkersAiTools(options.tools);
	const toolChoice = toWorkersAiToolChoice(options.toolChoice);
	const messages = toWorkersAiMessages(options.prompt);
	if (
		options.responseFormat?.type === "json" &&
		options.responseFormat.schema
	) {
		// Keep JSON mode for schemas the provider's grammar compiler cannot
		// handle, but never drop the SDK's shape contract. The SDK validates it.
		messages.unshift({
			role: "system",
			content: `Respond with only a JSON object conforming to this JSON Schema:\n${JSON.stringify(options.responseFormat.schema)}`,
		});
	}
	const result = await callWorkersAi(client, modelId, {
		messages,
		...(tools ? { tools } : {}),
		// ONLY alongside a tools array: ai v7's generateText defaults toolChoice
		// to "auto" even with zero tools, and Workers AI's gpt-oss models 400
		// ("AiError: Invalid input", 8001) on tool_choice without tools — this
		// silently broke every tool-less generateText surface (delegation
		// synthesis, auto-titles) once a force flag routed traffic here.
		...(tools && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
		// `generateObject` (the dominant caller) passes
		// responseFormat:{type:"json", schema} — forward JSON mode so the model
		// is actually constrained to JSON instead of relying on prompt discipline.
		...(options.responseFormat?.type === "json"
			? { response_format: { type: "json_object" } }
			: {}),
		...(options.maxOutputTokens !== undefined
			? { max_tokens: options.maxOutputTokens }
			: {}),
		...(options.temperature !== undefined
			? { temperature: options.temperature }
			: {}),
		...(options.abortSignal ? { signal: options.abortSignal } : {}),
		attribution,
	});
	const content: ModelContent[] = [];
	if (result.reasoning)
		content.push({ type: "reasoning", text: result.reasoning });

	if (result.text.length > 0) {
		content.push({ type: "text", text: result.text });
	}

	result.toolCalls.forEach((call) => {
		content.push({
			type: "tool-call",
			toolCallId: call.id,
			toolName: call.name,
			// LanguageModelV2ToolCall.input is a STRINGIFIED JSON object; the
			// transport returns `arguments` as a parsed object, so re-stringify it.
			input: JSON.stringify(call.arguments ?? {}),
		});
	});

	const finishReason: FinishReason =
		result.toolCalls.length > 0 ? "tool-calls" : "stop";

	return { content, finishReason, usage: toUsage(result.usage), warnings };
}

/**
 * Build a token-free Workers AI `LanguageModelV2`. `doStream` is BUFFERED: it
 * reuses `generateOnce` and replays the result as ordered stream parts.
 */
export function workersAiModel(
	client: WorkersAiClient,
	// Model selection is the caller's job — `selectWorkersAiModel` in
	// `./model-select` owns the ref→id resolution; no default here.
	modelId: string,
	// PRE-NORMALIZED AI Gateway attribution, threaded into `cf-aig-metadata` on
	// every call this model makes. Each app owns its own encoder.
	attribution?: Record<string, string>,
): LanguageModelV2 {
	if (!client.env?.AI && !usingWorkersAiGateway(client.env)) {
		throw new Error(
			"workersAiModel: no Workers AI transport available (needs the `AI` binding or a configured AI Gateway + CF_WORKERS_AI_TOKEN)",
		);
	}
	const model: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "workers-ai",
		modelId,
		supportedUrls: {},

		async doGenerate(options) {
			const { content, finishReason, usage, warnings } = await generateOnce(
				client,
				modelId,
				options,
				attribution,
			);
			return { content, finishReason, usage, warnings };
		},

		async doStream(options) {
			const { content, finishReason, usage, warnings } = await generateOnce(
				client,
				modelId,
				options,
				attribution,
			);
			const stream = new ReadableStream<StreamPart>({
				start(controller) {
					controller.enqueue({ type: "stream-start", warnings });
					let textIndex = 0;
					let reasoningIndex = 0;
					for (const part of content) {
						if (part.type === "text") {
							const id = `txt-${textIndex++}`;
							controller.enqueue({ type: "text-start", id });
							controller.enqueue({ type: "text-delta", id, delta: part.text });
							controller.enqueue({ type: "text-end", id });
						} else if (part.type === "reasoning") {
							const id = `reasoning-${reasoningIndex++}`;
							controller.enqueue({ type: "reasoning-start", id });
							controller.enqueue({
								type: "reasoning-delta",
								id,
								delta: part.text,
							});
							controller.enqueue({ type: "reasoning-end", id });
						} else if (part.type === "tool-call") {
							const id = part.toolCallId;
							const input = part.input;
							controller.enqueue({
								type: "tool-input-start",
								id,
								toolName: part.toolName,
							});
							controller.enqueue({
								type: "tool-input-delta",
								id,
								delta: input,
							});
							controller.enqueue({ type: "tool-input-end", id });
							controller.enqueue(part);
						}
					}
					controller.enqueue({ type: "finish", finishReason, usage });
					controller.close();
				},
			});
			return { stream };
		},
	};
	return model;
}
