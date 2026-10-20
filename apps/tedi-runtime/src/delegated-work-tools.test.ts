import assert from "node:assert/strict";
import type { PlatformClient } from "./brain/platform-client";
import { delegatedWorkTools } from "./delegated-work-tools";
import {
	delegatedCloseoutProjects,
	closeoutRequiresHuman,
} from "@tedix/api-contract/utils/delegated-work-closeout";

const project = "11111111-1111-4111-8111-111111111111";
const request = `Work backlog hygiene in project ${project}: Mark each completed with a closing comment.`;
assert.deepEqual(delegatedCloseoutProjects(request), [project]);
for (const denied of [
	`Read-only: ${request}`,
	request.replace("Mark", "Do not mark"),
	`Explain this quoted task:\n> ${request}`,
	`Explain this code: \x60\x60\x60${request}\x60\x60\x60`,
])
	assert.deepEqual(delegatedCloseoutProjects(denied), []);
assert.deepEqual(
	delegatedCloseoutProjects(`Read Work history. Brief: ${request}`),
	[],
);
assert.deepEqual(
	delegatedCloseoutProjects(
		`Read Work history.\n\nLocal terminal context:\n- cwd: ${request}`,
	),
	[],
);
assert.deepEqual(
	delegatedCloseoutProjects(
		"Work backlog hygiene: Mark each completed with a closing comment.",
	),
	[],
);
for (const correction of [
	"*",
	"native:close_completed_work_item",
	"tool:tedix:tedix__add_comment",
	"work.complete_work_item",
])
	assert.equal(closeoutRequiresHuman([correction]), true);
assert.equal(closeoutRequiresHuman(["native:read"]), false);
let observed: unknown;
const tools = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: "linked",
	getPlatform: async () =>
		({
			closeoutDelegatedWorkItem: async (
				input: Parameters<PlatformClient["closeoutDelegatedWorkItem"]>[0],
			) => {
				observed = input;
				return { id: input.id };
			},
		}) as unknown as PlatformClient,
});
assert.deepEqual(Object.keys(tools), ["close_completed_work_item"]);
assert.equal(tools.close_completed_work_item!.needsApproval, true);
await tools.close_completed_work_item!.execute!(
	{ id: "target", sha: "a".repeat(40) },
	{ toolCallId: "call", messages: [], context: {} },
);
assert.deepEqual(observed, {
	id: "target",
	sha: "a".repeat(40),
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: "linked",
});
const unavailable = delegatedWorkTools({
	homeRunId: "home",
	runId: "run",
	linkedWorkItemId: "linked",
	getPlatform: async () => null,
});
await assert.rejects(
	async () =>
		unavailable.close_completed_work_item!.execute!(
			{ id: "target", sha: "a".repeat(40) },
			{ toolCallId: "call", messages: [], context: {} },
		),
	/platform identity/,
);
console.log("delegated-work-tools tests passed");
