import { describe, expect, it, vi } from "vite-plus/test";
import { buildAppEditTools } from "./app-edit-webmcp-tools";

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

describe("workspace Home app editing", () => {
	it("reads the pinned files and proposes an edit in the linked chat, then refreshes Drafts", async () => {
		api.get.mockResolvedValue({
			gadget: { id: "app-1" },
			currentRevision: { id: "rev-1", manifest: { entry: "tedix:runtime/v1" } },
		});
		api.getCode.mockResolvedValue({
			code: { files: { "client.js": "hello", "server.js": "server" } },
		});
		api.proposeEdit.mockResolvedValue({
			proposal: { id: "draft-1", status: "open" },
		});
		const refresh = vi.fn(async () => {});
		const tools = buildAppEditTools("workspace-1", "chat-1", refresh);
		const read = await tools[0]!.execute({ gadgetId: "app-1" });
		expect(JSON.stringify(read)).toContain("hello");
		expect(api.getCode).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			gadgetId: "app-1",
			revisionId: "rev-1",
		});
		const edits = [
			{ path: "client.js", before: "hello", after: "good morning" },
		];
		const proposed = await tools[1]!.execute({
			gadgetId: "app-1",
			expectedRevisionId: "rev-1",
			edits,
		});
		expect(api.proposeEdit).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			conversationId: "chat-1",
			gadgetId: "app-1",
			expectedRevisionId: "rev-1",
			edits,
		});
		expect(JSON.stringify(proposed)).toContain("draft-1");
		expect(refresh).toHaveBeenCalledOnce();
	});
	it("reports a rejected edit without claiming a draft or refreshing the panel", async () => {
		api.proposeEdit.mockRejectedValueOnce(new Error("App revision changed"));
		const refresh = vi.fn(async () => {});
		const tool = buildAppEditTools("workspace-1", "chat-1", refresh)[1]!;
		const result = await tool.execute({
			gadgetId: "app-1",
			expectedRevisionId: "rev-1",
			edits: [],
		});
		expect(result.isError).toBe(true);
		expect(refresh).not.toHaveBeenCalled();
	});
});
