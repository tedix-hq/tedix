import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getBacklog: vi.fn(),
	getClient: vi.fn(),
	getReadiness: vi.fn(),
}));

vi.mock("@tedix/db/queries/graph-projection", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/db/queries/graph-projection")>();
	return {
		...actual,
		getGraphProjectionBacklogStats: mocks.getBacklog,
		getGraphProjectionReadState: mocks.getReadiness,
	};
});

vi.mock("../../integrations/graph-db/client", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../integrations/graph-db/client")>();
	return {
		...actual,
		getGraphClient: mocks.getClient,
	};
});

import { getContextAssemblyGraphClient } from "./memory-graph/policy-operations";

const db = {} as BaseContext["db"];
const env = {} as CloudflareEnv;
const context = {
	db,
	env,
	organizationId: "org-1",
} as BaseContext;
const graphClient = { isHealthy: vi.fn(async () => true) };

function readiness(overrides: Record<string, unknown> = {}) {
	return {
		state: "ready" as const,
		reason: null,
		persistedWatermark: 12,
		gdsWatermark: 12,
		projectionEpoch: "generation-a",
		gdsEpoch: "generation-a",
		nodeMismatchCount: 0,
		edgeMismatchCount: 0,
		lifecycleMismatchCount: 0,
		repairId: "repair-1",
		repairPhase: "complete" as const,
		repairCursor: null,
		repairHighWater: 12,
		repairStartedAt: "2026-07-27T05:00:00.000Z",
		lastCertifiedAt: new Date().toISOString(),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getClient.mockReturnValue(graphClient);
	mocks.getReadiness.mockResolvedValue(readiness());
	mocks.getBacklog.mockResolvedValue({
		cursor: 12,
		highWaterSequence: 12,
		pendingCount: 0,
		retryCount: 0,
		poisonedCount: 0,
		oldestPendingAt: null,
	});
});

describe("context assembly graph admission", () => {
	it("omits graph boosts when GDS is stale despite a certified base projection", async () => {
		mocks.getReadiness.mockResolvedValue(
			readiness({
				gdsWatermark: 11,
				gdsEpoch: "generation-old",
			}),
		);

		await expect(
			getContextAssemblyGraphClient(context),
		).resolves.toBeUndefined();
		expect(mocks.getReadiness).toHaveBeenCalledWith(db, "org-1");
		expect(mocks.getBacklog).toHaveBeenCalledWith(db, "org-1");
	});

	it("provides the graph client only for a matching certified GDS snapshot", async () => {
		await expect(getContextAssemblyGraphClient(context)).resolves.toBe(
			graphClient,
		);
	});
});
