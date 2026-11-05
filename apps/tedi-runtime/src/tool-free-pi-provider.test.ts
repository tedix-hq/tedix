import assert from "node:assert/strict";
import type {
	LanguageModelV2,
	LanguageModelV2CallOptions,
	LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import {
	createToolFreePiModels,
	toolFreePiModel,
} from "./tool-free-pi-provider";
import { evaluationOutputShape } from "./evaluation-evidence";

const identity = { provider: "fixture", model: "judge" };
function fixture(
	options: {
		emptyOutput?: boolean;
		unknownUsage?: boolean;
		missingRun?: boolean;
		changeRun?: boolean;
		governedReceipt?: boolean;
		denied?: boolean;
		audit?: (call: LanguageModelV2CallOptions) => Promise<void>;
	} = {},
) {
	let runId: string | undefined = options.missingRun ? undefined : "run-1";
	const order: string[] = [];
	const usage: unknown[] = [];
	const outcomes: unknown[] = [];
	let dispatched: LanguageModelV2CallOptions | undefined;
	const sdk: LanguageModelV2 = {
		specificationVersion: "v2",
		provider: "fixture",
		modelId: "judge",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("Unexpected generate");
		},
		doStream: async (input) => {
			order.push("dispatch");
			dispatched = input;
			if (options.changeRun) runId = "run-2";
			const parts: LanguageModelV2StreamPart[] = options.emptyOutput
				? []
				: [
						{ type: "text-start", id: "answer" },
						{ type: "text-delta", id: "answer", delta: "owned verdict" },
						{ type: "text-end", id: "answer" },
					];
			if (!options.unknownUsage)
				parts.push({
					type: "finish",
					finishReason: "stop",
					usage: {
						inputTokens: 12,
						outputTokens: 4,
						totalTokens: 16,
						cachedInputTokens: 3,
					},
				});
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
	const models = createToolFreePiModels({
		afterDispatch: async (outcome) => {
			outcomes.push(outcome);
		},
		beforeDispatch: options.audit,
		runId: () => runId,
		selected: () => ({ model: sdk, identity }),
		...(options.governedReceipt
			? {
					receiptOperation: () => "original-operation",
					assertOriginalReceipt: async (id: string, op?: string) => {
						assert.equal(id, "run-1");
						assert.equal(op, "original-operation");
						order.push("original-receipt");
					},
				}
			: {}),
		accounting: {
			captureProviderAttempt: async () =>
				Object.freeze({ runId: runId!, attemptId: "original-attempt" }),
			begin: async (id) => {
				assert.equal(id, runId);
				order.push("begin");
			},
			prepareStep: async (_input, limits) => {
				assert.equal(limits.maxSteps, 10);
				order.push("reserve");
				if (options.denied) throw new Error("budget denied");
				return 1;
			},
			recordProviderUsage: async (measured, steps, original) => {
				assert.deepEqual(original, {
					runId: "run-1",
					attemptId: "original-attempt",
				});
				assert.deepEqual(steps, []);
				order.push("settle");
				usage.push(measured);
			},
		},
	});
	return { models, order, outcomes, usage, dispatched: () => dispatched };
}
{
	const f = fixture({ emptyOutput: true });
	const answer = await run(f);
	assert.equal(answer.stopReason, "stop");
	assert.deepEqual(answer.content, []);
	assert.deepEqual((f.outcomes[0] as { outputShape?: unknown }).outputShape, {
		measurementBoundary: "pi-adapter-final-assistant-message-v1",
		textPartCount: 0,
		textChars: 0,
		reasoningPartCount: 0,
		reasoningChars: 0,
	});
}
async function run(
	f: ReturnType<typeof fixture>,
	model = toolFreePiModel(identity),
) {
	return f.models.completeSimple(model, {
		messages: [{ role: "user", content: "Assess the claim.", timestamp: 1 }],
	});
}
{
	const f = fixture();
	const answer = await run(f);
	assert.equal(answer.stopReason, "stop");
	assert.deepEqual(f.order, ["begin", "reserve", "dispatch", "settle"]);
	assert.deepEqual(f.dispatched()?.tools, []);
	assert.deepEqual(f.dispatched()?.toolChoice, { type: "none" });
	assert.deepEqual(f.usage, [
		{ inputTokens: 12, outputTokens: 4, totalTokens: 16 },
	]);
	assert.deepEqual((f.outcomes[0] as { outputShape?: unknown }).outputShape, {
		measurementBoundary: "pi-adapter-final-assistant-message-v1",
		textPartCount: 1,
		textChars: 13,
		reasoningPartCount: 0,
		reasoningChars: 0,
	});
}

for (const [message, expected] of [
	[
		{ content: [{ type: "text", text: "answer" }] },
		{
			textPartCount: 1,
			textChars: 6,
			reasoningPartCount: 0,
			reasoningChars: 0,
		},
	],
	[
		{ content: [{ type: "thinking", thinking: "private" }] },
		{
			textPartCount: 0,
			textChars: 0,
			reasoningPartCount: 1,
			reasoningChars: 7,
		},
	],
	[
		{
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			],
		},
		{
			textPartCount: 2,
			textChars: 6,
			reasoningPartCount: 1,
			reasoningChars: 4,
		},
	],
	[
		{ content: [] },
		{
			textPartCount: 0,
			textChars: 0,
			reasoningPartCount: 0,
			reasoningChars: 0,
		},
	],
] as const) {
	assert.deepEqual(evaluationOutputShape(message), {
		measurementBoundary: "pi-adapter-final-assistant-message-v1",
		...expected,
	});
}
for (const malformed of [
	undefined,
	{},
	{ content: null },
	{ content: [{ type: "text" }] },
	{ content: [{ type: "thinking", thinking: 4 }] },
	{ content: [{ type: "unknown", text: "private" }] },
])
	assert.equal(evaluationOutputShape(malformed), undefined);
{
	const f = fixture({ unknownUsage: true });
	await run(f);
	assert.deepEqual(f.usage, [
		{ inputTokens: null, outputTokens: null, totalTokens: null },
	]);
}
{
	const f = fixture({ missingRun: true });
	const answer = await run(f);
	assert.equal(answer.stopReason, "error");
	assert.match(answer.errorMessage ?? "", /no admitted run/);
	assert.equal(f.dispatched(), undefined);
}
{
	const f = fixture({ denied: true });
	const answer = await run(f);
	assert.equal(answer.stopReason, "error");
	assert.equal(f.dispatched(), undefined);
	assert.deepEqual(f.usage, []);
}
{
	const f = fixture({ changeRun: true });
	const answer = await run(f);
	assert.equal(answer.stopReason, "error");
	assert.match(answer.errorMessage ?? "", /stale run identity/);
	assert.deepEqual(f.usage, []);
}
{
	const f = fixture();
	const answer = await run(
		f,
		toolFreePiModel({ ...identity, model: "changed" }),
	);
	assert.equal(answer.stopReason, "error");
	assert.match(answer.errorMessage ?? "", /Pinned tool-free model changed/);
	assert.equal(f.dispatched(), undefined);
}
{
	const f = fixture({ changeRun: true, governedReceipt: true });
	const answer = await run(f);
	assert.equal(answer.stopReason, "stop");
	assert.deepEqual(f.order, [
		"begin",
		"reserve",
		"dispatch",
		"original-receipt",
		"settle",
	]);
	assert.deepEqual(f.usage, [
		{ inputTokens: 12, outputTokens: 4, totalTokens: 16 },
	]);
}
{
	const observed: LanguageModelV2CallOptions[] = [];
	const f = fixture({
		audit: async (call) => {
			observed.push({ ...call, prompt: structuredClone(call.prompt) });
		},
	});
	const answer = await run(f);
	assert.equal(answer.stopReason, "stop");
	assert.deepEqual(observed[0]?.prompt, f.dispatched()?.prompt);
	assert.deepEqual(observed[0]?.tools, []);
	assert.deepEqual(observed[0]?.toolChoice, { type: "none" });
}
{
	const f = fixture({
		audit: async () => {
			throw new Error("evidence storage unavailable");
		},
	});
	const answer = await run(f);
	assert.equal(answer.stopReason, "error");
	assert.match(answer.errorMessage ?? "", /evidence storage unavailable/);
	assert.equal(f.dispatched(), undefined);
	assert.deepEqual(f.usage, [
		{ inputTokens: 0, outputTokens: 0, totalTokens: 0 },
	]);
}
console.log("tool-free-pi-provider OK");
