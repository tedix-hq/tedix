import { jsonSchema, parseJsonEventStream, type LanguageModel } from "ai";

type Model = Extract<LanguageModel, { specificationVersion: "v2" }>;
type Result = Awaited<ReturnType<Model["doGenerate"]>>;
type Part =
	Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<
		infer P
	>
		? P
		: never;
interface Chunk {
	error?: unknown;
	choices?: Array<{
		index?: number;
		finish_reason?: string | null;
		delta?: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: Array<{
				index: number;
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
const chunkSchema = jsonSchema<Chunk>(
	{ type: "object" },
	{
		validate(value) {
			return value && typeof value === "object" && !Array.isArray(value)
				? { success: true, value: value as Chunk }
				: {
						success: false,
						error: new Error("Invalid Auto Router stream frame"),
					};
		},
	},
);

/** Convert parsed provider deltas immediately; complete tools only after a terminal receipt. */
export function autoRouterSdkStream(
	body: ReadableStream<Uint8Array>,
	providerMetadata: Result["providerMetadata"],
): ReadableStream<Part> {
	let textStarted = false;
	let reasoningStarted = false;
	let finishReason: Result["finishReason"] | undefined;
	let usage: Result["usage"] | undefined;
	const tools = new Map<
		number,
		{ id: string; name: string; input: string; started: boolean }
	>();
	return parseJsonEventStream({
		stream: body,
		schema: chunkSchema,
	}).pipeThrough(
		new TransformStream({
			start(controller) {
				controller.enqueue({ type: "stream-start", warnings: [] });
			},
			transform(parsed, controller) {
				if (!parsed.success) throw parsed.error;
				const chunk = parsed.value;
				if (chunk.error) throw new Error("Auto Router provider stream failed");
				if (chunk.usage) {
					const {
						prompt_tokens: inputTokens,
						completion_tokens: outputTokens,
					} = chunk.usage;
					if (
						typeof inputTokens !== "number" ||
						typeof outputTokens !== "number"
					)
						throw new Error("Incomplete Auto Router usage receipt");
					usage = {
						inputTokens,
						outputTokens,
						totalTokens: inputTokens + outputTokens,
						cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
						reasoningTokens:
							chunk.usage.completion_tokens_details?.reasoning_tokens,
					};
				}
				if (!Array.isArray(chunk.choices))
					throw new Error("Invalid Auto Router stream choices");
				for (const choice of chunk.choices) {
					if (choice.index !== undefined && choice.index !== 0) continue;
					if (choice.finish_reason)
						finishReason =
							choice.finish_reason === "length"
								? "length"
								: choice.finish_reason === "tool_calls"
									? "tool-calls"
									: choice.finish_reason === "content_filter"
										? "content-filter"
										: choice.finish_reason === "stop"
											? "stop"
											: "unknown";
					const delta = choice.delta;
					if (!delta) continue;
					for (const [type, value] of [
						["text", delta.content],
						["reasoning", delta.reasoning_content],
					] as const) {
						if (!value) continue;
						if (typeof value !== "string")
							throw new Error("Invalid Auto Router text delta");
						const id = type === "text" ? "txt-0" : "reasoning-0";
						if (type === "text" ? !textStarted : !reasoningStarted) {
							controller.enqueue({
								type: type === "text" ? "text-start" : "reasoning-start",
								id,
							});
							if (type === "text") textStarted = true;
							else reasoningStarted = true;
						}
						controller.enqueue({
							type: type === "text" ? "text-delta" : "reasoning-delta",
							id,
							delta: value,
						});
					}
					for (const call of delta.tool_calls ?? []) {
						if (!Number.isInteger(call.index) || call.index < 0)
							throw new Error("Invalid Auto Router tool index");
						const tool = tools.get(call.index) ?? {
							id: "",
							name: "",
							input: "",
							started: false,
						};
						if (call.id) {
							if (tool.started && call.id !== tool.id)
								throw new Error("Auto Router tool ID changed midstream");
							tool.id = call.id;
						}
						if (call.function?.name) {
							if (tool.started)
								throw new Error(
									"Auto Router tool name changed after arguments started",
								);
							tool.name += call.function.name;
						}
						const input = call.function?.arguments ?? "";
						tool.input += input;
						if (!tool.started && tool.id && tool.name && input) {
							controller.enqueue({
								type: "tool-input-start",
								id: tool.id,
								toolName: tool.name,
							});
							tool.started = true;
							if (tool.input)
								controller.enqueue({
									type: "tool-input-delta",
									id: tool.id,
									delta: tool.input,
								});
						} else if (tool.started && input)
							controller.enqueue({
								type: "tool-input-delta",
								id: tool.id,
								delta: input,
							});
						tools.set(call.index, tool);
					}
				}
			},
			flush(controller) {
				if (!finishReason || !usage)
					throw new Error(
						"Incomplete Auto Router stream: missing finish or usage receipt",
					);
				if (textStarted) controller.enqueue({ type: "text-end", id: "txt-0" });
				if (reasoningStarted)
					controller.enqueue({ type: "reasoning-end", id: "reasoning-0" });
				for (const tool of tools.values()) {
					if (!tool.started)
						throw new Error("Incomplete Auto Router tool call");
					controller.enqueue({ type: "tool-input-end", id: tool.id });
					controller.enqueue({
						type: "tool-call",
						toolCallId: tool.id,
						toolName: tool.name,
						input: tool.input,
					});
				}
				controller.enqueue({
					type: "finish",
					finishReason,
					usage,
					providerMetadata,
				});
			},
		}),
	);
}
