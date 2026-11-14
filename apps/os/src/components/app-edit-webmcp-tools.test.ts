import { describe, expect, it, vi } from "vite-plus/test";
import { buildAppEditTools } from "./app-edit-webmcp-tools";

const api = vi.hoisted(() => ({
	list: vi.fn(async (): Promise<{ items: unknown[]; truncated: boolean }> => ({
		items: [],
		truncated: false,
	})),
	get: vi.fn(),
	getCode: vi.fn(),
	proposeEdit: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			collaboration: { list: api.list },
			gadgets: { get: api.get, getCode: api.getCode },
		},
		osAppRuntime: { proposeEdit: api.proposeEdit },
	},
}));

describe("workspace Home app editing", () => {
	it("reads the pinned files and proposes an edit in the linked chat, then refreshes Drafts", async () => {
		api.get.mockResolvedValue({
			gadget: { id: "app-1", name: "Evaluations", status: "active" },
			currentRevision: {
				id: "rev-2",
				revision: 2,
				manifest: { entry: "tedix:runtime/v1", config: { version: 1 } },
			},
		});
		api.getCode.mockResolvedValue({
			code: {
				filesSha256: "a".repeat(64),
				files: { "client.js": "hello", "server.js": "server" },
			},
		});
		api.proposeEdit.mockResolvedValue({
			proposal: { id: "draft-1", status: "open" },
		});
		const refresh = vi.fn(async () => {});
		const tools = buildAppEditTools("workspace-1", "chat-1", refresh);
		const read = await tools[0]!.execute({ gadgetId: "app-1" });
		expect(JSON.stringify(read)).toContain("hello");
		expect(JSON.stringify(read)).toContain('"revision":2');
		expect(JSON.stringify(read)).toContain('"version":1');
		expect(api.getCode).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			gadgetId: "app-1",
			revisionId: "rev-2",
			knownFilesSha256: undefined,
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
	it("reads and forwards the pending proposal fence", async () => {
		api.list.mockResolvedValueOnce({
			items: [
				{
					id: "draft-1",
					documentType: "gadget",
					status: "open",
					baseRevision: 2,
					baseRevisionId: "rev-2",
					sequence: 1,
					content: {
						manifest: {
							entry: "tedix:runtime/v1",
							capabilities: [],
							config: { version: 1 },
						},
						files: { "client.js": "Pending source", "server.js": "server" },
					},
				},
			],
			truncated: false,
		});
		const tools = buildAppEditTools("workspace-1", "chat-1", async () => {});
		const read = await tools[0]!.execute({ gadgetId: "app-1" });
		expect(JSON.stringify(read)).toContain("Pending source");
		expect(JSON.stringify(read)).toContain('"sequence":1');
		await tools[1]!.execute({
			gadgetId: "app-1",
			expectedRevisionId: "rev-2",
			proposalId: "draft-1",
			expectedSequence: 1,
			edits: [
				{ path: "client.js", before: "Pending source", after: "Next source" },
			],
		});
		expect(api.proposeEdit).toHaveBeenLastCalledWith(
			expect.objectContaining({ proposalId: "draft-1", expectedSequence: 1 }),
		);
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
