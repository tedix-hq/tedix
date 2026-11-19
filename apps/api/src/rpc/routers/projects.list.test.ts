import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({
	listProjects: vi.fn(),
	excludedProject: vi.fn(),
}));

vi.mock("@tedix/db/queries/projects", async (original) => ({
	...(await original<Record<string, unknown>>()),
	listProjects: mocks.listProjects,
}));

vi.mock("../../services/agent-review-access", async (original) => ({
	...(await original<Record<string, unknown>>()),
	excludedAgentReviewProjectId: mocks.excludedProject,
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

it("applies the server-owned private-project exclusion before pagination", async () => {
	mocks.excludedProject.mockResolvedValueOnce("private-project");
	mocks.listProjects.mockResolvedValueOnce({ data: [], total: 4 });
	const context = {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		url: new URL("https://api.tedix.test/rpc/projects"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["tedis:read"],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
	const client = createRouterClient(projectsContractRouter, { context });
	const result = await client.list({ limit: 2, offset: 2 });
	expect(mocks.excludedProject).toHaveBeenCalledWith(context, ORG_ID);
	expect(mocks.listProjects).toHaveBeenLastCalledWith(context.db, {
		orgId: ORG_ID,
		excludeProjectId: "private-project",
		status: undefined,
		search: undefined,
		limit: 2,
		offset: 2,
	});
	expect(result.pagination).toEqual({
		limit: 2,
		offset: 2,
		total: 4,
		hasMore: false,
	});
});
