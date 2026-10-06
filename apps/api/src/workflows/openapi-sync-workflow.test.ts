import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
const mocks = vi.hoisted(() => ({
	import: vi.fn(),
	publish: vi.fn(),
	app: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/apps", () => ({
	getAppMetadataById: async () => ({}),
	getLinkedOpenApiCatalogSnapshot: async () => null,
	listApiSyncApps: async () => [],
}));
vi.mock("@tedix/db/queries/app-records", () => ({ getAppById: mocks.app }));
vi.mock("@tedix/db/queries/catalog/mcp-tools", () => ({
	projectCatalogToolsFromBaseApp: vi.fn(),
}));
vi.mock("../lib/mcp-subscriptions", () => ({
	publishMcpListChangedEvents: mocks.publish,
}));
vi.mock("../services/openapi-tool-import", () => ({
	executeOpenApiToolImport: mocks.import,
}));
vi.mock("../services/google-discovery-tool-import", () => ({
	runGoogleDiscoveryToolImport: vi.fn(),
}));
import { OpenApiSyncWorkflow } from "./openapi-sync-workflow";

async function run(dryRun = false) {
	const instance = new OpenApiSyncWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	(instance as unknown as { env: CloudflareEnv }).env = {} as CloudflareEnv;
	return instance.run(
		{ payload: { appId: "app", dryRun } } as never,
		{
			do: async (_name: string, callback: () => Promise<unknown>) => callback(),
		} as never,
	);
}

describe("OpenAPI sync inventory activation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.app.mockResolvedValue({
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
	it("supplies exact routing keys so applied imports purge caches before notification", async () => {
		await run();
		expect(mocks.publish).toHaveBeenCalledWith(
			{},
			{
				appId: "app",
				appResolutionKeys: ["mcp-subdomain:graph", "custom:graph.example.test"],
			},
			[
				"notifications/tools/list_changed",
				"notifications/resources/list_changed",
			],
		);
	});
	it("does not invalidate inventory for dry runs", async () => {
		await run(true);
		expect(mocks.publish).not.toHaveBeenCalled();
		expect(mocks.app).not.toHaveBeenCalled();
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
