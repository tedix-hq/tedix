import assert from "node:assert/strict";
import { chatTurnProbe } from "../test/tedi-do";

// The Code Mode batching note is part of the system prompt every chat turn
// sends to the model.
const probe = chatTurnProbe({
	async facetTurn() {
		return { assistantText: "ok" };
	},
});
await probe.run({ text: "hello" });
const system = probe.facetInputs[0]?.system ?? "";

assert.match(
	system,
	/the active runtime and plan policy/,
	"the model-facing budget guidance must follow effective policy",
);
assert.match(
	system,
	/reserves the final permitted round/,
	"the model must preserve a final synthesis round",
);
assert.match(
	system,
	/Batch aggressively/,
	"the note must retain batching guidance",
);
assert.doesNotMatch(
	system,
	/typically\s+10|fixed number of provider rounds/i,
	"the note must not reintroduce a fixed ten-round claim",
);

console.log("Code Mode batching note follows effective loop policy");
