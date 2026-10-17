import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	actor: vi.fn(),
	update: vi.fn(),
	project: vi.fn(),
}));
vi.mock("@tedix/db/queries/projects", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/projects")>()),
	getProjectByIdForOrganization: mocks.project,
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
import { updateSpecificationProcedure } from "./factory-lifecycle";
const item = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org-acme",
	version: 2,
};
function select(
	expectedWorkItemVersion = 2,
	executor: "codex" | "human" = "codex",
	steward: { stewardType?: "tedi" | null; stewardId?: string | null } = {},
) {
	return updateSpecificationProcedure["~orpc"].handler!({
		input: { id: item.id, executor, expectedWorkItemVersion, ...steward },
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
	mocks.update.mockResolvedValue(item);
});
it("keeps executor reassignment owner/admin controlled", async () => {
	mocks.actor.mockResolvedValue({ type: "external_agent", id: "local-acme" });
	await expect(select()).rejects.toThrow("owner/admin controlled");
	expect(mocks.update).not.toHaveBeenCalled();
});
it("passes an owner selection through the current Work version fence", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "acme-owner" });
	await select();
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({
			orgId: "org-acme",
			executor: "codex",
			expectedWorkItemVersion: 2,
		}),
	);
	await expect(select(1)).rejects.toThrow("Work changed");
	expect(mocks.update).toHaveBeenCalledTimes(1);
});

it("lets a verified tedi steward escalate to human without granting a code executor", async () => {
	mocks.actor.mockResolvedValue({ type: "tedi", id: "example-steward" });
	await expect(select()).rejects.toThrow("owner/admin controlled");
	await select(2, "human");
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ executor: "human", expectedWorkItemVersion: 2 }),
	);
});

it("defaults unassigned code Work stewardship to the scoped project lead", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "acme-owner" });
	mocks.access.mockResolvedValue({
		...item,
		projectId: "example-project",
		stewardType: null,
		stewardId: null,
	});
	mocks.project.mockResolvedValue({ leadTediId: "example-lead" });
	await select();
	expect(mocks.project).toHaveBeenCalledWith({}, "org-acme", "example-project");
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ stewardType: "tedi", stewardId: "example-lead" }),
	);
});

it("preserves an existing steward when an owner selects a code executor", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "acme-owner" });
	mocks.access.mockResolvedValue({
		...item,
		projectId: "example-project",
		stewardType: "tedi",
		stewardId: "existing-steward",
	});
	await select();
	expect(mocks.project).not.toHaveBeenCalled();
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ stewardId: undefined }),
	);
});

it("preserves an owner's explicit removal of stewardship", async () => {
	mocks.actor.mockResolvedValue({ type: "user", id: "acme-owner" });
	mocks.access.mockResolvedValue({
		...item,
		projectId: "example-project",
		stewardType: "tedi",
		stewardId: "existing-steward",
	});
	await select(2, "codex", { stewardType: null, stewardId: null });
	expect(mocks.project).not.toHaveBeenCalled();
	expect(mocks.update).toHaveBeenCalledWith(
		{},
		expect.objectContaining({ stewardType: null, stewardId: null }),
	);
});
