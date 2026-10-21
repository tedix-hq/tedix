import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
const mocks = vi.hoisted(() => ({ approval: vi.fn(), workItem: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.workItem,
}));
vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalRequestById: mocks.approval,
}));
vi.mock("../kernel/tedi-capabilities", () => ({
	readOrgDispatchPolicyLayer: vi.fn(async () => ({
		autonomy: { version: 1, maxRisk: "medium" },
	})),
}));
import { reviewWorkstationDelegationAutonomy } from "./delegation-autonomy-workstation-policy";

describe("direct pending delegation policy", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		mocks.approval.mockResolvedValue({ orgId: "org" });
		mocks.workItem.mockResolvedValue({ riskLevel: "medium" });
	});
	const context = { db: {} } as BaseContext;
	function run(sourceContent: string, status = "requires_approval") {
		return {
			organizationId: "org",
			status,
			metadata: {
				approvalRequestId: "approval",
				workItemId: "work",
				delegationWorkOrder: { kind: "workstation.attach", sourceContent },
			},
		} as unknown as KernelRuntimeRun;
	}
	it("releases non-critical orders under standing consent while retaining critical holds", async () => {
		for (const text of [
			"Research the paper",
			"Fix the parser through normal push gates",
		])
			expect(
				(await reviewWorkstationDelegationAutonomy(context, run(text)))
					?.allowed,
			).toBe(true);
		for (const text of [
			"Email a customer",
			"Delete records",
			"Publish a blog",
			"Prepare a delegation for approval first; do not dispatch",
		])
			expect(
				(await reviewWorkstationDelegationAutonomy(context, run(text)))
					?.allowed,
			).toBe(false);
	});
	it("retains legacy approvals when no Work risk is available", async () => {
		const legacy = run("Research");
		legacy.metadata = { ...legacy.metadata, workItemId: undefined };
		expect(
			await reviewWorkstationDelegationAutonomy(context, legacy),
		).toMatchObject({
			allowed: false,
			reason: "unknown risk requires human approval",
		});
		expect(mocks.workItem).not.toHaveBeenCalled();
	});
	it.each([
		["low", true],
		["medium", true],
		["high", false],
		["critical", false],
		[null, false],
	] as const)(
		"rechecks the linked Work's %s risk",
		async (riskLevel, allowed) => {
			mocks.workItem.mockResolvedValue({ riskLevel });
			expect(
				await reviewWorkstationDelegationAutonomy(context, run("Research")),
			).toMatchObject({ allowed });
			expect(mocks.workItem).toHaveBeenCalledWith(context.db, "work", "org");
		},
	);
	it("keeps a missing Work risk unknown and propagates lookup failures", async () => {
		mocks.workItem.mockResolvedValue(undefined);
		expect(
			await reviewWorkstationDelegationAutonomy(context, run("Research")),
		).toMatchObject({ allowed: false });
		mocks.workItem.mockRejectedValue(new Error("database unavailable"));
		await expect(
			reviewWorkstationDelegationAutonomy(context, run("Research")),
		).rejects.toThrow("database unavailable");
	});
	it.each(["row", "metadata", "receipt", "runtime"])(
		"retains approvals once child execution evidence exists: %s",
		async (location) => {
			const value = run("Research");
			if (location === "row") value.childRunId = "child";
			if (location === "metadata")
				value.metadata = { ...value.metadata, childRunId: "child" };
			if (location === "receipt")
				value.metadata = {
					...value.metadata,
					homeApprovedDispatch: { childRunId: "child" },
				};
			if (location === "runtime")
				value.runtimeMetadata = { childRunId: "child" };
			expect(
				await reviewWorkstationDelegationAutonomy(context, value),
			).toMatchObject({ allowed: false });
			expect(mocks.approval).not.toHaveBeenCalled();
		},
	);
	it("does not retire critical orphan records", async () => {
		mocks.approval.mockResolvedValue(undefined);
		expect(
			await reviewWorkstationDelegationAutonomy(
				context,
				run("Email a customer"),
			),
		).toMatchObject({ allowed: false });
		expect(mocks.approval).not.toHaveBeenCalled();
	});
	it("does not replay terminal or resolved runs", async () => {
		expect(
			await reviewWorkstationDelegationAutonomy(
				context,
				run("Research", "failed"),
			),
		).toBeNull();
		const resolved = run("Research");
		resolved.metadata = {
			...resolved.metadata,
			approvalResolvedAt: "2026-10-19T12:00:00Z",
		};
		expect(
			await reviewWorkstationDelegationAutonomy(context, resolved),
		).toBeNull();
	});
});
