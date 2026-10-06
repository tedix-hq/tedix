import assert from "node:assert/strict";
import { handleAgentMemoryProjectionInspect } from "./agent-memory-projection";

const profile = {
	list: async () => ({
		memories: [
			{
				id: "memory-1",
				type: "fact",
				summary: "projected summary",
				sessionId: "fact:1",
				createdAt: new Date(0),
				updatedAt: new Date(0),
			},
		],
	}),
} as unknown as AgentMemoryProfile;

const inspected = await handleAgentMemoryProjectionInspect(
	new Request(
		"https://runtime/__admin/agent-memory/inspect?sessionId=fact%3A1",
	),
	async () => profile,
);
assert.equal(inspected.status, 200);
const body = (await inspected.json()) as {
	memories: Array<{ summary: string }>;
};
assert.match(body.memories[0]!.summary, /<<<external_agent_memory>>>/);

const invalid = await handleAgentMemoryProjectionInspect(
	new Request("https://runtime/__admin/agent-memory/inspect"),
	async () => profile,
);
assert.equal(invalid.status, 400);

console.log("agent-memory-projection.test.ts: all assertions passed");
