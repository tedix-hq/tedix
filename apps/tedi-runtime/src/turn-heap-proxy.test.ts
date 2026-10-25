import assert from "node:assert/strict";
import { payloadSize, TurnHeapProxy } from "./turn-heap-proxy";
import { shapeStepTelemetry } from "./step-telemetry";

assert.deepEqual(payloadSize({ text: "Aé😀", binary: new Uint8Array(3) }), {
	chars: 4,
	bytes: 10,
});
const cyclic: Record<string, unknown> = { text: "abc" };
cyclic.self = cyclic;
assert.deepEqual(payloadSize(cyclic), { chars: 3, bytes: 3 });
const heap = new TurnHeapProxy();
heap.promptChars = 123;
const releaseA = heap.holdToolResult("abcd");
const releaseB = heap.holdToolResult("é");
assert.deepEqual(heap.snapshot(), {
	promptChars: 123,
	inFlightToolResultBytes: 6,
	peakInFlightToolResultBytes: 6,
});
releaseA();
releaseB();
assert.deepEqual(heap.snapshot(), {
	promptChars: 123,
	inFlightToolResultBytes: 0,
	peakInFlightToolResultBytes: 6,
});
assert.deepEqual(
	shapeStepTelemetry({ heapProxy: heap.snapshot() }).heapProxy,
	heap.snapshot(),
);
console.log("turn-heap-proxy OK");
