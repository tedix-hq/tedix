import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	actor: vi.fn(),
	update: vi.fn(),
	project: vi.fn(),
	pinned: vi.fn(),
}));
vi.mock("./policy-helpers", async (original) => ({
	...(await original<typeof import("./policy-helpers")>()),
	assertWorkItemAccess: mocks.access,
	workItemStewardActor: mocks.actor,
}));
vi.mock("@tedix/db/queries/work-items/crud", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/crud")>()),
	updateWorkItemSpecification: mocks.update,
}));
vi.mock("@tedix/db/queries/work-items/purpose", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/purpose")>()),
	assertValidWorkItemProject: mocks.project,
}));
vi.mock("@tedix/db/queries/work-items/milestones", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/work-items/milestones")
	>()),
	workItemHasMilestoneLinks: mocks.pinned,
}));
import { WorkItemProjectError } from "@tedix/db/queries/work-items/purpose";
import { updateSpecificationProcedure } from "./factory-lifecycle";

const TARGET = "22222222-2222-4222-8222-222222222222";
const item = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org-acme",
	version: 3,
	projectId: "33333333-3333-4333-8333-333333333333",
	workClass: "objective",
	objectiveId: "objective-a",
};
function move(input: Record<string, unknown> = {}) {
	return updateSpecificationProcedure["~orpc"].handler!({
		input: { id: item.id, projectId: TARGET, ...input },
		context: { db: {} } as BaseContext,
		path: ["workItems", "updateSpecification"],
		procedure: updateSpecificationProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockResolvedValue(item);
	mocks.actor.mockResolvedValue({ type: "user", id: "acme-owner" });
	mocks.update.mockResolvedValue(item);
	mocks.project.mockResolvedValue({ key: "B", objectiveId: "objective-b" });
	mocks.pinned.mockResolvedValue(false);
});

it("moves owner Work to another project and takes that project's objective", async () => {
	await move();
	expect(mocks.project).toHaveBeenCalledWith(
		{},
		{ orgId: "org-acme", projectId: TARGET },
	);
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			projectId: TARGET,
			objectiveId: "objective-b",
			expectedWorkItemVersion: 3,
		}),
	);
});

it("keeps operational purpose when operational Work moves", async () => {
	mocks.access.mockResolvedValue({
		...item,
		workClass: "maintenance",
		objectiveId: null,
	});
	mocks.project.mockResolvedValue({ key: "B", objectiveId: null });
	await move();
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ projectId: TARGET, objectiveId: undefined }),
	);
});

it.each([
	[
		"a tedi",
		() => mocks.actor.mockResolvedValue({ type: "tedi", id: "steward" }),
		"owner/admin controlled",
	],
	[
		"a project in another organization",
		() =>
			mocks.project.mockRejectedValue(
				new WorkItemProjectError("wrong_org", "other org"),
			),
		"Project not found",
	],
	[
		"Work pinned by a milestone",
		() => mocks.pinned.mockResolvedValue(true),
		"detach it before moving",
	],
	[
		"objective Work into a project without an objective",
		() => mocks.project.mockResolvedValue({ key: "B", objectiveId: null }),
		"project with an objective",
	],
])("refuses moving %s", async (_label, arrange, message) => {
	arrange();
	await expect(move()).rejects.toThrow(message);
	expect(mocks.update).not.toHaveBeenCalled();
});

it("refuses a move combined with purpose repair", async () => {
	mocks.access.mockResolvedValue({
		...item,
		workClass: "maintenance",
		objectiveId: null,
		purposeExceptionExpiresAt: "2026-11-01T00:00:00.000Z",
	});
	await expect(
		move({ purposeExceptionExpiresAt: "2026-11-20T00:00:00.000Z" }),
	).rejects.toThrow("separate updates");
	expect(mocks.update).not.toHaveBeenCalled();
});

it("treats the current project as no move", async () => {
	await move({ projectId: item.projectId, title: "Renamed" });
	expect(mocks.project).not.toHaveBeenCalled();
	expect(mocks.pinned).not.toHaveBeenCalled();
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ title: "Renamed", objectiveId: undefined }),
	);
});
