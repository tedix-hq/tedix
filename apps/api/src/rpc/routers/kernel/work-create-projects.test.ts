import type { DbClient } from "@tedix/db/client";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import {
	readWorkCreateProjects,
	workCreateProjectName,
} from "./work-create-projects";

const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
}));
vi.mock("@tedix/db/queries/projects", () => ({
	listProjects: mocks.listProjects,
}));
const db = {} as DbClient;

beforeEach(() => vi.resetAllMocks());

it("reads only the current organization's active projects, without private briefs", async () => {
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
	const context = JSON.parse(
		await readWorkCreateProjects(db, { organizationId: "orchard" }),
	);
	expect(mocks.listProjects).toHaveBeenCalledWith(db, {
		orgId: "orchard",
		status: "active",
		limit: 100,
	});
	expect(context).toEqual({
		projects: [{ projectId: "project-a", name: "Accounts", key: "BOOKS" }],
		truncated: false,
	});
	expect(JSON.stringify(context)).not.toContain("private brief");
	expect(workCreateProjectName(JSON.stringify(context), "project-a")).toBe(
		"Accounts",
	);
	expect(workCreateProjectName(JSON.stringify(context), "missing")).toBeNull();
});

it("keeps ambiguous names distinct and reports a truncated org list", async () => {
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
	expect(
		context.projects.map((project: { projectId: string }) => project.projectId),
	).toEqual(["a", "b"]);
	expect(context.truncated).toBe(true);
});

it("does not turn a failed project lookup into made-up references", async () => {
	mocks.listProjects.mockRejectedValue(new Error("unavailable"));
	await expect(
		readWorkCreateProjects(db, { organizationId: "orchard" }),
	).rejects.toThrow("unavailable");
});
