import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {},
}));
vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class NonRetryableError extends Error {},
}));

const mocks = vi.hoisted(() => ({
	cancel: vi.fn(),
	createDb: vi.fn(),
	fail: vi.fn(),
	get: vi.fn(),
	markRunning: vi.fn(),
	refresh: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({
	createDbClient: mocks.createDb,
}));
vi.mock("@tedix/db/queries/graph-projection-maintenance", () => ({
	cancelGraphProjectionMaintenance: mocks.cancel,
	failGraphProjectionMaintenance: mocks.fail,
	getGraphProjectionMaintenanceRun: mocks.get,
	markGraphProjectionMaintenanceRunning: mocks.markRunning,
}));
vi.mock("../services/graph-projection-algorithms", () => ({
	GraphProjectionAlgorithmRefreshError: class GraphProjectionAlgorithmRefreshError extends Error {
		reason: string;
		constructor(reason: string, message: string) {
			super(message);
			this.reason = reason;
		}
	},
	refreshGraphProjectionAlgorithms: mocks.refresh,
}));

import { GraphGdsRefreshWorkflow } from "./graph-gds-refresh-workflow";

const db = {};
const event = {
	instanceId: "graph-gds-1",
	payload: {
		runtimeEnvironment: "production" as const,
		organizationId: "org-1",
		ledgerId: "graph-gds-1",
		source: "mcp" as const,
	},
};

function stepHarness() {
	const calls: string[] = [];
	return {
		calls,
		step: {
			do: vi.fn(
				async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					calls.push(name);
					return callback();
				},
			),
		},
	};
}

function workflow() {
	const instance = new GraphGdsRefreshWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	(instance as unknown as { env: CloudflareEnv }).env = {
		DB: {},
		ENVIRONMENT: "production",
	} as CloudflareEnv;
	return instance;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDb.mockReturnValue(db);
	mocks.markRunning.mockResolvedValue({ status: "running" });
	mocks.cancel.mockResolvedValue({ status: "canceled" });
	mocks.fail.mockResolvedValue({ status: "failed" });
	mocks.refresh.mockResolvedValue({ watermark: 42, epoch: "epoch-1" });
});

describe("GraphGdsRefreshWorkflow", () => {
	it("reuses a committed terminal receipt instead of replaying Neo4j mutation", async () => {
		const completed = {
			id: "graph-gds-1",
			organizationId: "org-1",
			operation: "gds_refresh",
			workflowId: "graph-gds-1",
			status: "completed",
			result: {
				operation: "gds_refresh",
				organizationId: "org-1",
				watermark: 42,
				epoch: "epoch-1",
			},
		};
		mocks.get.mockResolvedValue(completed);
		const { step, calls } = stepHarness();

		await expect(
			workflow().run(event as never, step as never),
		).resolves.toEqual(completed.result);
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(calls).toEqual([
			"mark GDS refresh running",
			"refresh graph data science projection",
		]);
	});

	it("settles cancellation before starting the expensive refresh", async () => {
		mocks.get.mockResolvedValue({
			operation: "gds_refresh",
			workflowId: "graph-gds-1",
			status: "cancel_requested",
		});
		const { step } = stepHarness();

		await expect(workflow().run(event as never, step as never)).rejects.toThrow(
			"Graph GDS refresh was canceled",
		);
		expect(mocks.cancel).toHaveBeenCalledWith(
			db,
			"production",
			"org-1",
			"graph-gds-1",
		);
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it("runs once and requires the maintenance row to own completion", async () => {
		mocks.get
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "queued",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "running",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "completed",
			});
		const { step } = stepHarness();

		await expect(
			workflow().run(event as never, step as never),
		).resolves.toEqual({
			operation: "gds_refresh",
			organizationId: "org-1",
			watermark: 42,
			epoch: "epoch-1",
		});
		expect(mocks.markRunning).toHaveBeenCalledWith(
			db,
			"production",
			"org-1",
			"graph-gds-1",
		);
		expect(mocks.refresh).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				operationId: "graph-gds-1",
				maintenanceRunId: "graph-gds-1",
				assertCanContinue: expect.any(Function),
			}),
		);
	});

	it("rejects a workflow dispatched through the wrong runtime environment", async () => {
		const mismatched = {
			...event,
			payload: { ...event.payload, runtimeEnvironment: "staging" as const },
		};
		const { step } = stepHarness();

		await expect(
			workflow().run(mismatched as never, step as never),
		).rejects.toThrow("runtime environment does not match");
		expect(mocks.get).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
	});

	it("fails closed on a malformed prior completed receipt", async () => {
		mocks.get.mockResolvedValue({
			operation: "gds_refresh",
			workflowId: "graph-gds-1",
			status: "completed",
			result: { operation: "gds_refresh", organizationId: "org-1" },
		});
		const { step } = stepHarness();

		await expect(workflow().run(event as never, step as never)).rejects.toThrow(
			"without a valid atomic receipt",
		);
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.fail).not.toHaveBeenCalled();
	});

	it("records refresh failure in the environment-fenced lifecycle", async () => {
		mocks.get
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "queued",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "running",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "running",
			});
		mocks.refresh.mockRejectedValueOnce(new Error("Aura unavailable"));
		const { step } = stepHarness();

		await expect(workflow().run(event as never, step as never)).rejects.toThrow(
			"Aura unavailable",
		);
		expect(mocks.fail).toHaveBeenCalledWith(
			db,
			"production",
			"org-1",
			"graph-gds-1",
			"Aura unavailable",
		);
	});

	it("settles cancellation observed during a refresh boundary", async () => {
		mocks.get
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "queued",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "running",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "cancel_requested",
			})
			.mockResolvedValueOnce({
				operation: "gds_refresh",
				workflowId: "graph-gds-1",
				status: "cancel_requested",
			});
		mocks.refresh.mockImplementationOnce(
			async (input: { assertCanContinue: () => Promise<void> }) => {
				await input.assertCanContinue();
				throw new Error("unreachable");
			},
		);
		const { step } = stepHarness();

		await expect(workflow().run(event as never, step as never)).rejects.toThrow(
			"canceled before the next mutation phase",
		);
		expect(mocks.cancel).toHaveBeenCalledWith(
			db,
			"production",
			"org-1",
			"graph-gds-1",
		);
		expect(mocks.fail).not.toHaveBeenCalled();
	});
});
