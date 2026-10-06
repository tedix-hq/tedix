/**
 * Structural guard for the facet-per-conversation judge turn.
 *
 * The cutover is UNGATED production behavior: every blind verification turn
 * (`evidence:judge:*`) runs on its own Pi facet. These assertions pin the
 * invariants that make that safe: structural blindness (tool-free Pi
 * facet, per-conversation history), parent-owned ledger, shared model
 * selection, fail-soft hydration, and the complete removal of the pilot
 * flag/scaffolding.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { facetRunnerProbe, facetWorkflowTurnProbe } from "../test/tedi-do";
import * as runtimeWorker from "./index";
import { JudgeSessionFacet } from "./judge-session-facet";
import {
	selectChatModelForTurn,
	selectJudgeModelForTurn,
} from "./turn-model-selection";
import { wrapUntrustedInput } from "./untrusted-input";

const JUDGE_IDENTITY = { provider: "azure-openai", model: "judge-model" };

const here = import.meta.dirname;
const wranglerSource = readFileSync(join(here, "..", "wrangler.jsonc"), "utf8");
const isPublicExport = !existsSync(
	join(here, "../../..", "scripts/oss/public-files.json"),
);

// --- every blind verification turn routes to the judge facet ---
{
	const judged: Array<Record<string, unknown>> = [];
	const probe = facetWorkflowTurnProbe({
		fields: {
			async runJudgeFacetTurn(input: Record<string, unknown>) {
				probe.order.push("judge");
				judged.push(input);
				return {
					assistantText: "verdict: supported",
					turnError: null,
					modelIdentity: JUDGE_IDENTITY,
				};
			},
		},
	});
	const result = await probe.run({
		sessionKey: "evidence:judge:claim-1",
		userText: "Is the claim supported?",
	});
	assert.equal(probe.facetInputs.length, 0, "never the general tool facet");
	assert.equal(probe.prepared.length, 0, "no tool surface is prepared");
	assert.equal(
		judged[0]?.guardedUserText,
		wrapUntrustedInput("Is the claim supported?", "mcp"),
	);
	// Parent-owned ledger: the user append precedes the facet branch.
	assert.deepEqual(
		probe.order.map((entry) => entry.split(":")[0]),
		["append", "judge", "commit"],
	);
	assert.deepEqual(result.modelIdentity, JUDGE_IDENTITY);
}

// --- the durable workflow path keeps the same judge boundary ---
{
	const probe = facetWorkflowTurnProbe({
		fields: {
			async runJudgeFacetTurn() {
				return {
					assistantText: "verdict: refuted",
					turnError: null,
					modelIdentity: JUDGE_IDENTITY,
				};
			},
		},
	});
	const result = await probe.run({ sessionKey: "evidence:judge:claim-2" });
	assert.equal(probe.facetInputs.length, 0);
	assert.deepEqual(probe.commits[0]?.modelIdentity, JUDGE_IDENTITY);
	assert.deepEqual(result.modelIdentity, JUDGE_IDENTITY);
}

// --- the judge runner: first-turn hydration only, fail-soft errors ---
{
	const judge = {
		sessionKey: "evidence:judge:c",
		runId: "judge-run-c",
		guardedUserText: "claim",
		userTs: 1,
	};
	const first = facetRunnerProbe({ priorTurnCount: 0 });
	await first.agent.runJudgeFacetTurn(judge);
	const original = first.agent.runtimeAdmission().gate.claim(judge.runId);
	assert.equal(original.sessionKey, judge.sessionKey);
	assert.equal(original.principalId, "tedi-1");
	await assert.rejects(
		first.agent.runtimeAdmission().beginAcceptedTurn({
			runId: judge.runId,
			sessionKey: judge.sessionKey,
			principalId: "tedi-1",
			input: { ...judge, guardedUserText: "changed claim" },
			expectedGeneration: 1,
		}),
		/Unit accepted input changed/,
	);
	assert.match(
		first.calls[1]!,
		/^judge:Prior turns[\s\S]*earlier question[\s\S]*claim$/,
	);
	const later = facetRunnerProbe({ priorTurnCount: 2 });
	await later.agent.runJudgeFacetTurn(judge);
	assert.equal(later.calls[1], "judge:claim");
	const failed = facetRunnerProbe({ fail: true });
	assert.deepEqual(await failed.agent.runJudgeFacetTurn(judge), {
		assistantText: "",
		turnError: "facet evicted",
	});
}

// Worker entry export so ctx.exports resolves the facet class.
assert.equal(typeof runtimeWorker.JudgeSessionFacet, "function");

assert.doesNotMatch(
	wranglerSource,
	/TEDI_FACET_SESSIONS/,
	"the pilot flag must be removed from every wrangler env block",
);

// Native Worker fixtures exercise the real tool-free durable loop. This source
// test retains parent routing and the authoritative model selector contracts.
{
	const pinned = {
		TEDI_JUDGE_MODEL_REF: "workers-ai/@cf/openai/gpt-oss-120b",
		AI: { run: async () => ({}) },
	};
	assert.deepEqual(selectJudgeModelForTurn(pinned as never).identity, {
		provider: "workers-ai",
		model: "@cf/openai/gpt-oss-120b",
	});
	assert.throws(
		() =>
			selectJudgeModelForTurn({ TEDI_JUDGE_MODEL_REF: "nope/model" } as never),
		/Invalid TEDI_JUDGE_MODEL_REF/,
	);
	const unpinned = {
		AZURE_OPENAI_RESOURCE: "fixture",
		AZURE_OPENAI_API_VERSION: "fixture",
		AZURE_CHAT_DEPLOYMENT: "fixture",
		AI_GATEWAY_ACCOUNT_ID: "fixture",
		AI_GATEWAY_LLM_ID: "fixture",
		CF_AI_GATEWAY_TOKEN: "fixture",
		AI: { run: async () => ({}) },
	};
	assert.deepEqual(selectJudgeModelForTurn(unpinned as never).identity, {
		provider: "workers-ai",
		model: "cloudflare/auto",
	});
}
// Derived from the file rather than hard-coded: the count is the ASSERTION
// ("every env pins the judge model"), not a constant. A literal silently
// becomes wrong the moment an env is added or retired — it broke when the
// staging env was removed, which is exactly the drift this should catch.
const varsBlockCount = wranglerSource.match(/"vars"\s*:\s*\{/g)?.length ?? 0;
assert.ok(
	varsBlockCount > 0,
	"the wrangler config must declare at least one vars block",
);
assert.equal(
	wranglerSource.match(
		isPublicExport
			? /"TEDI_JUDGE_MODEL_REF": "configured-via-private-overlay"/g
			: /"TEDI_JUDGE_MODEL_REF": "cloudflare\/auto"/g,
	)?.length,
	varsBlockCount,
	"every wrangler env block defaults the judge to Auto Router",
);
console.log("judge-session-facet OK");
