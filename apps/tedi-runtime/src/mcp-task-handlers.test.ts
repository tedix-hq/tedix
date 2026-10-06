import { strict as assert } from "node:assert";
import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import { McpTaskError } from "@tedix/mcp-shared/tasks";
import {
	buildDirectTediTaskHandlers,
	type DirectTediTaskPlatform,
} from "./mcp-task-handlers";

const events: TediRuntimeEvent[] = [
	{
		id: "event-1",
		tediId: "tedi-1",
		kind: "run.started",
		runId: "run-1",
		conversationId: "conversation-1",
		createdAt: "2026-07-10T00:00:00.000Z",
	},
];
const stopped: Array<Record<string, unknown>> = [];
const platform: DirectTediTaskPlatform = {
	listRuntimeEvents: async ({ runId }) => ({
		events: events.filter((event) => event.runId === runId),
	}),
	stopRuntimeRun: async (params) => {
		stopped.push(params);
		return { ok: true };
	},
};
const handlers = buildDirectTediTaskHandlers({
	getPlatform: async () => platform,
});

const state = await handlers.get({ taskId: "run-1" });
assert.equal(state.status, "working");
assert.equal(state.taskId, "run-1");

await handlers.cancel({ taskId: "run-1" });
assert.deepEqual(stopped, [
	{
		runId: "run-1",
		conversationId: "conversation-1",
		reason: "Canceled via direct tedi MCP tasks/cancel",
	},
]);

const rejectedCancel = buildDirectTediTaskHandlers({
	getPlatform: async () => ({
		listRuntimeEvents: async () => ({ events }),
		stopRuntimeRun: async () => ({
			ok: false,
			reason: "runtime rejected cancellation",
		}),
	}),
});
await assert.rejects(
	rejectedCancel.cancel({ taskId: "run-1" }),
	(error: unknown) =>
		error instanceof McpTaskError &&
		/runtime rejected cancellation/.test(error.message),
);

await assert.rejects(
	handlers.update({ taskId: "run-1", inputResponses: {} }),
	(error: unknown) =>
		error instanceof McpTaskError && /permissions_respond/.test(error.message),
);

const missing = buildDirectTediTaskHandlers({ getPlatform: async () => null });
await assert.rejects(
	missing.get({ taskId: "missing" }),
	(error: unknown) => error instanceof McpTaskError && error.code === -32_602,
);

console.log("Direct tedi MCP task handler tests passed.");

await assert.rejects(
	handlers.get({ taskId: "unknown-run" }),
	(error) => error instanceof McpTaskError && error.code === -32602,
);
