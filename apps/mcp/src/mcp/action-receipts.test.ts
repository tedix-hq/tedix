import { describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./server-context";
import { executeTool } from "./tool-execution";

function fixture(readAllowed = true) {
	const write = {
		toolId: "tedix__add_work_items_comment",
		toolTypeId: "rpc",
		title: "Add comment",
		config: {
			transport: "rpc",
			endpoint: "workItems/addComment",
			_aggregateNamespace: "work",
		},
		annotations: { readOnlyHint: false },
		outputSchema: null,
	} as unknown as AppTool;
	const read = {
		...write,
		toolId: "tedix__get_work_items_by_id",
		config: {
			transport: "rpc",
			endpoint: "workItems/getById",
			_aggregateNamespace: "work",
		},
		annotations: { readOnlyHint: true },
	};
	const calls: string[] = [];
	const agent = {
		env: { ENVIRONMENT: "production" },
		ctx: { waitUntil: vi.fn() },
		appId: "app-1",
		appSlug: "fictional",
		app: { organizationId: "org-1" },
		appMetadata: null,
		appCapabilities: {},
		callerIdentity: { authType: "service", tediId: "worker-1", scopes: [] },
		toolOutputTemplates: new Map(),
		loadedTools: new Map(readAllowed ? [[read.toolId, read]] : []),
		toolHandler: {
			execute: async (_args: unknown, ctx: { toolId: string }) => {
				calls.push(ctx.toolId);
				return {
					status: 200,
					data:
						ctx.toolId === write.toolId
							? { id: "comment-1", workItemId: "work-1" }
							: {
									workItem: { id: "work-1", disposition: "accepted" },
									comments: [{ id: "comment-1" }],
								},
				};
			},
			buildStructuredContent: (result: { data: unknown }) => result.data,
			buildTextContent: () => "Tool returned",
		},
	} as unknown as ServerContext;
	return { agent, write, calls };
}

describe("shared MCP action receipts", () => {
	it("reads back direct skill and Code Mode writes with tedi attribution", async () => {
		for (const executionId of [undefined, "code-1"]) {
			const { agent, write, calls } = fixture();
			const result = await executeTool(
				agent,
				write,
				{ id: "work-1", body: "Scratch note" },
				{ adapterScope: "primary", resultStrategy: "merge", executionId },
			);
			expect(calls).toEqual([write.toolId, "tedix__get_work_items_by_id"]);
			expect(result.structuredContent).toMatchObject({
				actionReceipt: {
					verified: true,
					state: "accepted",
					actor: "tedi:worker-1",
					url: "https://os.tedix.dev/work/items/work-1#comment-comment-1",
				},
			});
		}
	});
	it("keeps an unverified receipt and never repeats a write when no reader is available", async () => {
		const { agent, write, calls } = fixture(false);
		const result = await executeTool(
			agent,
			write,
			{ id: "work-1" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(calls).toEqual([write.toolId]);
		expect(result.structuredContent).toMatchObject({
			actionReceipt: { verified: false },
			completionEvidence: {
				unsupportedClaims: expect.arrayContaining([
					"the requested effect is verified",
				]),
			},
		});
	});
	it("does not bypass the reader's scope gate", async () => {
		const { agent, write, calls } = fixture();
		const scoped = {
			...agent,
			callerIdentity: {
				authType: "oauth",
				tediId: "worker-1",
				scopes: ["mcp:work.write"],
			},
		} as ServerContext;
		const result = await executeTool(
			scoped,
			write,
			{ id: "work-1" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(calls).toEqual([write.toolId]);
		expect(result.structuredContent).toMatchObject({
			actionReceipt: { verified: false },
		});
	});
});
