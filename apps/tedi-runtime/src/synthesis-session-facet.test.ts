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
import { selectChatModelForTurn } from "./turn-model-selection";

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
				};
			},
		},
	});
	await probe.run({ sessionKey: "workflow:synth:report" });
	assert.equal(probe.prepared.length, 0, "synthesis skips MCP setup");
	assert.equal(probe.facetInputs.length, 0);
	assert.deepEqual(probe.commits[0]?.facetUsage, { totalTokens: 4 });
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

// ctx.exports must expose the facet class.
assert.equal(typeof runtimeWorker.SynthesisSessionFacet, "function");

console.log("synthesis-session-facet OK");
