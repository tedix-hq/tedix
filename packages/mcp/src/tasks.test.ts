import { describe, expect, it } from "vite-plus/test";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_TASKS_EXTENSION,
} from "./protocol";
import {
	clientSupportsTasks,
	extractMcpTaskId,
	runEventsToTaskState,
} from "./tasks";

describe("extractMcpTaskId", () => {
	it("reads a protocol-native resultType:task envelope", () => {
		expect(
			extractMcpTaskId({ resultType: "task", taskId: "generic-abc" }),
		).toBe("generic-abc");
	});

	it("no longer reads the removed compat task linkages (native-only)", () => {
		// The legacy top-level and structuredContent `task:{id}` linkages were
		// removed with the compat shims — native only.
		expect(extractMcpTaskId({ task: { id: "tedi:t1:r1" } })).toBe(null);
		expect(
			extractMcpTaskId({ structuredContent: { task: { id: "home-run-1" } } }),
		).toBe(null);
	});

	it("returns null for a normal synchronous tool result", () => {
		expect(extractMcpTaskId({ content: [{ type: "text", text: "hi" }] })).toBe(
			null,
		);
		expect(extractMcpTaskId(null)).toBe(null);
		expect(extractMcpTaskId("nope")).toBe(null);
	});
});

describe("clientSupportsTasks", () => {
	it("returns true when the tasks extension is declared", () => {
		const meta = {
			[MCP_CLIENT_CAPABILITIES_META_KEY]: {
				extensions: { [MCP_TASKS_EXTENSION]: {} },
			},
		};
		expect(clientSupportsTasks(meta)).toBe(true);
	});

	it("returns false when capabilities are declared WITHOUT the tasks extension (opt-out)", () => {
		const meta = {
			[MCP_CLIENT_CAPABILITIES_META_KEY]: { extensions: {} },
		};
		expect(clientSupportsTasks(meta)).toBe(false);
	});

	it("returns false when capabilities declare other extensions but not tasks", () => {
		const meta = {
			[MCP_CLIENT_CAPABILITIES_META_KEY]: {
				extensions: { "io.modelcontextprotocol/ui": {} },
			},
		};
		expect(clientSupportsTasks(meta)).toBe(false);
	});

	it("returns false for legacy/unknown callers (no clientCapabilities in _meta)", () => {
		// The no-capabilities exemption was removed with the compat shims: the
		// 2026-07-28 spec REQUIRES the tasks extension, so a
		// caller that never declares capabilities is not task-capable.
		expect(clientSupportsTasks(undefined)).toBe(false);
		expect(clientSupportsTasks(null)).toBe(false);
		expect(clientSupportsTasks({})).toBe(false);
		expect(
			clientSupportsTasks({ [MCP_PROTOCOL_VERSION_META_KEY]: "2026-07-28" }),
		).toBe(false);
	});

	it("returns true when clientCapabilities present but extensions absent is treated as opt-out=false", () => {
		// capabilities object present with no extensions key → modern client that
		// did not opt into tasks.
		const meta = { [MCP_CLIENT_CAPABILITIES_META_KEY]: {} };
		expect(clientSupportsTasks(meta)).toBe(false);
	});
});

describe("runEventsToTaskState", () => {
	it("points working tedi runs at tasks/get and messages_read", () => {
		const state = runEventsToTaskState("run-1", [
			{
				kind: "run.started",
				runId: "run-1",
				conversationId: "conv-1",
				createdAt: "2026-06-14T00:00:00Z",
			},
		]);

		expect(state.status).toBe("working");
		expect(state.statusMessage).toContain("tasks/get");
		expect(state.statusMessage).toContain("messages_read");
		expect(state.statusMessage).not.toContain("events_wait");
		expect(state.statusMessage).not.toContain("events_poll");
	});

	it("points terminal tedi run results at messages_read", () => {
		const state = runEventsToTaskState("run-1", [
			{
				kind: "run.started",
				runId: "run-1",
				conversationId: "conv-1",
				createdAt: "2026-06-14T00:00:00Z",
			},
			{
				kind: "message.completed",
				runId: "run-1",
				messageId: "msg-1",
				conversationId: "conv-1",
				createdAt: "2026-06-14T00:01:00Z",
			},
			{
				kind: "run.completed",
				runId: "run-1",
				conversationId: "conv-1",
				createdAt: "2026-06-14T00:02:00Z",
			},
		]);

		expect(state.status).toBe("completed");
		expect(state.result).toMatchObject({
			runId: "run-1",
			conversationId: "conv-1",
			outputMessageId: "msg-1",
			readWith: "messages_read",
		});
		expect(JSON.stringify(state.result)).not.toContain("events_poll");
	});
});
