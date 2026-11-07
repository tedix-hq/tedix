import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	owner: vi.fn(),
	ready: vi.fn(),
	reassign: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<typeof import("./policy-helpers")>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.owner,
}));
vi.mock("@tedix/db/queries/work-items/readiness", () => ({
	deriveWorkItemReadiness: mocks.ready,
}));
vi.mock("@tedix/db/queries/work-items/idle-reassignment", () => ({
	reassignIdleWork: mocks.reassign,
}));
import { updateSpecificationProcedure } from "./factory-lifecycle";
const input = {
	id: "11111111-1111-4111-8111-111111111111",
	expectedWorkItemVersion: 3,
	executor: "opencode" as const,
	idleReassignment: {
		fromExecutor: "codex" as const,
		unavailableSince: "2026-11-07T21:45:00Z",
		minimumIdleMinutes: 15,
		reason: "busy" as const,
	},
};
const invoke = (value = input) =>
	updateSpecificationProcedure["~orpc"].handler!({
		input: value,
		context: { db: {} } as BaseContext,
		path: [],
		procedure: updateSpecificationProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockResolvedValue({
		id: input.id,
		orgId: "org-acme",
		version: 3,
	});
	mocks.owner.mockResolvedValue("example-owner");
	mocks.ready.mockResolvedValue({ ready: true });
	mocks.reassign.mockResolvedValue({ id: input.id });
});
it("requires owner authority and startable Work before the atomic reassignment", async () => {
	await invoke();
	expect(mocks.owner).toHaveBeenCalled();
	expect(mocks.reassign).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			orgId: "org-acme",
			expectedVersion: 3,
			executor: "opencode",
			fromExecutor: "codex",
		}),
	);
});
it("retains assignment when readiness fails", async () => {
	mocks.ready.mockResolvedValue({ ready: false });
	await expect(invoke()).rejects.toThrow("not startable");
	expect(mocks.reassign).not.toHaveBeenCalled();
});
it("denies a caller without owner/admin authority", async () => {
	mocks.owner.mockRejectedValue(new Error("owner/admin required"));
	await expect(invoke()).rejects.toThrow("owner/admin");
	expect(mocks.ready).not.toHaveBeenCalled();
	expect(mocks.reassign).not.toHaveBeenCalled();
});
it("does not combine reassignment with a specification change", async () => {
	await expect(
		invoke({ ...input, title: "Different brief" } as typeof input),
	).rejects.toThrow("without specification edits");
	expect(mocks.reassign).not.toHaveBeenCalled();
});
