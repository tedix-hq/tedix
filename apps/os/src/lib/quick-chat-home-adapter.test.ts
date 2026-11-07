import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeStreamReadOutput } from "@tedix/api-contract/schemas/runtime-submissions";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import type { QuickChatHomeDeps } from "./quick-chat-home";
import {
	createQuickChatHomeAdapter,
	quickChatWorkspaceContext,
} from "./quick-chat-home-adapter";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const appId = "22222222-2222-4222-8222-222222222222";
const pathname = `/workspace/${workspaceId}`;
const pageContext = { pathname, entity: { type: "gadget", id: appId } };

function setup(toolName = "read_workspace_output") {
	const tool: WebMcpToolDef = {
		name: "read_workspace_output",
		description: "Read the saved sheet revision.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		execute: vi.fn(async () => ({
			content: [{ type: "text" as const, text: "revision 23" }],
		})),
	};
	const run = {
		id: "run-1",
		conversationId: "home:os:thread-1",
		organizationId: "org-1",
		status: "completed" as const,
		createdAt: "2026-11-01T10:00:00Z",
	};
	const deps: QuickChatHomeDeps = {
		enqueueMessage: vi.fn(async () => ({
			conversationId: run.conversationId,
			idempotencyKey: "key-1",
			status: "queued" as const,
			run: { ...run, status: "queued" as const },
		})),
		readRun: vi.fn(async () => ({ run })),
		readMessages: vi.fn(async () => ({
			messages: [
				{
					id: "answer",
					role: "assistant" as const,
					status: "completed" as const,
					content: "The sheet is revision 23.",
					runId: run.id,
					conversationId: run.conversationId,
					organizationId: "org-1",
					createdAt: run.createdAt,
				},
			],
		})),
		readRunEvents: vi.fn(
			async () =>
				({
					events: [
						{
							id: "e-1",
							kind: "tool.started",
							createdAt: run.createdAt,
							payload: {
								pageTool: {
									callId: "call-00000001",
									name: toolName,
									args: {},
									confirm: false,
								},
							},
						},
					],
					stream: { streamId: "run-1", offset: 0, nextOffset: 1, closed: true },
				}) as RuntimeStreamReadOutput,
		),
		resolvePageTool: vi.fn(async () => ({ accepted: true })),
		randomUuid: () => "key-1",
		sleep: async () => {},
		now: () => 0,
	};
	const workspaceTools = vi.fn(() => [tool]);
	return {
		deps,
		tool,
		workspaceTools,
		turn: createQuickChatHomeAdapter(deps, {
			pathname: () => pathname,
			workspaceTools,
		}),
	};
}

describe("quick chat workspace context", () => {
	it("keeps workspace scope when page sharing is off, but removes the selected app", () => {
		expect(quickChatWorkspaceContext(pathname, pageContext)).toEqual({
			workspaceId,
			workpiece: { kind: "gadget", id: appId },
		});
		expect(quickChatWorkspaceContext(pathname, undefined)).toEqual({
			workspaceId,
		});
		expect(
			quickChatWorkspaceContext(pathname, {
				...pageContext,
				pathname: "/work",
			}),
		).toEqual({ workspaceId });
		expect(quickChatWorkspaceContext("/work", pageContext)).toBeUndefined();
		expect(
			quickChatWorkspaceContext("/workspace/%", pageContext),
		).toBeUndefined();
		expect(
			quickChatWorkspaceContext("/workspace/not-a-workspace", pageContext),
		).toBeUndefined();
		expect(
			quickChatWorkspaceContext("/workspace/%2Fwork", pageContext),
		).toBeUndefined();
	});

	it("sends typed scope and executes a workspace read through the same offered tool", async () => {
		const { turn, deps, tool, workspaceTools } = setup();
		await expect(
			turn({ conversationId: "thread-1", text: "Read the sheet", pageContext }),
		).resolves.toEqual({ text: "The sheet is revision 23." });
		expect(workspaceTools).toHaveBeenCalledWith({
			workspaceId,
			conversationId: "home:os:thread-1",
			workpiece: { kind: "gadget", id: appId },
		});
		expect(deps.enqueueMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				workspaceContext: {
					workspaceId,
					workpiece: { kind: "gadget", id: appId },
				},
				pageTools: [expect.objectContaining({ name: "read_workspace_output" })],
			}),
			expect.anything(),
		);
		expect(tool.execute).toHaveBeenCalledOnce();
		expect(deps.resolvePageTool).toHaveBeenCalledWith({
			runId: "run-1",
			callId: "call-00000001",
			result: { ok: true, content: "revision 23" },
		});
	});

	it("rejects a tool that was not offered instead of forwarding it to the page", async () => {
		const { turn, deps, tool } = setup("delete_workspace");
		const runPageTool = vi.fn();
		await turn({
			conversationId: "thread-1",
			text: "Read the sheet",
			pageContext,
			runPageTool,
		});
		expect(tool.execute).not.toHaveBeenCalled();
		expect(runPageTool).not.toHaveBeenCalled();
		expect(deps.resolvePageTool).toHaveBeenCalledWith(
			expect.objectContaining({
				result: {
					ok: false,
					content: "This tool was not offered for this turn.",
				},
			}),
		);
	});
});
