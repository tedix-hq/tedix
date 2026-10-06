import type { TediRuntimeEvent } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { StopRuntimeRunResult } from "./brain/platform-client";
import {
	McpTaskError,
	type McpTaskHandlers,
	runEventsToTaskState,
} from "@tedix/mcp-shared/tasks";

export interface DirectTediTaskPlatform {
	listRuntimeEvents(params: {
		runId?: string;
		limit?: number;
	}): Promise<{ events: TediRuntimeEvent[] }>;
	stopRuntimeRun(params: {
		runId: string;
		conversationId?: string;
		reason?: string;
	}): Promise<StopRuntimeRunResult>;
}

/** Project one tedi's canonical runtime-event ledger as MCP Tasks. */
export function buildDirectTediTaskHandlers(input: {
	getPlatform: () => Promise<DirectTediTaskPlatform | null>;
}): McpTaskHandlers {
	const read = async (taskId: string) => {
		const platform = await input.getPlatform();
		if (!platform) throw McpTaskError.notFound(taskId);
		const { events } = await platform.listRuntimeEvents({
			runId: taskId,
			limit: 500,
		});
		if (events.length === 0) throw McpTaskError.notFound(taskId);
		return { platform, events, state: runEventsToTaskState(taskId, events) };
	};

	return {
		async get({ taskId }) {
			return (await read(taskId)).state;
		},
		async update({ taskId }) {
			throw new McpTaskError(
				-32_000,
				"Tedi run approvals do not flow through tasks/update. Use permissions_list_open and permissions_respond.",
				{ taskId },
			);
		},
		async cancel({ taskId }) {
			const { platform, events, state } = await read(taskId);
			if (
				state.status === "completed" ||
				state.status === "failed" ||
				state.status === "cancelled"
			) {
				throw new McpTaskError(
					-32_000,
					`Task is already terminal: ${state.status}`,
					{ taskId, status: state.status },
				);
			}
			const conversationId = events.find(
				(event) => typeof event.conversationId === "string",
			)?.conversationId;
			const result = await platform.stopRuntimeRun({
				runId: taskId,
				...(conversationId ? { conversationId } : {}),
				reason: "Canceled via direct tedi MCP tasks/cancel",
			});
			if (!result.ok) {
				throw new McpTaskError(-32_000, result.reason, { taskId });
			}
		},
	};
}
