import assert from "node:assert/strict";
import {
	createToolInputProgress,
	measureToolInputDelta,
} from "./chat-tool-input-progress";

const progress = createToolInputProgress();
const frame = (chunk: Record<string, unknown>) =>
	progress.read(JSON.stringify(chunk));

assert.deepEqual(frame({ type: "tool-input-start", toolCallId: "call-1" }), {
	kind: "tool_input",
	toolCallId: "call-1",
	chars: 0,
});
assert.deepEqual(
	frame({ type: "tool-input-delta", toolCallId: "call-1", delta: '{"q":' }),
	{ kind: "tool_input", toolCallId: "call-1", chars: 5 },
);
// The count accumulates; the argument text itself never appears in the frame.
assert.deepEqual(
	frame({ type: "tool-input-delta", toolCallId: "call-1", delta: '"oil"}' }),
	{ kind: "tool_input", toolCallId: "call-1", chars: 11 },
);
assert.equal(frame({ type: "text-delta", toolCallId: "call-1" }), null);
assert.equal(frame({ type: "tool-input-start" }), null);
assert.equal(progress.read("not-json"), null);

// A surrogate pair split across two deltas counts once, on arrival of the
// second half — never as two characters and never as one half of one.
const split = createToolInputProgress();
split.read(JSON.stringify({ type: "tool-input-start", toolCallId: "c" }));
assert.deepEqual(
	split.read(
		JSON.stringify({
			type: "tool-input-delta",
			toolCallId: "c",
			delta: `a${"\u{1f600}"[0]}`,
		}),
	),
	{ kind: "tool_input", toolCallId: "c", chars: 1 },
);
assert.deepEqual(
	split.read(
		JSON.stringify({
			type: "tool-input-delta",
			toolCallId: "c",
			delta: `${"\u{1f600}"[1]}b`,
		}),
	),
	{ kind: "tool_input", toolCallId: "c", chars: 3 },
);

assert.deepEqual(measureToolInputDelta("ab", false), { chars: 2, held: false });
assert.deepEqual(measureToolInputDelta("\u{1f600}", false), {
	chars: 1,
	held: false,
});
assert.deepEqual(measureToolInputDelta("\u{1f600}"[0]!, false), {
	chars: 0,
	held: true,
});
// An orphaned high surrogate whose pair never arrives is dropped, not counted.
assert.deepEqual(measureToolInputDelta("z", true), { chars: 1, held: false });

console.log("chat-tool-input-progress OK");
