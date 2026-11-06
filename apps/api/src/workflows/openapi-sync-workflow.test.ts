import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
const mocks = vi.hoisted(() => ({
	import: vi.fn(),
	publish: vi.fn(),
	app: vi.fn(),
	metadata: vi.fn(),
	list: vi.fn(),
	discovery: vi.fn(),
	projection: vi.fn(),
	review: vi.fn(),
	writeCapabilityReport: vi.fn(async () => ({
		totalTools: 0,
		totalApps: 0,
		listed: 0,
		truncated: false,
		items: [],
		summary: "Every tool declares a write capability.",
	})),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppMetadataById: mocks.metadata,
	getLinkedOpenApiCatalogSnapshot: async () => null,
	listApiSyncApps: mocks.list,
}));
vi.mock("@tedix/db/queries/app-records", () => ({ getAppById: mocks.app }));
vi.mock("@tedix/db/queries/catalog/mcp-tools", () => ({
	projectCatalogToolsFromBaseApp: mocks.projection,
}));
vi.mock("@tedix/db/queries/catalog/write-capability", () => ({
	reportUnclassifiedWriteCapability: mocks.writeCapabilityReport,
}));
vi.mock("../lib/mcp-subscriptions", () => ({
	publishMcpListChangedEvents: mocks.publish,
}));
vi.mock("../services/openapi-tool-import", () => ({
	executeOpenApiToolImport: mocks.import,
}));
vi.mock("../services/google-discovery-tool-import", () => ({
	runGoogleDiscoveryToolImport: mocks.discovery,
}));
vi.mock("../services/tool-review-approvals", () => ({
	ensurePendingToolReviewApprovals: mocks.review,
}));
import {
	OpenApiSyncWorkflow,
	type OpenApiSyncWorkflowInput,
} from "./openapi-sync-workflow";

type TestStep = {
	do: (name: string, callback: () => Promise<unknown>) => Promise<unknown>;
};
async function run(
	dryRun = false,
	payload: OpenApiSyncWorkflowInput = { appId: "app" },
	step: TestStep = {
		do: async (_name, callback) => callback(),
	},
) {
	const instance = new OpenApiSyncWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	(instance as unknown as { env: CloudflareEnv }).env = {} as CloudflareEnv;
	return instance.run(
		{ payload: { ...payload, dryRun } } as never,
		step as never,
	);
}

describe("OpenAPI sync inventory activation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.metadata.mockResolvedValue({});
		mocks.list.mockResolvedValue([]);
		mocks.app.mockResolvedValue({
			id: "app",
			organizationId: "org",
			name: "Graph",
			slug: "graph",
			customMcpDomain: "graph.example.test",
		});
		mocks.import.mockImplementation(async (_db, input) => ({
			appId: input.appId,
			dryRun: input.dryRun,
			created: 0,
			updated: 1,
			deleted: 0,
			inSync: 0,
			failed: 0,
			items: [],
		}));
	});
	it("requests review without exposing an applied import", async () => {
		await run();
		expect(mocks.review).toHaveBeenCalledWith(
			{},
			{
				appId: "app",
				appName: "Graph",
				organizationId: "org",
			},
		);
		expect(mocks.publish).not.toHaveBeenCalled();
	});
	it("does not invalidate inventory for dry runs", async () => {
		await run(true);
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.app).not.toHaveBeenCalled();
	});
	it("reports the residual undeclared write-capability backlog per app", async () => {
		mocks.writeCapabilityReport.mockResolvedValue({
			totalTools: 2,
			totalApps: 1,
			listed: 2,
			truncated: false,
			items: [
				{ toolId: "create_issue", appId: "app", reason: "no_annotations" },
				{ toolId: "send_mail", appId: "app", reason: "no_annotations" },
			],
			summary: "2 enabled tool(s) have no declared write capability",
		});
		const result = await run();
		expect(mocks.writeCapabilityReport).toHaveBeenCalledWith(
			expect.anything(),
			{ appId: "app", limit: 100 },
		);
		expect(result.writeCapabilityReport).toHaveLength(1);
		expect(result.writeCapabilityReport[0].items.map((i) => i.toolId)).toEqual([
			"create_issue",
			"send_mail",
		]);
	});
	it("does not invalidate unchanged tools", async () => {
		mocks.import.mockResolvedValue({
			dryRun: false,
			created: 0,
			updated: 0,
			deleted: 0,
			inSync: 1,
			failed: 0,
			items: [],
		});
		await run();
		expect(mocks.publish).not.toHaveBeenCalled();
	});
});

describe("OpenAPI app checkpoints", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.metadata.mockResolvedValue({});
		mocks.list.mockResolvedValue([{ id: "first" }, { id: "second" }]);
		mocks.app.mockResolvedValue({
			id: "app",
			organizationId: "org",
			name: "Example",
			slug: "example",
		});
		mocks.import.mockImplementation(async (_db, input) => ({
			appId: input.appId,
			dryRun: input.dryRun,
			totalOperations: 1,
			planned: 1,
			created: 0,
			updated: 1,
			deleted: 0,
			inSync: 0,
			skipped: 0,
			failed: 0,
			items: [],
		}));
	});

	it("resumes the frozen plan without reimporting or renotifying successful apps", async () => {
		const cache = new Map<string, unknown>();
		let interrupted = true;
		const step: TestStep = {
			do: async (name, callback) => {
				if (cache.has(name)) return cache.get(name);
				if (
					interrupted &&
					(name === "import openapi app 1" ||
						name === "record failed openapi app 1")
				) {
					throw new Error("execution interrupted");
				}
				const value = await callback();
				cache.set(name, value);
				return value;
			},
		};
		await expect(run(false, {}, step)).rejects.toThrow("execution interrupted");
		expect(mocks.import).toHaveBeenCalledTimes(1);
		interrupted = false;
		mocks.list.mockResolvedValue([{ id: "different" }]);
		const result = await run(false, {}, step);
		expect(result.status).toBe("succeeded");
		expect(result.results.map((item) => item.appId)).toEqual([
			"first",
			"second",
		]);
		expect(mocks.list).toHaveBeenCalledTimes(1);
		expect(mocks.import).toHaveBeenCalledTimes(2);
		expect(mocks.review).toHaveBeenCalledTimes(2);
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("retries review creation from its saved import without losing the change counts", async () => {
		const cache = new Map<string, unknown>();
		let interrupted = true;
		mocks.review.mockRejectedValueOnce(new Error("review interrupted"));
		const step: TestStep = {
			do: async (name, callback) => {
				if (cache.has(name)) return cache.get(name);
				if (interrupted && name.startsWith("record failed"))
					throw new Error("execution interrupted");
				const value = await callback();
				cache.set(name, value);
				return value;
			},
		};
		await expect(run(false, { appId: "app" }, step)).rejects.toThrow(
			"execution interrupted",
		);
		interrupted = false;
		const result = await run(false, { appId: "app" }, step);
		expect(result.updated).toBe(1);
		expect(result.status).toBe("succeeded");
		expect(mocks.import).toHaveBeenCalledTimes(1);
		expect(mocks.review).toHaveBeenCalledTimes(2);
	});

	it("counts an app once when review creation fails and keeps its imported changes", async () => {
		mocks.review.mockRejectedValueOnce(new Error("review unavailable"));
		const result = await run(false, { appIds: ["first", "second", "first"] });
		expect(result).toMatchObject({
			status: "partial",
			apps: 2,
			failedApps: 1,
			failed: 1,
			updated: 2,
		});
		expect(result.results[0]).toMatchObject({
			appId: "first",
			updated: 1,
			failed: 1,
		});
		expect(result.results[0].items[0]?.message).toBe("review unavailable");
		expect(mocks.import).toHaveBeenCalledTimes(2);
	});

	it("reports all app imports failing without stopping the remaining apps", async () => {
		mocks.import.mockRejectedValue(new Error("spec unavailable"));
		const result = await run(false, {});
		expect(result).toMatchObject({
			status: "failed",
			apps: 2,
			failedApps: 2,
			failed: 2,
		});
		expect(mocks.publish).not.toHaveBeenCalled();
	});

	it("keeps discovery selection and dry runs free of projection and notification", async () => {
		mocks.metadata.mockResolvedValue({
			mcpConfig: { googleDiscoverySync: { enabled: true } },
		});
		mocks.discovery.mockResolvedValue({
			appId: "app",
			dryRun: true,
			created: 0,
			updated: 1,
			deleted: 0,
			inSync: 0,
			failed: 0,
			items: [],
		});
		const result = await run(true, { appId: "app", limit: 10 });
		expect(result.status).toBe("succeeded");
		expect(mocks.discovery).toHaveBeenCalledWith(
			{},
			{ appId: "app", dryRun: true, limit: 10 },
		);
		expect(mocks.import).not.toHaveBeenCalled();
		expect(mocks.projection).not.toHaveBeenCalled();
		expect(mocks.publish).not.toHaveBeenCalled();
	});
});
