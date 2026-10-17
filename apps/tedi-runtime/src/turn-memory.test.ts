import assert from "node:assert/strict";
import { refreshTurnMemory } from "./turn-memory";
import { parseObserverResult } from "@tedix/context-core/observer";
import { parseReflectorObservations } from "@tedix/context-core/reflector";
import { observationFreshness } from "@tedix/context-core/memory-freshness";

const workId = "11111111-1111-4111-8111-111111111111";
let reads = 0;
const block = await refreshTurnMemory({
	userText: "continue",
	remembered: `Mira prefers short updates. Work ${workId} was accepted.`,
	refresh: async (references) => {
		reads++;
		assert.deepEqual(references, [workId]);
		return {
			checkedAt: "2026-10-17T10:00:00Z",
			preferences: [
				{ id: "preference", content: "Mira prefers short updates." },
			],
			tasks: [
				{
					id: workId,
					kind: "work",
					title: "Review the sample report",
					state: "completed",
					deadline: null,
				},
			],
			unresolvedReferences: [],
			truncated: false,
		};
	},
});
assert.equal(reads, 1, "short continuation still refreshes live state");
assert.ok(block.includes("Mira prefers short updates."));
assert.ok(block.includes('"state":"completed"'));
assert.ok(block.includes("stays closed"));

const references = Array.from(
	{ length: 100 },
	(_, index) => `11111111-1111-4111-8111-${index.toString().padStart(12, "0")}`,
);
references.push(workId);
const batches: string[][] = [];
const batched = await refreshTurnMemory({
	userText: "continue",
	remembered: references.join(" "),
	refresh: async (batch) => {
		assert.ok(batch.length <= 100, "TurnMemoryInputSchema request limit");
		batches.push(batch);
		return {
			checkedAt: `2026-10-17T10:00:0${batches.length}Z`,
			preferences: [
				{ id: "preference", content: "Mira prefers short updates." },
			],
			tasks: [
				{
					id: workId,
					kind: "work",
					title: "Sample report",
					state: batches.length === 1 ? "accepted" : "cancelled",
					deadline: null,
				},
			],
			unresolvedReferences: batch,
			truncated: batches.length === 1,
		};
	},
});
assert.deepEqual(
	batches.flat(),
	references,
	"no remembered reference is dropped",
);
assert.equal(batches.length, 2);
const snapshot = JSON.parse(
	batched.slice(batched.indexOf("{"), batched.lastIndexOf("}") + 1),
);
assert.equal(snapshot.checkedAt, "2026-10-17T10:00:02Z");
assert.equal(
	snapshot.preferences.length,
	1,
	"shared preferences stay deduplicated",
);
assert.equal(snapshot.tasks.length, 1, "shared owned tasks stay deduplicated");
assert.equal(
	snapshot.tasks[0].state,
	"cancelled",
	"newer canonical state wins",
);
assert.deepEqual(snapshot.unresolvedReferences, references.slice(0, -1));
assert.equal(snapshot.truncated, true, "earlier truncation remains visible");

let batchReads = 0;
const failedBatch = await refreshTurnMemory({
	userText: "continue",
	remembered: references.join(" "),
	refresh: async (batch) => {
		if (++batchReads === 2) throw new Error("later batch offline");
		return {
			checkedAt: "2026-10-17T10:00:01Z",
			preferences: [],
			tasks: [],
			unresolvedReferences: batch,
			truncated: false,
		};
	},
});
assert.equal(batchReads, 2);
assert.ok(failedBatch.includes("Do not act on or chase remembered tasks"));
assert.ok(!failedBatch.includes("# Preferences and current task state"));

const failed = await refreshTurnMemory({
	userText: "continue",
	remembered: "Old approval is pending",
	refresh: async () => {
		throw new Error("offline");
	},
});
assert.ok(failed.includes("Do not act on or chase remembered tasks"));
assert.ok(!failed.includes("Old approval is pending"));

const observations = parseObserverResult(
	JSON.stringify({
		observations: [
			{
				date: "2026-10-17",
				time: "10:00",
				type: "preference",
				priority: "high",
				content: "Mira prefers short updates.",
				details: [],
			},
			{
				date: "2026-10-17",
				time: "10:00",
				type: "technical",
				priority: "high",
				content: `Work ${workId} is accepted`,
				details: [],
				verifyBeforeUse: false,
			},
		],
	}),
).observations;
assert.equal(observations[0]!.verifyBeforeUse, false);
assert.equal(observations[1]!.verifyBeforeUse, true);
assert.deepEqual(observationFreshness(observations[1]!).sourceRefs, [workId]);
const reflected = parseReflectorObservations(JSON.stringify({ observations }));
assert.equal(
	reflected[1]!.verifyBeforeUse,
	true,
	"reflector cannot lose transient marker",
);
assert.equal(reflected[0]!.content, observations[0]!.content);
console.log("turn-memory tests passed");

const { reflect } = await import("./brain/reflector");
const preference = observations[0]!;
const longObservation = {
	...observations[1]!,
	content: `Work ${workId} is accepted. `.repeat(50),
};
const reflectedResult = await reflect({
	observations: [preference, longObservation],
	model: "fictional-model",
	serialize: JSON.stringify,
	llm: {
		chat: async () => ({
			content: JSON.stringify({
				observations: [
					{
						...longObservation,
						content: `Work ${workId} is completed`,
						verifyBeforeUse: false,
					},
				],
			}),
		}),
	},
});
assert.ok(
	reflectedResult.observations.some(
		(observation) => observation.content === preference.content,
	),
	"reflector retains preference verbatim even when model drops it",
);
assert.equal(
	reflectedResult.observations.find(
		(observation) => observation.type === "technical",
	)?.verifyBeforeUse,
	true,
);
const mislabeledState = parseObserverResult(
	JSON.stringify({
		observations: [
			{ ...observations[1], type: "preference", verifyBeforeUse: false },
		],
	}),
).observations[0];
assert.equal(
	mislabeledState?.verifyBeforeUse,
	true,
	"a concrete Work reference cannot become a durable preference by relabeling it",
);
