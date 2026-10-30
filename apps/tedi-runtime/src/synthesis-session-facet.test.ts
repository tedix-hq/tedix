import {
	modelCatalogEntry,
	modelCatalogConfig,
} from "@tedix/api-contract/test/model-catalog";
const fixtureCatalog = modelCatalogConfig([
	modelCatalogEntry("azure-openai/gpt-6-astra", {
		reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
	}),
	modelCatalogEntry("azure-openai/gpt-6-luna", {}),
	modelCatalogEntry("workers-ai/@cf/openai/gpt-oss-120b", {
		maxOutputTokens: 16000,
	}),
	modelCatalogEntry("cloudflare/auto", {}),
]);
const selectChatModelForTurn = (
	...args: Parameters<typeof configured_selectChatModelForTurn>
) => {
	const values = [...args];
	values[8] ??= fixtureCatalog;
	return configured_selectChatModelForTurn(
		...(values as Parameters<typeof configured_selectChatModelForTurn>),
	);
};
/**
 * Structural guard for lean workflow synthesis (`workflow:synth:*`).
 *
 * The cost win depends on routing BEFORE general MCP turn preparation; a
 * nominal empty-tool call after the full catalog was assembled would preserve
 * almost all of the prompt overhead this cutover removes.
 */
import assert from "node:assert/strict";
import { facetRunnerProbe, facetWorkflowTurnProbe } from "../test/tedi-do";
import * as runtimeWorker from "./index";
import { ConversationFacet } from "./conversation-facet";
import { SynthesisSessionFacet } from "./synthesis-session-facet";
import { selectChatModelForTurn as configured_selectChatModelForTurn } from "./turn-model-selection";

// The real native Worker suite covers submission, durable accounting and tools.
// Keep the shared selector contract and parent routing guards here.
{
	const env = { AI: { run: async () => ({}) } };
	assert.deepEqual(
		selectChatModelForTurn(env as never, {
			modelRef: "workers-ai/@cf/openai/gpt-oss-120b",
		}).identity,
		{ provider: "workers-ai", model: "@cf/openai/gpt-oss-120b" },
	);
}

// Synthesis routes BEFORE general MCP/tool preparation in the workflow.
{
	const synthesized: Array<Record<string, unknown>> = [];
	const probe = facetWorkflowTurnProbe({
		fields: {
			async runSynthesisFacetTurn(input: Record<string, unknown>) {
				synthesized.push(input);
				return {
					assistantText: "summary",
					turnError: null,
					usage: { totalTokens: 4 },
					modelIdentity: { provider: "example", model: "small-review" },
				};
			},
		},
	});
	const reply = await probe.run({ sessionKey: "workflow:synth:report" });
	assert.deepEqual(reply.modelIdentity, {
		provider: "example",
		model: "small-review",
	});
	assert.equal(probe.prepared.length, 0, "synthesis skips MCP setup");
	assert.equal(probe.facetInputs.length, 0);
	assert.deepEqual(probe.commits[0]?.facetUsage, { totalTokens: 4 });
	assert.deepEqual(
		probe.commits[0]?.modelIdentity,
		reply.modelIdentity,
		"the settled receipt must retain the selected model for idempotent redelivery",
	);
	assert.equal(synthesized.length, 1, "workflow synthesis runs its facet");
}

// One run gets one isolated synthesis facet, even if a producer reuses its
// session key.
{
	const probe = facetRunnerProbe();
	for (const runId of ["run-a", "run-b", "run-a"]) {
		await probe.agent.runSynthesisFacetTurn({
			sessionKey: "workflow:synth:report",
			guardedUserText: "Summarize.",
			runId,
		});
	}
	const [a, b, again] = probe.facetNames;
	assert.notEqual(a, b);
	assert.equal(a, again);
	assert.match(a!, /^synth_/);
}

{
	const probe = facetRunnerProbe({
		fields: {
			modelOverrideForSurface: (surface: string) =>
				surface === "synthesis"
					? { modelRef: "azure-openai/gpt-6-luna" }
					: { modelRef: "azure-openai/gpt-6-astra" },
		},
	});
	const reply = await probe.agent.runSynthesisFacetTurn({
		sessionKey: "workflow:synth:review",
		guardedUserText: "Review the lane.",
		runId: "review-run",
	});
	assert.equal(probe.configs[0]?.modelRef, "azure-openai/gpt-6-luna");
	assert.deepEqual(reply.modelIdentity, {
		provider: "workers-ai",
		model: "judge-model",
	});
}

// ctx.exports must expose the facet class.
assert.equal(typeof runtimeWorker.SynthesisSessionFacet, "function");

console.log("synthesis-session-facet OK");
