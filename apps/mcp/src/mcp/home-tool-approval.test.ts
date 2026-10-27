import { describe, expect, it, vi } from "vite-plus/test";
import {
	isHomeApprovalCall,
	requireDestructiveToolApproval,
} from "./governance";
import * as analytics from "./utils/analytics";
import type { ServerContext } from "./server-context";
import { registerTextOnlyTool } from "./text-tool-registration";
import type { ToolCallback } from "./middleware/telemetry";
import * as toolExecution from "./tool-execution";

const args = {
	kind: "sheet",
	title: "Opportunities",
	content: { rows: [["Pricing"]] },
};
const options = {
	toolName: "os.create_os_output",
	args,
	extra: { _meta: { "com.tedix/homeApprovalRequestId": "approval-1" } },
};
function context(
	resolve: ReturnType<typeof vi.fn>,
	kernel = true,
	authType = "service",
	identity: { userId?: string; approvedHomeUserId?: string } = {
		userId: "user-1",
	},
) {
	return {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "example-unified",
		app: { organizationId: "org-1" },
		callerIdentity: {
			kernel,
			authType,
			...identity,
			organizationId: "org-1",
		},
		apiClient: { mcpGovernance: { resolveHomeToolApproval: resolve } },
	} as unknown as ServerContext;
}
describe("Home approval at MCP dispatch", () => {
	it.each([{ userId: "user-1" }, { approvedHomeUserId: "user-1" }])(
		"audits the kernel on behalf of the member for %j",
		async (identity) => {
			const audit = vi
				.spyOn(analytics, "emitMcpAuditEvent")
				.mockImplementation(() => {});
			const agent = context(
				vi.fn().mockResolvedValue({ approved: true }),
				true,
				"service",
				identity,
			);
			Object.assign(agent, {
				appId: "app-1",
				env: {},
				ctx: { waitUntil: vi.fn() },
			});
			try {
				expect(
					await requireDestructiveToolApproval(
						agent,
						{ toolId: "tedix__create_os_output", title: "Create output" },
						{ destructiveHint: true },
						options,
					),
				).toBeNull();
				expect(audit).toHaveBeenCalledWith(
					agent.env,
					expect.objectContaining({
						userId: "user-1",
						authType: "service",
						metadata: expect.objectContaining({
							governance: "destructive_approved",
							reason: "home_tool_approval",
							actor: "kernel on behalf of user:user-1",
							delegationMode: "kernel",
							subjectUserId: "user-1",
						}),
					}),
					expect.any(Function),
				);
				expect(agent.callerIdentity).toEqual(expect.objectContaining(identity));
				expect(agent.callerIdentity?.userId).toBe(identity.userId);
			} finally {
				audit.mockRestore();
			}
		},
	);

	it("accepts only the exact server-verified call without another elicitation", async () => {
		const resolve = vi.fn().mockResolvedValue({ approved: true });
		expect(
			await requireDestructiveToolApproval(
				context(resolve),
				{ toolId: "tedix__create_os_output", title: "Create output" },
				{ destructiveHint: true },
				options,
			),
		).toBeNull();
		expect(resolve).toHaveBeenCalledWith({
			organizationId: "org-1",
			userId: "user-1",
			appSlug: "example-unified",
			toolName: "os.create_os_output",
			args,
			approvalRequestId: "approval-1",
			credential: "user",
		});
	});
	it.each([true, false])(
		"native dispatch executes only after receipt verification (%s)",
		async (approved) => {
			const execute = vi.spyOn(toolExecution, "executeTool").mockResolvedValue({
				content: [],
				structuredContent: { ok: true },
				_meta: {},
			});
			const audit = vi
				.spyOn(analytics, "emitMcpAuditEvent")
				.mockImplementation(() => {});
			let callback: ToolCallback | undefined;
			const resolve = vi.fn().mockResolvedValue({ approved });
			const agent = context(resolve);
			Object.assign(agent, {
				env: {},
				ctx: { waitUntil: vi.fn() },
				requestMeta: {
					"com.tedix/homeApprovalRequestId": "approval-1",
					"com.tedix/homeApprovalToolName": "os.create_os_output",
				},
				server: {
					registerTool: vi.fn((_name, _spec, handler: ToolCallback) => {
						callback = handler;
						return {};
					}),
				},
				registeredTools: new Map(),
				appToolIds: new Set(),
				loadedTools: new Map(),
				authRequiredTools: new Set(),
			});
			try {
				await registerTextOnlyTool(
					agent,
					{
						toolId: "tedix__create_os_output",
						toolTypeId: "rpc",
						title: "Create output",
						inputSchema: { type: "object", properties: {} },
						config: {
							transport: "rpc",
							endpoint: "osWorkspaces/outputs/create",
						},
					} as unknown as Parameters<typeof registerTextOnlyTool>[1],
					{} as never,
					{ readOnlyHint: false },
				);
				if (!callback) throw new Error("Missing registered callback");
				await callback(args, {} as Parameters<ToolCallback>[1]);
				expect(resolve).toHaveBeenCalledWith(
					expect.objectContaining({ toolName: "os.create_os_output", args }),
				);
				if (approved)
					expect(execute).toHaveBeenCalledWith(
						agent,
						expect.any(Object),
						args,
						expect.objectContaining({ homeApprovedCall: true }),
					);
				else expect(execute).not.toHaveBeenCalled();
			} finally {
				execute.mockRestore();
				audit.mockRestore();
			}
		},
	);
	it.each(["os.create_os_output", "os.delete_os_output", 42])(
		"binds a native replay's stored callable to its current server identity (%s)",
		async (storedName) => {
			const resolve = vi.fn().mockResolvedValue({ approved: true });
			const result = await requireDestructiveToolApproval(
				context(resolve),
				{
					toolId: "tedix__create_os_output",
					title: "Create output",
					config: { transport: "rpc", endpoint: "osWorkspaces/outputs/create" },
				},
				{ readOnlyHint: false },
				{
					args,
					extra: {
						_meta: {
							"com.tedix/homeApprovalRequestId": "approval-1",
							"com.tedix/homeApprovalToolName": storedName,
						},
					},
				},
			);
			if (storedName === "os.create_os_output") {
				expect(result).toBeNull();
				expect(resolve).toHaveBeenCalledWith(
					expect.objectContaining({
						toolName: storedName,
						args,
						approvalRequestId: "approval-1",
					}),
				);
			} else {
				expect(result).toMatchObject({ isError: true });
				expect(resolve).not.toHaveBeenCalled();
			}
		},
	);
	it("matches a tenant-credential retry to the approval's member", async () => {
		const resolve = vi.fn().mockResolvedValue({ approved: true });
		expect(
			await requireDestructiveToolApproval(
				context(resolve, true, "service", { approvedHomeUserId: "user-1" }),
				{ toolId: "tedix__create_os_output", title: "Create output" },
				{ destructiveHint: true },
				options,
			),
		).toBeNull();
		expect(resolve).toHaveBeenCalledWith(
			expect.objectContaining({ userId: "user-1", credential: "tenant" }),
		);
	});
	it("does not look up a receipt without any member identity", async () => {
		const resolve = vi.fn().mockResolvedValue({ approved: true });
		await requireDestructiveToolApproval(
			context(resolve, true, "service", {}),
			{ toolId: "tedix__create_os_output", title: "Create output" },
			{ destructiveHint: true },
			options,
		);
		expect(resolve).not.toHaveBeenCalled();
	});
	it.each([false, "error"])(
		"fails closed when receipt verification returns %s",
		async (result) => {
			const resolve =
				result === "error"
					? vi.fn().mockRejectedValue(new Error("unavailable"))
					: vi.fn().mockResolvedValue({ approved: false });
			expect(
				await requireDestructiveToolApproval(
					context(resolve),
					{ toolId: "tedix__create_os_output", title: "Create output" },
					{ destructiveHint: true },
					options,
				),
			).toMatchObject({ isError: true });
		},
	);
	it.each([
		[false, "service"],
		[true, "oauth"],
		[true, "external_agent"],
	])(
		"does not trust client metadata for kernel=%s authType=%s",
		async (kernel, authType) => {
			const resolve = vi.fn().mockResolvedValue({ approved: true });
			await requireDestructiveToolApproval(
				context(resolve, kernel, authType),
				{ toolId: "tedix__create_os_output", title: "Create output" },
				{ readOnlyHint: true },
				options,
			);
			expect(resolve).not.toHaveBeenCalled();
		},
	);
	it.each([
		[true, "service", options, true],
		[false, "service", options, false],
		[true, "oauth", options, false],
		[true, "service", { extra: { _meta: {} } }, false],
	])(
		"marks a call for scoped delegation only on a kernel Home replay (kernel=%s authType=%s)",
		(kernel, authType, callOptions, expected) => {
			expect(
				isHomeApprovalCall(context(vi.fn(), kernel, authType), callOptions),
			).toBe(expected);
		},
	);
});
