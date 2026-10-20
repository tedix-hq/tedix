import { describe, expect, it, vi } from "vite-plus/test";
import { MCP_CLIENT_CAPABILITIES_META_KEY } from "@tedix/mcp-shared/protocol";
import { requireDestructiveToolApproval } from "./governance";
import { buildHomeSurfaceTools } from "./home-surface-tools";
import type { ServerContext } from "./server-context";

const ask = buildHomeSurfaceTools().find((tool) => tool.toolId === "ask")!;

function ownerContext() {
	return {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "connect",
		callerIdentity: { authType: "oauth", userId: "owner" },
	} as unknown as ServerContext;
}

const options = {
	args: { content: "What is 2 plus 2?" },
	extra: {
		_meta: {
			[MCP_CLIENT_CAPABILITIES_META_KEY]: {
				extensions: { "io.modelcontextprotocol/tasks": {} },
				elicitation: {},
			},
		},
	},
};

describe("Home ingress approval", () => {
	it.each(["ask", "enqueue_kernel_runtime_message"])(
		"lets the kernel assess the request behind %s for a tasks-capable owner CLI",
		async (toolId) => {
			const context = ownerContext();
			expect(
				await requireDestructiveToolApproval(
					context,
					{ ...ask, toolId },
					ask.annotations,
					options,
				),
			).toBeNull();
			expect(context.server.server.elicitInput).not.toHaveBeenCalled();
		},
	);
	it("retains a destructive ingress gate", async () => {
		expect(
			await requireDestructiveToolApproval(
				ownerContext(),
				ask,
				{ ...ask.annotations, destructiveHint: true },
				options,
			),
		).not.toBeNull();
	});
	it.each(["always", "work_item"])(
		"preserves an explicit %s ingress policy",
		async (approvalPolicy) => {
			expect(
				await requireDestructiveToolApproval(
					ownerContext(),
					{ ...ask, config: { ...ask.config, approvalPolicy } },
					ask.annotations,
					options,
				),
			).not.toBeNull();
		},
	);
	it.each([
		"kernelRuntime/respondApproval",
		"kernelRuntime/cancelRun",
		"other/enqueueMessage",
	])("does not exempt %s from approval", async (endpoint) => {
		expect(
			await requireDestructiveToolApproval(
				ownerContext(),
				{ ...ask, config: { ...ask.config, endpoint } },
				ask.annotations,
				options,
			),
		).not.toBeNull();
	});
});
