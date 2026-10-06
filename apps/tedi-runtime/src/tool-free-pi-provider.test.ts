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

const identity = { provider: "fixture", model: "judge" };
function fixture(
	options: {
		unknownUsage?: boolean;
		missingRun?: boolean;
		changeRun?: boolean;
		governedReceipt?: boolean;
		denied?: boolean;
	} = {},
) {
	let runId: string | undefined = options.missingRun ? undefined : "run-1";
	const order: string[] = [];
	const usage: unknown[] = [];
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
			const parts: LanguageModelV2StreamPart[] = [
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
	return { models, order, usage, dispatched: () => dispatched };
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
}
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
console.log("tool-free-pi-provider OK");
