import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";

const mocks = vi.hoisted(() => ({ review: vi.fn(), settle: vi.fn() }));
vi.mock("./delegation-autonomy-review", () => ({
	reviewDelegationAutonomy: mocks.review,
}));
vi.mock("../kernel/run-store", () => ({
	asyncCompletionAssistantMessageId: (id: string) => `${id}:completion`,
	persistKernelTurnSettlement: mocks.settle,
}));
import { closePolicyBlockedDelegation } from "./delegation-autonomy-blocked";

const context = {} as BaseContext;
function run() {
	return {
		id: "home",
		organizationId: "org",
		conversationId: "conversation",
		status: "requires_approval",
		updatedAt: "2026-06-15T12:00:00.000Z",
		metadata: { approvalRequestId: "missing-approval" },
	} as unknown as KernelRuntimeRun;
}
beforeEach(() => {
	vi.clearAllMocks();
	mocks.review.mockResolvedValue({
		allowed: false,
		executionBlocked: true,
		workstation: true,
		reason: "legacy approval unavailable",
	});
	mocks.settle.mockResolvedValue({ runTransitioned: true });
});
it("retires a legacy orphan with its original reference and a blocked outcome", async () => {
	expect(await closePolicyBlockedDelegation(context, run())).toBe(true);
	const input = mocks.settle.mock.calls[0][1];
	expect(input.run).toMatchObject({
		fromStatus: "requires_approval",
		expectedUpdatedAt: "2026-06-15T12:00:00.000Z",
		patch: {
			status: "failed",
			progressLabel: "Blocked",
			metadata: {
				approvalRequestId: null,
				policyBlocked: {
					approvalRequestId: "missing-approval",
					resolvedBy: { type: "policy", id: "delegation-autonomy.v1" },
				},
			},
		},
	});
	expect(input.events.map((event: { kind: string }) => event.kind)).toEqual([
		"message.completed",
		"run.failed",
	]);
	expect(input.run.patch).not.toHaveProperty("childRunId");
});
it("reports a lost run CAS without claiming a successful closure", async () => {
	mocks.settle.mockResolvedValue({ runTransitioned: false });
	expect(await closePolicyBlockedDelegation(context, run())).toBe(false);
});
it("keeps critical holds and already dispatched or terminal runs untouched", async () => {
	mocks.review.mockResolvedValue({ allowed: false });
	expect(await closePolicyBlockedDelegation(context, run())).toBe(false);
	expect(
		await closePolicyBlockedDelegation(context, {
			...run(),
			childRunId: "child",
		}),
	).toBe(false);
	expect(
		await closePolicyBlockedDelegation(context, { ...run(), status: "failed" }),
	).toBe(false);
	expect(mocks.settle).not.toHaveBeenCalled();
});
