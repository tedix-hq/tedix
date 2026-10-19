import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
vi.mock("../kernel/tedi-capabilities", () => ({
	readOrgDispatchPolicyLayer: vi.fn(async () => ({
		autonomy: { version: 1, maxRisk: "medium" },
	})),
}));
import { reviewWorkstationDelegationAutonomy } from "./delegation-autonomy-workstation-policy";

describe("direct pending delegation policy", () => {
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
	it("permits bounded research and code, while retaining critical and explicit human holds", async () => {
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
