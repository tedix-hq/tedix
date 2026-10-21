import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	load: vi.fn(),
	respond: vi.fn(),
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	countActiveDelegatedRunsByTedi: mocks.load,
}));
vi.mock("../kernel/tedi-capabilities", () => ({
	DEFAULT_DELEGATION_CONCURRENCY: 2,
	getTediCapabilityCards: async () => [
		{ tediId: "tedi-builder", name: "Builder", delegationConcurrency: 2 },
	],
}));
vi.mock("./approval-control", () => ({
	respondKernelDelegationRecommendationApprovalCore: mocks.respond,
}));

import { isCapacityDeferredDelegation } from "../../../kernel/delegation-deferral";
import { releaseCapacityDeferredDelegations } from "./delegation-capacity-release";

const context = { db: {} } as BaseContext;

function deferredRun(id: string, createdAt: string): KernelRuntimeRun {
	return {
		id,
		organizationId: "org-globex",
		conversationId: "home:main",
		status: "queued",
		childRunId: null,
		delegatedTediId: null,
		createdAt,
		metadata: {
			homeDelegation: {
				workOrder: { targetTediId: "tedi-builder", targetTediLabel: "Builder" },
				decision: {
					mode: "deferred",
					canAutoDispatch: false,
					reason: "capacity: target is already running 2 of its 2",
				},
			},
		},
	} as unknown as KernelRuntimeRun;
}

const runs = [
	deferredRun("home-run-2", "2026-10-21T12:02:00.000Z"),
	deferredRun("home-run-1", "2026-10-21T12:01:00.000Z"),
];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.respond.mockResolvedValue({});
});

describe("capacity-deferred delegations", () => {
	it("are waiting runs, not approvals", () => {
		expect(isCapacityDeferredDelegation(runs[0]!)).toBe(true);
		expect(
			isCapacityDeferredDelegation({
				...runs[0]!,
				status: "requires_approval",
			}),
		).toBe(false);
		expect(
			isCapacityDeferredDelegation({ ...runs[0]!, childRunId: "child-1" }),
		).toBe(false);
	});

	it("keep waiting while the target is full", async () => {
		mocks.load.mockResolvedValue(new Map([["tedi-builder", 2]]));
		expect(
			await releaseCapacityDeferredDelegations(context, "org-globex", runs),
		).toEqual([]);
		expect(mocks.respond).not.toHaveBeenCalled();
	});

	it("start automatically, oldest first, as slots free", async () => {
		mocks.load.mockResolvedValue(new Map([["tedi-builder", 1]]));
		expect(
			await releaseCapacityDeferredDelegations(context, "org-globex", runs),
		).toEqual(["home-run-1"]);
		expect(mocks.respond).toHaveBeenCalledTimes(1);
		expect(mocks.respond).toHaveBeenCalledWith(context, {
			organizationId: "org-globex",
			run: runs[1],
			decision: "approve",
			resolvedBy: { type: "policy", id: "delegation-capacity" },
			note: expect.stringContaining("Builder"),
			capacityRelease: true,
		});
	});
});
