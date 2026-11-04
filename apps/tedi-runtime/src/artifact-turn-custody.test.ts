import assert from "node:assert/strict";
import { tediDo } from "../test/tedi-do";
import type { ActiveTurnBinding } from "./runtime-state";
import type { HttpPlatformClient } from "./brain/platform-client";
import type { RecordArtifactInput } from "@tedix/api-contract/schemas/cognitive-runtime";

let release = () => {};
const identityReady = new Promise<void>((resolve) => {
	release = resolve;
});
const recorded: { owner: string; input: RecordArtifactInput }[] = [];
function binding(owner: string): ActiveTurnBinding {
	return {
		runId: `run-${owner}`,
		conversationId: `conversation-${owner}`,
		platform: {
			recordArtifact: async (input: RecordArtifactInput) => {
				recorded.push({ owner, input });
				return { artifact: {} };
			},
		} as unknown as HttpPlatformClient,
	};
}
const a = binding("a");
const b = binding("b");
const agent = tediDo({
	state: { tediId: "tedi-example" },
	env: { TEDI_STORAGE: {} },
	ensureIdentity: async () => identityReady,
	activeTurnBinding: b,
	getPlatformClient: async () => {
		assert.fail("must use the captured turn client");
	},
});
const options = { toolCallId: "artifact", messages: [], context: undefined };
const toolsA = agent.objectStoreAiTools(a);
const toolsB = agent.objectStoreAiTools(b);
const first = toolsA.record_artifact!.execute!(
	{ name: "report.md", content: "a" },
	options,
);
const second = toolsB.record_artifact!.execute!(
	{ name: "report.md", content: "b" },
	options,
);
agent.activeTurnBinding = a;
release();
await Promise.all([first, second]);
assert.equal(recorded.length, 2);
for (const { owner, input } of recorded) {
	assert.equal(input.tediId, "tedi-example");
	assert.equal(input.runId, `run-${owner}`);
	assert.equal(input.conversationId, `conversation-${owner}`);
	assert.equal(input.content, owner);
	assert.equal(input.id, `run-${owner}:artifact:v2:deliverable:report.md`);
}
assert.deepEqual(
	await agent.objectStoreAiTools(null).record_artifact!.execute!(
		{ name: "report.md", content: "unbound" },
		options,
	),
	{ ok: false, error: "artifact_turn_context_unavailable" },
);
assert.equal(recorded.length, 2);
