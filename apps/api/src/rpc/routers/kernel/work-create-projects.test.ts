import type { DbClient } from "@tedix/db/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { readWorkCreateProjects } from "./work-create-projects";

const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
	listOsWorkspaceProjects: vi.fn(),
}));
vi.mock("@tedix/db/queries/projects", () => ({
	listProjects: mocks.listProjects,
}));
vi.mock("@tedix/db/queries/os-workspaces/projects", () => ({
	listOsWorkspaceProjects: mocks.listOsWorkspaceProjects,
}));
const db = {} as DbClient;

beforeEach(() => vi.resetAllMocks());

it("reads only the current organization's active projects and workspace links, without private briefs", async () => {
	mocks.listProjects.mockResolvedValue({
		data: [
			{
				id: "project-a",
				name: "Accounts",
				key: "BOOKS",
				description: "private brief",
			},
		],
		total: 1,
	});
	mocks.listOsWorkspaceProjects.mockResolvedValue([{ projectId: "project-a" }]);
	const context = JSON.parse(
		await readWorkCreateProjects(db, {
			organizationId: "orchard",
			workspaceId: "accounts-space",
		}),
	);
	expect(mocks.listProjects).toHaveBeenCalledWith(db, {
		orgId: "orchard",
		status: "active",
		limit: 100,
	});
	expect(mocks.listOsWorkspaceProjects).toHaveBeenCalledWith(db, {
		organizationId: "orchard",
		workspaceId: "accounts-space",
		status: "active",
		limit: 100,
	});
	expect(context).toEqual({
		projects: [
			{
				projectId: "project-a",
				name: "Accounts",
				key: "BOOKS",
				linkedToSelectedWorkspace: true,
			},
		],
		truncated: false,
	});
	expect(JSON.stringify(context)).not.toContain("private brief");
});

it("keeps ambiguous names distinct and reports a truncated org list without inventing a workspace destination", async () => {
	mocks.listProjects.mockResolvedValue({
		data: [
			{ id: "a", name: "Accounts", key: "A" },
			{ id: "b", name: "Accounts", key: "B" },
		],
		total: 101,
	});
	const context = JSON.parse(
		await readWorkCreateProjects(db, { organizationId: "orchard" }),
	);
	expect(mocks.listOsWorkspaceProjects).not.toHaveBeenCalled();
	expect(
		context.projects.map((project: { projectId: string }) => project.projectId),
	).toEqual(["a", "b"]);
	expect(
		context.projects.every(
			(project: { linkedToSelectedWorkspace: boolean }) =>
				!project.linkedToSelectedWorkspace,
		),
	).toBe(true);
	expect(context.truncated).toBe(true);
});

it("does not turn a failed project lookup into made-up references", async () => {
	mocks.listProjects.mockRejectedValue(new Error("unavailable"));
	await expect(
		readWorkCreateProjects(db, { organizationId: "orchard" }),
	).rejects.toThrow("unavailable");
});
