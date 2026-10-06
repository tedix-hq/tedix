import assert from "node:assert/strict";
import { ModelGenerationPolicySchema } from "@tedix/api-contract/schemas/model-generation";
import {
	configureFacetGeneration,
	FACET_GENERATION_SETTINGS,
	resolveFacetGeneration,
	supportsReasoningNone,
} from "./facet-generation-settings";
import { generationForSurface, normalizeModelPolicy } from "./model-policy";

const terra = { provider: "azure-openai", model: "gpt-5.6-terra" } as const;
assert.deepEqual(resolveFacetGeneration(terra).turnConfig, {
	maxOutputTokens: 16_000,
	providerOptions: { azure: { reasoningEffort: "medium" } },
});
const policy = normalizeModelPolicy({
	chatModelRef: "cloudflare/auto",
	cronModelRef: "cloudflare/auto",
	observerModelRef: "cloudflare/auto",
	generation: {
		chat: { reasoningEffort: "high", maxOutputTokens: 32_000 },
		cron: { reasoningEffort: "low" },
	},
});
assert.deepEqual(generationForSurface(policy, "cron"), {
	reasoningEffort: "low",
	maxOutputTokens: 32_000,
});
assert.deepEqual(generationForSurface(policy, "observer"), {});
const restored = JSON.parse(
	JSON.stringify(generationForSurface(policy, "chat")),
);
assert.deepEqual(
	configureFacetGeneration(
		{ runId: "run", generation: restored },
		{ runId: "run", generation: { reasoningEffort: "low" } },
	),
	restored,
);
assert.deepEqual(
	configureFacetGeneration(
		{ runId: "run", generation: restored },
		{ runId: "next", generation: { reasoningEffort: "low" } },
	),
	{ reasoningEffort: "low" },
);
assert.equal(
	resolveFacetGeneration(terra, restored).resolved.reasoningEffort,
	"high",
);
assert.deepEqual(
	resolveFacetGeneration(terra, restored, {
		maxOutputTokens: 1500,
		reasoningEffort: "none",
	}).resolved,
	{
		...terra,
		maxOutputTokens: 1500,
		reasoningEffort: "none",
	},
);
assert.throws(() =>
	ModelGenerationPolicySchema.parse({ chat: { thinking: "high" } }),
);
assert.throws(() => resolveFacetGeneration(terra, { maxOutputTokens: 0 }));
assert.throws(() =>
	resolveFacetGeneration(terra, { maxOutputTokens: 128_001 }),
);
assert.throws(
	() =>
		resolveFacetGeneration(
			{ ...terra, model: "unknown" },
			{ maxOutputTokens: 32_000 },
		),
	/limit/,
);
assert.throws(
	() =>
		resolveFacetGeneration(
			{ provider: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct" },
			{ reasoningEffort: "high" },
		),
	/unsupported/,
);
assert.deepEqual(
	resolveFacetGeneration(
		{ provider: "workers-ai", model: "@cf/meta/llama-3.2-3b-instruct" },
		{ reasoningEffort: "none", maxOutputTokens: 1500 },
	).turnConfig,
	{ maxOutputTokens: 1500 },
);
// A reasoning-capable Workers AI model cannot take an effort on the wire, so
// "none" resolves to no option instead of failing the turn (the embedded
// widget sends "none" on every turn, including Azure-circuit fallbacks).
assert.deepEqual(
	resolveFacetGeneration(
		{ provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
		{ reasoningEffort: "none" },
	).turnConfig,
	{ maxOutputTokens: FACET_GENERATION_SETTINGS.maxOutputTokens },
);
assert.throws(
	() =>
		resolveFacetGeneration(
			{ provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
			{ reasoningEffort: "low" },
		),
	/unsupported/,
);
assert.equal(
	resolveFacetGeneration({ ...terra, model: "unknown" }).resolved
		.reasoningEffort,
	null,
);

// The native provider dispatch applies the same resolved policy; actual call
// options and request accounting are checked in native-facet.workerd.test.ts.
{
	const resolved = resolveFacetGeneration(
		terra,
		{},
		{ reasoningEffort: "high", maxOutputTokens: 20_000 },
	);
	assert.equal(resolved.turnConfig.maxOutputTokens, 20_000);
	assert.deepEqual(resolved.turnConfig.providerOptions, {
		azure: { reasoningEffort: "high" },
	});
	assert.equal("reasoning" in resolved.turnConfig, false);
}
console.log(
	"Generation policy: inheritance, overrides, restore and unsupported settings pass",
);

assert.deepEqual(
	resolveFacetGeneration(
		{ provider: "workers-ai", model: "cloudflare/auto" },
		{ reasoningEffort: "high" },
	).turnConfig,
	{
		maxOutputTokens: FACET_GENERATION_SETTINGS.maxOutputTokens,
		providerOptions: { cloudflareAutoRouter: { reasoningEffort: "high" } },
	},
);

for (const model of ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
	assert.equal(
		resolveFacetGeneration(
			{ provider: "azure-openai", model },
			{ maxOutputTokens: 128_000 },
		).resolved.maxOutputTokens,
		128_000,
	);
}
for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
	assert.equal(supportsReasoningNone(`azure-openai/${model}`), false);
	assert.throws(
		() =>
			resolveFacetGeneration(
				{ provider: "azure-openai", model },
				{ reasoningEffort: "none" },
			),
		/none is unsupported/,
	);
	assert.equal(
		resolveFacetGeneration(
			{ provider: "azure-openai", model },
			{ reasoningEffort: "low" },
		).resolved.reasoningEffort,
		"low",
	);
}
assert.equal(supportsReasoningNone("azure-openai/gpt-6-luna"), true);
assert.equal(
	resolveFacetGeneration(
		{ provider: "azure-openai", model: "gpt-6-luna" },
		{ reasoningEffort: "none" },
	).resolved.reasoningEffort,
	"none",
);
