import assert from "node:assert/strict";
import type { GuestTurnLearnInput } from "@tedix/api-contract/schemas/tedi-guest-turn";
import {
	guestToolCatalog,
	guestToolRun,
	guestTurnLearn,
	type GuestTurnHost,
} from "./guest-turn";

const learned: string[] = [];
let toolCalls = 0;
const host: GuestTurnHost = {
	ensureIdentity: async () => {},
	getPlatformClient: async () => {
		toolCalls++;
		return null;
	},
	getMcpRuntime: async () => {
		toolCalls++;
		return null;
	},
	dispatchTurnMemoryEffects: async (input) => {
		learned.push(input.runId);
	},
};
const turn: GuestTurnLearnInput = {
	tediId: "tedi-1",
	organizationId: "org-1",
	trust: "trusted",
	senderUserId: "ana",
	tediOwnerUserId: "ana",
	workspaceId: "ws-1",
	conversationId: "conv-1",
	othersCanOpen: false,
	turnId: "turn-1",
	userText: "Remember that the review moved to Thursday.",
	replyText: "Noted.",
	steps: [{ tool: "read_skill", ok: true }],
};

// A personal tedi learns from its owner's private workspace and nowhere else;
// an organization tedi learns only from a workspace private to the sender.
assert.deepEqual(await guestTurnLearn.call(host, turn), { accepted: true });
assert.deepEqual(learned, ["tedi-1:guest:turn-1"]);
for (const refused of [
	{ ...turn, othersCanOpen: true },
	{ ...turn, senderUserId: "ben" },
	{ ...turn, trust: "untrusted" as const },
	{ ...turn, tediOwnerUserId: null, othersCanOpen: true },
]) {
	const result = await guestTurnLearn.call(host, refused);
	assert.equal(result.accepted, false);
}
assert.equal(
	(await guestTurnLearn.call(host, { ...turn, tediOwnerUserId: null }))
		.accepted,
	true,
);
assert.equal(learned.length, 2);

// A turn nobody signed in for gets no catalog and every run refused, and a
// shared workspace never reaches the tedi's connected accounts.
toolCalls = 0;
const untrusted = { ...turn, trust: "untrusted" as const };
const catalog = await guestToolCatalog.call(host, untrusted);
assert.deepEqual(
	[catalog.skills, catalog.namespaces, catalog.tools],
	[[], [], []],
);
for (const refused of [
	{ ...untrusted, tool: "read_skill", args: { slug: "a" } },
	{ ...untrusted, tool: "mail.send_message" },
	{ ...turn, othersCanOpen: true, tool: "mail.send_message" },
])
	assert.equal((await guestToolRun.call(host, refused)).status, "refused");
assert.equal(toolCalls, 0);
