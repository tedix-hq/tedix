import { describe, expect, it, vi } from "vite-plus/test";
import { runMcpScan } from "./catalog-scan-cron";
import { listApiSyncApps } from "@tedix/db/queries/apps";
import { loadCatalogMaintenancePolicy } from "../lib/catalog-sync-source";
vi.mock("../lib/catalog-sync-source", () => ({
	loadCatalogMaintenancePolicy: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/apps", () => ({
	listApiSyncApps: vi.fn(async () => []),
}));

describe("MCP catalog scan cadence", () => {
	it("uses the published provider cohort without changing scan bounds or drift dispatch", async () => {
		vi.mocked(loadCatalogMaintenancePolicy).mockResolvedValue({
			version: 1,
			frequentProviderSlugs: ["configured-provider"],
			sources: [],
		});
		const create = vi.fn(async () => ({ id: "scan" }));
		const drift = vi.fn(async () => ({ id: "drift" }));
		await runMcpScan(
			{
				MCP_SCAN_WORKFLOW: { create },
				CATALOG_DRIFT_WORKFLOW: { create: drift },
			} as unknown as CloudflareEnv,
			"configured",
		);
		expect(create).toHaveBeenCalledWith({
			id: "scan-configured",
			params: {
				frequentProviderSlugs: ["configured-provider"],
				limit: 200,
				maxAgeHours: 24,
			},
		});
		expect(create).toHaveBeenCalledOnce();
		expect(drift).toHaveBeenCalledOnce();
	});
	it("still dispatches drift and OpenAPI sync when the shared MCP scan cannot start", async () => {
		vi.mocked(loadCatalogMaintenancePolicy).mockResolvedValue({
			version: 1,
			frequentProviderSlugs: [],
			sources: [],
		});
		vi.mocked(listApiSyncApps).mockResolvedValueOnce([
			{ id: "example", slug: "example" },
		]);
		const drift = vi.fn().mockResolvedValue({ id: "drift" });
		const sync = vi.fn().mockResolvedValue({ id: "sync" });
		await expect(
			runMcpScan(
				{
					MCP_SCAN_WORKFLOW: {
						create: vi
							.fn()
							.mockRejectedValue(new Error("fixture scan failure")),
					},
					CATALOG_DRIFT_WORKFLOW: { create: drift },
					OPENAPI_SYNC_WORKFLOW: { create: sync },
				} as unknown as CloudflareEnv,
				"failed",
			),
		).rejects.toMatchObject({ counts: { workflowsDispatched: 0 } });
		expect(drift).toHaveBeenCalledOnce();
		expect(sync).toHaveBeenCalledWith({
			id: "openapi-sync-example-failed",
			params: { appId: "example", dryRun: false },
		});
	});
});
