import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	eligible: true,
	status: "pending",
	admit: vi.fn(),
	dispatch: vi.fn(),
	fyi: vi.fn(),
	resolve: vi.fn(),
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	getKernelRuntimeRun: vi.fn(async () => ({
		id: "home",
		organizationId: "org",
		conversationId: "conversation",
		status: "requires_approval",
		metadata: {
			approvalRequestId: "approval",
			workItemId: "work",
			delegationWorkOrder: {
				kind: "workstation.attach",
				targetTediId: "tedi",
				sourceContent: "Research the paper",
				executionRequirement: {
					surface: "native",
					requiredCapabilities: [],
					fallbackSurface: null,
					prohibitedSurfaces: [],
					satisfiable: true,
					reason: "research",
				},
			},
		},
	})),
}));
vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalRequestById: vi.fn(async () => ({
		orgId: "org",
		status: mocks.status,
	})),
	resolveApprovalRequest: mocks.resolve,
}));
vi.mock("@tedix/db/queries/work-items/delegation-autonomy", () => ({
	recordDelegationFyi: mocks.fyi,
}));
vi.mock("../kernel/delegation-work-item", () => ({
	createDelegationWorkItem: mocks.admit,
}));
vi.mock("../kernel/workstation-dispatch", () => ({
	workstationDispatchIdentity: vi.fn(() => ({ runtimeRunId: "child" })),
}));
vi.mock("./run-reads-streams", () => ({
	resolveKernelDelegateTarget: vi.fn(async () => ({
		id: "tedi",
		slug: "researcher",
	})),
}));
vi.mock("./control-proposals", () => ({
	resolveKernelWorkstationAttachWorkOrder: mocks.dispatch,
}));
vi.mock("./delegation-autonomy-review", () => ({
	reviewDelegationAutonomy: vi.fn(async () => ({ allowed: mocks.eligible })),
}));
import { releaseWorkstationDelegationAutonomy } from "./delegation-autonomy-workstation";

describe("direct workstation policy migration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.eligible = true;
		mocks.status = "pending";
		mocks.admit.mockResolvedValue("work");
		mocks.resolve.mockImplementation(async () => {
			if (mocks.status !== "pending") return null;
			mocks.status = "approved";
			return { id: "approval" };
		});
		mocks.dispatch.mockResolvedValue({
			run: { childRunId: "child", status: "queued" },
		});
	});
	const context = {} as BaseContext;
	const input = { organizationId: "org", runId: "home" };
	it("re-admits the exact Work, resolves as policy, dispatches once and records an FYI", async () => {
		await releaseWorkstationDelegationAutonomy(context, input);
		expect(mocks.admit.mock.calls[0][1]).toMatchObject({
			workItemId: "work",
			autonomyClass: "delegation:embodied",
			childRunId: "child",
		});
		expect(mocks.resolve.mock.calls[0][2].resolvedBy).toBe(
			"policy:delegation-autonomy.v1",
		);
		expect(mocks.dispatch.mock.calls[0][1].policyResolution).toBe(true);
		expect(mocks.fyi.mock.calls[0][1].fyi).toMatchObject({
			childRunId: "child",
			outcome: "queued",
			tediName: "researcher",
		});
		await expect(
			releaseWorkstationDelegationAutonomy(context, input),
		).rejects.toThrow("no longer pending");
		expect(mocks.dispatch).toHaveBeenCalledTimes(1);
	});
	it("does not resolve critical work or work without a fresh admitted Attempt", async () => {
		mocks.eligible = false;
		await expect(
			releaseWorkstationDelegationAutonomy(context, input),
		).rejects.toThrow("policy eligible");
		expect(mocks.admit).not.toHaveBeenCalled();
		mocks.eligible = true;
		mocks.admit.mockRejectedValueOnce(new Error("admission denied"));
		await expect(
			releaseWorkstationDelegationAutonomy(context, input),
		).rejects.toThrow("admission denied");
		expect(mocks.resolve).not.toHaveBeenCalled();
		expect(mocks.dispatch).not.toHaveBeenCalled();
	});
});
