import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeStreamEvent } from "@tedix/api-contract/schemas/runtime-submissions";
import { buildAppEditTools } from "@/components/app-edit-webmcp-tools";
import { WorkspaceChatPageTools } from "./workspace-chat-page-tools";

const api = vi.hoisted(() => ({
	get: vi.fn(),
	getCode: vi.fn(),
	proposeEdit: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: { gadgets: { get: api.get, getCode: api.getCode } },
		osAppRuntime: { proposeEdit: api.proposeEdit },
	},
}));

function frame(
	name: string,
	args = {},
	callId = "call_read_123",
	runId = "run-1",
): RuntimeStreamEvent {
	return {
		id: callId,
		kind: "tool.started",
		runId,
		createdAt: "2026-10-26T11:00:00Z",
		payload: { pageTool: { name, args, callId, confirm: false } },
	};
}

describe("workspace Home app tools", () => {
	it("reads app files and saves a chat draft using the offered workspace and conversation", async () => {
		api.get.mockResolvedValue({
			gadget: { id: "app-1" },
			currentRevision: { id: "rev-1", manifest: {} },
		});
		api.getCode.mockResolvedValue({
			code: { files: { "client.js": "Hello counter" } },
		});
		api.proposeEdit.mockResolvedValue({
			proposal: { id: "draft-1", status: "open" },
		});
		const proposed = vi.fn().mockResolvedValue(undefined);
		const relay = new WorkspaceChatPageTools();
		const tools = buildAppEditTools("workspace-1", "conversation-1", proposed);
		expect(relay.offer("send-1", tools).map((tool) => tool.name)).toEqual([
			"read_app_files",
			"propose_app_edit",
		]);
		const resolve = vi.fn().mockResolvedValue({ accepted: true });
		await relay.handle(frame("read_app_files", { gadgetId: "app-1" }), resolve);
		expect(resolve).not.toHaveBeenCalled();
		relay.bind("send-1", "run-1", resolve);
		await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
		const edits = [
			{
				path: "client.js",
				before: "Hello counter",
				after: "Hello visitor counter",
			},
		];
		const edit = frame(
			"propose_app_edit",
			{ gadgetId: "app-1", expectedRevisionId: "rev-1", edits },
			"call_edit_123",
		);
		await relay.handle(edit, resolve);
		await relay.handle(edit, resolve);
		expect(api.proposeEdit).toHaveBeenCalledExactlyOnceWith({
			workspaceId: "workspace-1",
			conversationId: "conversation-1",
			gadgetId: "app-1",
			expectedRevisionId: "rev-1",
			edits,
		});
		expect(proposed).toHaveBeenCalledOnce();
		expect(resolve).toHaveBeenLastCalledWith(
			expect.objectContaining({
				runId: "run-1",
				result: { ok: true, content: expect.stringContaining("draft-1") },
			}),
		);
	});

	it("rejects unoffered tools and ignores other runs", async () => {
		const relay = new WorkspaceChatPageTools();
		const tools = buildAppEditTools(
			"workspace-1",
			"conversation-1",
			async () => {},
		);
		const resolve = vi.fn().mockResolvedValue({ accepted: true });
		relay.offer("send-1", tools);
		relay.bind("send-1", "run-1", resolve);
		await relay.handle(frame("open_computer"), resolve);
		expect(resolve).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({ ok: false }),
			}),
		);
		resolve.mockClear();
		await relay.handle(
			frame("read_app_files", {}, "other_call_1", "other-run"),
			resolve,
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("retries result delivery without repeating a write or caching the next call's result", async () => {
		const execute = vi.fn().mockResolvedValue({
			content: [{ type: "text", text: "draft created" }],
		});
		const relay = new WorkspaceChatPageTools();
		relay.offer("send-1", [
			{
				name: "propose_app_edit",
				description: "Save a draft",
				inputSchema: { type: "object" },
				annotations: { readOnlyHint: false },
				execute,
			},
		]);
		const resolve = vi
			.fn()
			.mockRejectedValueOnce(new Error("disconnected"))
			.mockResolvedValue({ accepted: true });
		relay.bind("send-1", "run-1", resolve);
		await relay.handle(frame("propose_app_edit"), resolve);
		await relay.handle(frame("propose_app_edit"), resolve);
		expect(execute).toHaveBeenCalledOnce();
		await relay.handle(frame("propose_app_edit", {}, "next_call_12"), resolve);
		expect(execute).toHaveBeenCalledTimes(2);
	});
});
