import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	claim: vi.fn(),
	confirm: vi.fn(),
	tedi: vi.fn(),
	stop: vi.fn(),
}));
vi.mock("@tedix/db/queries/cognitive-runtime-orphan-cleanup", () => ({
	listPendingOrphanWorkflowCleanups: mocks.list,
	claimOrphanWorkflowCleanup: mocks.claim,
	confirmOrphanWorkflowCleanup: mocks.confirm,
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTediByIdForOrganization: mocks.tedi,
}));
vi.mock("@tedix/provisioning", () => ({
	cleanupOrphanRuntimeTurn: mocks.stop,
}));
vi.mock("../rpc/routers/tedis/helpers", () => ({
	getProvisioningConfig: () => ({ workerUrl: "https://worker.example.test" }),
}));
import { cleanupOrphanWorkflows } from "./orphan-workflow-cleanup";
const item = {
	terminalEventId: "terminal-1",
	organizationId: "org-1",
	tediId: "tedi-1",
	runId: "tedi-1:mcp:request-1",
	sealedAt: "2026-10-31T11:00:00Z",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.list.mockResolvedValue([item]);
	mocks.claim.mockResolvedValue(true);
	mocks.tedi.mockResolvedValue({
		id: "tedi-1",
		organizationId: "org-1",
		slug: "worker",
	});
	mocks.stop.mockResolvedValue({ success: true, detail: "terminated" });
});
it("uses the exact tenant and terminal cutoff and acknowledges only confirmed native cleanup", async () => {
	expect(await cleanupOrphanWorkflows({} as never, {} as never)).toEqual({
		cleanupChecked: 1,
		cleanupConfirmed: 1,
		cleanupPending: 0,
	});
	expect(mocks.tedi).toHaveBeenCalledWith({}, "tedi-1", "org-1");
	expect(mocks.stop).toHaveBeenCalledWith(
		{ workerUrl: "https://worker.example.test" },
		{
			clientRequestId: "request-1",
			runId: item.runId,
			orphanedBefore: item.sealedAt,
		},
	);
	expect(mocks.confirm).toHaveBeenCalledWith({}, item, "terminated");
});
it("leaves failed, unsupported, and unverified stops pending for later ticks", async () => {
	for (const value of [
		null,
		{ success: false },
		{ success: true, detail: "unknown" },
	]) {
		mocks.confirm.mockClear();
		if (value === null)
			mocks.stop.mockRejectedValue(new Error("private transport failure"));
		else mocks.stop.mockResolvedValue(value);
		expect(
			(await cleanupOrphanWorkflows({} as never, {} as never)).cleanupPending,
		).toBe(1);
		expect(mocks.confirm).not.toHaveBeenCalled();
	}
});
it("does not call a runtime when a competing tick or restart wins the claim", async () => {
	mocks.claim.mockResolvedValue(false);
	await cleanupOrphanWorkflows({} as never, {} as never);
	expect(mocks.stop).not.toHaveBeenCalled();
});
it("drains old pending rows on every invocation with at most four native calls in flight", async () => {
	mocks.list.mockResolvedValue(
		Array.from({ length: 20 }, (_, i) => ({
			...item,
			terminalEventId: `terminal-${i}`,
		})),
	);
	let active = 0,
		max = 0;
	mocks.stop.mockImplementation(async () => {
		active++;
		max = Math.max(max, active);
		await Promise.resolve();
		active--;
		return { success: true, detail: "already_settled" };
	});
	const result = await cleanupOrphanWorkflows({} as never, {} as never);
	expect(result.cleanupConfirmed).toBe(20);
	expect(max).toBeLessThanOrEqual(4);
});
