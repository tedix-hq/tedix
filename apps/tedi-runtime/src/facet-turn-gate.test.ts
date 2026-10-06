import assert from "node:assert/strict";
import { FacetTurnGate } from "./facet-turn-gate";

const gate = new FacetTurnGate();
const order: string[] = [];
let releaseFirst!: () => void;
const firstBlocked = new Promise<void>((resolve) => {
	releaseFirst = resolve;
});

const first = gate.run(async () => {
	order.push("first:start");
	await firstBlocked;
	order.push("first:end");
	return "first";
});
const second = gate.run(async () => {
	order.push("second:start");
	order.push("second:end");
	return "second";
});

await Promise.resolve();
assert.deepEqual(order, ["first:start"], "the second task must not interleave");
releaseFirst();
assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
assert.deepEqual(order, [
	"first:start",
	"first:end",
	"second:start",
	"second:end",
]);

await assert.rejects(
	gate.run(async () => {
		throw new Error("expected");
	}),
	/expected/,
);
assert.equal(
	await gate.run(async () => "recovered"),
	"recovered",
	"a failed task must release the gate",
);

console.log("facet-turn-gate OK");

// A retry must wait through settlement, while unrelated runs stay independent.
const keyed = new (await import("./facet-turn-gate")).KeyedFacetTurnGate();
const keyedOrder: string[] = [];
let finishFirst!: () => void;
let finishRetry!: () => void;
const blockedFirst = new Promise<void>((resolve) => {
	finishFirst = resolve;
});
const blockedRetry = new Promise<void>((resolve) => {
	finishRetry = resolve;
});
const original = keyed.run("same", async () => {
	keyedOrder.push("original");
	await blockedFirst;
	throw new Error("original failed");
});
const originalFailure = assert.rejects(original, /original failed/);
const retry = keyed.run("same", async () => {
	keyedOrder.push("retry");
	await blockedRetry;
});
await keyed.run("other", async () => {
	keyedOrder.push("independent");
});
assert.deepEqual(keyedOrder, ["original", "independent"]);
finishFirst();
await originalFailure;
// Joining while the retry holds the gate must not create a replacement gate.
const third = keyed.run("same", async () => {
	keyedOrder.push("third");
});
await Promise.resolve();
assert.deepEqual(keyedOrder, ["original", "independent", "retry"]);
finishRetry();
await Promise.all([retry, third]);
assert.deepEqual(keyedOrder, ["original", "independent", "retry", "third"]);
assert.equal(await keyed.run("same", async () => "reused"), "reused");
