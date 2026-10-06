/**
 * Standalone assertions for the pure `shapeStepTelemetry` helper that feeds the
 * native Pi provider receipt → `step.completed` runtime-event telemetry.
 * Run directly: `bun run src/step-telemetry.test.ts`.
 *
 * No vitest/cloudflare:workers harness needed — `shapeStepTelemetry` is a pure
 * function, so a plain `node:assert` file keeps the check zero-dependency while
 * the rest of the agent runtime stays untestable in this offline harness
 * (mirrors `admin-agent-diag.test.ts`).
 */
import assert from "node:assert/strict";
import {
	bodyExecutionUsageFromSteps,
	emptyFacetTurnUsage,
	facetToolCallOutcomes,
	shapeStepTelemetry,
	summarizeToolSteps,
} from "./step-telemetry";

// --- facet proxy outcomes survive into workflow / cron terminal telemetry ---
{
	const outcomes = facetToolCallOutcomes([
		{
			finishReason: "facet-tool-proxy",
			toolNames: ["tedix_mcp_code"],
			toolResultCount: 1,
		},
		{
			finishReason: "facet-tool-error",
			toolNames: ["browser_execute"],
			toolResultCount: 1,
		},
		{
			finishReason: "facet-tool-proxy",
			toolNames: ["incomplete_call"],
			toolResultCount: 0,
		},
	]);
	assert.deepEqual(outcomes, [
		{ name: "tedix_mcp_code", ok: true },
		{ name: "browser_execute", ok: false },
		{ name: "incomplete_call", ok: false },
	]);
}

// --- full ai@7 LanguageModelUsage shape, with tool calls -------------------
{
	const payload = shapeStepTelemetry({
		stepNumber: 2,
		model: { provider: "azure.chat", modelId: "gpt-5.6-terra" },
		finishReason: "tool-calls",
		text: "partial answer",
		toolCalls: [
			{ toolName: "search" } as never,
			{ toolName: "fetch" } as never,
		],
		toolResults: [{} as never],
		usage: {
			inputTokens: 1200,
			outputTokens: 80,
			totalTokens: 1280,
			inputTokenDetails: {
				noCacheTokens: 200,
				cacheReadTokens: 1000,
				cacheWriteTokens: 64,
			},
			outputTokenDetails: { textTokens: 70, reasoningTokens: 10 },
		} as never,
	});

	assert.equal(payload.source, "pi-provider-receipt");
	assert.equal(payload.stepNumber, 2);
	assert.equal(payload.provider, "azure.chat");
	assert.equal(payload.model, "gpt-5.6-terra");
	assert.equal(payload.finishReason, "tool-calls");
	assert.equal(payload.toolCallCount, 2);
	assert.equal(payload.toolResultCount, 1);
	assert.deepEqual(payload.toolNames, ["search", "fetch"]);
	assert.equal(payload.textLength, "partial answer".length);
	assert.equal(payload.usage.inputTokens, 1200);
	assert.equal(payload.usage.outputTokens, 80);
	assert.equal(payload.usage.totalTokens, 1280);
	assert.equal(payload.usage.reasoningTokens, 10);
	assert.equal(payload.usage.cacheReadTokens, 1000, "cache read from detail");
	assert.equal(payload.usage.cacheWriteTokens, 64, "cache write from detail");
}

// Extra provider fields cannot fill unavailable receipt measurements.
{
	const payload = shapeStepTelemetry({
		stepNumber: 0,
		finishReason: "stop",
		text: "done",
		toolCalls: [],
		toolResults: [],
		usage: {
			inputTokens: 500,
			outputTokens: 40,
			totalTokens: 540,
			// The receipt projection supplies no detailed cache/reasoning usage.
			cachedInputTokens: 480,
			reasoningTokens: 5,
		} as never,
	});

	assert.deepEqual(payload.usage, {
		inputTokens: 500,
		outputTokens: 40,
		totalTokens: 540,
		cacheReadTokens: null,
		reasoningTokens: null,
		cacheWriteTokens: null,
	});
	const detailedZero = shapeStepTelemetry({
		usage: {
			inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 0 },
			outputTokenDetails: { reasoningTokens: 0 },
			cachedInputTokens: 480,
			reasoningTokens: 5,
		},
	});
	assert.equal(detailedZero.usage.cacheReadTokens, 0);
	assert.equal(detailedZero.usage.cacheWriteTokens, 0);
	assert.equal(detailedZero.usage.reasoningTokens, 0);
	assert.equal(payload.toolCallCount, 0);
	assert.deepEqual(payload.toolNames, []);
}

// --- missing / undefined usage normalizes to all-null (fail-soft) ----------
{
	const payload = shapeStepTelemetry({
		// Cast the whole partial object: simulate a provider that omits every
		// field except the step index (SDK shape drift). `shapeStepTelemetry`
		// must still produce a fully-normalized, all-null payload.
		stepNumber: 1,
		finishReason: undefined,
		text: undefined,
		toolCalls: undefined,
		toolResults: undefined,
		usage: undefined,
	} as never);

	assert.equal(payload.finishReason, "unknown");
	assert.equal(payload.provider, null);
	assert.equal(payload.model, null);
	assert.equal(payload.textLength, 0);
	assert.equal(payload.toolCallCount, 0);
	assert.equal(payload.toolResultCount, 0);
	assert.deepEqual(payload.toolNames, []);
	assert.deepEqual(payload.usage, {
		inputTokens: null,
		outputTokens: null,
		totalTokens: null,
		reasoningTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
	});
}

// The payload must be JSON-serializable (it goes into the ledger as
// `RuntimeMetadataSchema` = Record<string, unknown>).
{
	const payload = shapeStepTelemetry({
		stepNumber: 0,
		finishReason: "stop",
		text: "",
		toolCalls: [],
		toolResults: [],
		usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } as never,
	});
	assert.equal(typeof JSON.stringify(payload), "string");
}

// --- body usage sums reported tokens with the same observed identity -------
{
	const usage = bodyExecutionUsageFromSteps([
		{
			provider: "azure.chat",
			model: "gpt-5.6-terra",
			usage: {
				inputTokens: 100,
				outputTokens: 10,
				reasoningTokens: 3,
				cacheReadTokens: 5,
			},
		},
		{
			provider: "azure.chat",
			model: "gpt-5.6-terra",
			usage: {
				inputTokens: 200,
				outputTokens: 20,
				reasoningTokens: 4,
				cacheWriteTokens: 4,
			},
		},
	]);
	assert.equal(usage.provider, "azure.chat");
	assert.equal(usage.model, "gpt-5.6-terra");
	assert.equal(usage.inputTokens, 300);
	assert.equal(usage.outputTokens, 30);
	assert.equal(usage.reasoningTokens, 7);
	assert.equal(usage.cacheReadTokens, 5);
	assert.equal(usage.cacheWriteTokens, 4);
}

// Actual fallback identity survives even when it differs from primary policy.
{
	const primary = shapeStepTelemetry({
		model: { provider: "azure.chat", modelId: "gpt-5.6-terra" },
		usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
	});
	const fallback = shapeStepTelemetry({
		model: { provider: "workers-ai", modelId: "@cf/openai/gpt-oss-120b" },
		usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
	});
	assert.equal(fallback.provider, "workers-ai");
	assert.equal(fallback.model, "@cf/openai/gpt-oss-120b");
	const fallbackOnly = bodyExecutionUsageFromSteps([fallback]);
	assert.equal(fallbackOnly.provider, "workers-ai");
	assert.equal(fallbackOnly.model, "@cf/openai/gpt-oss-120b");

	// Neither the newest model nor the configured primary owns mixed totals.
	for (const steps of [
		[primary, fallback],
		[fallback, primary],
	]) {
		const mixed = bodyExecutionUsageFromSteps(steps);
		assert.equal(mixed.provider, null);
		assert.equal(mixed.model, null);
		assert.equal(mixed.inputTokens, 30);
		assert.equal(mixed.outputTokens, 5);
	}
	const sameProviderDifferentModel = bodyExecutionUsageFromSteps([
		primary,
		{ ...primary, model: "another-deployment" },
	]);
	assert.equal(sameProviderDifferentModel.provider, null);
	assert.equal(sameProviderDifferentModel.model, null);

	// Missing/partial identity in any contributing row keeps the total unknown.
	const missingIdentitySteps: Parameters<
		typeof bodyExecutionUsageFromSteps
	>[0] = [
		{ usage: { inputTokens: 5 } },
		{ usage: { outputTokens: 0 } },
		{ usage: { totalTokens: 5 } },
		{ provider: "azure.chat", usage: { inputTokens: 5 } },
		{ model: "gpt-5.6-terra", usage: { inputTokens: 5 } },
	];
	for (const missing of missingIdentitySteps) {
		for (const steps of [
			[missing, primary],
			[primary, missing],
		]) {
			const unknown = bodyExecutionUsageFromSteps(steps);
			assert.equal(unknown.provider, null);
			assert.equal(unknown.model, null);
		}
	}

	// Proxy records carry no model usage and must not erase observed identity.
	const proxy = { finishReason: "facet-tool-proxy", usage: undefined };
	const withProxy = bodyExecutionUsageFromSteps([
		proxy,
		primary,
		proxy,
		shapeStepTelemetry({}),
	]);
	assert.equal(withProxy.provider, "azure.chat");
	assert.equal(withProxy.model, "gpt-5.6-terra");
	assert.equal(withProxy.inputTokens, 10);
}

// Unreported token fields stay null, while a genuine reported zero stays zero.
{
	const usage = bodyExecutionUsageFromSteps([
		{ usage: { inputTokens: 50 } },
		{ usage: { inputTokens: 50 } },
	]);
	assert.equal(usage.inputTokens, 100);
	assert.equal(usage.outputTokens, null);
	assert.equal(usage.cacheReadTokens, null);
	assert.equal(usage.cacheWriteTokens, null);
	assert.equal(usage.reasoningTokens, null);
	assert.equal(usage.provider, null);
	assert.equal(usage.model, null);

	for (const steps of [
		[],
		[{ usage: undefined }, null],
		[
			shapeStepTelemetry({
				model: { provider: "azure.chat", modelId: "gpt-5.6-terra" },
			}),
		],
	]) {
		assert.deepEqual(bodyExecutionUsageFromSteps(steps), {
			provider: null,
			model: null,
			inputTokens: null,
			outputTokens: null,
			reasoningTokens: null,
			cacheReadTokens: null,
			cacheWriteTokens: null,
		});
	}
	const zero = bodyExecutionUsageFromSteps([
		{
			provider: "azure.chat",
			model: "gpt-5.6-terra",
			usage: { outputTokens: 0 },
		},
	]);
	assert.equal(zero.outputTokens, 0);
	assert.equal(zero.inputTokens, null);
	assert.equal(zero.provider, "azure.chat");
	assert.equal(zero.model, "gpt-5.6-terra");
}

// --- summarizeToolSteps: the shared scores.json / tokensUsed rollup -----------
{
	const summary = summarizeToolSteps([
		{ toolCallCount: 2, usage: { totalTokens: 1280 } },
		{ toolCallCount: 0, usage: { totalTokens: 540 } },
		{ toolCallCount: 1, usage: null },
	]);
	assert.equal(summary.steps, 3);
	assert.equal(summary.toolCalls, 3);
	assert.equal(summary.totalTokens, 1820, "summed only over reporting steps");
}

// --- summarizeToolSteps USAGE INVARIANT: no step reported → null, not 0 -------
{
	const summary = summarizeToolSteps([
		{ toolCallCount: 1 },
		{ toolCallCount: 2, usage: { totalTokens: null } },
	]);
	assert.equal(summary.steps, 2);
	assert.equal(summary.toolCalls, 3);
	assert.equal(summary.totalTokens, null, "no reported totalTokens → null");
	// A genuine zero is preserved (distinct from the null-absent case).
	assert.equal(
		summarizeToolSteps([{ toolCallCount: 0, usage: { totalTokens: 0 } }])
			.totalTokens,
		0,
		"a reported 0 stays 0, not null",
	);
	assert.deepEqual(summarizeToolSteps([]), {
		steps: 0,
		toolCalls: 0,
		totalTokens: null,
	});
}

// A fresh facet accumulator is all-null (the null-absent seed).
assert.deepEqual(emptyFacetTurnUsage(), {
	inputTokens: null,
	outputTokens: null,
	totalTokens: null,
});

// Auto Router receipts survive the AI SDK's provider metadata into the ledger.
{
	const payload = shapeStepTelemetry({
		providerMetadata: {
			cloudflareAutoRouter: {
				routedModel: " openai/gpt-5.6-luna ",
				routingReason: "quality_match",
				routingDecisionId: "decision-1",
				requestId: "request-1",
				ignored: "not allowlisted",
			},
		},
	});
	assert.deepEqual(payload.autoRouter, {
		routedModel: "openai/gpt-5.6-luna",
		routingReason: "quality_match",
		routingDecisionId: "decision-1",
		requestId: "request-1",
	});
	assert.equal(
		shapeStepTelemetry({ providerMetadata: { other: { model: "no" } } })
			.autoRouter,
		undefined,
	);
	assert.equal(
		shapeStepTelemetry({
			providerMetadata: { cloudflareAutoRouter: { ignored: "no" } },
		}).autoRouter,
		undefined,
	);
}

console.log("step-telemetry.test.ts: all assertions passed");

// Native provider elapsed times are rounded and reject invalid measurements.
assert.equal(shapeStepTelemetry({ stepNumber: 0 }, 12.6).durationMs, 13);
assert.equal(shapeStepTelemetry({ stepNumber: 0 }, -5).durationMs, 0);
assert.equal(
	shapeStepTelemetry({ stepNumber: 0 }, Number.NaN).durationMs,
	null,
);
