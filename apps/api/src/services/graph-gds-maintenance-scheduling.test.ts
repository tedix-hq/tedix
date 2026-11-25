import { describe, expect, it, vi } from "vite-plus/test";
import { ensureGraphGdsRefreshWorkflow } from "./graph-gds-maintenance-scheduling";

function binding() {
	return {
		get: vi.fn(),
		create: vi.fn(),
	} as unknown as CloudflareEnv["GRAPH_GDS_REFRESH_WORKFLOW"];
}

describe("graph GDS Workflow scheduling", () => {
	it("creates the deterministic environment-fenced instance", async () => {
		const workflow = binding();
		vi.mocked(workflow.get).mockReturnValue({
			status: vi.fn().mockRejectedValue(new Error("not found")),
		} as never);
		vi.mocked(workflow.create).mockResolvedValue({} as never);

		await expect(
			ensureGraphGdsRefreshWorkflow(workflow, {
				id: "graph-gds-1",
				runtimeEnvironment: "production",
				organizationId: "org-1",
				source: "mcp",
			}),
		).resolves.toBe("created");
		expect(workflow.create).toHaveBeenCalledWith({
			id: "graph-gds-1",
			params: {
				runtimeEnvironment: "production",
				organizationId: "org-1",
				ledgerId: "graph-gds-1",
				source: "mcp",
			},
		});
	});

	it("skips the status probe for a newly won reservation", async () => {
		const workflow = binding();
		vi.mocked(workflow.create).mockResolvedValue({} as never);

		await expect(
			ensureGraphGdsRefreshWorkflow(
				workflow,
				{
					id: "graph-gds-1",
					runtimeEnvironment: "production",
					organizationId: "org-1",
					source: "mcp",
				},
				{ preferCreate: true },
			),
		).resolves.toBe("created");
		expect(workflow.get).not.toHaveBeenCalled();
	});

	it("accepts a duplicate-create race only after the instance is readable", async () => {
		const workflow = binding();
		const status = vi
			.fn()
			.mockRejectedValueOnce(new Error("not found"))
			.mockResolvedValueOnce({ status: "queued" });
		vi.mocked(workflow.get).mockReturnValue({ status } as never);
		vi.mocked(workflow.create).mockRejectedValue(new Error("already exists"));

		await expect(
			ensureGraphGdsRefreshWorkflow(workflow, {
				id: "graph-gds-1",
				runtimeEnvironment: "production",
				organizationId: "org-1",
				source: "mcp",
			}),
		).resolves.toBe("existing");
	});
});
