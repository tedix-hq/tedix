import assert from "node:assert/strict";
import { collectActionReceipts, appendActionReceipts } from "./action-receipts";
import { AGENT_RUNTIME_PROMPT } from "./runtime-tool-guidance";

const receipt = {
	operation: "work.add_comment",
	actor: "tedi:worker-1",
	verified: true,
	url: "https://os.example.test/work/items/work-1",
	state: "accepted",
	checkedAt: "2026-10-16T12:00:00.000Z",
};
const receipts = collectActionReceipts({
	result: "summary omitted proof",
	actionReceipts: [receipt],
	nested: JSON.stringify({ actionReceipt: receipt }),
});
assert.equal(receipts.length, 1);
assert.deepEqual(
	collectActionReceipts({ result: { actionReceipts: [receipt] } }),
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
assert.deepEqual(collectActionReceipts("not JSON"), []);
console.log("action receipt tests passed");
