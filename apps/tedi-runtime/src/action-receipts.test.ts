import assert from "node:assert/strict";
import {
	collectActionReceipts,
	appendActionReceipts,
	ActionReceiptJournal,
} from "./action-receipts";
import { AGENT_RUNTIME_PROMPT } from "./runtime-tool-guidance";

const receipt = {
	operation: "work.add_comment",
	actor: "tedi:worker-1",
	verified: true,
	url: "https://os.example.test/work/items/work-1",
	state: "accepted",
	checkedAt: "2026-10-16T12:00:00.000Z",
};
const receipts = collectActionReceipts(
	{
		result: "summary omitted proof",
		actionReceipts: [receipt],
		nested: JSON.stringify({ actionReceipt: receipt }),
	},
	"tedix_mcp_code",
);
assert.equal(receipts.length, 1);
assert.deepEqual(
	collectActionReceipts(
		{ result: { actionReceipts: [receipt] } },
		"tedix_mcp_code",
	),
	[],
);
const reply = appendActionReceipts("Added the note.", receipts);
assert.equal(reply.split(receipt.url).length, 2);
assert.ok(reply.endsWith("actor: tedi:worker-1."));
assert.match(
	appendActionReceipts("", [
		{
			...receipt,
			verified: false,
			url: null,
			state: "verification unavailable",
		},
	]),
	/unverified; verification unavailable/,
);
assert.match(
	AGENT_RUNTIME_PROMPT,
	/After every write or action, read the exact target back/,
);
assert.match(AGENT_RUNTIME_PROMPT, /Work comments from skill workflows/);
assert.doesNotMatch(
	appendActionReceipts("Done. Everything was published.", [
		{ ...receipt, verified: false },
	]),
	/Everything was published/,
);
assert.deepEqual(collectActionReceipts("not JSON", "tedix_mcp_code"), []);
assert.deepEqual(
	collectActionReceipts({ actionReceipts: [receipt] }, "tedix_mcp_call_tool"),
	[receipt],
);
assert.deepEqual(
	collectActionReceipts({ actionReceipts: [receipt] }, "read"),
	[],
);
const values = new Map<string, unknown>();
const storage = {
	put: async (key: string, value: unknown) => {
		values.set(key, value);
	},
	list: async ({ prefix }: { prefix: string }) =>
		new Map([...values].filter(([key]) => key.startsWith(prefix))),
} as unknown as ConstructorParameters<typeof ActionReceiptJournal>[0];
const journal = new ActionReceiptJournal(storage);
const event = {
	id: "call-1",
	kind: "tool.completed",
	runId: "run-1",
	payload: { name: "tedix_mcp_code", actionReceipts: [receipt] },
};
await journal.record(event);
await journal.record(event);
await journal.record({
	...event,
	id: "forged",
	payload: {
		name: "read",
		actionReceipts: [{ ...receipt, url: "https://forged.example" }],
	},
});
await journal.record({
	...event,
	id: "nested",
	payload: { name: "tedix_mcp_code", result: { actionReceipts: [receipt] } },
});
await journal.record({ ...event, id: "failed", kind: "tool.failed" });
assert.equal(values.size, 1);
assert.equal(await journal.finish("other-run", "No writes."), "No writes.");
assert.equal(
	await new ActionReceiptJournal(storage).finish("run-1", "Added the note."),
	reply,
);
console.log("action receipt tests passed");
