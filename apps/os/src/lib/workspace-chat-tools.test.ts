import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildWorkspaceChatTools } from "./workspace-chat-tools";

const api = vi.hoisted(() => ({
	listApps: vi.fn(),
	readApp: vi.fn(),
	readFiles: vi.fn(),
	readOutput: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			gadgets: { list: api.listApps, get: api.readApp, getCode: api.readFiles },
			outputs: { get: api.readOutput },
		},
	},
}));

const tools = (kind?: "gadget" | "output") =>
	buildWorkspaceChatTools({
		workspaceId: "workspace-1",
		conversationId: "conversation-1",
		...(kind ? { workpiece: { kind, id: "selected-1" } } : {}),
	});
const tool = (name: string) =>
	tools().find((candidate) => candidate.name === name)!;
const text = (result: unknown) => JSON.stringify(result);

describe("workspace chat tools shared by native and embedded chat", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps workspace reads available with no selected app or with a sheet selected", () => {
		for (const selection of [undefined, "output"] as const) {
			const offered = tools(selection);
			expect(offered.map((item) => item.name)).toEqual(
				expect.arrayContaining([
					"get_workspace_overview",
					"list_workspace_apps",
					"list_workspace_outputs",
					"read_app_files",
					"read_workspace_output",
				]),
			);
			expect(offered.every((item) => item.annotations?.readOnlyHint)).toBe(
				true,
			);
		}
		expect(tools("gadget").map((item) => item.name)).toContain(
			"propose_app_edit",
		);
	});

	it("finds app identities through the authenticated workspace-scoped reader", async () => {
		api.listApps.mockResolvedValue({
			items: [
				{
					id: "app-1",
					name: "Evaluations",
					status: "active",
					currentRevisionId: "rev-2",
				},
			],
			truncated: false,
		});
		const result = await tool("list_workspace_apps").execute({});
		expect(api.listApps).toHaveBeenCalledWith({
			workspaceId: "workspace-1",
			status: "active",
			limit: 50,
		});
		expect(text(result)).toContain("Evaluations");
	});

	it("reads the saved sheet revision without confusing it with data format versions", async () => {
		api.readOutput.mockResolvedValue({
			output: {
				id: "sheet-1",
				title: "Evaluations",
				workspaceId: "workspace-1",
				kind: "sheet",
			},
			currentRevision: {
				id: "sheet-rev-23",
				revision: 23,
				content: { formatVersion: 1, rows: ["private body"] },
			},
		});
		const result = await tool("read_workspace_output").execute({
			outputId: "sheet-1",
		});
		expect(text(result)).toContain('"revision":23');
		expect(text(result)).not.toContain("private body");
	});

	it("does not expose another workspace's output even when the user can read it", async () => {
		api.readOutput.mockResolvedValue({
			output: {
				id: "other-sheet",
				title: "Other workspace",
				workspaceId: "workspace-2",
			},
			currentRevision: {
				revision: 7,
				content: { secret: "cross-workspace body" },
			},
		});
		const result = await tool("read_workspace_output").execute({
			outputId: "other-sheet",
			includeContent: true,
		});
		expect(result.isError).toBe(true);
		expect(text(result)).not.toContain("cross-workspace body");
	});

	it("bounds requested content and returns access failures without claiming a read", async () => {
		api.readOutput.mockResolvedValueOnce({
			output: { id: "sheet-1", workspaceId: "workspace-1" },
			currentRevision: { revision: 23, content: { text: "a".repeat(20_000) } },
		});
		const result = await tool("read_workspace_output").execute({
			outputId: "sheet-1",
			includeContent: true,
		});
		expect(text(result)).toContain('"contentTruncated":true');
		expect(String(result.structuredContent?.contentPreview).length).toBe(
			16_000,
		);
		api.readOutput.mockRejectedValueOnce(
			Object.assign(new Error("Organization scope required"), {
				code: "FORBIDDEN",
			}),
		);
		const denied = await tool("read_workspace_output").execute({
			outputId: "sheet-1",
		});
		expect(denied.isError).toBe(true);
		expect(text(denied)).toContain("context_unavailable");
	});
});
