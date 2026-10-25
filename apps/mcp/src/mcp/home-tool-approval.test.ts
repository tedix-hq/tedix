import { describe, expect, it, vi } from "vite-plus/test";
import { requireDestructiveToolApproval } from "./governance";
import type { ServerContext } from "./server-context";

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
) {
	return {
		server: { server: { elicitInput: vi.fn() } },
		appSlug: "example-unified",
		app: { organizationId: "org-1" },
		callerIdentity: {
			kernel,
			authType,
			userId: "user-1",
			organizationId: "org-1",
		},
		apiClient: { mcpGovernance: { resolveHomeToolApproval: resolve } },
	} as unknown as ServerContext;
}
describe("Home approval at MCP dispatch", () => {
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
		});
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
});
