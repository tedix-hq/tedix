import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	GraphProjectionAlgorithmRefreshError,
	refreshGraphProjectionAlgorithms,
} from "./graph-projection-algorithms";

const mocks = vi.hoisted(() => ({
	acquireLease: vi.fn(),
	commitMaintenance: vi.fn(),
	getBacklog: vi.fn(),
	getClient: vi.fn(),
	getReadiness: vi.fn(),
	invalidateCache: vi.fn(),
	refresh: vi.fn(),
	releaseLease: vi.fn(),
	renewLease: vi.fn(),
	setReadiness: vi.fn(),
}));

vi.mock("@tedix/db/queries/graph-projection", () => ({
	acquireGraphProjectionLease: mocks.acquireLease,
	getGraphProjectionBacklogStats: mocks.getBacklog,
	getGraphProjectionReadState: mocks.getReadiness,
	releaseGraphProjectionLease: mocks.releaseLease,
	renewGraphProjectionLease: mocks.renewLease,
	setGraphProjectionReadiness: mocks.setReadiness,
}));

vi.mock("@tedix/db/queries/graph-projection-maintenance", () => ({
	commitGraphProjectionMaintenanceGdsSuccess: mocks.commitMaintenance,
}));

vi.mock("../integrations/graph-db/client", () => ({
	getGraphClient: mocks.getClient,
}));

vi.mock("./memory-graph-context-assembly", () => ({
	invalidateInfluenceCache: mocks.invalidateCache,
}));

const db = {} as Parameters<typeof refreshGraphProjectionAlgorithms>[0]["db"];
const env = { ENVIRONMENT: "production" } as CloudflareEnv;

function readiness() {
	return {
		state: "ready" as const,
		reason: null,
		persistedWatermark: 12,
		gdsWatermark: 11,
		projectionEpoch: "generation-a",
		gdsEpoch: "generation-old",
		nodeMismatchCount: 0,
		edgeMismatchCount: 0,
		lifecycleMismatchCount: 0,
		repairId: "repair-1",
		repairPhase: "complete" as const,
		repairCursor: null,
		repairHighWater: 12,
		repairStartedAt: "2026-07-27T05:00:00.000Z",
		lastCertifiedAt: new Date().toISOString(),
	};
}

const backlog = {
	cursor: 12,
	highWaterSequence: 12,
	pendingCount: 0,
	retryCount: 0,
	poisonedCount: 0,
	oldestPendingAt: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.acquireLease.mockResolvedValue(true);
	mocks.commitMaintenance.mockResolvedValue(true);
	mocks.getBacklog.mockResolvedValue(backlog);
	mocks.getReadiness.mockResolvedValue(readiness());
	mocks.releaseLease.mockResolvedValue(undefined);
	mocks.renewLease.mockResolvedValue(true);
	mocks.setReadiness.mockResolvedValue(undefined);
	mocks.refresh.mockImplementation(
		async (
			_organizationId: string,
			options?: { beforeStep?: () => Promise<void> },
		) => {
			await options?.beforeStep?.();
			await options?.beforeStep?.();
		},
	);
	mocks.getClient.mockReturnValue({
		isHealthy: vi.fn(async () => true),
		refreshStructuralEmbeddings: mocks.refresh,
	});
});

describe("controlled graph algorithm refresh", () => {
	it("holds and renews the tenant lease, invalidates GDS admission, then stamps the stable snapshot", async () => {
		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
			}),
		).resolves.toEqual({ watermark: 12, epoch: "generation-a" });

		expect(mocks.acquireLease).toHaveBeenCalledWith(
			db,
			"org-1",
			expect.any(String),
			300_000,
		);
		const leaseToken = mocks.acquireLease.mock.calls[0]![2];
		expect(mocks.setReadiness).toHaveBeenNthCalledWith(1, db, {
			organizationId: "org-1",
			state: "ready",
			reason: null,
			gdsWatermark: 0,
			gdsEpoch: null,
		});
		expect(mocks.refresh).toHaveBeenCalledWith("org-1", {
			epoch: "generation-a",
			sourceWatermark: 12,
			attemptKey: `generation-a-12-workflow-1-${leaseToken}`,
			beforeStep: expect.any(Function),
		});
		expect(mocks.renewLease).toHaveBeenCalledTimes(3);
		for (const call of mocks.renewLease.mock.calls) {
			expect(call).toEqual([db, "org-1", leaseToken, 300_000]);
		}
		expect(mocks.setReadiness).toHaveBeenCalledTimes(1);
		expect(mocks.commitMaintenance).toHaveBeenCalledWith(db, {
			runtimeEnvironment: "production",
			organizationId: "org-1",
			id: "graph-gds-1",
			watermark: 12,
			epoch: "generation-a",
			result: {
				operation: "gds_refresh",
				organizationId: "org-1",
				watermark: 12,
				epoch: "generation-a",
			},
		});
		expect(mocks.invalidateCache).toHaveBeenCalledWith("org-1");
		expect(mocks.releaseLease).toHaveBeenCalledWith(db, "org-1", leaseToken);
	});

	it("fails before GDS mutation when another projection operation owns the lease", async () => {
		mocks.acquireLease.mockResolvedValue(false);

		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
			}),
		).rejects.toMatchObject<Partial<GraphProjectionAlgorithmRefreshError>>({
			reason: "projection_busy",
		});
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.releaseLease).not.toHaveBeenCalled();
	});

	it("keeps GDS admission invalid and releases the lease when refresh fails", async () => {
		mocks.refresh.mockRejectedValueOnce(new Error("GDS unavailable"));

		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
			}),
		).rejects.toThrow("GDS unavailable");

		expect(mocks.setReadiness).toHaveBeenCalledTimes(1);
		expect(mocks.setReadiness).toHaveBeenCalledWith(
			db,
			expect.objectContaining({
				gdsWatermark: 0,
				gdsEpoch: null,
			}),
		);
		expect(mocks.invalidateCache).not.toHaveBeenCalled();
		const leaseToken = mocks.acquireLease.mock.calls[0]![2];
		expect(mocks.releaseLease).toHaveBeenCalledWith(db, "org-1", leaseToken);
	});

	it("stops the refresh and leaves admission invalid when lease renewal fails", async () => {
		mocks.renewLease.mockResolvedValueOnce(false);

		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
			}),
		).rejects.toMatchObject<Partial<GraphProjectionAlgorithmRefreshError>>({
			reason: "projection_lease_lost",
		});

		expect(mocks.setReadiness).toHaveBeenCalledTimes(1);
		expect(mocks.invalidateCache).not.toHaveBeenCalled();
		const leaseToken = mocks.acquireLease.mock.calls[0]![2];
		expect(mocks.releaseLease).toHaveBeenCalledWith(db, "org-1", leaseToken);
	});

	it("checks cooperative cancellation before any GDS admission mutation", async () => {
		const assertCanContinue = vi.fn(async () => {
			throw new GraphProjectionAlgorithmRefreshError(
				"operation_cancelled",
				"cancelled",
			);
		});

		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
				assertCanContinue,
			}),
		).rejects.toMatchObject<Partial<GraphProjectionAlgorithmRefreshError>>({
			reason: "operation_cancelled",
		});
		expect(assertCanContinue).toHaveBeenCalledTimes(1);
		expect(mocks.setReadiness).not.toHaveBeenCalled();
		expect(mocks.refresh).not.toHaveBeenCalled();
		expect(mocks.releaseLease).toHaveBeenCalledOnce();
	});

	it("uses the maintenance-run CAS to publish freshness and task completion", async () => {
		const assertCanContinue = vi.fn(async () => undefined);

		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
				assertCanContinue,
			}),
		).resolves.toEqual({ watermark: 12, epoch: "generation-a" });

		expect(assertCanContinue).toHaveBeenCalledTimes(5);
		expect(mocks.commitMaintenance).toHaveBeenCalledWith(db, {
			runtimeEnvironment: "production",
			organizationId: "org-1",
			id: "graph-gds-1",
			watermark: 12,
			epoch: "generation-a",
			result: {
				operation: "gds_refresh",
				organizationId: "org-1",
				watermark: 12,
				epoch: "generation-a",
			},
		});
		// First call clears freshness. The terminal stamp is owned by the atomic
		// maintenance-run commit rather than a second unguarded readiness write.
		expect(mocks.setReadiness).toHaveBeenCalledTimes(1);
		expect(mocks.invalidateCache).toHaveBeenCalledWith("org-1");
	});

	it("fails closed when terminal maintenance ownership is canceled", async () => {
		mocks.commitMaintenance.mockResolvedValueOnce(false);

		await expect(
			refreshGraphProjectionAlgorithms({
				db,
				env,
				organizationId: "org-1",
				operationId: "workflow-1",
				maintenanceRunId: "graph-gds-1",
			}),
		).rejects.toMatchObject<Partial<GraphProjectionAlgorithmRefreshError>>({
			reason: "operation_cancelled",
		});
		expect(mocks.setReadiness).toHaveBeenCalledTimes(1);
		expect(mocks.invalidateCache).not.toHaveBeenCalled();
	});
});
