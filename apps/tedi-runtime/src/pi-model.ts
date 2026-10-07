import { estimateInferenceTokens } from "./inference-guardrails";
import { repairToolCallInput } from "./repair-tool-call";
import type {
	LanguageModelV2,
	LanguageModelV3,
	LanguageModelV4,
	LanguageModelV2CallOptions,
	LanguageModelV2Prompt,
	LanguageModelV3Prompt,
	LanguageModelV2StreamPart,
	LanguageModelV3StreamPart,
	LanguageModelV2Usage,
	LanguageModelV3Usage,
	LanguageModelV4Usage,
	LanguageModelV4Prompt,
	LanguageModelV4StreamPart,
	LanguageModelV4ToolResultPart,
	LanguageModelV2ToolResultPart,
	LanguageModelV3ToolResultPart,
	SharedV2ProviderOptions,
	SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type {
	Api,
	Model,
	Provider,
	TranscriptContext,
	SimpleStreamOptions,
	StreamOptions,
	AssistantMessage,
	Message,
	Usage,
	JsonObject,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
	getCurrentSystemPrompt,
	getCurrentTools,
} from "@earendil-works/pi-ai/utils/transcript";

export type TedixSdkModel = LanguageModelV2 | LanguageModelV3 | LanguageModelV4;
export type TedixPiDispatch<R> = {
	model?: TedixSdkModel;
	prompt?: LanguageModelV2Prompt;
	callOptions?: Omit<LanguageModelV2CallOptions, "prompt" | "abortSignal">;
	receipt?: R;
};
export type TedixPiProviderOptions<R> = {
	/** Maximum provider idle time between headers/stream parts; defaults to120s. */
	idleTimeoutMs?: number;
	catalog(): readonly Model<Api>[];
	resolveModel(model: Model<Api>): TedixSdkModel | Promise<TedixSdkModel>;
	/** Called once immediately before every real doStream, including recovery/retries. */
	prepare?(
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions,
	): Promise<TedixPiDispatch<R>>;
	/** Called once after dispatch, also on cancellation/error; must persist an idempotent usage receipt. */
	settled?(
		receipt: R | undefined,
		message: AssistantMessage,
		measurement: {
			hasUsage: boolean;
			dispatched: boolean;
			/** The finish part's provider metadata (e.g. Auto Router routing receipts); never persisted on the message. */
			providerMetadata?: SharedV3ProviderMetadata;
		},
	): Promise<void>;
};

const SDK_OPTIONS_SIGNATURE = "tedix-sdk-options:v1:";

/** Opaque provider continuity metadata is persisted in Pi's durable signature slots. */
export function encodeSdkProviderOptions(
	options: SharedV2ProviderOptions | SharedV3ProviderMetadata | undefined,
): string | undefined {
	return options === undefined
		? undefined
		: SDK_OPTIONS_SIGNATURE + JSON.stringify(options);
}
export function decodeSdkProviderOptions(
	signature: string | undefined,
): SharedV2ProviderOptions | undefined {
	if (signature === undefined) return undefined;
	if (!signature.startsWith(SDK_OPTIONS_SIGNATURE))
		throw new Error(
			"Unmanaged provider signature requires an explicit migration adapter",
		);
	const parsed: unknown = JSON.parse(
		signature.slice(SDK_OPTIONS_SIGNATURE.length),
	);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Invalid durable provider options");
	return parsed as SharedV2ProviderOptions;
}
function mergeSdkProviderOptions(
	previous: string | undefined,
	next: SharedV2ProviderOptions | SharedV3ProviderMetadata | undefined,
): string | undefined {
	if (next === undefined) return previous;
	const options = decodeSdkProviderOptions(previous) ?? {};
	for (const [provider, fields] of Object.entries(
		decodeSdkProviderOptions(encodeSdkProviderOptions(next)) ?? {},
	))
		options[provider] = { ...options[provider], ...fields };
	return encodeSdkProviderOptions(options);
}

/** Replay positional system changes, retaining their instruction text and current tool declarations. */
export function piToSdkPrompt(messages: readonly Message[]): {
	prompt: LanguageModelV2Prompt;
	tools: NonNullable<LanguageModelV2CallOptions["tools"]>;
} {
	const prompt: LanguageModelV2Prompt = [];
	const system = getCurrentSystemPrompt(messages);
	if (system) prompt.push({ role: "system", content: system });
	for (const message of messages) {
		switch (message.role) {
			case "system":
				break;
			case "user":
				prompt.push({
					role: "user",
					content:
						typeof message.content === "string"
							? [{ type: "text", text: message.content }]
							: message.content.map((part) =>
									part.type === "text"
										? { type: "text", text: part.text }
										: {
												type: "file",
												data: Uint8Array.from(atob(part.data), (char) =>
													char.charCodeAt(0),
												),
												mediaType: part.mimeType,
											},
								),
				});
				break;
			case "assistant":
				prompt.push({
					role: "assistant",
					content: message.content.map((part) => {
						if (part.type === "text")
							return {
								type: "text",
								text: part.text,
								providerOptions: decodeSdkProviderOptions(part.textSignature),
							};
						if (part.type === "thinking")
							return {
								type: "reasoning",
								text: part.thinking,
								providerOptions: decodeSdkProviderOptions(
									part.thinkingSignature,
								),
							};
						return {
							type: "tool-call",
							toolCallId: part.id,
							toolName: part.name,
							input: part.arguments,
							providerOptions: decodeSdkProviderOptions(part.thoughtSignature),
						};
					}),
				});
				break;
			case "toolResult":
				prompt.push({
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: message.toolCallId,
							toolName: message.toolName,
							output: message.isError
								? {
										type: "error-text",
										value: message.content
											.filter((part) => part.type === "text")
											.map((part) => part.text)
											.join("\n"),
									}
								: {
										type: "content",
										value: message.content.map((part) =>
											part.type === "text"
												? { type: "text", text: part.text }
												: {
														type: "media",
														data: part.data,
														mediaType: part.mimeType,
													},
										),
									},
						},
					],
				});
				break;
		}
	}
	return {
		prompt,
		tools: getCurrentTools(messages).map((tool) => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters,
		})),
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** V3 renamed embedded tool-result media; other prompt parts are structurally compatible. */
export function sdkV2ToV3Prompt(
	prompt: LanguageModelV2Prompt,
): LanguageModelV3Prompt {
	const result = (
		part: LanguageModelV2ToolResultPart,
	): LanguageModelV3ToolResultPart => ({
		...part,
		output:
			part.output.type !== "content"
				? part.output
				: {
						type: "content",
						value: part.output.value.map((value) =>
							value.type === "media"
								? {
										type: "image-data",
										data: value.data,
										mediaType: value.mediaType,
									}
								: value,
						),
					},
	});
	return prompt.map((message) => {
		if (message.role === "system" || message.role === "user") return message;
		if (message.role === "tool")
			return { ...message, content: message.content.map(result) };
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "tool-result" ? result(part) : part,
			),
		};
	});
}

/** SDK V4 tags files and unifies file content inside tool outputs. */
export function sdkV2ToV4Prompt(
	prompt: LanguageModelV2Prompt,
): LanguageModelV4Prompt {
	const result = (
		part: LanguageModelV2ToolResultPart,
	): LanguageModelV4ToolResultPart => ({
		...part,
		output:
			part.output.type !== "content"
				? part.output
				: {
						type: "content",
						value: part.output.value.map((value) =>
							value.type === "media"
								? {
										type: "file",
										data: { type: "data", data: value.data },
										mediaType: value.mediaType,
									}
								: value,
						),
					},
	});
	return prompt.map((message) => {
		if (message.role === "system") return message;
		if (message.role === "user")
			return {
				...message,
				content: message.content.map((part) =>
					part.type === "file"
						? {
								...part,
								data:
									part.data instanceof URL
										? { type: "url" as const, url: part.data }
										: { type: "data" as const, data: part.data },
							}
						: part,
				),
			};
		if (message.role === "tool")
			return { ...message, content: message.content.map(result) };
		return {
			...message,
			content: message.content.map((part) =>
				part.type === "tool-result"
					? result(part)
					: part.type === "file"
						? {
								...part,
								data:
									part.data instanceof URL
										? { type: "url" as const, url: part.data }
										: { type: "data" as const, data: part.data },
							}
						: part,
			),
		};
	});
}

export function sdkToPiUsage(
	usage: LanguageModelV2Usage | LanguageModelV3Usage | LanguageModelV4Usage,
	model: Model<Api>,
): Usage {
	const v3 =
		typeof usage.inputTokens === "object" && usage.inputTokens !== null;
	const cacheRead = v3
		? ((usage as LanguageModelV3Usage).inputTokens.cacheRead ?? 0)
		: ((usage as LanguageModelV2Usage).cachedInputTokens ?? 0);
	const cacheWrite = v3
		? ((usage as LanguageModelV3Usage).inputTokens.cacheWrite ?? 0)
		: 0;
	const input = v3
		? ((usage as LanguageModelV3Usage).inputTokens.noCache ??
			Math.max(
				0,
				((usage as LanguageModelV3Usage).inputTokens.total ?? 0) -
					cacheRead -
					cacheWrite,
			))
		: Math.max(
				0,
				((usage as LanguageModelV2Usage).inputTokens ?? 0) - cacheRead,
			);
	const output = v3
		? ((usage as LanguageModelV3Usage).outputTokens.total ?? 0)
		: ((usage as LanguageModelV2Usage).outputTokens ?? 0);
	const reasoning = v3
		? (usage as LanguageModelV3Usage).outputTokens.reasoning
		: (usage as LanguageModelV2Usage).reasoningTokens;
	const cost = {
		input: (input * model.cost.input) / 1e6,
		output: (output * model.cost.output) / 1e6,
		cacheRead: (cacheRead * model.cost.cacheRead) / 1e6,
		cacheWrite: (cacheWrite * model.cost.cacheWrite) / 1e6,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: v3
			? input + cacheRead + cacheWrite + output
			: ((usage as LanguageModelV2Usage).totalTokens ??
				input + cacheRead + output),
		cost,
	};
}

function parseArguments(value: string, toolName: string): JsonObject {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		parsed = repairToolCallInput(toolName, value);
	}
	if (typeof parsed === "string")
		parsed = repairToolCallInput(toolName, parsed);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error("Tool input must be a JSON object");
	return parsed as JsonObject;
}

export function createTedixPiProvider<R>(
	config: TedixPiProviderOptions<R>,
): Provider {
	const idleTimeoutMs = config.idleTimeoutMs ?? 120_000;
	if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)
		throw new Error("Pi provider idle timeout must be positive and finite");
	const dispatch = (
		model: Model<Api>,
		context: TranscriptContext,
		options: SimpleStreamOptions = {},
	) => {
		const events = createAssistantMessageEventStream();
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			usage: emptyUsage(),
			stopReason: "pending",
		};
		void (async () => {
			const sdkAbort = new AbortController();
			const forwardAbort = () => sdkAbort.abort(options.signal?.reason);
			options.signal?.addEventListener("abort", forwardAbort, { once: true });
			if (options.signal?.aborted) forwardAbort();
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const armIdle = () => {
				if (idleTimer !== undefined) clearTimeout(idleTimer);
				idleTimer = setTimeout(
					() =>
						sdkAbort.abort(
							new Error(
								`Provider stream idle timeout after ${idleTimeoutMs}ms`,
							),
						),
					idleTimeoutMs,
				);
			};
			const bounded = async <T>(pending: Promise<T>): Promise<T> => {
				let rejectAbort: () => void = () => {};
				const abort = new Promise<never>((_resolve, reject) => {
					rejectAbort = () => reject(sdkAbort.signal.reason);
					sdkAbort.signal.addEventListener("abort", rejectAbort, {
						once: true,
					});
					if (sdkAbort.signal.aborted) rejectAbort();
				});
				try {
					return await Promise.race([pending, abort]);
				} finally {
					sdkAbort.signal.removeEventListener("abort", rejectAbort);
				}
			};
			let receipt: R | undefined;
			let dispatched = false;
			let reserved = false;
			let reader:
				| ReadableStreamDefaultReader<
						| LanguageModelV2StreamPart
						| LanguageModelV3StreamPart
						| LanguageModelV4StreamPart
				  >
				| undefined;
			const blocks = new Map<string, number>();
			const inputs = new Map<string, string>();
			let finish = false;
			let hasUsage = false;
			let providerMetadata: SharedV3ProviderMetadata | undefined;
			let failure: unknown;
			try {
				options.signal?.throwIfAborted();
				const selected = await config.resolveModel(model);
				const prepared =
					(await config.prepare?.(model, context, options)) ?? {};
				receipt = prepared.receipt;
				reserved = config.prepare !== undefined;
				const actual = prepared.model ?? selected;
				const translated = piToSdkPrompt(context.messages);
				const call: LanguageModelV2CallOptions = {
					prompt: prepared.prompt ?? translated.prompt,
					tools: translated.tools,
					maxOutputTokens: options.maxTokens,
					temperature: options.temperature,
					toolChoice:
						options.toolChoice === undefined
							? undefined
							: { type: options.toolChoice },
					...prepared.callOptions,
					abortSignal: sdkAbort.signal,
				};
				options.signal?.throwIfAborted();
				dispatched = true;
				armIdle();
				const pendingResponse = (async () =>
					actual.specificationVersion === "v4"
						? await actual.doStream({
								...call,
								prompt: sdkV2ToV4Prompt(call.prompt),
								tools: call.tools?.map((tool) => {
									if (tool.type !== "function")
										throw new Error(
											"Provider-defined tools require a governed adapter",
										);
									return tool;
								}),
							})
						: actual.specificationVersion === "v3"
							? await actual.doStream({
									...call,
									prompt: sdkV2ToV3Prompt(call.prompt),
									tools: call.tools?.map((tool) => {
										if (tool.type !== "function")
											throw new Error(
												"Provider-defined tools require a governed adapter",
											);
										return tool;
									}),
								})
							: await actual.doStream(call))();
				void pendingResponse.then(
					(response) => {
						if (sdkAbort.signal.aborted)
							void response.stream
								.cancel(sdkAbort.signal.reason)
								.catch(() => {});
					},
					() => {},
				);
				const response = await bounded(pendingResponse);
				armIdle();
				reader = response.stream.getReader();
				const abortReader = () => {
					void reader?.cancel(sdkAbort.signal.reason).catch(() => {});
				};
				sdkAbort.signal.addEventListener("abort", abortReader, { once: true });
				events.push({ type: "start", partial: message });
				try {
					while (true) {
						const next = await bounded(reader.read());
						sdkAbort.signal.throwIfAborted();
						armIdle();
						if (next.done) break;
						const part = next.value;
						switch (part.type) {
							case "text-start":
							case "reasoning-start": {
								const index = message.content.length;
								blocks.set(part.id, index);
								message.content.push(
									part.type === "text-start"
										? {
												type: "text",
												text: "",
												textSignature: encodeSdkProviderOptions(
													part.providerMetadata,
												),
											}
										: {
												type: "thinking",
												thinking: "",
												thinkingSignature: encodeSdkProviderOptions(
													part.providerMetadata,
												),
											},
								);
								events.push({
									type:
										part.type === "text-start"
											? "text_start"
											: "thinking_start",
									contentIndex: index,
									partial: message,
								});
								break;
							}
							case "text-delta":
							case "reasoning-delta": {
								const index = blocks.get(part.id);
								if (index === undefined)
									throw new Error(`Delta without start: ${part.id}`);
								const block = message.content[index];
								if (part.type === "text-delta" && block?.type === "text") {
									block.text += part.delta;
									block.textSignature = mergeSdkProviderOptions(
										block.textSignature,
										part.providerMetadata,
									);
									events.push({
										type: "text_delta",
										contentIndex: index,
										delta: part.delta,
										partial: message,
									});
								} else if (
									part.type === "reasoning-delta" &&
									block?.type === "thinking"
								) {
									block.thinking += part.delta;
									block.thinkingSignature = mergeSdkProviderOptions(
										block.thinkingSignature,
										part.providerMetadata,
									);
									events.push({
										type: "thinking_delta",
										contentIndex: index,
										delta: part.delta,
										partial: message,
									});
								} else throw new Error(`Mismatched content block: ${part.id}`);
								break;
							}
							case "text-end":
							case "reasoning-end": {
								const index = blocks.get(part.id);
								if (index === undefined)
									throw new Error(`End without start: ${part.id}`);
								const block = message.content[index];
								if (block?.type === "text")
									block.textSignature = mergeSdkProviderOptions(
										block.textSignature,
										part.providerMetadata,
									);
								if (block?.type === "thinking")
									block.thinkingSignature = mergeSdkProviderOptions(
										block.thinkingSignature,
										part.providerMetadata,
									);
								if (block?.type === "text")
									events.push({
										type: "text_end",
										contentIndex: index,
										content: block.text,
										partial: message,
									});
								else if (block?.type === "thinking")
									events.push({
										type: "thinking_end",
										contentIndex: index,
										content: block.thinking,
										partial: message,
									});
								break;
							}
							case "tool-input-start": {
								if (part.providerExecuted)
									throw new Error(
										"Provider-executed tools require a governed adapter",
									);
								const index = message.content.length;
								blocks.set(part.id, index);
								inputs.set(part.id, "");
								message.content.push({
									type: "toolCall",
									id: part.id,
									name: part.toolName,
									arguments: {},
									thoughtSignature: encodeSdkProviderOptions(
										part.providerMetadata,
									),
								});
								events.push({
									type: "toolcall_start",
									contentIndex: index,
									partial: message,
								});
								break;
							}
							case "tool-input-delta": {
								const index = blocks.get(part.id);
								if (index === undefined)
									throw new Error(`Tool delta without start: ${part.id}`);
								inputs.set(part.id, (inputs.get(part.id) ?? "") + part.delta);
								events.push({
									type: "toolcall_delta",
									contentIndex: index,
									delta: part.delta,
									partial: message,
								});
								break;
							}
							case "tool-call": {
								if (part.providerExecuted)
									throw new Error(
										"Provider-executed tools require a governed adapter",
									);
								let index = blocks.get(part.toolCallId);
								if (index === undefined) {
									index = message.content.length;
									blocks.set(part.toolCallId, index);
									message.content.push({
										type: "toolCall",
										id: part.toolCallId,
										name: part.toolName,
										arguments: {},
										thoughtSignature: encodeSdkProviderOptions(
											part.providerMetadata,
										),
									});
									events.push({
										type: "toolcall_start",
										contentIndex: index,
										partial: message,
									});
								}
								const block = message.content[index];
								if (block?.type !== "toolCall")
									throw new Error("Tool call points to a non-tool block");
								block.arguments = parseArguments(part.input, block.name);
								block.thoughtSignature = mergeSdkProviderOptions(
									block.thoughtSignature,
									part.providerMetadata,
								);
								events.push({
									type: "toolcall_end",
									contentIndex: index,
									toolCall: block,
									partial: message,
								});
								break;
							}
							case "response-metadata":
								if (part.id !== undefined) message.responseId = part.id;
								if (part.modelId !== undefined)
									message.responseModel = part.modelId;
								break;
							case "finish": {
								providerMetadata = part.providerMetadata;
								message.usage = sdkToPiUsage(part.usage, model);
								hasUsage =
									typeof part.usage.inputTokens === "object" &&
									part.usage.inputTokens !== null
										? (part.usage.inputTokens.total !== undefined ||
												part.usage.inputTokens.noCache !== undefined) &&
											typeof part.usage.outputTokens === "object" &&
											part.usage.outputTokens.total !== undefined
										: part.usage.inputTokens !== undefined &&
											typeof part.usage.outputTokens === "number";
								const reason =
									typeof part.finishReason === "string"
										? part.finishReason
										: part.finishReason.unified;
								message.rawStopReason =
									typeof part.finishReason === "string"
										? part.finishReason
										: (part.finishReason.raw ?? reason);
								message.stopReason =
									reason === "tool-calls"
										? "toolUse"
										: reason === "length"
											? "length"
											: reason === "stop"
												? "stop"
												: "error";
								finish = true;
								break;
							}
							case "error":
								failure = part.error;
								break;
							case "tool-result":
							case "tool-approval-request":
							case "file":
							case "reasoning-file":
							case "custom":
								throw new Error(
									`Unsupported governed model output: ${part.type}`,
								);
							case "stream-start":
							case "tool-input-end":
							case "source":
							case "raw":
								break;
						}
					}
				} finally {
					sdkAbort.signal.removeEventListener("abort", abortReader);
				}
				if (failure !== undefined) throw failure;
				if (!finish)
					throw new Error("Model stream ended without a finish receipt");
				if (message.stopReason === "error")
					throw new Error(`Model stopped: ${message.rawStopReason}`);
			} catch (error) {
				message.stopReason = options.signal?.aborted ? "aborted" : "error";
				message.errorMessage =
					error instanceof Error ? error.message : String(error);
			} finally {
				if (idleTimer !== undefined) clearTimeout(idleTimer);
				options.signal?.removeEventListener("abort", forwardAbort);
				if (reader) {
					try {
						void reader.cancel(sdkAbort.signal.reason).catch(() => {});
					} catch {}
					reader.releaseLock();
				}
				if (dispatched || reserved) {
					try {
						await config.settled?.(receipt, message, {
							hasUsage,
							dispatched,
							...(providerMetadata ? { providerMetadata } : {}),
						});
					} catch (error) {
						message.stopReason = "error";
						message.errorMessage = `Usage settlement failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
				if (
					message.stopReason === "aborted" ||
					message.stopReason === "error" ||
					message.stopReason === "pending"
				) {
					events.push({
						type: "error",
						reason: message.stopReason === "aborted" ? "aborted" : "error",
						error: message,
					});
				} else
					events.push({ type: "done", reason: message.stopReason, message });
				events.end();
			}
		})();
		return events;
	};
	return {
		id: "tedix",
		name: "Tedix governed inference",
		getModels: config.catalog,
		auth: {
			apiKey: {
				name: "Tedix runtime binding",
				resolve: async () => ({ auth: {}, source: "Tedix runtime binding" }),
			},
		},
		stream: (model, context, options?: StreamOptions) =>
			dispatch(model, context, options),
		streamSimple: dispatch,
	};
}

import { createModels } from "@earendil-works/pi-ai";
import type { ContextCompactionCompletion } from "./pi-compaction";
import type { PiTurnAccounting } from "./pi-turn-accounting";
import type { ConfiguredObserverCallOptions } from "./observer-llm";

/** Embed in ConversationFacet; all model work uses its existing admitted journal. */
export interface GovernedPiCompactionHost {
	model: Model<Api>;
	accounting: Pick<
		PiTurnAccounting,
		"begin" | "prepareStep" | "captureProviderAttempt" | "recordProviderUsage"
	>;
	runId(): string;
	assertReady(): void | Promise<void>;
	resolveSdkModel(
		options: ConfiguredObserverCallOptions,
	): TedixSdkModel | Promise<TedixSdkModel>;
}
export function governedPiCompactionCompletion(
	host: GovernedPiCompactionHost,
): ContextCompactionCompletion {
	return async (options) => {
		const runId = host.runId();
		const models = createModels();
		models.setProvider(
			createTedixPiProvider({
				catalog: () => [host.model],
				resolveModel: () => host.resolveSdkModel(options),
				prepare: async (_model, context) => {
					options.signal?.throwIfAborted();
					await host.assertReady();
					if (host.runId() !== runId)
						throw new Error("Compaction lost admitted run ownership");
					await host.accounting.begin(runId);
					const ordinal = await host.accounting.prepareStep(
						{ messages: context.messages },
						{},
					);
					return {
						receipt: {
							runId,
							ordinal,
							original: await host.accounting.captureProviderAttempt(),
						},
						callOptions: {
							temperature: options.temperature ?? 0.2,
							maxOutputTokens: options.maxCompletionTokens ?? 4000,
							responseFormat: { type: "json" as const },
							tools: [],
							toolChoice: { type: "none" as const },
						},
					};
				},
				settled: async (receipt, message, measurement) => {
					if (!receipt) return;
					const usage = measurement.hasUsage
						? {
								inputTokens:
									message.usage.input +
									message.usage.cacheRead +
									message.usage.cacheWrite,
								outputTokens: message.usage.output,
								totalTokens: message.usage.totalTokens,
							}
						: measurement.dispatched
							? { inputTokens: null, outputTokens: null, totalTokens: null }
							: { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
					await host.accounting.recordProviderUsage(
						usage,
						[],
						receipt.original,
					);
				},
			}),
		);
		const now = Date.now();
		const result = await models.completeSimple(
			host.model,
			{
				systemPrompt: options.messages
					.filter((message) => message.role === "system")
					.map((message) => message.content)
					.join("\n\n"),
				messages: options.messages.flatMap((message) => {
					if (message.role === "system") return [];
					if (message.role === "user")
						return [
							{
								role: "user" as const,
								content: message.content,
								timestamp: now,
							},
						];
					// Observer input is rendered prose, not a reconstructed assistant transcript.
					return [
						{
							role: "user" as const,
							content: `assistant:\n${message.content}`,
							timestamp: now,
						},
					];
				}),
			},
			{
				signal: options.signal,
				maxTokens: options.maxCompletionTokens ?? 4000,
				temperature: options.temperature ?? 0.2,
			},
		);
		if (result.stopReason === "error" || result.stopReason === "aborted")
			throw new Error(result.errorMessage ?? `Compaction ${result.stopReason}`);
		if (result.content.some((part) => part.type === "toolCall"))
			throw new Error("Compaction generated an unauthorized tool call");
		return result.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("");
	};
}

/** Reserve binary media as its base64 wire length without serializing millions of byte-index properties. */
export function estimateSdkPromptTokens(prompt: LanguageModelV2Prompt): number {
	let binaryChars = 0;
	const textual = prompt.map((message) => ({
		...message,
		content:
			typeof message.content === "string"
				? message.content
				: message.content.map((part) => {
						if (part.type === "file" && part.data instanceof Uint8Array) {
							binaryChars += Math.ceil(part.data.byteLength / 3) * 4;
							return { ...part, data: "" };
						}
						return part;
					}),
	}));
	return estimateInferenceTokens(textual) + Math.ceil(binaryChars / 3);
}
