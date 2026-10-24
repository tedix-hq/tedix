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

// A finished inline video leaves the rest of the response unread; the source
// must be canceled, not merely released.
{
	let cancels = 0;
	const open = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue(
					encoder.encode(
						'{"bytesBase64Encoded":"' + btoa("motion-video") + '","more":',
					),
				);
			},
			cancel() {
				cancels++;
			},
		},
		{ highWaterMark: 0 },
	);
	const decoded = vertexInlineVideoStream(open, 100);
	assert.equal(await new Response(decoded.readable).text(), "motion-video");
	await decoded.completed;
	assert.equal(cancels, 1);
	assert.equal(open.locked, false);
}

// A decode failure must also cancel the source.
{
	let pulls = 0;
	let cancels = 0;
	const open = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls++;
				if (pulls > 2) throw new Error("read past video size limit");
				controller.enqueue(
					encoder.encode(pulls === 1 ? '{"bytesBase64Encoded":"' : "AAAAAAAA"),
				);
			},
			cancel() {
				cancels++;
			},
		},
		{ highWaterMark: 0 },
	);
	const decoded = vertexInlineVideoStream(open, 3);
	await assert.rejects(new Response(decoded.readable).arrayBuffer());
	await assert.rejects(decoded.completed, /exceeds 3 byte limit/);
	assert.equal(pulls, 2);
	assert.equal(cancels, 1);
	assert.equal(open.locked, false);
}

// Canceling the decoded stream must stop upstream reading too.
{
	let cancels = 0;
	const open = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue(encoder.encode("AAAA"));
			},
			cancel() {
				cancels++;
			},
		},
		{ highWaterMark: 0 },
	);
	const decoded = vertexInlineVideoStream(open, 100);
	await decoded.readable.cancel();
	await assert.rejects(decoded.completed);
	assert.equal(cancels, 1);
	assert.equal(open.locked, false);
}

for (const cancelThrows of [false, true]) {
	let pulls = 0;
	let canceled = false;
	const unclosed = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls++;
				if (pulls > 3) throw new Error("read past video size limit");
				controller.enqueue(
					encoder.encode(pulls === 1 ? '{"bytesBase64Encoded":"' : "AAAA"),
				);
			},
			cancel() {
				canceled = true;
				if (cancelThrows) throw new Error("cancel failed");
			},
		},
		{ highWaterMark: 0 },
	);
	await assert.rejects(
		vertexInlineVideoByteLength(unclosed, 3),
		/Vertex video exceeds 3 byte limit/,
	);
	assert.equal(pulls, 3, "reject without waiting for the closing quote");
	assert.equal(canceled, true);
	assert.equal(unclosed.locked, false);
}

for (let size = 1; size <= 8; size++) {
	const exact = JSON.stringify({ bytesBase64Encoded: btoa("x".repeat(size)) });
	for (let split = 1; split < exact.length; split++) {
		assert.equal(
			await vertexInlineVideoByteLength(chunked(exact, split), size),
			size,
		);
	}
	await assert.rejects(
		vertexInlineVideoByteLength(chunked(exact, 24), size - 1),
		/Vertex video exceeds/,
	);
}

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

for (const state of [true, false]) {
	let cancels = 0;
	const open = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encoder.encode(`{"name":"op","done":${state},"response":{"videos":[`),
			);
		},
		cancel() {
			cancels++;
		},
	});
	assert.equal(await vertexOperationDone(open), state);
	assert.equal(cancels, 1, `done:${state} poll cancels the response stream`);
	assert.equal(open.locked, false);
}

assert.equal(decoder.decode(encoder.encode("round-trip")), "round-trip");
console.log("vertex inline video stream tests passed");
