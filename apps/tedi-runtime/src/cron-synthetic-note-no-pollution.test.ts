/**
 * Regression: a no-prose cron turn commits a SYNTHETIC terminal note only
 * to seal the named execution's success (ledger mirror + kernel-visible run
 * lifecycle). That boilerplate string is NOT genuine assistant cognition, so it
 * must NOT be fanned into the brain bridge, daily narrative log, or the
 * learning-conversion signal — the exact curation stores these cognitive crons
 * exist to tend. Each fire has a distinct runId (no content dedup), so without
 * the guard the identical note would accumulate across every fire.
 */
import assert from "node:assert/strict";
import { memoryStorage, tediDo } from "../test/tedi-do";

const cronInput = {
	sessionKey: "cron:reflect",
	runId: "tedi-1:cron:fire-1",
	conversationId: "conversation",
	userTs: 1,
	userText: "Run the reflection cycle.",
	trustedInstructionOrigin: "cron",
};

async function runCronTurn(assistantText: string) {
	const commits: Array<Record<string, unknown>> = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		activeTurnBinding: null,
		async ensureIdentity() {},
		async ensureModelPolicy() {},
		logDanglingTurnIfAny() {},
		sessionHarness: { appendTurn: async () => true },
		async prepareMcpFacetTurn() {
			return { system: "SYSTEM", tools: {}, turnBinding: null };
		},
		async runConversationFacetTurn() {
			return { assistantText, turnError: null };
		},
		effectiveStepCeiling: () => 40,
		clearActiveTurn() {},
		runHadFacetToolError: () => false,
		peekPendingToolSteps: () => [],
		async commitAssistantTurn(input: Record<string, unknown>) {
			commits.push(input);
		},
	});
	const result = await agent.runFacetWorkflowTurnImpl(cronInput);
	return { result, commits };
}

// --- 1. A no-prose cron turn still commits a terminal note (success seal)
//        and flags it synthetic; a genuine reply is not suppressed. ---
{
	const { result, commits } = await runCronTurn("");
	assert.equal(commits.length, 1);
	assert.match(
		String(commits[0]?.assistantText),
		/^Cron maintenance cycle completed/,
	);
	assert.equal(commits[0]?.suppressMemoryEffects, true);
	assert.equal(result.text, commits[0]?.assistantText);
}
{
	const { commits } = await runCronTurn("Consolidated 3 memories.");
	assert.equal(commits[0]?.assistantText, "Consolidated 3 memories.");
	assert.equal(commits[0]?.suppressMemoryEffects, false);
}

// --- 2. The commit gates the cognitive fan-out behind the flag, while the
//        ledger mirror (success seal) always runs. ---
async function commit(suppressMemoryEffects: boolean) {
	const calls: string[] = [];
	const agent = tediDo({
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		async ensureIdentity() {},
		sessionHarness: { appendTurn: async () => true },
		broadcast() {},
		toolCallRefsForRun: () => [],
		toolExecutionEvidenceForRun: () => [],
		async onLedgerMirror() {
			calls.push("ledger");
		},
		async dispatchTurnMemoryEffects() {
			calls.push("memory");
		},
		enqueueCompaction() {},
	});
	await agent.commitAssistantTurnImpl({
		...cronInput,
		assistantText: "note",
		stopReason: "stop",
		toolCalls: [],
		suppressMemoryEffects,
	});
	return calls;
}
assert.deepEqual(await commit(true), ["ledger"]);
assert.deepEqual(
	await commit(false),
	["memory", "ledger"],
	"enroll original memory work before the ledger seals its parent claim",
);

console.log("cron-synthetic-note-no-pollution.test.ts: all assertions passed");
