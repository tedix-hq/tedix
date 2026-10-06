import { describe, expect, it, vi } from "vite-plus/test";
import { TriggerScanInputSchema } from "@tedix/api-contract/schemas/catalog";
import { MCP_SCAN_HOURLY_LIMIT, runMcpScan } from "./catalog-scan-cron";

describe("MCP catalog scan cadence", () => {
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
