import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	modelCatalogConfig,
	modelCatalogEntry,
} from "@tedix/api-contract/test/model-catalog";
import type { BaseContext } from "../orpc";
const mocks = vi.hoisted(() => ({
	registry: vi.fn(),
	app: vi.fn(),
	job: vi.fn(),
	workflow: vi.fn(),
}));
vi.mock("@tedix/db/queries/model-catalog", () => ({
	getModelCatalogConfig: mocks.registry,
}));
vi.mock("@tedix/db/queries/apps", () => ({ getAppBySlug: mocks.app }));
vi.mock("@tedix/db/queries/jobs", () => ({ createJob: mocks.job }));
import { mcpEvalContractRouter } from "./mcp-eval";
const context = {
	authType: "user",
	db: {},
	env: {
		DB: {},
		TEDIX_FLEET_AUTHORITY_MODE: "co-located",
		MCP_EVAL_WORKFLOW: { create: mocks.workflow },
	},
	headers: new Headers(),
	organizationId: "org-example",
	user: {
		sub: "operator",
		scope: "platform:admin",
		permissions: ["settings:manage"],
		roles: [],
	},
} as unknown as BaseContext;
const client = createRouterClient(mcpEvalContractRouter, { context });
beforeEach(() => {
	vi.clearAllMocks();
	mocks.registry.mockResolvedValue(
		modelCatalogConfig([modelCatalogEntry("azure-openai/sample-eval")]),
	);
	mocks.app.mockResolvedValue({ id: "admin-app" });
	mocks.job.mockResolvedValue({ id: "job-example" });
});
describe("evaluation registry boundary", () => {
	it("rejects unregistered refs before creating a job or dispatch", async () => {
		await expect(
			client.run({ appSlug: "sample", model: "azure-openai/unregistered" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.job).not.toHaveBeenCalled();
		expect(mocks.workflow).not.toHaveBeenCalled();
	});
	it("dispatches a configured custom model", async () => {
		await expect(
			client.run({ appSlug: "sample", model: "azure-openai/sample-eval" }),
		).resolves.toMatchObject({ jobId: "job-example" });
		expect(mocks.workflow).toHaveBeenCalledWith(
			expect.objectContaining({
				params: expect.objectContaining({ model: "azure-openai/sample-eval" }),
			}),
		);
	});
});
