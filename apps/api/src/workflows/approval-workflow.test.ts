import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

const mocks = vi.hoisted(() => ({
	audit: vi.fn(),
	createDb: vi.fn(),
	expire: vi.fn(),
	failGadget: vi.fn(),
	getApproval: vi.fn(),
	getTedi: vi.fn(),
	settleGadget: vi.fn(),
}));

vi.mock("@tedix/db/client", () => ({ createDbClient: mocks.createDb }));
vi.mock("@tedix/db/queries/approvals", () => ({
	expireStaleApprovals: mocks.expire,
	getApprovalRequestById: mocks.getApproval,
}));
vi.mock("@tedix/db/queries/tedis", () => ({ getTediById: mocks.getTedi }));
vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.audit,
}));
vi.mock("../services/os-gadget-approval-settlement", () => ({
	failOsGadgetApprovalDispatch: mocks.failGadget,
	settleOsGadgetApproval: mocks.settleGadget,
}));

import { ApprovalWorkflow } from "./approval-workflow";

function approval(status: string) {
	return {
		id: "approval-1",
		tediId: "tedi-1",
		orgId: "org-1",
		actionType: "os_gadget_execution",
		description: "Dispatch Gadget",
		payload: { executionId: "execution-1" },
		status,
		createdAt: "2026-08-17T00:00:00.000Z",
		expiresAt: "2026-08-20T00:00:00.000Z",
		resolvedAt: status === "pending" ? null : "2026-08-17T00:01:00.000Z",
		resolvedBy: status === "pending" ? null : "approver-1",
		resolution: null,
		workflowId: "approval-approval-1",
	};
}

function harness(onWait?: () => void) {
	const calls: string[] = [];
	const step = {
		do: vi.fn(
			async (name: string, _options: unknown, callback: () => unknown) => {
				calls.push(name);
				return callback();
			},
		),
		waitForEvent: vi.fn(async (name: string, options: unknown) => {
			calls.push(name);
			onWait?.();
			return { payload: { status: "approved" }, options };
		}),
	};
	const workflow = new ApprovalWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	(workflow as unknown as { env: CloudflareEnv }).env = {
		DB: {},
		ENVIRONMENT: "test",
	} as CloudflareEnv;
	return {
		calls,
		step,
		run: () =>
			workflow.run(
				{
					instanceId: "approval-approval-1",
					payload: {
						approvalRequestId: "approval-1",
						tediId: "tedi-1",
						orgId: "org-1",
						ttlHours: 1,
					},
				} as never,
				step as never,
			),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.createDb.mockReturnValue({});
	mocks.expire.mockResolvedValue(0);
	mocks.getTedi.mockResolvedValue(null);
	mocks.audit.mockResolvedValue(undefined);
	mocks.settleGadget.mockResolvedValue({
		handled: true,
		dispatched: true,
		execution: { id: "execution-1", status: "queued" },
	});
	mocks.failGadget.mockResolvedValue(null);
});

describe("ApprovalWorkflow", () => {
	it("wakes on the resolution event and settles the linked Gadget automatically", async () => {
		let status = "pending";
		mocks.getApproval.mockImplementation(async () => approval(status));
		const { run, step } = harness(() => {
			status = "approved";
		});

		await expect(run()).resolves.toMatchObject({
			approvalRequestId: "approval-1",
			finalStatus: "approved",
		});
		expect(step.waitForEvent).toHaveBeenCalledWith("approval-resolution-0", {
			type: "approval-resolution",
			timeout: "5 minutes",
		});
		expect(mocks.settleGadget).toHaveBeenCalledOnce();
		expect(mocks.failGadget).not.toHaveBeenCalled();
	});

	it("settles rejection without waiting for a browser-side second action", async () => {
		mocks.getApproval.mockResolvedValue(approval("rejected"));
		const { run, step } = harness();

		await expect(run()).resolves.toMatchObject({ finalStatus: "rejected" });
		expect(step.waitForEvent).not.toHaveBeenCalled();
		expect(mocks.settleGadget).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ status: "rejected" }),
		);
	});

	it("terminalizes a claimed receipt when dispatch retries exhaust", async () => {
		const row = approval("approved");
		mocks.getApproval.mockResolvedValue(row);
		mocks.settleGadget.mockRejectedValue(new Error("runtime unavailable"));
		const { run } = harness();

		await expect(run()).resolves.toMatchObject({ finalStatus: "approved" });
		expect(mocks.failGadget).toHaveBeenCalledWith(
			expect.anything(),
			row,
			expect.objectContaining({ message: "runtime unavailable" }),
		);
	});
});
