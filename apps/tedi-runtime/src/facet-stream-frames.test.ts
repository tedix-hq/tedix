/**
 * Unit coverage for the facet→parent NDJSON frame parser and the SSE frame-parity contract: every facet frame kind maps
 * 1:1 onto the Tedix OS's bespoke `{kind:"delta"|"done"|"error"}` protocol.
 */
import assert from "node:assert/strict";
import { parseFacetStreamFrames } from "./facet-stream-frames";

// Whole frames parse in order; partial trailing line carries over as rest.
{
	const { frames, rest } = parseFacetStreamFrames(
		'{"kind":"delta","text":"Hel"}\n{"kind":"delta","text":"lo"}\n{"kind":"do',
	);
	assert.equal(frames.length, 2);
	assert.deepEqual(frames[0], { kind: "delta", text: "Hel" });
	assert.deepEqual(frames[1], { kind: "delta", text: "lo" });
	assert.equal(rest, '{"kind":"do');
}

// The carried rest completes on the next chunk (incremental reads).
{
	const first = parseFacetStreamFrames('{"kind":"do');
	const second = parseFacetStreamFrames(
		`${first.rest}ne","requestId":"r1","text":"Hello","turnCount":3,"turnMs":42}\n`,
	);
	assert.equal(second.frames.length, 1);
	const done = second.frames[0];
	assert.ok(done, "terminal frame parsed from carried rest");
	assert.equal(done?.kind, "done");
	if (done?.kind === "done") {
		assert.equal(done.text, "Hello");
		assert.equal(done.turnCount, 3);
	}
}

// Malformed and unknown-kind lines are dropped, never thrown.
{
	const { frames } = parseFacetStreamFrames(
		'not json\n{"kind":"mystery"}\n{"kind":"error","message":"boom"}\n\n',
	);
	assert.equal(frames.length, 1);
	assert.deepEqual(frames[0], { kind: "error", message: "boom" });
}

// SSE frame parity: the facet frame kinds are exactly the Tedix OS protocol kinds.
{
	const kinds = new Set(
		parseFacetStreamFrames(
			'{"kind":"delta","text":"x"}\n{"kind":"done","requestId":null,"text":"x","turnCount":1,"turnMs":1}\n{"kind":"error","message":"m"}\n',
		).frames.map((frame) => frame.kind),
	);
	assert.deepEqual([...kinds].sort(), ["delta", "done", "error"]);
}

// WS-parity: the `chunk` frame carries the raw AI SDK chunk body (tool/data
// parts) and must survive the parser so tool chips stream over SSE.
{
	const { frames } = parseFacetStreamFrames(
		'{"kind":"chunk","body":"{\\"type\\":\\"tool-input-start\\",\\"toolCallId\\":\\"t1\\",\\"toolName\\":\\"grep\\"}"}\n{"kind":"delta","text":"hi"}\n',
	);
	assert.equal(frames.length, 2);
	assert.equal(frames[0]?.kind, "chunk");
	assert.equal(
		(frames[0] as { kind: "chunk"; body: string }).body,
		'{"type":"tool-input-start","toolCallId":"t1","toolName":"grep"}',
	);
}

console.log("facet-stream-frames OK");
