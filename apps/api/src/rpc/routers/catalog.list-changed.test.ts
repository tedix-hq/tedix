/**
 * Catalog sync/propagation MCP subscription publishes.
 *
 * Non-dry-run catalog → app tool rewrites must nudge live MCP subscribers on
 * every affected app with tools + prompts + resources list_changed.
 */

import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	syncCatalogToolsToApp: vi.fn(),
	propagateTools: vi.fn(),
	getCatalogAppById: vi.fn(),
	getCatalogBaseApp: vi.fn(),
	scanUpstreamCatalogAppNow: vi.fn(),
	resolveDriftReport: vi.fn(),
	createBaseAppFromCatalog: vi.fn(),
}));

vi.mock(
	"@tedix/db/queries/catalog/sync-tools-to-app",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			syncCatalogToolsToApp: mocks.syncCatalogToolsToApp,
		};
	},
);

vi.mock(
	"@tedix/db/queries/catalog/fork-propagation",
	async (importOriginal) => {
		const actual = await importOriginal<Record<string, unknown>>();
		return {
			...actual,
			propagateTools: mocks.propagateTools,
		};
	},
);

vi.mock("@tedix/db/queries/catalog/get-app", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getCatalogAppById: mocks.getCatalogAppById,
}));
vi.mock("@tedix/db/queries/catalog/drift-reports", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	resolveDriftReport: mocks.resolveDriftReport,
}));
vi.mock(
	"@tedix/db/queries/catalog/create-base-app",
	async (importOriginal) => ({
		...(await importOriginal<Record<string, unknown>>()),
		createBaseAppFromCatalog: mocks.createBaseAppFromCatalog,
	}),
);
vi.mock("./catalog/policy-quality", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getCatalogBaseApp: mocks.getCatalogBaseApp,
}));
vi.mock("./catalog/install-scan", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	scanUpstreamCatalogAppNow: mocks.scanUpstreamCatalogAppNow,
}));

import { catalogContractRouter } from "./catalog";

const CATALOG_APP_ID = "6f0a49a2-8c5f-4d0b-a2e6-1f2d3c4b5a69";
const TARGET_APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const FORK_APP_ID = "9c1de3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const OTHER_FORK_APP_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const ALL_INVENTORY_METHODS = [
	"notifications/tools/list_changed",
	"notifications/prompts/list_changed",
	"notifications/resources/list_changed",
];

function makeHarness() {
	const published: Array<{
		appId?: string;
		appIds?: string[];
		method: string;
	}> = [];
	const purges: string[] = [];
	const pending: Promise<unknown>[] = [];
	const env = {
		DB: {} as D1Database,
		ENVIRONMENT: "test",
		TEDIX_FLEET_AUTHORITY_MODE: "co-located",
		MCP_SERVICE: {
			fetch: async (req: Request) => {
				if (new URL(req.url).pathname === "/__internal/purge-aggregate-cache") {
					purges.push(((await req.json()) as { reason: string }).reason);
					return Response.json({ ok: true });
				}
				published.push(
					(await req.json()) as {
						appId?: string;
						appIds?: string[];
						method: string;
					},
				);
				return new Response(null, { status: 200 });
			},
		},
	} as unknown as CloudflareEnv;

	// Platform API key: carries cross-org authority plus the exact catalog
	// capability and bypasses user RBAC permission checks.
	const context: BaseContext = {
		authType: "apikey",
		apiKey: {
			id: "key-1",
			scopes: ["platform:admin", "catalog:manage"],
		},
		db: {} as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: null,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/catalog"),
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
	} as unknown as BaseContext;

	const client = createRouterClient(catalogContractRouter, { context });
	const flush = () => Promise.all(pending);
	return { client, flush, published, purges };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("catalog syncCatalogToolsToApp subscription publishes", () => {
	it("publishes tools + prompts + resources list_changed to the target app after a non-dry-run sync", async () => {
		const { client, flush, published } = makeHarness();
		mocks.syncCatalogToolsToApp.mockResolvedValue({
			catalogAppId: CATALOG_APP_ID,
			catalogAppName: "Peec",
			appId: TARGET_APP_ID,
			appName: "Peec base",
			mcpServerUrl: "https://api.peec.ai/mcp",
			dryRun: false,
			results: [{ toolName: "list_things", action: "updated" }],
			summary: "1 updated",
		});

		await client.syncCatalogToolsToApp({
			catalogAppId: CATALOG_APP_ID,
			appId: TARGET_APP_ID,
			mcpServerUrl: "https://api.peec.ai/mcp",
			dryRun: false,
		});
		await flush();

		expect(published.map((p) => p.method)).toEqual(ALL_INVENTORY_METHODS);
		for (const event of published) {
			expect(event.appId).toBe(TARGET_APP_ID);
		}
	});

	it("publishes nothing for a dry-run sync", async () => {
		const { client, flush, published } = makeHarness();
		mocks.syncCatalogToolsToApp.mockResolvedValue({
			catalogAppId: CATALOG_APP_ID,
			catalogAppName: "Peec",
			appId: TARGET_APP_ID,
			appName: "Peec base",
			mcpServerUrl: "https://api.peec.ai/mcp",
			dryRun: true,
			results: [{ toolName: "list_things", action: "would_update" }],
			summary: "1 would update",
		});

		await client.syncCatalogToolsToApp({
			catalogAppId: CATALOG_APP_ID,
			appId: TARGET_APP_ID,
			mcpServerUrl: "https://api.peec.ai/mcp",
			dryRun: true,
		});
		await flush();

		expect(published).toHaveLength(0);
	});
});

describe("catalog propagateTools subscription publishes", () => {
	it("publishes all three list_changed methods to only the mutated fork apps", async () => {
		const { client, flush, published } = makeHarness();
		mocks.propagateTools.mockResolvedValue({
			sourceAppId: TARGET_APP_ID,
			sourceAppName: "Peec base",
			dryRun: false,
			results: [
				{
					targetAppId: FORK_APP_ID,
					targetAppName: "Fork A",
					toolName: "list_things",
					action: "updated_schema",
				},
				{
					targetAppId: FORK_APP_ID,
					targetAppName: "Fork A",
					toolName: "get_thing",
					action: "created",
				},
				{
					targetAppId: OTHER_FORK_APP_ID,
					targetAppName: "Fork B",
					toolName: "list_things",
					action: "skipped",
					reason: "in sync",
				},
			],
			summary: "2 applied, 1 skipped",
		});

		await client.propagateTools({
			sourceAppId: TARGET_APP_ID,
			appIds: [FORK_APP_ID, OTHER_FORK_APP_ID],
			dryRun: false,
		});
		await flush();

		expect(published.map((p) => p.method)).toEqual(ALL_INVENTORY_METHODS);
		// Only the fork with applied changes is notified; the skipped fork is not.
		for (const event of published) {
			expect(event.appIds).toEqual([FORK_APP_ID]);
		}
	});

	it("publishes nothing when a dry-run propagation only previews changes", async () => {
		const { client, flush, published } = makeHarness();
		mocks.propagateTools.mockResolvedValue({
			sourceAppId: TARGET_APP_ID,
			sourceAppName: "Peec base",
			dryRun: true,
			results: [
				{
					targetAppId: FORK_APP_ID,
					targetAppName: "Fork A",
					toolName: "list_things",
					action: "would_update",
				},
			],
			summary: "1 would update",
		});

		await client.propagateTools({
			sourceAppId: TARGET_APP_ID,
			appIds: [FORK_APP_ID],
			dryRun: true,
		});
		await flush();

		expect(published).toHaveLength(0);
	});
});

describe("catalog reconcile aggregate cache activation", () => {
	beforeEach(() => {
		mocks.getCatalogAppById.mockResolvedValue({
			id: CATALOG_APP_ID,
			name: "CMS",
			slug: "cms",
			toolSource: "upstream_mcp",
			mcpEndpointNormalized: "https://builder.tedix.dev/mcp",
		});
		mocks.getCatalogBaseApp.mockResolvedValue({
			id: TARGET_APP_ID,
			name: "CMS",
			slug: "cms",
			metadata: {},
		});
		mocks.scanUpstreamCatalogAppNow.mockResolvedValue({
			addedTools: 0,
			changedTools: 1,
			removedTools: 0,
			resourceCount: 0,
			resourceTemplateCount: 0,
			promptCount: 0,
			healthStatus: "healthy",
		});
		mocks.syncCatalogToolsToApp.mockResolvedValue({
			results: [{ action: "updated" }],
			summary: "1 updated",
		});
		mocks.resolveDriftReport.mockResolvedValue(undefined);
	});
	it("activates refreshed schemas before returning a successful reconciliation", async () => {
		const { client, flush, purges } = makeHarness();
		await client.reconcileApp({
			catalogAppId: CATALOG_APP_ID,
			baseAppId: TARGET_APP_ID,
			dryRun: false,
			customForkAppIds: [],
		});
		expect(purges).toEqual(["catalog.reconcile_app schema sync"]);
		await flush();
	});
	it("does not invalidate caches for a dry-run reconciliation", async () => {
		const { client, purges } = makeHarness();
		await client.reconcileApp({
			catalogAppId: CATALOG_APP_ID,
			baseAppId: TARGET_APP_ID,
			dryRun: true,
			customForkAppIds: [],
		});
		expect(purges).toEqual([]);
		expect(mocks.scanUpstreamCatalogAppNow).not.toHaveBeenCalled();
	});
	it("does not claim activation when the schema write fails", async () => {
		mocks.syncCatalogToolsToApp.mockRejectedValueOnce(
			new Error("schema write failed"),
		);
		const { client, purges } = makeHarness();
		await expect(
			client.reconcileApp({
				catalogAppId: CATALOG_APP_ID,
				baseAppId: TARGET_APP_ID,
				dryRun: false,
				customForkAppIds: [],
			}),
		).rejects.toThrow("schema write failed");
		expect(purges).toEqual([]);
	});
	it("activates schemas when reconciliation creates the base app", async () => {
		mocks.getCatalogBaseApp.mockResolvedValueOnce(null);
		mocks.createBaseAppFromCatalog.mockResolvedValueOnce({
			app: { id: TARGET_APP_ID, name: "CMS", slug: "cms" },
			sync: { results: [{ action: "created" }] },
		});
		const { client, purges } = makeHarness();
		await client.reconcileApp({
			catalogAppId: CATALOG_APP_ID,
			organizationId: OTHER_FORK_APP_ID,
			dryRun: false,
			customForkAppIds: [],
		});
		expect(purges).toEqual(["catalog.reconcile_app base creation"]);
	});
	it("activates explicitly changed custom forks after propagation", async () => {
		mocks.propagateTools.mockResolvedValueOnce({
			dryRun: false,
			results: [{ targetAppId: FORK_APP_ID, action: "updated_schema" }],
			summary: "1 updated",
		});
		const { client, purges } = makeHarness();
		await client.reconcileApp({
			catalogAppId: CATALOG_APP_ID,
			baseAppId: TARGET_APP_ID,
			dryRun: false,
			customForkAppIds: [FORK_APP_ID],
		});
		expect(purges).toEqual([
			"catalog.reconcile_app schema sync",
			"catalog.reconcile_app fork propagation",
		]);
	});
});
