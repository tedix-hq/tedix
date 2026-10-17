import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
const mocks = vi.hoisted(() => ({ get: vi.fn(), attempts: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/crud", () => ({
	getWorkItemById: mocks.get,
}));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: mocks.attempts,
}));
import { disposableCleanupApprover } from "./disposable-cleanup-approval";
const db = {} as DbClient;
const input = {
	orgId: "fictional-org",
	tediId: "fictional-owner",
	actionType: "work_item.cleanup",
	payload: { operation: "cancel", workItemId: "scratch" },
};
const work = {
	id: "scratch",
	metadata: { disposable: true },
	sourceSessionKey: "codex:fictional",
	accountableOwnerType: "tedi",
	accountableOwnerId: "fictional-owner",
	riskLevel: "low",
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.get.mockResolvedValue(work);
	mocks.attempts.mockResolvedValue({ data: [] });
});
describe("disposable cleanup approval", () => {
	it("routes marked scratch cleanup to its owning tedi", async () => {
		expect(await disposableCleanupApprover(db, input)).toBe("fictional-owner");
		expect(mocks.get).toHaveBeenCalledWith(db, "scratch", "fictional-org");
	});
	it.each([
		{ metadata: {} },
		{ sourceSessionKey: null },
		{ accountableOwnerId: "another-owner" },
		{ riskLevel: "high" },
	])(
		"keeps ordinary Work and other owners behind approval: %j",
		async (override) => {
			mocks.get.mockResolvedValue({ ...work, ...override });
			expect(await disposableCleanupApprover(db, input)).toBeNull();
		},
	);
	it("preserves active Attempts and rejects unrelated provider actions", async () => {
		mocks.attempts.mockResolvedValue({
			data: [{ finishedAt: null, expiresAt: "2099-01-01T00:00:00Z" }],
		});
		expect(await disposableCleanupApprover(db, input)).toBeNull();
		expect(
			await disposableCleanupApprover(db, {
				...input,
				actionType: "home.tool_write",
			}),
		).toBeNull();
	});
	it("keeps expired Attempts intact and never crosses a tenant boundary", async () => {
		mocks.attempts.mockResolvedValue({
			data: [{ finishedAt: null, expiresAt: "2000-01-01T00:00:00Z" }],
		});
		expect(await disposableCleanupApprover(db, input)).toBe("fictional-owner");
		mocks.get.mockResolvedValue(null);
		expect(await disposableCleanupApprover(db, input)).toBeNull();
	});
});
