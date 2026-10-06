import assert from "node:assert/strict";
import { chatTurnProbe } from "../test/tedi-do";
import {
	createRuntimePhaseTracker,
	runtimeToolPhase,
} from "./chat-runtime-phase";

assert.deepEqual(
	runtimeToolPhase(
		JSON.stringify({ type: "tool-input-start", toolName: "search_orders" }),
	),
	{ kind: "phase", phase: "using_tool", detail: "search_orders" },
);
assert.equal(runtimeToolPhase('{"type":"text-delta"}'), null);
assert.equal(runtimeToolPhase("not-json"), null);

// The loop starts in planning; generating is stamped only when text begins.
// Emitting generating when the loop starts would show "writing the answer"
// before any tool ran.
const phases = (chunks: Record<string, unknown>[]): string[] => {
	const tracker = createRuntimePhaseTracker();
	const out = [tracker.start().phase];
	for (const chunk of chunks) {
		const phase = tracker.read(JSON.stringify(chunk));
		if (phase) out.push(phase.phase);
	}
	return out;
};

// Tool-first turn: never generating before the tool.
assert.deepEqual(
	phases([
		{ type: "start" },
		{ type: "start-step" },
		{ type: "tool-input-start", toolName: "search_orders" },
		{ type: "tool-input-delta", inputTextDelta: "{" },
		{ type: "tool-output-available" },
		{ type: "text-start" },
		{ type: "text-delta", delta: "Found" },
		{ type: "text-delta", delta: " 3" },
		{ type: "finish" },
	]),
	["planning", "using_tool", "generating"],
);

// Narrate-then-act: generating precedes the tool, and returns after it.
assert.deepEqual(
	phases([
		{ type: "text-start" },
		{ type: "text-delta", delta: "Let me check" },
		{ type: "tool-input-start", toolName: "search_orders" },
		{ type: "text-start" },
		{ type: "text-delta", delta: "Done" },
	]),
	["planning", "generating", "using_tool", "generating"],
);

// No text-start frame: the first delta stamps generating, later ones do not.
assert.deepEqual(
	phases([
		{ type: "text-delta", delta: "a" },
		{ type: "text-delta", delta: "b" },
	]),
	["planning", "generating"],
);
assert.equal(createRuntimePhaseTracker().read("not-json"), null);

// A streamed turn stamps phases only through the tracker: preparing and
// finalizing bracket the tracker's planning → using_tool → generating.
{
	const probe = chatTurnProbe({
		async facetTurn(input) {
			for (const chunk of [
				{ type: "start" },
				{ type: "tool-input-start", toolName: "search_orders" },
				{ type: "text-start" },
				{ type: "text-delta", delta: "Found 3" },
			]) {
				input.onChunk(JSON.stringify(chunk));
			}
			input.onDelta("Found 3");
			return { assistantText: "Found 3" };
		},
	});
	const { frames } = await probe.run({ text: "find orders" });
	assert.deepEqual(
		frames
			.filter((frame) => frame.kind === "phase")
			.map((frame) => frame.phase),
		["preparing_context", "planning", "using_tool", "generating", "finalizing"],
	);
}

console.log("chat-runtime-phase OK");
