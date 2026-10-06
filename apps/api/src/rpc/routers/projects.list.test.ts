import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({ listProjects: vi.fn() }));

vi.mock("@tedix/db/queries/projects", async (original) => ({
	...(await original<Record<string, unknown>>()),
	listProjects: mocks.listProjects,
}));

const ORG_ID = "22222222-2222-4222-8222-222222222222";

describe("project list search and paging", () => {
	it("passes the bounded search to the tenant-scoped query and reports its total", async () => {
		mocks.listProjects.mockResolvedValueOnce({ data: [], total: 125 });
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

		const result = await client.list({
			limit: 20,
			offset: 20,
			search: " KeY ",
		});

		expect(mocks.listProjects).toHaveBeenCalledWith(context.db, {
			orgId: ORG_ID,
			status: undefined,
			search: "KeY",
			limit: 20,
			offset: 20,
		});
		expect(result.pagination).toEqual({
			limit: 20,
			offset: 20,
			total: 125,
			hasMore: true,
		});
	});
});
