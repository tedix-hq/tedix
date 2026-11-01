import assert from "node:assert/strict";
import {
	summarizeContextEntries,
	type ContextCompactionCompletion,
} from "./pi-compaction";
import type { ObserverEnv } from "./observer-llm";

const env = {} as ObserverEnv;
let calls = 0;
const completion: ContextCompactionCompletion = async () => {
	calls += 1;
	return '{"summary":"updated"}';
};
for (const previousSummary of [
	undefined,
	"An existing summary remains valid.",
]) {
	for (const entries of [
		[],
		[{ role: "user" as const, content: "" }],
		[
			{ role: "user" as const, content: " \n\t" },
			{ role: "assistant" as const, content: "\r\n" },
		],
	]) {
		assert.equal(
			await summarizeContextEntries(
				env,
				entries,
				previousSummary,
				undefined,
				undefined,
				completion,
			),
			null,
		);
	}
}
assert.equal(
	calls,
	0,
	"Empty spans must not invoke a billed observer, even with a prior summary",
);

const meaningful =
	"  Keep the exact path /src/server.ts and command bun run check.  ";
const entries = [
	{ role: "user" as const, content: "\n\t" },
	{ role: "assistant" as const, content: meaningful },
	{ role: "assistant" as const, content: "" },
];
const snapshot = structuredClone(entries);
const metadata = { source: "observer:session-compaction" };
const result = await summarizeContextEntries(
	env,
	entries,
	"Prior facts",
	metadata,
	{ modelRef: "workers-ai/example" },
	async (options) => {
		calls += 1;
		assert.equal(options.env, env);
		assert.equal(options.metadata, metadata);
		assert.equal(options.modelRef, "workers-ai/example");
		assert.equal(
			options.messages[1]?.content,
			`<previous-summary>\nPrior facts\n</previous-summary>\n\n<new-messages>\nassistant:\n${meaningful}\n</new-messages>`,
		);
		return '{"summary":"Prior facts and exact path retained."}';
	},
);
assert.equal(result, "Prior facts and exact path retained.");
assert.equal(calls, 1);
assert.deepEqual(
	entries,
	snapshot,
	"Compaction must not mutate source history",
);
console.log(
	"PASS empty compaction skips inference while mixed spans retain exact content and policy",
);
