import assert from "node:assert/strict";
import { selectSkillsWithJev } from "./jev-skill-ranking";
const skills = Array.from({ length: 7 }, (_, i) => ({
	id: `skill-${i}`,
	title: "Accounting invoice review",
	lifecycleState: i === 6 ? "draft" : "active",
}));
const base = {
	skills,
	query: "Accounting invoice review",
	options: { topK: 2 },
	runId: "run",
};
let calls = 0;
const ordered = await selectSkillsWithJev({
	...base,
	rank: async ({ skillIds }) => {
		calls++;
		assert(!skillIds.includes("skill-6"));
		return {
			skillIds: [...skillIds].reverse(),
			executionAttempts: [],
			usagePersistence: "not_dispatched",
		};
	},
});
assert.equal(calls, 1);
assert.deepEqual(
	ordered.map((m) => m.skill.id),
	["skill-5", "skill-4"],
);
for (const skillIds of [["foreign"], Array(6).fill("skill-0"), null]) {
	const result = await selectSkillsWithJev({
		...base,
		rank: async () => ({
			skillIds,
			executionAttempts: [],
			usagePersistence: "not_dispatched",
		}),
	});
	assert.deepEqual(
		result.map((m) => m.skill.id),
		["skill-0", "skill-1"],
	);
}
let captured = false;
const fallback = await selectSkillsWithJev({
	...base,
	rank: async () => ({
		skillIds: null,
		executionAttempts: [],
		usagePersistence: "failed",
	}),
	onExecutionAttempts: async (receipt) => {
		captured = receipt.usagePersistence === "failed";
	},
});
assert(captured);
assert.equal(fallback.length, 2);
const warnings: unknown[][] = [];
const originalWarn = console.warn;
console.warn = (...values: unknown[]) => {
	warnings.push(values);
};
try {
	const failed = await selectSkillsWithJev({
		...base,
		rank: async () => {
			throw new Error("provider-token-sensitive", {
				cause: new TypeError("private-query-sensitive"),
			});
		},
	});
	assert.deepEqual(
		failed.map((m) => m.skill.id),
		["skill-0", "skill-1"],
	);
} finally {
	console.warn = originalWarn;
}
assert.deepEqual(warnings, [
	[
		{
			event: "jev.skill_ranking_failed",
			exception: { type: "Error", cause: { type: "TypeError" } },
		},
	],
]);
assert(!JSON.stringify(warnings).includes("provider-token-sensitive"));
assert(!JSON.stringify(warnings).includes("private-query-sensitive"));
console.log("jev skill ranking tests passed");
