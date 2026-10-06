import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const rate = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/client", () => ({
	createDbClient: (binding: unknown) => binding,
}));
vi.mock("@tedix/db/queries/tedi-usage", () => ({ getDailySpendRate: rate }));
vi.mock("@tedix/db/queries/organizations", () => ({
	listOrganizations: async () => [],
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	getTedisByOrganization: async () => [],
}));
import { runCostAnomalyCheck } from "./cost-anomaly";
afterEach(() => vi.restoreAllMocks());
describe("unpriced cost diagnostics", () => {
	it("alerts explicitly on incomplete cost without asserting a numerical anomaly", async () => {
		rate.mockResolvedValue({
			anomaly_score: null,
			daily_usd: null,
			sevenDayAvgDailyUsd: null,
			knownSubtotalUsd: 0,
			unpricedCalls: 2,
			baselineUnpricedCalls: 1,
			models: [],
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		await runCostAnomalyCheck({ DB: {} } as CloudflareEnv, "offline-test");
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('"signal":"tedi.cost.unpriced"'),
		);
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('"unpricedCalls":2'),
		);
		expect(warning.mock.calls.flat().join(" ")).not.toContain(
			'"signal":"tedi.cost.anomaly"',
		);
	});
	it("does not report unknown pricing for a genuinely known zero", async () => {
		rate.mockResolvedValue({
			anomaly_score: 0,
			daily_usd: 0,
			sevenDayAvgDailyUsd: 0,
			knownSubtotalUsd: 0,
			unpricedCalls: 0,
			baselineUnpricedCalls: 0,
			models: [],
		});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		await runCostAnomalyCheck({ DB: {} } as CloudflareEnv, "offline-test");
		expect(error).not.toHaveBeenCalled();
	});
});
