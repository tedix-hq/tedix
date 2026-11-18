import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const rollups = vi.hoisted(() => ({
	list: vi.fn(),
	rebuild: vi.fn(),
}));
vi.mock("@tedix/db/queries/billing/cost-rollups", () => ({
	listCostRollupDaysToBuild: rollups.list,
	rebuildCostRollupDay: rollups.rebuild,
}));

const maintenance = vi.hoisted(() => ({
	check: vi.fn(),
	quarantine: vi.fn(),
	staleSyncs: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: () => ({}) }));
vi.mock("@tedix/db/queries/catalog/categories-stats", () => ({
	checkCatalogBrowseTotals: maintenance.check,
}));
vi.mock("./billing-metering", () => ({
	quarantineUnreservedGatewayCosts: maintenance.quarantine,
}));
vi.mock("@tedix/db/queries/catalog/sync-logs", () => ({
	failStaleAppCatalogSyncLogs: maintenance.staleSyncs,
}));

import {
	runDailyBillingAndCatalogMaintenance,
	COST_ROLLUP_DAYS_PER_RUN,
	rebuildClosedCostRollups,
} from "./daily-billing-and-catalog-maintenance";

const db = {} as never;
const now = new Date("2026-10-10T02:00:00.000Z");

describe("daily cost rollup step", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	it("rebuilds a bounded batch and keeps going past a failed day", async () => {
		rollups.list.mockResolvedValue([
			{ organizationId: "org-a", day: "2026-10-09" },
			{ organizationId: "org-b", day: "2026-10-09" },
			{ organizationId: "org-a", day: "2026-10-08" },
		]);
		rollups.rebuild
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("D1 busy"))
			.mockResolvedValueOnce(undefined);

		await expect(rebuildClosedCostRollups(db, now)).resolves.toEqual({
			built: 2,
			failed: 1,
		});
		expect(rollups.list).toHaveBeenCalledWith(db, COST_ROLLUP_DAYS_PER_RUN, {
			now,
		});
		expect(rollups.rebuild).toHaveBeenNthCalledWith(
			3,
			db,
			"org-a",
			"2026-10-08",
			{ now },
		);
	});

	it("is non-fatal when selection fails", async () => {
		rollups.list.mockRejectedValue(new Error("D1 unavailable"));
		await expect(rebuildClosedCostRollups(db, now)).resolves.toEqual({
			built: 0,
			failed: 0,
		});
		expect(rollups.rebuild).not.toHaveBeenCalled();
	});
});

describe("daily catalog total verification", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		rollups.list.mockResolvedValue([]);
		maintenance.quarantine.mockResolvedValue({
			selected: 0,
			quarantined: 0,
			remainingAtLeast: 0,
		});
		maintenance.staleSyncs.mockResolvedValue(0);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("records a checked counter and fails the cron on drift or a failed read", async () => {
		maintenance.check.mockResolvedValue({ matches: true });
		expect(
			await runDailyBillingAndCatalogMaintenance({} as CloudflareEnv, "run"),
		).toMatchObject({ catalogTotalsChecked: 1 });
		maintenance.check.mockResolvedValue({
			matches: false,
			expectedTotal: 2,
			storedTotal: 1,
		});
		await expect(
			runDailyBillingAndCatalogMaintenance({} as CloudflareEnv, "run"),
		).rejects.toThrow("Catalog browse totals drift:");
		maintenance.check.mockRejectedValue(new Error("D1 unavailable"));
		await expect(
			runDailyBillingAndCatalogMaintenance({} as CloudflareEnv, "run"),
		).rejects.toThrow("D1 unavailable");
	});
});
