import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import { createDelegationWorkItem } from "./delegation-work-item";

const mocks = vi.hoisted(() => ({
	getWorkItemBySourceIntentId: vi.fn(),
	listWorkItemAttempts: vi.fn(),
	startWorkItemAttempt: vi.fn(),
	admitWorkAttempt: vi.fn(),
}));

vi.mock("@tedix/db/queries/work-items/crud", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/crud")
	>()),
	getWorkItemBySourceIntentId: mocks.getWorkItemBySourceIntentId,
}));
vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/attempts")
	>()),
	listWorkItemAttempts: mocks.listWorkItemAttempts,
	startWorkItemAttempt: mocks.startWorkItemAttempt,
}));
vi.mock("../work-items/attempt-admission", async (importOriginal) => ({
	...(await importOriginal<typeof import("../work-items/attempt-admission")>()),
	admitWorkAttempt: mocks.admitWorkAttempt,
}));

const NOW = "2026-10-22T11:06:50.000Z";
const CHILD_RUN_ID = "tedi-cfo:mcp:home-run_workstation_tedi-cfo";
const existing = {
	id: "work-1",
	orgId: "org-1",
	accountableOwnerType: "tedi",
	accountableOwnerId: "tedi-cfo",
	version: 3,
	admissionSpecRevision: "rev-1",
	metadata: {},
};

function attempt(overrides: Record<string, unknown>) {
	return {
		id: "attempt-1",
		workItemId: "work-1",
		runtimeState: "running",
		executorType: "tedi",
		executorId: "tedi-cfo",
		runId: CHILD_RUN_ID,
		expiresAt: "2026-10-22T11:08:22.000Z",
		...overrides,
	};
}

async function redispatch() {
	return createDelegationWorkItem({ db: {} } as unknown as BaseContext, {
		assigneeTediId: "tedi-cfo",
		childRunId: CHILD_RUN_ID,
		content: "Draft the invoice",
		conversationId: "home:os:conv",
		createdAt: NOW,
		executionRequirement: {
			surface: "workstation",
			requiredCapabilities: [],
			fallbackSurface: null,
			prohibitedSurfaces: [],
			satisfiable: true,
			reason: "test",
		},
		homeRunId: "home-run",
		organizationId: "org-1",
	});
}

describe("createDelegationWorkItem re-dispatch of the same child run", () => {
	it("reuses the Attempt the interrupted approval already admitted", async () => {
		mocks.getWorkItemBySourceIntentId.mockResolvedValue(existing);
		mocks.listWorkItemAttempts.mockResolvedValue({
			data: [attempt({})],
			nextCursor: null,
		});
		await expect(redispatch()).resolves.toBe("work-1");
		expect(mocks.admitWorkAttempt).not.toHaveBeenCalled();
		expect(mocks.startWorkItemAttempt).not.toHaveBeenCalled();
	});

	it.each([
		["another run", { runId: "tedi-cfo:mcp:other-run" }],
		["another executor", { executorId: "tedi-cto" }],
		["a settled attempt", { runtimeState: "failed" }],
		["a lapsed lease", { expiresAt: "2026-10-22T11:06:49.000Z" }],
		["a legacy null-expiry row", { expiresAt: null }],
	])("admits anew when the active attempt belongs to %s", async (_, row) => {
		mocks.getWorkItemBySourceIntentId.mockResolvedValue(existing);
		mocks.listWorkItemAttempts.mockResolvedValue({
			data: [attempt(row)],
			nextCursor: null,
		});
		mocks.admitWorkAttempt.mockResolvedValue({
			id: "admission-2",
			expiresAt: "2026-10-22T11:11:50.000Z",
		});
		mocks.startWorkItemAttempt.mockResolvedValue({});
		await expect(redispatch()).resolves.toBe("work-1");
		expect(mocks.admitWorkAttempt).toHaveBeenCalledTimes(1);
		expect(mocks.startWorkItemAttempt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ admissionId: "admission-2" }),
		);
	});
});
