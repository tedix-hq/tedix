import { describe, expect, it, vi, beforeEach } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
const mocks = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn() }));
vi.mock("@tedix/db/queries/kernel-runtime-runs", () => ({
	getKernelRuntimeRun: mocks.run,
}));
vi.mock("@tedix/db/queries/approvals", () => ({
	getApprovalRequestById: mocks.get,
}));
import { factoryApprovalContext } from "./factory-approval";
import { isLifecycleOverrideAuthority } from "../rpc/routers/cognitive-shared";
const org = "11111111-1111-4111-8111-111111111111";
const input = { factory: "sample-review" };
const context = () =>
	({
		authType: "service-binding",
		organizationId: org,
		descopeUserId: "sample-user",
		headers: new Headers({ "X-Tedix-Approved-Factory-Request": "approval-1" }),
		db: {},
	}) as BaseContext;
const approval = () => ({
	id: "approval-1",
	orgId: org,
	status: "approved",
	resolvedBy: "sample-user",
	payload: {
		kind: "home_tool_write",
		toolName: "projects.pause_factory",
		organizationId: org,
		initiatedByUserId: "sample-user",
		args: input,
		homeRunId: "sample-run",
		conversationId: "sample-chat",
	},
});
beforeEach(() => {
	mocks.get.mockResolvedValue(approval());
	mocks.run.mockResolvedValue({
		status: "running",
		conversationId: "sample-chat",
		metadata: { kernelWriteExecutedAt: "2026-10-16T10:00:00Z" },
	});
});
describe("factory approval authority", () => {
	it("earns local operator authority only for the exact approved call", async () => {
		const original = context();
		const admitted = await factoryApprovalContext(
			original,
			"projects.pause_factory",
			input,
		);
		expect(isLifecycleOverrideAuthority(admitted)).toBe(true);
		expect(isLifecycleOverrideAuthority(original)).toBe(false);
		expect(admitted.authType).toBe("service-binding");
	});
	it.each(["pending", "rejected", "expired"])(
		"refuses %s approval",
		async (status) => {
			mocks.get.mockResolvedValue({ ...approval(), status });
			await expect(
				factoryApprovalContext(context(), "projects.pause_factory", input),
			).rejects.toThrow();
		},
	);
	it("refuses a different factory, operation, tenant, initiating user or policy-only approval", async () => {
		await expect(
			factoryApprovalContext(context(), "projects.pause_factory", {
				factory: "other-review",
			}),
		).rejects.toThrow();
		await expect(
			factoryApprovalContext(context(), "projects.archive_factory", input),
		).rejects.toThrow();
		for (const patch of [
			{ orgId: "other-org" },
			{ resolvedBy: "policy" },
			{ payload: { ...approval().payload, initiatedByUserId: "other-user" } },
		]) {
			mocks.get.mockResolvedValue({ ...approval(), ...patch });
			await expect(
				factoryApprovalContext(context(), "projects.pause_factory", input),
			).rejects.toThrow();
		}
	});
	it("does not turn external headers or a tedi into operator authority", async () => {
		for (const patch of [
			{ authType: "tedi", tediId: "sample-tedi" },
			{ authType: "service-binding", tediId: "sample-tedi" },
		]) {
			const caller = { ...context(), ...patch } as BaseContext;
			expect(
				await factoryApprovalContext(caller, "projects.pause_factory", input),
			).toBe(caller);
		}
	});
});

it("refuses replay after the approved Home run has completed", async () => {
	mocks.run.mockResolvedValue({
		status: "completed",
		conversationId: "sample-chat",
	});
	await expect(
		factoryApprovalContext(context(), "projects.pause_factory", input),
	).rejects.toThrow();
});
