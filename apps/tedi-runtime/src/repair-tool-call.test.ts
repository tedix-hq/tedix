import assert from "node:assert/strict";
import {
	repairMalformedToolCall,
	repairToolCallInput,
} from "./repair-tool-call";

// --- repairToolCallInput: the structural manglings we actually repair ---

// A plain object that is already well formed has nothing to repair; returning
// undefined leaves the SDK's original validation error intact.
assert.equal(repairToolCallInput("list_skills", { limit: 10 }), undefined);

// Arguments emitted as a JSON string instead of an object.
assert.deepEqual(repairToolCallInput("list_skills", '{"limit":10}'), {
	limit: 10,
});

// Arguments wrapped in a markdown code fence.
assert.deepEqual(
	repairToolCallInput("list_skills", '```json\n{"limit": 10}\n```'),
	{ limit: 10 },
);

// A bare fence with no language tag.
assert.deepEqual(repairToolCallInput("list_skills", '```\n{"a":1}\n```'), {
	a: 1,
});

// Trailing commentary after a complete object.
assert.deepEqual(
	repairToolCallInput("list_skills", '{"limit": 10}\n\nHope that helps!'),
	{ limit: 10 },
);

// Double-encoded JSON (a JSON string whose value is itself JSON).
assert.deepEqual(repairToolCallInput("list_skills", '"{\\"limit\\":10}"'), {
	limit: 10,
});

// Envelope keys the model sometimes adds around the real arguments.
for (const key of ["input", "arguments", "args", "parameters"]) {
	assert.deepEqual(
		repairToolCallInput("list_skills", { [key]: { limit: 10 } }),
		{ limit: 10 },
		`envelope key ${key} should unwrap`,
	);
}

// The tool's own name as the envelope key.
assert.deepEqual(
	repairToolCallInput("list_skills", { list_skills: { limit: 10 } }),
	{ limit: 10 },
);

// A single-key object whose key is NOT an envelope name is left alone — a tool
// may genuinely take one object-valued field.
assert.equal(
	repairToolCallInput("record_skill", { skill: { name: "x" } }),
	undefined,
);

// Braces inside string literals must not end the balanced scan early.
assert.deepEqual(
	repairToolCallInput("record_skill", '{"body":"a } b"} trailing'),
	{ body: "a } b" },
);

// Escaped quotes inside strings must not desynchronize the scan.
assert.deepEqual(
	repairToolCallInput("record_skill", '{"body":"say \\"hi\\""} tail'),
	{ body: 'say "hi"' },
);

// Unrepairable inputs yield undefined rather than a wrong guess.
assert.equal(repairToolCallInput("list_skills", "not json at all"), undefined);
assert.equal(repairToolCallInput("list_skills", "[1,2,3]"), undefined);
assert.equal(repairToolCallInput("list_skills", 42), undefined);
assert.equal(repairToolCallInput("list_skills", null), undefined);

// --- repairMalformedToolCall: the SDK-shaped handler ---

const call = {
	type: "tool-call" as const,
	toolCallId: "call_1",
	toolName: "list_skills",
	input: '```json\n{"limit": 10}\n```',
};

const repaired = await repairMalformedToolCall({
	toolCall: call,
	error: { name: "AI_InvalidToolInputError" },
});
assert.ok(repaired, "fenced arguments should repair");
// The SDK contract is a stringified JSON object, not a parsed one.
assert.equal(typeof repaired.input, "string");
assert.deepEqual(JSON.parse(repaired.input as string), { limit: 10 });
// Identity fields must survive the repair.
assert.equal(repaired.toolCallId, "call_1");
assert.equal(repaired.toolName, "list_skills");

// A tool we do not serve is a routing problem, not a formatting one.
assert.equal(
	await repairMalformedToolCall({
		toolCall: { ...call, toolName: "nope" },
		error: { name: "AI_NoSuchToolError" },
	}),
	null,
);

// Already-valid JSON arrives here only because the tool SCHEMA rejected it, not
// the parser. The repair re-emits the same arguments, so the second validation
// fails the same way and the original error is what surfaces.
const passthrough = await repairMalformedToolCall({
	toolCall: { ...call, input: '{"limit":10}' },
	error: { name: "AI_InvalidToolInputError" },
});
assert.ok(passthrough);
assert.deepEqual(JSON.parse(passthrough.input as string), { limit: 10 });

console.log(
	"✓ repair-tool-call: fences, double encoding, envelopes, and bounds",
);
