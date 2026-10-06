/**
 * Structural guard for the single post-turn memory-effects dispatcher.
 *
 * A lean-context turn — blind verification (`evidence:judge:*`) or lean
 * workflow synthesis (`workflow:synth:*`) — must leave ZERO traces in the
 * tedi's learning surfaces (brain bridge, daily narrative log). That guarantee
 * is structural: every turn surface fans out through ONE dispatcher whose
 * first act is the lean-session gate — no per-surface vigilance checks.
 */
import assert from "node:assert/strict";
import {
	isBlindVerificationSession,
	isLeanContextSession,
	isWorkflowSynthesisSession,
} from "@tedix/api-contract/utils/runtime-identity";
import { chatTurnProbe, memoryStorage, tediDo } from "../test/tedi-do";
import { AgentTediDO } from "./do";

// The gate itself: evidence:judge:* is blind, workflow:synth:* is lean
// synthesis, and BOTH are lean-context; ordinary sessions are neither.
assert.equal(isBlindVerificationSession("evidence:judge:claim-42"), true);
assert.equal(isBlindVerificationSession("agent:main:main"), false);
assert.equal(
	isWorkflowSynthesisSession("workflow:synth:grounding-review:r1"),
	true,
);
assert.equal(isWorkflowSynthesisSession("agent:main:main"), false);
assert.equal(isWorkflowSynthesisSession("grounding-review:r1"), false);
assert.equal(isLeanContextSession("evidence:judge:claim-42"), true);
assert.equal(isLeanContextSession("workflow:synth:grounding-review:r1"), true);
assert.equal(
	isLeanContextSession("work-evidence-review:work-1:evidence-1"),
	false,
);
assert.equal(isLeanContextSession("agent:main:main"), false);

// The dispatcher: the lean-session gate comes first; ordinary turns queue
// the brain bridge (or await it for workflow ordering) and log the pair.
function dispatcherProbe() {
	const effects: string[] = [];
	const agent = tediDo({
		state: { tediId: "tedi-1", pendingDailyEntries: [] },
		setState(next: unknown) {
			agent.state = next;
		},
		toolCallRefsForRun: () => [],
		toolExecutionEvidenceForRun: () => [],
		async queue(callback: string) {
			effects.push(`queue:${callback}`);
		},
		async onBridgeTurn() {
			effects.push("await:onBridgeTurn");
		},
	});
	return { agent, effects };
}
const turn = (sessionKey: string) => ({
	user: { role: "user", content: "q", sessionKey, ts: 1 },
	assistant: { role: "assistant", content: "a", sessionKey, ts: 2 },
	runId: "run-1",
	origin: "chat",
	sessionKey,
});
for (const sessionKey of [
	"evidence:judge:claim-42",
	"workflow:synth:grounding-review:r1",
]) {
	const probe = dispatcherProbe();
	await probe.agent.dispatchTurnMemoryEffects(turn(sessionKey));
	await probe.agent.dispatchTurnMemoryEffects({
		...turn(sessionKey),
		awaitBridge: true,
	});
	assert.deepEqual(probe.effects, [], `${sessionKey} leaves no learning trace`);
	assert.deepEqual(probe.agent.state.pendingDailyEntries, []);
}
{
	const probe = dispatcherProbe();
	await probe.agent.dispatchTurnMemoryEffects(turn("agent:main:main"));
	await probe.agent.dispatchTurnMemoryEffects({
		...turn("agent:main:main"),
		runId: "run-2",
		awaitBridge: true,
		dailyLog: false,
	});
	assert.deepEqual(probe.effects, ["queue:onBridgeTurn", "await:onBridgeTurn"]);
	assert.equal(probe.agent.state.pendingDailyEntries.length, 2);
	assert.deepEqual(
		["run-1:memory", "run-2:memory"].map(
			(id) => probe.agent.runtimeAdmission().gate.claim(id)?.principalId,
		),
		["tedi-1", "tedi-1"],
		"distinct operations retain the original tedi principal",
	);
	await assert.rejects(
		probe.agent.dispatchTurnMemoryEffects({
			...turn("agent:main:main"),
			user: { ...turn("agent:main:main").user, content: "changed original" },
		}),
		/Unit accepted input changed/,
	);
	assert.deepEqual(probe.effects, ["queue:onBridgeTurn", "await:onBridgeTurn"]);
}

// Every turn surface fans out through that one dispatcher, so a lean session
// leaves no trace on any of them while an ordinary one reaches the bridge.
const bridged = (queued: Array<{ callback: string }>) =>
	queued.some((entry) => entry.callback === "onBridgeTurn");
const realDispatcher = {
	dispatchTurnMemoryEffects:
		AgentTediDO.prototype["dispatchTurnMemoryEffects" as keyof AgentTediDO],
	toolCallRefsForRun: () => [],
	toolExecutionEvidenceForRun: () => [],
	enqueueDailyLogPair() {},
};
for (const [sessionKey, expected] of [
	["workflow:synth:report", false],
	["agent:main:main", true],
] as const) {
	// Tedix OS SSE turn.
	const sse = chatTurnProbe({
		async facetTurn() {
			return { assistantText: "ok" };
		},
		fields: realDispatcher,
	});
	await sse.run({ sessionKey, text: "hello" });
	assert.equal(bridged(sse.queued), expected, `SSE ${sessionKey}`);

	// Durable workflow commit (awaits the bridge instead of queueing it).
	let awaited = false;
	const commit = tediDo({
		...realDispatcher,
		ctx: { storage: memoryStorage() },
		mcpRuntime: null,
		async ensureIdentity() {},
		sessionHarness: { appendTurn: async () => true },
		broadcast() {},
		async onLedgerMirror() {},
		async onBridgeTurn() {
			awaited = true;
		},
		enqueueCompaction() {},
	});
	await commit.commitAssistantTurnImpl({
		sessionKey,
		runId: "run-1",
		conversationId: "conversation",
		userTs: 1,
		userText: "hello",
		assistantText: "done",
		stopReason: "stop",
		toolCalls: [],
	});
	assert.equal(awaited, expected, `workflow commit ${sessionKey}`);
}

console.log("memory-effects-dispatcher OK");
