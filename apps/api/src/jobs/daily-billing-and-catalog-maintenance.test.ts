import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const rollups = vi.hoisted(() => ({
	list: vi.fn(),
	rebuild: vi.fn(),
}));
vi.mock("@tedix/db/queries/billing/cost-rollups", () => ({
	listCostRollupDaysToBuild: rollups.list,
	rebuildCostRollupDay: rollups.rebuild,
}));

import {
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
