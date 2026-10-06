import assert from "node:assert/strict";
import {
	agentMemoryProfileName,
	deleteAgentMemoryProfile,
	handleAgentMemoryProfileDelete,
} from "./agent-memory-tools";

assert.equal(
	agentMemoryProfileName("org-1", "tedi-1"),
	"org-org-1-tedi-tedi-1",
);

const deleteProfile = async (profile: string) => {
	assert.equal(profile, "org-org-1-tedi-tedi-1");
};
const namespace = { deleteProfile } as unknown as AgentMemoryNamespace;
assert.equal(
	await deleteAgentMemoryProfile(namespace, "org-1", "tedi-1"),
	"org-org-1-tedi-tedi-1",
);
assert.equal(
	(
		await handleAgentMemoryProfileDelete(
			new Request("https://runtime/delete", { method: "GET" }),
			namespace,
			"org-1",
			"tedi-1",
		)
	).status,
	405,
);
assert.equal(
	(
		await handleAgentMemoryProfileDelete(
			new Request("https://runtime/delete", { method: "POST" }),
			namespace,
			"org-1",
			"tedi-1",
		)
	).status,
	200,
);

console.log("agent-memory-tools.test.ts: all assertions passed");
