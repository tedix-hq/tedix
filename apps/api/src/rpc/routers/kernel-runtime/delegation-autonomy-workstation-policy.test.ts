import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import * as dispatchPolicy from "../kernel/dispatch-policy";
const mocks = vi.hoisted(() => ({ approval: vi.fn() }));
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
	});
	const context = { db: {} } as BaseContext;
	function run(sourceContent: string, status = "requires_approval") {
		return {
			organizationId: "org",
			status,
			metadata: {
				approvalRequestId: "approval",
				delegationWorkOrder: { kind: "workstation.attach", sourceContent },
			},
		} as unknown as KernelRuntimeRun;
	}
	it("withholds direct delegation without verified route risk and warm-state evidence", async () => {
		for (const text of [
			"Research the paper",
			"Fix the parser through normal push gates",
		])
			expect(
				(await reviewWorkstationDelegationAutonomy(context, run(text)))
					?.allowed,
			).toBe(false);
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
	it.each([undefined, { orgId: "other" }])(
		"closes a non-critical legacy record without a current organization approval: %s",
		async (approval) => {
			vi.spyOn(dispatchPolicy, "classifyWorkstationDispatch").mockReturnValue({
				autoDispatch: true,
				risk: "low",
				reasons: ["independently verified dispatch eligibility"],
			});
			mocks.approval.mockResolvedValue(approval);
			expect(
				await reviewWorkstationDelegationAutonomy(context, run("Research")),
			).toMatchObject({ allowed: false, executionBlocked: true });
		},
	);
	it("does not close current-protocol records or interpret a lookup failure as absence", async () => {
		vi.spyOn(dispatchPolicy, "classifyWorkstationDispatch").mockReturnValue({
			autoDispatch: true,
			risk: "low",
			reasons: ["independently verified dispatch eligibility"],
		});
		mocks.approval.mockRejectedValue(new Error("database unavailable"));
		await expect(
			reviewWorkstationDelegationAutonomy(context, run("Research")),
		).rejects.toThrow("database unavailable");
		const current = run("Research");
		current.metadata = {
			...current.metadata,
			workItemId: "work",
		};
		expect(
			(await reviewWorkstationDelegationAutonomy(context, current))?.allowed,
		).toBe(true);
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
