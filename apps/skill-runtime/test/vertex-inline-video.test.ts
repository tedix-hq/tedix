import assert from "node:assert/strict";
import {
	vertexInlineVideoByteLength,
	vertexInlineVideoStream,
	vertexOperationDone,
} from "../src/vertex-inline-video";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunked(value: string, at: number): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(value.slice(0, at)));
			controller.enqueue(encoder.encode(value.slice(at)));
			controller.close();
		},
	});
}

const payload = JSON.stringify({
	response: { videos: [{ bytesBase64Encoded: btoa("motion-video") }] },
});
const decoded = vertexInlineVideoStream(chunked(payload, 37), 100);
assert.equal(await new Response(decoded.readable).text(), "motion-video");
await decoded.completed;
assert.equal(
	await vertexInlineVideoByteLength(chunked(payload, 37), 100),
	"motion-video".length,
);
const prettyPayload =
	'{\n  "response": {\n    "videos": [{\n      "bytesBase64Encoded": "' +
	btoa("motion-video") +
	'"\n    }]\n  }\n}';
assert.equal(
	await new Response(
		vertexInlineVideoStream(chunked(prettyPayload, 42), 100).readable,
	).text(),
	"motion-video",
);
assert.equal(
	await vertexInlineVideoByteLength(chunked(prettyPayload, 42), 100),
	"motion-video".length,
);

const missing = vertexInlineVideoStream(
	chunked(JSON.stringify({ response: { videos: [] } }), 12),
	100,
);
await assert.rejects(new Response(missing.readable).arrayBuffer());
await assert.rejects(missing.completed);

const oversized = vertexInlineVideoStream(chunked(payload, 10), 3);
await assert.rejects(new Response(oversized.readable).arrayBuffer());
await assert.rejects(oversized.completed);

assert.equal(
	await vertexOperationDone(
		chunked('{"name":"op","done":true,"response":{"videos":["', 19),
	),
	true,
);
assert.equal(await vertexOperationDone(chunked('{"done":false}', 6)), false);
assert.equal(
	await vertexOperationDone(
		chunked('{\n  "done": true,\n  "response": {}', 14),
	),
	true,
);

assert.equal(decoder.decode(encoder.encode("round-trip")), "round-trip");
console.log("vertex inline video stream tests passed");
