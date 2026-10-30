import { describe, expect, it, vi } from "vite-plus/test";
import { TriggerScanInputSchema } from "@tedix/api-contract/schemas/catalog";
import {
	MCP_SCAN_HOURLY_LIMIT,
	runMcpScan,
	runActiveProviderScanAndDrift,
} from "./catalog-scan-cron";
import { loadCatalogMaintenancePolicy } from "../lib/catalog-sync-source";
import { listActiveProviderCatalogApps } from "@tedix/db/queries/catalog/health-metrics";
vi.mock("../lib/catalog-sync-source", () => ({
	loadCatalogMaintenancePolicy: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/catalog/health-metrics", () => ({
	listActiveProviderCatalogApps: vi.fn(),
}));
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
		vi.mocked(listActiveProviderCatalogApps).mockResolvedValue([
			{ id: "configured-app", slug: "configured-provider" },
		]);
		const create = vi.fn(async () => ({ id: "scan" }));
		const drift = vi.fn(async () => ({ id: "drift" }));
		await runActiveProviderScanAndDrift(
			{
				MCP_SCAN_WORKFLOW: { create },
				CATALOG_DRIFT_WORKFLOW: { create: drift },
			} as unknown as CloudflareEnv,
			"configured",
		);
		expect(listActiveProviderCatalogApps).toHaveBeenCalledWith({}, [
			"configured-provider",
		]);
		expect(create).toHaveBeenCalledWith({
			id: "active-provider-scan-configured",
			params: { catalogAppIds: ["configured-app"], limit: 1, maxAgeHours: 1 },
		});
		expect(drift).toHaveBeenCalledOnce();
	});
	it("dispatches bounded catch-up capacity for the current fleet", async () => {
		const create = vi.fn(async () => ({ id: "scan-hour" }));
		const result = await runMcpScan(
			{ MCP_SCAN_WORKFLOW: { create } } as unknown as CloudflareEnv,
			"hour",
		);

		expect(MCP_SCAN_HOURLY_LIMIT).toBe(200);
		expect(MCP_SCAN_HOURLY_LIMIT * 24).toBeGreaterThanOrEqual(4_800);
		expect(() =>
			TriggerScanInputSchema.parse({
				limit: MCP_SCAN_HOURLY_LIMIT,
				maxAgeHours: 24,
			}),
		).not.toThrow();
		expect(create).toHaveBeenCalledWith({
			id: "scan-hour",
			params: { limit: 200, maxAgeHours: 24 },
		});
		expect(result).toEqual({ workflowsDispatched: 1 });
	});
});
