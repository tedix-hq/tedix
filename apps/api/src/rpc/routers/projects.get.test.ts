import { createRouterClient } from "@orpc/server";
import { projectsContract } from "@tedix/api-contract/contracts/projects";
import { procedureOutputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { projectsContractRouter } from "./projects";

const mocks = vi.hoisted(() => ({
	getProjectById: vi.fn(),
	getObjectiveById: vi.fn(),
}));

vi.mock("@tedix/db/queries/projects", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getProjectById: mocks.getProjectById,
}));

vi.mock("@tedix/db/queries/tedi-objectives", async (original) => ({
	...(await original<Record<string, unknown>>()),
	getObjectiveById: mocks.getObjectiveById,
}));

const projectId = "10000000-0000-4000-8000-000000000001";
const orgId = "20000000-0000-4000-8000-000000000001";
const objectiveId = "30000000-0000-4000-8000-000000000001";
const project = {
	id: projectId,
	orgId,
	key: "ORCHARD",
	name: "Orchard research",
	description: null,
	status: "active",
	leadTediId: null,
	ownerUserId: null,
	objectiveId,
	targetDate: null,
	metadata: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: null,
	archivedAt: null,
};
const context = {
	authType: "user",
	db: {} as BaseContext["db"],
	env: { ENVIRONMENT: "test" } as CloudflareEnv,
	headers: new Headers(),
	organizationId: orgId,
	url: new URL("https://api.tedix.test/rpc/projects"),
	user: {
		permissions: ["tedis:read"],
		roles: [],
		sub: "user-1",
	},
} as BaseContext;
const client = createRouterClient(projectsContractRouter, { context });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getProjectById.mockResolvedValue(project);
});

it("returns the project's objective summary through the contract", async () => {
	mocks.getObjectiveById.mockResolvedValue({
		id: objectiveId,
		orgId,
		title: "Grow healthy orchards",
		priority: 0,
		description: "A longer brief",
	});
	const result = await client.get({ id: projectId });
	expect(result.objective).toEqual({
		id: objectiveId,
		title: "Grow healthy orchards",
		priority: 0,
	});
	expect(procedureOutputSchema(projectsContract.get).parse(result)).toEqual(
		result,
	);
	expect(mocks.getObjectiveById).toHaveBeenCalledWith(context.db, objectiveId);
});

it("returns null without looking up an objective when none is linked", async () => {
	mocks.getProjectById.mockResolvedValue({ ...project, objectiveId: null });
	expect((await client.get({ id: projectId })).objective).toBeNull();
	expect(mocks.getObjectiveById).not.toHaveBeenCalled();
});

it.each([
	undefined,
	{ id: objectiveId, orgId: "another-org", title: "Private", priority: 1 },
])(
	"returns null for a missing or out-of-scope objective: %j",
	async (objective) => {
		mocks.getObjectiveById.mockResolvedValue(objective);
		expect((await client.get({ id: projectId })).objective).toBeNull();
	},
);

it("checks project access before reading its objective", async () => {
	mocks.getProjectById.mockResolvedValue({ ...project, orgId: "another-org" });
	await expect(client.get({ id: projectId })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	expect(mocks.getObjectiveById).not.toHaveBeenCalled();
});
