import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	owner: vi.fn(),
	restore: vi.fn(),
	project: vi.fn(),
	objective: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<typeof import("./policy-helpers")>()),
	assertWorkItemAccess: mocks.access,
	requireOwnerAdminWorkItemAuthor: mocks.owner,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/crud")>()),
	restoreWorkItemFiling: mocks.restore,
}));
vi.mock("@tedix/db/queries/work-items/purpose", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/purpose")>()),
	assertValidWorkItemProject: mocks.project,
	requireOrgObjective: mocks.objective,
}));
import { restoreFilingProcedure } from "./factory-lifecycle";

const ID = "11111111-1111-4111-8111-111111111111";
const item = { id: ID, orgId: "org-acme", version: 3 };
function restore(input: Record<string, unknown> = {}) {
	return restoreFilingProcedure["~orpc"].handler!({
		input: {
			id: ID,
			expectedWorkItemVersion: 3,
			projectId: null,
			objectiveId: null,
			workClass: "maintenance",
			purposeExceptionExpiresAt: "2026-11-30T00:00:00.000Z",
			...input,
		},
		context: { db: {} } as BaseContext,
		path: ["workItems", "restoreFiling"],
		procedure: restoreFilingProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockResolvedValue(item);
	mocks.owner.mockResolvedValue("acme-owner");
	mocks.restore.mockResolvedValue(item);
});

it("restores a null project and the original class as the acting owner", async () => {
	await restore();
	expect(mocks.project).not.toHaveBeenCalled();
	expect(mocks.restore).toHaveBeenCalledWith(
		{},
		{
			orgId: "org-acme",
			workItemId: ID,
			actor: { type: "user", id: "acme-owner" },
			expectedWorkItemVersion: 3,
			filing: {
				projectId: null,
				objectiveId: null,
				workClass: "maintenance",
				purposeExceptionExpiresAt: "2026-11-30T00:00:00.000Z",
			},
		},
	);
});

it("checks a restored project and objective against the Work's organization", async () => {
	const projectId = "33333333-3333-4333-8333-333333333333";
	const objectiveId = "44444444-4444-4444-8444-444444444444";
	await restore({
		projectId,
		objectiveId,
		workClass: "objective",
		purposeExceptionExpiresAt: null,
	});
	expect(mocks.project).toHaveBeenCalledWith(
		{},
		{ orgId: "org-acme", projectId },
	);
	expect(mocks.objective).toHaveBeenCalledWith(
		{},
		{ orgId: "org-acme", objectiveId },
	);
});

it("rejects non-owner/admin callers and a stale version before writing", async () => {
	mocks.owner.mockRejectedValue(new Error("owner/admin required"));
	await expect(restore()).rejects.toThrow("owner/admin required");
	mocks.owner.mockResolvedValue("acme-owner");
	await expect(restore({ expectedWorkItemVersion: 2 })).rejects.toThrow(
		"Work changed before filing restore",
	);
	expect(mocks.restore).not.toHaveBeenCalled();
});
