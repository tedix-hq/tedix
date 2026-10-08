import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CatalogSyncWorkflow } from "./catalog-sync-workflow";
import {
	getCatalogSnapshotStats,
	listEnabledCatalogAppsForVectorSync,
} from "@tedix/db/queries/catalog/scheduled-maintenance";
import {
	disableOrphanedCatalogApps,
	markStoreListingsAsRemoved,
	updateAppCatalogSyncLog,
} from "@tedix/db/queries/catalog/sync-logs";
import {
	bulkUpsertCatalogApps,
	getOrCreateCatalogVectorClient,
} from "@tedix/db/vector/catalog";

vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/catalog/scheduled-maintenance", () => ({
	getCatalogSnapshotStats: vi.fn(),
	listEnabledCatalogAppsForVectorSync: vi.fn(),
}));
vi.mock("@tedix/db/queries/catalog/sync-logs", () => ({
	disableOrphanedCatalogApps: vi.fn(),
	markStaleFeedStoreListingsAsRemoved: vi.fn(),
	markStoreListingsAsRemoved: vi.fn(),
	updateAppCatalogSyncLog: vi.fn(),
}));
vi.mock("@tedix/db/vector/catalog", () => ({
	bulkUpsertCatalogApps: vi.fn(),
	getOrCreateCatalogVectorClient: vi.fn(),
}));

describe("catalog search-only refresh", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getCatalogSnapshotStats).mockResolvedValue({
			total: 1,
			mcpCount: 1,
			enabledCount: 1,
		});
		vi.mocked(listEnabledCatalogAppsForVectorSync).mockResolvedValue([
			{ id: "existing", name: "Existing", connectorType: "MCP" },
		] as Awaited<ReturnType<typeof listEnabledCatalogAppsForVectorSync>>);
		vi.mocked(getOrCreateCatalogVectorClient).mockResolvedValue(
			{} as NonNullable<
				Awaited<ReturnType<typeof getOrCreateCatalogVectorClient>>
			>,
		);
	});
	async function refresh() {
		const workflow = Object.create(
			CatalogSyncWorkflow.prototype,
		) as CatalogSyncWorkflow;
		Object.defineProperty(workflow, "env", { value: {} });
		const steps: string[] = [];
		const step = {
			do: async (
				name: string,
				_config: unknown,
				fn: () => Promise<unknown>,
			) => {
				steps.push(name);
				return fn();
			},
		};
		const output = await workflow.run(
			{
				payload: { syncType: "full", searchOnly: true, syncLogId: "refresh" },
			} as Parameters<CatalogSyncWorkflow["run"]>[0],
			step as unknown as Parameters<CatalogSyncWorkflow["run"]>[1],
		);
		return { output, steps };
	}
	it("uploads existing records without supplier capture or removals", async () => {
		vi.mocked(bulkUpsertCatalogApps).mockResolvedValue({
			upserted: 1,
			failed: 0,
		});
		const { output } = await refresh();
		expect(output).toMatchObject({
			success: true,
			appsInserted: 0,
			appsUpdated: 0,
			appsRemoved: 0,
			search: { synced: 1, complete: true },
		});
		expect(disableOrphanedCatalogApps).not.toHaveBeenCalled();
		expect(markStoreListingsAsRemoved).not.toHaveBeenCalled();
	});
	it("reports failed uploads as an unsuccessful refresh", async () => {
		vi.mocked(bulkUpsertCatalogApps).mockResolvedValue({
			upserted: 0,
			failed: 1,
		});
		const { output } = await refresh();
		expect(output).toMatchObject({
			success: false,
			search: { failed: 1, complete: false },
		});
		expect(updateAppCatalogSyncLog).toHaveBeenLastCalledWith(
			expect.anything(),
			"refresh",
			expect.objectContaining({ status: "failed" }),
		);
	});
	it("follows an id cursor to the end even when the enabled count changes", async () => {
		const fullPage = Array.from({ length: 100 }, (_, index) => ({
			id: `app-${String(index).padStart(3, "0")}`,
			name: "App",
			connectorType: "MCP",
		}));
		vi.mocked(listEnabledCatalogAppsForVectorSync)
			.mockResolvedValueOnce(
				fullPage as Awaited<
					ReturnType<typeof listEnabledCatalogAppsForVectorSync>
				>,
			)
			.mockResolvedValueOnce([
				{ id: "app-100", name: "App", connectorType: "MCP" },
			] as Awaited<ReturnType<typeof listEnabledCatalogAppsForVectorSync>>);
		vi.mocked(bulkUpsertCatalogApps).mockImplementation(
			async (_client, apps) => ({
				upserted: apps.length,
				failed: 0,
			}),
		);
		const { output, steps } = await refresh();
		expect(output).toMatchObject({
			success: true,
			search: { synced: 101, complete: true },
		});
		expect(
			vi.mocked(listEnabledCatalogAppsForVectorSync).mock.calls[1]?.[1],
		).toEqual({
			limit: 100,
			afterId: "app-099",
		});
		expect(
			steps.filter((name) => name.startsWith("vector-index-sync-")),
		).toEqual(["vector-index-sync-0", "vector-index-sync-100"]);
	});
	it("does not report an unconfigured index as a successful refresh", async () => {
		vi.mocked(getOrCreateCatalogVectorClient).mockResolvedValue(null);
		const { output } = await refresh();
		expect(output).toMatchObject({
			success: false,
			search: { skipped: true, complete: false },
		});
	});
});
