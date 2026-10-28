import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { OsWorkspaceResourceRow } from "@tedix/db/schema/os-workspaces";
import { userContext } from "../rpc/test-context";

const mocks = vi.hoisted(() => ({
	run: vi.fn(),
	artifact: vi.fn(),
	allowed: vi.fn(),
	scope: vi.fn(),
	sources: vi.fn(),
	call: vi.fn(),
}));
vi.mock("@tedix/db/queries/skill-runs", async (load) => ({
	...(await load<object>()),
	getSkillRun: mocks.run,
}));
vi.mock("@tedix/db/queries/skill-run-artifacts", async (load) => ({
	...(await load<object>()),
	getRunArtifact: mocks.artifact,
}));
vi.mock("../rpc/orpc", async (load) => ({
	...(await load<object>()),
	hasTedisReadAuthorization: mocks.allowed,
	hasRequiredScope: mocks.scope,
}));
vi.mock("./os-derived-resource-access", () => ({
	authorizeDerivedOutputSources: mocks.sources,
}));
vi.mock("@orpc/server", async (load) => ({
	...(await load<object>()),
	call: mocks.call,
}));
import { readWorkspaceAppSkill } from "./os-app-skill-read";

const context = userContext({ permissions: ["tedis:read"] });
const resource = {
	providerId: "tedix",
	resourceType: "skill",
	status: "active",
	organizationId: "org-1",
	providerResourceId: "fictional-skill",
} as OsWorkspaceResourceRow;
const run = {
	id: "fictional-run",
	organizationId: "org-1",
	skillId: "fictional-skill",
	status: "completed",
	executionEpoch: 0,
	startedAt: "2026-01-01T08:00:00Z",
	completedAt: "2026-01-01T08:01:00Z",
	result: { count: 2 },
	error: null,
	workflowRetiredAt: null,
	resourceAccessEnvelope: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.allowed.mockReturnValue(true);
	mocks.scope.mockReturnValue(true);
	mocks.run.mockResolvedValue({ ...run });
	mocks.sources.mockResolvedValue(true);
	mocks.artifact.mockResolvedValue({ sizeBytes: 100 });
	mocks.call.mockResolvedValue({ content: "{}" });
});

describe("workspace app skill reads", () => {
	it("reads only the bound skill in the current organization and environment", async () => {
		expect(
			await readWorkspaceAppSkill(context, resource, {
				view: "run",
				runId: run.id,
			}),
		).toEqual({
			id: run.id,
			skillId: run.skillId,
			status: "completed",
			executionEpoch: 0,
			startedAt: run.startedAt,
			completedAt: run.completedAt,
			result: run.result,
		});
		expect(mocks.run).toHaveBeenCalledWith(context.db, run.id, "org-1", "test");
	});
	it.each([
		{ organizationId: "other-org" },
		{ skillId: "other-skill" },
		{ workflowRetiredAt: "2026-01-01" },
		{ error: "REVOKED: removed" },
	])("refuses a run outside the live grant: %j", async (patch) => {
		mocks.run.mockResolvedValue({ ...run, ...patch });
		await expect(
			readWorkspaceAppSkill(context, resource, { view: "run", runId: run.id }),
		).rejects.toThrow("Skill run not found");
		expect(mocks.call).not.toHaveBeenCalled();
	});
	it("requires both user permission and token scope", async () => {
		mocks.allowed.mockReturnValue(false);
		await expect(
			readWorkspaceAppSkill(context, resource, { view: "run", runId: run.id }),
		).rejects.toThrow("not permitted");
		mocks.allowed.mockReturnValue(true);
		mocks.scope.mockReturnValue(false);
		await expect(
			readWorkspaceAppSkill(context, resource, { view: "run", runId: run.id }),
		).rejects.toThrow("not permitted");
		expect(mocks.run).not.toHaveBeenCalled();
	});
	it("rechecks recorded source access before returning cached-report inputs", async () => {
		mocks.run.mockResolvedValue({
			...run,
			resourceAccessEnvelope: { version: 1, sources: [] },
		});
		mocks.sources.mockResolvedValue(false);
		await expect(
			readWorkspaceAppSkill(context, resource, { view: "run", runId: run.id }),
		).rejects.toThrow("no longer available");
	});
	it("does not expose inputs or arbitrary artifact paths", async () => {
		for (const path of [
			"inputs.json",
			"manifest.json",
			"outputs/../inputs.json",
		]) {
			await expect(
				readWorkspaceAppSkill(context, resource, {
					view: "artifact",
					runId: run.id,
					path,
				}),
			).rejects.toThrow();
		}
		expect(mocks.artifact).not.toHaveBeenCalled();
	});
	it("uses the canonical artifact read with the bound skill cross-check", async () => {
		await readWorkspaceAppSkill(context, resource, {
			view: "artifact",
			runId: run.id,
			path: "outputs/read.json",
		});
		expect(mocks.call).toHaveBeenCalledWith(
			expect.anything(),
			{
				runId: run.id,
				skillId: resource.providerResourceId,
				path: "outputs/read.json",
			},
			{ context },
		);
	});
	it("refuses oversized bodies before fetching them", async () => {
		mocks.artifact.mockResolvedValue({ sizeBytes: 262145 });
		await expect(
			readWorkspaceAppSkill(context, resource, {
				view: "artifact",
				runId: run.id,
				path: "outputs/read.json",
			}),
		).rejects.toThrow("256 KiB");
		expect(mocks.call).not.toHaveBeenCalled();
	});
});
