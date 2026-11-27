import assert from "node:assert/strict";
import type { GuestTurnLearnInput } from "@tedix/api-contract/schemas/tedi-guest-turn";
import type { PersonalAgentClient } from "@tedix/auth/personal-agent-client";
import {
	guestToolCatalog,
	guestToolRun,
	guestTurnLearn,
	type GuestTurnHost,
} from "./guest-turn";
import {
	createPoppyAgentAiTools,
	POPPY_CALL_TOOL_NAME,
	POPPY_DISCOVER_TOOL_NAME,
} from "./poppy-agent-tools";

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
	getPoppyAgentTools: () => ({}),
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

// Without the tedi's Poppy identity the same names stay unavailable.
assert.deepEqual(
	(await guestToolCatalog.call(host, { ...turn, query: "poppy" })).tools,
	[],
);
assert.equal(
	(
		await guestToolRun.call(host, {
			...turn,
			tool: POPPY_DISCOVER_TOOL_NAME,
			args: { company: "company.example" },
		})
	).status,
	"refused",
);

// A tedi with its Poppy signing key lists and runs the same two tools a Home
// turn gets; the guest path validates arguments before the signed call.
const poppyClient = {
	discoverCompany: async () => ({
		protocolVersion: "1.0",
		audience: "https://company.example",
		mcpUrl: "https://company.example/mcp",
		agentUrl: "https://company.example/poppy",
		tasksUrl: "https://company.example/tasks",
	}),
	call: async () =>
		new Response(JSON.stringify({ reply: "seller reply" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
} as unknown as PersonalAgentClient;
const poppyHost: GuestTurnHost = {
	...host,
	getPoppyAgentTools: () =>
		createPoppyAgentAiTools({
			enabled: true,
			db: {} as never,
			masterKey: undefined,
			apiBaseUrl: "https://api.tedix.test",
			tediId: "tedi-1",
			slug: "amber-otter",
			loadClient: async () => poppyClient,
		}),
};

const poppyCatalog = await guestToolCatalog.call(poppyHost, {
	...turn,
	query: "poppy",
});
assert.deepEqual(
	poppyCatalog.tools.map((tool) => tool.name),
	[POPPY_DISCOVER_TOOL_NAME, POPPY_CALL_TOOL_NAME],
);
const described = await guestToolCatalog.call(poppyHost, {
	...turn,
	describe: POPPY_CALL_TOOL_NAME,
});
assert.equal(described.tools[0]?.name, POPPY_CALL_TOOL_NAME);
assert.equal(typeof described.tools[0]?.inputSchema, "object");
const namespaces = await guestToolCatalog.call(poppyHost, turn);
assert.deepEqual(namespaces.namespaces, [{ name: "poppy", tools: 2 }]);

const poppyRun = await guestToolRun.call(poppyHost, {
	...turn,
	tool: POPPY_CALL_TOOL_NAME,
	args: {
		company: "company.example",
		surface: "conversations",
		text: "find widgets on example-shop",
	},
});
assert.equal(poppyRun.status, "ok");
if (poppyRun.status === "ok") {
	const result = poppyRun.result as { status: number; body: string };
	assert.equal(result.status, 200);
	assert.ok(result.body.includes("seller reply"));
}
assert.equal(
	(
		await guestToolRun.call(poppyHost, {
			...turn,
			tool: POPPY_DISCOVER_TOOL_NAME,
			args: {},
		})
	).status,
	"refused",
);
