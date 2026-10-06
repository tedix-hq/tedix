const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];
function test(name: string, run: () => void | Promise<void>) {
	cases.push({ name, run });
}
import assert from "node:assert/strict";
import type {
	LanguageModelV2,
	LanguageModelV2StreamPart,
	LanguageModelV3,
	LanguageModelV3StreamPart,
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import type { Api, Model, AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	createTedixPiProvider,
	estimateSdkPromptTokens,
	governedPiCompactionCompletion,
	sdkV2ToV3Prompt,
	piToSdkPrompt,
	encodeSdkProviderOptions,
} from "./pi-model";

const model: Model<Api> = {
	id: "test",
	name: "test",
	provider: "tedix",
	api: "openai-completions",
	baseUrl: "",
	input: ["text", "image"],
	reasoning: true,
	contextWindow: 8192,
	maxTokens: 1000,
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
};
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});
function v2(
	parts: LanguageModelV2StreamPart[],
	onDispatch?: () => void,
): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "tedix",
		modelId: "test",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("Unexpected generate");
		},
		doStream: async () => {
			onDispatch?.();
			return {
				stream: new ReadableStream({
					start(controller) {
						for (const part of parts) controller.enqueue(part);
						controller.close();
					},
				}),
			};
		},
	};
}
const finish: LanguageModelV2StreamPart = {
	type: "finish",
	finishReason: "tool-calls",
	usage: {
		inputTokens: 12,
		outputTokens: 4,
		totalTokens: 16,
		cachedInputTokens: 2,
		reasoningTokens: 1,
	},
};

test("per-dispatch reservation precedes inference, and text/thinking/tool data and usage settle before done", async () => {
	const order: string[] = [];
	const sdk = v2(
		[
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: "Hello" },
			{ type: "text-end", id: "t" },
			{ type: "reasoning-start", id: "r" },
			{ type: "reasoning-delta", id: "r", delta: "Reason" },
			{ type: "reasoning-end", id: "r" },
			{ type: "tool-input-start", id: "c", toolName: "read" },
			{ type: "tool-input-delta", id: "c", delta: '{"x":1}' },
			{ type: "tool-input-end", id: "c" },
			{
				type: "tool-call",
				toolCallId: "c",
				toolName: "read",
				input: '{"x":1}',
			},
			finish,
		],
		() => order.push("dispatch"),
	);
	let settled: AssistantMessage | undefined;
	const provider = createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => sdk,
		prepare: async () => {
			order.push("reserve");
			return { receipt: "request-1" };
		},
		settled: async (receipt, message) => {
			assert.equal(receipt, "request-1");
			order.push("settle");
			settled = message;
		},
	});
	const stream = provider.streamSimple(model, context);
	const types: string[] = [];
	for await (const event of stream) types.push(event.type);
	const result = await stream.result();
	assert.deepEqual(order, ["reserve", "dispatch", "settle"]);
	assert.equal(result, settled);
	assert.equal(result.stopReason, "toolUse");
	assert.deepEqual(JSON.parse(JSON.stringify(result.content)), [
		{ type: "text", text: "Hello" },
		{ type: "thinking", thinking: "Reason" },
		{ type: "toolCall", id: "c", name: "read", arguments: { x: 1 } },
	]);
	assert.equal(result.usage.input, 10);
	assert.equal(result.usage.cacheRead, 2);
	assert.equal(result.usage.reasoning, 1);
	assert.equal(types.at(-1), "done");
	assert.ok(types.includes("toolcall_end"));
});

test("V3 media output conversion and cache usage are retained", async () => {
	const prompt = sdkV2ToV3Prompt([
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c",
					toolName: "read",
					output: {
						type: "content",
						value: [
							{ type: "media", data: "aGVsbG8=", mediaType: "image/png" },
						],
					},
				},
			],
		},
	]);
	assert.deepEqual(prompt[0], {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c",
				toolName: "read",
				output: {
					type: "content",
					value: [
						{ type: "image-data", data: "aGVsbG8=", mediaType: "image/png" },
					],
				},
			},
		],
	});
	const parts: LanguageModelV3StreamPart[] = [
		{
			type: "finish",
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: { total: 16, noCache: 10, cacheRead: 4, cacheWrite: 2 },
				outputTokens: { total: 6, text: 4, reasoning: 2 },
			},
		},
	];
	const sdk: LanguageModelV3 = {
		specificationVersion: "v3",
		provider: "tedix",
		modelId: "test",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("Unexpected");
		},
		doStream: async () => ({
			stream: new ReadableStream({
				start(c) {
					parts.forEach((part) => c.enqueue(part));
					c.close();
				},
			}),
		}),
	};
	const result = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => sdk,
	})
		.streamSimple(model, context)
		.result();
	assert.deepEqual(
		{ ...result.usage, cost: undefined },
		{
			input: 10,
			output: 6,
			cacheRead: 4,
			cacheWrite: 2,
			reasoning: 2,
			totalTokens: 22,
			cost: undefined,
		},
	);
});

test("stream errors preserve usage and settle as failure; missing finish cannot become success", async () => {
	const result = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () =>
			v2([finish, { type: "error", error: new Error("broken") }]),
	})
		.streamSimple(model, context)
		.result();
	assert.equal(result.stopReason, "error");
	assert.equal(result.errorMessage, "broken");
	assert.equal(result.usage.totalTokens, 16);
	const truncated = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => v2([]),
	})
		.streamSimple(model, context)
		.result();
	assert.equal(truncated.stopReason, "error");
	assert.match(truncated.errorMessage ?? "", /without a finish/);
});

test("already cancelled request does not reserve or dispatch", async () => {
	const abort = new AbortController();
	abort.abort(new Error("cancelled"));
	let count = 0;
	const result = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => v2([], () => count++),
		prepare: async () => {
			count++;
			return {};
		},
	})
		.streamSimple(model, context, { signal: abort.signal })
		.result();
	assert.equal(count, 0);
	assert.equal(result.stopReason, "aborted");
});

test("system section replacement removes stale instructions", () => {
	const { prompt } = piToSdkPrompt([
		{
			role: "system",
			content: "base",
			sections: { rules: "old" },
			timestamp: 0,
		},
		{ role: "user", content: "hello", timestamp: 1 },
		{ role: "system", content: "", sections: { rules: "new" }, timestamp: 2 },
	]);
	assert.equal(prompt[0]?.role, "system");
	if (prompt[0]?.role === "system") {
		assert.match(prompt[0].content, /new/);
		assert.doesNotMatch(prompt[0].content, /old/);
	}
});

test("unknown usage remains explicit after an interrupted dispatch", async () => {
	let measured: { hasUsage: boolean; dispatched: boolean } | undefined;
	const result = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => v2([]),
		prepare: async () => ({ receipt: "reservation" }),
		settled: async (receipt, _message, measurement) => {
			assert.equal(receipt, "reservation");
			measured = measurement;
		},
	})
		.streamSimple(model, context)
		.result();
	assert.equal(result.stopReason, "error");
	assert.deepEqual(measured, { hasUsage: false, dispatched: true });
});

test("cancellation after reservation releases undispatched reservation", async () => {
	const abort = new AbortController();
	let dispatches = 0;
	let measured: { hasUsage: boolean; dispatched: boolean } | undefined;
	const result = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => v2([], () => dispatches++),
		prepare: async () => {
			abort.abort(new Error("cancelled"));
			return { receipt: "reservation" };
		},
		settled: async (_receipt, _message, measurement) => {
			measured = measurement;
		},
	})
		.streamSimple(model, context, { signal: abort.signal })
		.result();
	assert.equal(result.stopReason, "aborted");
	assert.equal(dispatches, 0);
	assert.deepEqual(measured, { hasUsage: false, dispatched: false });
});

test("opaque provider continuity survives durable serialization and replay", async () => {
	const metadata = {
		azure: { reasoningItemId: "rs_1", encryptedContent: "opaque" },
	};
	const sdk = v2([
		{ type: "reasoning-start", id: "r", providerMetadata: metadata },
		{ type: "reasoning-delta", id: "r", delta: "private" },
		{ type: "reasoning-end", id: "r" },
		{
			type: "tool-call",
			toolCallId: "c",
			toolName: "read",
			input: "{}",
			providerMetadata: { azure: { itemId: "fc_1" } },
		},
		finish,
	]);
	const output = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => sdk,
	})
		.streamSimple(model, context)
		.result();
	const durable = JSON.parse(JSON.stringify(output)) as AssistantMessage;
	const replay = piToSdkPrompt([durable]).prompt;
	assert.equal(replay[0]?.role, "assistant");
	if (replay[0]?.role === "assistant") {
		assert.deepEqual(replay[0].content[0]?.providerOptions, metadata);
		assert.deepEqual(replay[0].content[1]?.providerOptions, {
			azure: { itemId: "fc_1" },
		});
	}
});

test("usage settlement failure fences success before terminal delivery", async () => {
	const output = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => v2([finish]),
		prepare: async () => ({ receipt: "r" }),
		settled: async () => {
			throw new Error("ledger unavailable");
		},
	})
		.streamSimple(model, context)
		.result();
	assert.equal(output.stopReason, "error");
	assert.match(output.errorMessage ?? "", /ledger unavailable/);
});

test("actual SDK V4 dispatch tags files, retains signatures and preserves usage", async () => {
	let request: LanguageModelV4CallOptions | undefined;
	const metadata = {
		openai: {
			itemId: "opaque-item",
			reasoningEncryptedContent: "opaque-encrypted",
		},
	};
	const input = normalizeContext({
		messages: [
			{
				role: "user",
				timestamp: 1,
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
			{
				role: "assistant",
				timestamp: 2,
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: [
					{
						type: "thinking",
						thinking: "reasoning",
						thinkingSignature: encodeSdkProviderOptions(metadata),
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "c",
				toolName: "read",
				timestamp: 3,
				isError: false,
				content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			},
		],
	});
	const parts: LanguageModelV4StreamPart[] = [
		{ type: "reasoning-start", id: "r", providerMetadata: metadata },
		{ type: "reasoning-delta", id: "r", delta: "Thought" },
		{ type: "reasoning-end", id: "r" },
		{ type: "text-start", id: "t" },
		{ type: "text-delta", id: "t", delta: "Answer" },
		{ type: "text-end", id: "t" },
		{
			type: "finish",
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: { total: 16, noCache: 10, cacheRead: 4, cacheWrite: 2 },
				outputTokens: { total: 6, text: 4, reasoning: 2 },
			},
		},
	];
	const sdk: LanguageModelV4 = {
		specificationVersion: "v4",
		provider: "tedix",
		modelId: "test",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("Unexpected generate");
		},
		doStream: async (options) => {
			request = options;
			return {
				stream: new ReadableStream({
					start(c) {
						parts.forEach((part) => c.enqueue(part));
						c.close();
					},
				}),
			};
		},
	};
	const result = await createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => sdk,
	})
		.streamSimple(model, input)
		.result();
	assert.equal(result.stopReason, "stop");
	assert.equal(result.usage.totalTokens, 22);
	assert.deepEqual(request?.prompt[1], {
		role: "assistant",
		content: [
			{ type: "reasoning", text: "reasoning", providerOptions: metadata },
		],
	});
	assert.equal(request?.prompt[0]?.role, "user");
	if (request?.prompt[0]?.role === "user") {
		const part = request.prompt[0].content[0];
		assert.equal(part?.type, "file");
		if (part?.type === "file")
			assert.deepEqual(part.data, {
				type: "data",
				data: Uint8Array.from([104, 101, 108, 108, 111]),
			});
	}
	assert.deepEqual(request?.prompt[2], {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c",
				toolName: "read",
				output: {
					type: "content",
					value: [
						{
							type: "file",
							data: { type: "data", data: "aGVsbG8=" },
							mediaType: "image/png",
						},
					],
				},
			},
		],
	});
	const thought = result.content[0];
	assert.equal(thought?.type, "thinking");
	if (thought?.type === "thinking")
		assert.equal(thought.thinkingSignature, encodeSdkProviderOptions(metadata));
});

const compactionModel: Model<Api> = {
	id: "compact",
	name: "compact",
	provider: "tedix",
	api: "openai-completions",
	baseUrl: "",
	input: ["text"],
	reasoning: false,
	contextWindow: 8192,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function compactionFixture(
	parts: LanguageModelV2StreamPart[],
	order: string[],
): LanguageModelV2 {
	return {
		specificationVersion: "v2",
		provider: "tedix",
		modelId: "compact",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("not called");
		},
		doStream: async (options) => {
			order.push("dispatch");
			assert.deepEqual(options.toolChoice, { type: "none" });
			assert.deepEqual(options.tools, []);
			return {
				stream: new ReadableStream({
					start(c) {
						for (const part of parts) c.enqueue(part);
						c.close();
					},
				}),
			};
		},
	};
}
test("native compaction reserves canonical journal before actual dispatch and records measured usage", async () => {
	const order: string[] = [];
	let usage: unknown;
	const sdk = compactionFixture(
		[
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: '{"summary":"retained"}' },
			{ type: "text-end", id: "t" },
			{
				type: "finish",
				finishReason: "stop",
				usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
			},
		],
		order,
	);
	const complete = governedPiCompactionCompletion({
		model: compactionModel,
		runId: () => "run",
		assertReady: () => {
			order.push("authority");
		},
		resolveSdkModel: () => sdk,
		accounting: {
			begin: async () => {
				order.push("begin");
			},
			prepareStep: async () => {
				order.push("reserve");
				return 1;
			},
			captureProviderAttempt: async () => ({
				runId: "compaction-run",
				attemptId: "original-provider-attempt",
			}),
			recordProviderUsage: async (value) => {
				order.push("settle");
				usage = value;
			},
		},
	});
	const text = await complete({
		env: {} as never,
		messages: [
			{ role: "system", content: "compact" },
			{ role: "user", content: "transcript" },
		],
	});
	assert.equal(text, '{"summary":"retained"}');
	assert.deepEqual(order, [
		"authority",
		"begin",
		"reserve",
		"dispatch",
		"settle",
	]);
	assert.deepEqual(usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 });
});
test("interrupted dispatched compaction retains unknown usage rather than measured zero", async () => {
	const order: string[] = [];
	let usage: unknown;
	const complete = governedPiCompactionCompletion({
		model: compactionModel,
		runId: () => "run",
		assertReady: () => undefined,
		resolveSdkModel: () =>
			compactionFixture(
				[{ type: "error", error: new Error("network interrupted") }],
				order,
			),
		accounting: {
			begin: async () => undefined,
			prepareStep: async () => 1,
			captureProviderAttempt: async () => ({
				runId: "compaction-run",
				attemptId: "original-provider-attempt",
			}),
			recordProviderUsage: async (value) => {
				usage = value;
			},
		},
	});
	await assert.rejects(
		complete({
			env: {} as never,
			messages: [{ role: "user", content: "transcript" }],
		}),
	);
	assert.deepEqual(order, ["dispatch"]);
	assert.deepEqual(usage, {
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
	});
});

test("idle provider timeout aborts SDK and settles unknown usage before terminal despite hanging cancel", async () => {
	let cancelled = false;
	let sdkSignal: AbortSignal | undefined;
	const order: string[] = [];
	const sdk: LanguageModelV2 = {
		...v2([]),
		doStream: async (options) => {
			sdkSignal = options.abortSignal;
			return {
				stream: new ReadableStream<LanguageModelV2StreamPart>({
					start(controller) {
						controller.enqueue({ type: "text-start", id: "partial" });
						controller.enqueue({
							type: "text-delta",
							id: "partial",
							delta: "retained",
						});
					},
					cancel() {
						cancelled = true;
						return new Promise<void>(() => {});
					},
				}),
			};
		},
	};
	const provider = createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => sdk,
		idleTimeoutMs: 10,
		prepare: async () => ({ receipt: "owned" }),
		settled: async (receipt, message, measurement) => {
			assert.equal(receipt, "owned");
			assert.deepEqual(measurement, { hasUsage: false, dispatched: true });
			assert.equal(message.stopReason, "error");
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push("receipt");
		},
	});
	const stream = provider.streamSimple(model, context, {});
	for await (const event of stream) {
		if (event.type === "error") order.push("terminal");
	}
	const result = await stream.result();
	assert.match(result.errorMessage ?? "", /idle timeout/);
	assert.equal(sdkSignal?.aborted, true);
	assert.equal(cancelled, true);
	assert.deepEqual(order, ["receipt", "terminal"]);
});
test("idle provider header timeout settles actual dispatch without waiting for SDK", async () => {
	let sdkSignal: AbortSignal | undefined;
	let settled = false;
	const sdk: LanguageModelV2 = {
		...v2([]),
		doStream: (options) => {
			sdkSignal = options.abortSignal;
			return new Promise(() => {});
		},
	};
	const provider = createTedixPiProvider({
		catalog: () => [model],
		resolveModel: () => sdk,
		idleTimeoutMs: 10,
		prepare: async () => ({ receipt: "header" }),
		settled: async (receipt, _message, measurement) => {
			assert.equal(receipt, "header");
			assert.deepEqual(measurement, { hasUsage: false, dispatched: true });
			settled = true;
		},
	});
	const result = await provider.streamSimple(model, context, {}).result();
	assert.match(result.errorMessage ?? "", /idle timeout/);
	assert.equal(sdkSignal?.aborted, true);
	assert.equal(settled, true);
});

test("binary prompt reservations include wire-sized media without expanding byte indexes", () => {
	const prompt: import("@ai-sdk/provider").LanguageModelV2Prompt = [
		{
			role: "user",
			content: [
				{
					type: "file",
					mediaType: "image/png",
					data: new Uint8Array(1024 * 1024),
				},
			],
		},
	];
	const expected = estimateSdkPromptTokens([
		{
			role: "user",
			content: [
				{
					type: "file",
					mediaType: "image/png",
					data: "a".repeat(Math.ceil((1024 * 1024) / 3) * 4),
				},
			],
		},
	]);
	assert.ok(estimateSdkPromptTokens(prompt) >= expected);
	assert.ok(estimateSdkPromptTokens(prompt) <= expected + 1);
	assert.ok(expected > 400000);
});
for (const entry of cases) {
	await entry.run();
	console.log(`PASS ${entry.name}`);
}

test("compaction settles its captured reservation after mutable host ownership changes", async () => {
	let currentRun = "original";
	const original = Object.freeze({
		runId: "original",
		attemptId: "original-step",
	});
	let recorded: unknown;
	const sdk = compactionFixture(
		[
			{ type: "text-start", id: "t" },
			{ type: "text-delta", id: "t", delta: '{"summary":"retained"}' },
			{ type: "text-end", id: "t" },
			{
				type: "finish",
				finishReason: "stop",
				usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
			},
		],
		[],
	);
	const stream = sdk.doStream.bind(sdk);
	sdk.doStream = async (input) => {
		currentRun = "subsequent";
		return stream(input);
	};
	const complete = governedPiCompactionCompletion({
		model: compactionModel,
		runId: () => currentRun,
		assertReady: () => undefined,
		resolveSdkModel: () => sdk,
		accounting: {
			begin: async () => undefined,
			prepareStep: async () => 1,
			captureProviderAttempt: async () => original,
			recordProviderUsage: async (_usage, _calls, attempt) => {
				recorded = attempt;
			},
		},
	});
	assert.equal(
		await complete({
			env: {} as never,
			messages: [{ role: "user", content: "transcript" }],
		}),
		'{"summary":"retained"}',
	);
	assert.equal(currentRun, "subsequent");
	assert.equal(recorded, original);
});
