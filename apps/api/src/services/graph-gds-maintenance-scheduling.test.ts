import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ensureGraphGdsRefreshWorkflow,
	reconcileStaleGraphGdsRefreshes,
} from "./graph-gds-maintenance-scheduling";

const mocks = vi.hoisted(() => ({
	cancel: vi.fn(),
	fail: vi.fn(),
	listStale: vi.fn(),
}));

vi.mock("@tedix/db/queries/graph-projection-maintenance", () => ({
	cancelGraphProjectionMaintenance: mocks.cancel,
	failGraphProjectionMaintenance: mocks.fail,
	listStaleGraphProjectionMaintenanceRuns: mocks.listStale,
}));

const db = {} as Parameters<typeof reconcileStaleGraphGdsRefreshes>[0]["db"];

function binding() {
	return {
		get: vi.fn(),
		create: vi.fn(),
	} as unknown as CloudflareEnv["GRAPH_GDS_REFRESH_WORKFLOW"];
}

function run(
	overrides: Partial<{
		id: string;
		workflowId: string;
		runtimeEnvironment: "production";
		organizationId: string;
		status: "queued" | "running" | "cancel_requested";
	}> = {},
) {
	return {
		id: "graph-gds-1",
		workflowId: "graph-gds-1",
		runtimeEnvironment: "production" as const,
		organizationId: "org-1",
		status: "queued" as const,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cancel.mockResolvedValue({ status: "canceled" });
	mocks.fail.mockResolvedValue({ status: "failed" });
});

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

	it("redrives only stale queued rows returned for this environment", async () => {
		const workflow = binding();
		vi.mocked(workflow.get).mockReturnValue({
			status: vi.fn().mockRejectedValue(new Error("not found")),
		} as never);
		vi.mocked(workflow.create).mockResolvedValue({} as never);
		mocks.listStale.mockResolvedValue([run()]);

		await expect(
			reconcileStaleGraphGdsRefreshes({
				db,
				binding: workflow,
				runtimeEnvironment: "production",
				nowMs: Date.parse("2026-07-28T00:01:00.000Z"),
			}),
		).resolves.toEqual({
			candidates: 1,
			created: 1,
			existing: 0,
			settled: 0,
			failed: 0,
		});
		expect(mocks.listStale).toHaveBeenCalledWith(db, {
			runtimeEnvironment: "production",
			updatedBefore: "2026-07-28T00:00:30.000Z",
			limit: 10,
		});
	});

	it("creates a missing instance for a cancel-requested reservation", async () => {
		const workflow = binding();
		vi.mocked(workflow.get).mockReturnValue({
			status: vi.fn().mockRejectedValue(new Error("not found")),
		} as never);
		vi.mocked(workflow.create).mockResolvedValue({} as never);
		mocks.listStale.mockResolvedValue([run({ status: "cancel_requested" })]);

		await expect(
			reconcileStaleGraphGdsRefreshes({
				db,
				binding: workflow,
				runtimeEnvironment: "production",
				nowMs: Date.parse("2026-07-28T00:01:00.000Z"),
			}),
		).resolves.toMatchObject({ created: 1, failed: 0 });
		expect(workflow.create).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "graph-gds-1",
				params: expect.objectContaining({ source: "redrive" }),
			}),
		);
	});

	it.each(["complete", "errored", "terminated"])(
		"settles native %s without a D1 terminal receipt as failed",
		async (nativeStatus) => {
			const workflow = binding();
			vi.mocked(workflow.get).mockReturnValue({
				status: vi.fn().mockResolvedValue({ status: nativeStatus }),
			} as never);
			mocks.listStale.mockResolvedValue([run({ status: "running" })]);

			await expect(
				reconcileStaleGraphGdsRefreshes({
					db,
					binding: workflow,
					runtimeEnvironment: "production",
					nowMs: Date.parse("2026-07-28T00:01:00.000Z"),
				}),
			).resolves.toMatchObject({ settled: 1, failed: 0 });
			expect(mocks.fail).toHaveBeenCalledWith(
				db,
				"production",
				"org-1",
				"graph-gds-1",
				expect.stringContaining(nativeStatus),
			);
		},
	);

	it("settles a cancel-requested terminal instance as canceled", async () => {
		const workflow = binding();
		vi.mocked(workflow.get).mockReturnValue({
			status: vi.fn().mockResolvedValue({ status: "terminated" }),
		} as never);
		mocks.listStale.mockResolvedValue([run({ status: "cancel_requested" })]);

		await expect(
			reconcileStaleGraphGdsRefreshes({
				db,
				binding: workflow,
				runtimeEnvironment: "production",
				nowMs: Date.parse("2026-07-28T00:01:00.000Z"),
			}),
		).resolves.toMatchObject({ settled: 1 });
		expect(mocks.cancel).toHaveBeenCalledWith(
			db,
			"production",
			"org-1",
			"graph-gds-1",
		);
	});

	it("leaves a running row untouched on an ambiguous status error", async () => {
		const workflow = binding();
		vi.mocked(workflow.get).mockReturnValue({
			status: vi.fn().mockRejectedValue(new Error("provider unavailable")),
		} as never);
		mocks.listStale.mockResolvedValue([run({ status: "running" })]);

		await expect(
			reconcileStaleGraphGdsRefreshes({
				db,
				binding: workflow,
				runtimeEnvironment: "production",
				nowMs: Date.parse("2026-07-28T00:01:00.000Z"),
			}),
		).resolves.toMatchObject({ failed: 1, settled: 0 });
		expect(mocks.fail).not.toHaveBeenCalled();
		expect(mocks.cancel).not.toHaveBeenCalled();
	});
});
