import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
	apps: vi.fn(),
	baseApps: vi.fn(),
	backlog: vi.fn(),
	complete: vi.fn(),
	sync: vi.fn(),
	review: vi.fn(),
	resolveDrift: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/apps", () => ({
	listBaseAppsForCatalogApp: mocks.baseApps,
}));
vi.mock("@tedix/db/queries/catalog/health-metrics", () => ({
	getCatalogAppsNeedingScan: mocks.apps,
	getCatalogScanBacklogSummary: mocks.backlog,
	updateCatalogAppHealthMetrics: vi.fn(),
}));
vi.mock("@tedix/db/queries/catalog/health-history", () => ({
	insertCatalogHealthHistory: vi.fn(),
}));
vi.mock("@tedix/db/queries/catalog/mcp-tools", () => ({
	syncCatalogMcpTools: vi.fn(async () => ({
		drifts: [],
		added: 0,
		removed: 0,
		updated: 0,
	})),
}));
vi.mock("@tedix/db/queries/catalog/drift-reports", () => ({
	resolveDriftReport: mocks.resolveDrift,
}));
vi.mock("@tedix/db/queries/catalog/sync-tools-to-app", () => ({
	syncCatalogToolsToApp: mocks.sync,
}));
vi.mock("@tedix/db/queries/catalog/vendor-variants", () => ({
	refreshCatalogShadowedVariants: vi.fn(),
}));
vi.mock("@tedix/db/queries/workflow-runs", () => ({
	createWorkflowRunRecord: async () => ({ id: "run" }),
	completeWorkflowRunRecord: mocks.complete,
}));
vi.mock("@tedix/db/vector/catalog", () => ({
	getOrCreateCatalogVectorClient: vi.fn(),
}));
vi.mock("../lib/mcp-subscriptions", () => ({
	publishMcpCatalogInventoryEvents: vi.fn(),
}));
vi.mock("../services/tool-review-approvals", () => ({
	ensurePendingToolReviewApprovals: mocks.review,
}));
import { McpScanWorkflow } from "./mcp-scan-workflow";

async function run() {
	const workflow = new McpScanWorkflow(
		{} as ExecutionContext,
		{} as CloudflareEnv,
	);
	vi.spyOn(
		workflow as unknown as { scanApp: () => Promise<unknown> },
		"scanApp",
	).mockResolvedValue({
		status: "healthy",
		checkedAt: "2026-11-18T00:00:00.000Z",
		tools: [],
	});
	return workflow.run(
		{ instanceId: "workflow", payload: {} } as never,
		{
			do: async (_name: string, ...args: unknown[]) => {
				const callback = args.at(-1) as () => Promise<unknown>;
				return callback();
			},
		} as never,
	);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.apps.mockResolvedValue([
		{
			id: "catalog",
			name: "Fictional",
			toolSource: "upstream_mcp",
			mcpEndpointNormalized: "https://fictional.example/mcp",
			mcpEndpointHash: "hash",
		},
	]);
	mocks.baseApps.mockResolvedValue([
		{ id: "base", name: "Fictional", organizationId: "org", metadata: {} },
		{ id: "other-base", name: "Other", organizationId: "org", metadata: {} },
	]);
	mocks.backlog.mockResolvedValue({ dueNow: 0 });
	mocks.sync.mockResolvedValue({ errors: [] });
});

describe("MCP scan sync failures", () => {
	it("creates reviews for valid changes before recording a failed scan with policy errors", async () => {
		mocks.sync.mockResolvedValueOnce({
			errors: ["Tool publish_page has invalid policy"],
		});
		const result = await run();
		expect(mocks.sync).toHaveBeenCalledTimes(2);
		expect(mocks.review).toHaveBeenCalledWith(
			{},
			{ appId: "base", appName: "Fictional", organizationId: "org" },
		);
		expect(mocks.review).toHaveBeenCalledWith(
			{},
			{ appId: "other-base", appName: "Other", organizationId: "org" },
		);
		expect(result).toMatchObject({
			success: false,
			errors: 1,
			errorDetails: [
				expect.stringContaining("publish_page has invalid policy"),
			],
		});
		expect(mocks.complete).toHaveBeenCalledWith(
			{},
			"run",
			expect.objectContaining({
				status: "failed",
				totalCount: 1,
				successCount: 0,
				errorCount: 1,
				error: expect.stringContaining("publish_page has invalid policy"),
				output: expect.objectContaining({
					errorDetails: [
						expect.stringContaining("publish_page has invalid policy"),
					],
				}),
			}),
		);
		// Only the upstream inventory check resolves drift; failed materialization must not.
		expect(mocks.resolveDrift).toHaveBeenCalledTimes(1);
	});

	it("reports completed when every tool sync succeeds", async () => {
		expect(await run()).toMatchObject({
			success: true,
			errors: 0,
			appsChecked: 1,
		});
		expect(mocks.complete).toHaveBeenCalledWith(
			{},
			"run",
			expect.objectContaining({
				status: "completed",
				totalCount: 1,
				successCount: 1,
				errorCount: 0,
			}),
		);
	});

	it("counts successful apps separately from apps with sync failures", async () => {
		mocks.apps.mockResolvedValue([
			{
				id: "catalog",
				name: "Fictional",
				toolSource: "upstream_mcp",
				mcpEndpointNormalized: "https://fictional.example/mcp",
				mcpEndpointHash: "hash",
			},
			{
				id: "other-catalog",
				name: "Other",
				toolSource: "upstream_mcp",
				mcpEndpointNormalized: "https://other.example/mcp",
				mcpEndpointHash: "other-hash",
			},
		]);
		mocks.sync.mockResolvedValueOnce({
			errors: ["Tool publish_page has invalid policy"],
		});
		expect(await run()).toMatchObject({
			success: false,
			errors: 1,
			appsChecked: 1,
		});
		expect(mocks.complete).toHaveBeenCalledWith(
			{},
			"run",
			expect.objectContaining({
				status: "failed",
				totalCount: 2,
				successCount: 1,
				errorCount: 1,
			}),
		);
	});

	it("reports a failed scan when materialization throws", async () => {
		mocks.sync.mockRejectedValueOnce(new Error("Database unavailable"));
		expect(await run()).toMatchObject({ success: false, errors: 1 });
		expect(mocks.complete).toHaveBeenCalledWith(
			{},
			"run",
			expect.objectContaining({ status: "failed", errorCount: 1 }),
		);
	});
});
