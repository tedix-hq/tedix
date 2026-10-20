import { createRouterClient } from "@orpc/server";
import { projectsContract } from "@tedix/api-contract/contracts/projects";
import { procedureOutputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { expect, it, vi } from "vite-plus/test";
import * as z from "zod";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({
	getProjectById: vi.fn(),
	getProjectRollup: vi.fn(),
}));

vi.mock("@tedix/db/queries/projects", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getProjectById: mocks.getProjectById,
	getProjectRollup: mocks.getProjectRollup,
}));

it("returns top-level work kinds without undeclared rollup fields", async () => {
	const projectId = "10000000-0000-4000-8000-000000000001";
	const orgId = "20000000-0000-4000-8000-000000000001";
	mocks.getProjectById.mockResolvedValueOnce({ id: projectId, orgId });
	mocks.getProjectRollup.mockResolvedValueOnce({
		projectId,
		total: 1,
		byDisposition: { accepted: 1 },
		byWorkKind: { coding: 1 },
		percentDone: 0,
		aggregateDisposition: "accepted",
		distinctExecutors: [],
		topLevelItems: [
			{
				id: "work-1",
				workKind: "coding",
				title: "Fix schema",
				status: "accepted",
			},
		],
		truncated: false,
	});
	const context = {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: orgId,
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
	const result = await client.getRollup({ id: projectId });
	const schema = procedureOutputSchema(projectsContract.getRollup);
	if (!(schema instanceof z.ZodObject))
		throw new Error("Expected object output");
	// Equality also catches undeclared nested fields that Zod would strip.
	expect(schema.strict().parse(result)).toEqual(result);
	expect(result.topLevelItems).toEqual([
		{
			id: "work-1",
			workKind: "coding",
			title: "Fix schema",
			disposition: "accepted",
		},
	]);
	expect(mocks.getProjectRollup).toHaveBeenCalledWith(context.db, {
		orgId,
		projectId,
	});
});
