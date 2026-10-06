import assert from "node:assert/strict";
import { embeddedUserText } from "./embedded-transcript";
import {
	embeddedReadToolCandidates,
	embeddedToolFitGuidance,
} from "./embedded-tool-fit";

const reads = [
	"shop.list_orders",
	"shop.get_order",
	"shop.list_orders",
	"invalid();",
];
assert.deepEqual(embeddedReadToolCandidates(reads), [
	{ id: "shop.list_orders", kind: "tool", description: "shop list orders" },
	{ id: "shop.get_order", kind: "tool", description: "shop get order" },
]);

const turnText = `${embeddedUserText("Which orders are overdue today?")}\n\nUntrusted host page signal:\n{"apiKey":"do not send"}`;
let calls = 0;
const guidance = await embeddedToolFitGuidance({
	turnText,
	readCallables: reads,
	runId: "run-1",
	rank: async (request) => {
		calls++;
		assert.equal(request.query, "Which orders are overdue today?");
		assert.equal(JSON.stringify(request).includes("apiKey"), false);
		assert.deepEqual(request.candidates, embeddedReadToolCandidates(reads));
		assert.equal(request.runId, "run-1");
		return {
			rankedIds: ["shop.list_orders", "shop.get_order"],
			usagePersistence: "persisted",
			executionAttempts: [],
		};
	},
});
assert.equal(calls, 1);
assert.match(guidance, /Likely matching admitted read tool: shop\.list_orders/);
assert.match(guidance, /grants no additional authority/);

for (const invalid of [
	"Legacy message\nUntrusted page signal: apiKey",
	embeddedUserText("short"),
	embeddedUserText("shop.list_orders"),
]) {
	assert.equal(
		await embeddedToolFitGuidance({
			turnText: invalid,
			readCallables: reads,
			runId: "run-1",
			rank: async () => {
				throw new Error("must not rank");
			},
		}),
		"",
	);
}
for (const badIds of [
	["shop.list_orders", "shop.list_orders"],
	["shop.list_orders", "shop.write_order"],
	["shop.list_orders"],
]) {
	assert.equal(
		await embeddedToolFitGuidance({
			turnText,
			readCallables: reads,
			runId: "run-1",
			rank: async () => ({
				rankedIds: badIds,
				usagePersistence: "persisted",
				executionAttempts: [],
			}),
		}),
		"",
	);
}
assert.equal(
	await embeddedToolFitGuidance({
		turnText,
		readCallables: reads,
		runId: "run-1",
		rank: async () => ({
			rankedIds: ["shop.list_orders", "shop.get_order"],
			usagePersistence: "failed",
			executionAttempts: [],
		}),
	}),
	"",
);
console.log("embedded tool fit stays read-only and page-context-free");
