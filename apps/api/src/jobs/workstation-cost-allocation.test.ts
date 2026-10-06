import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const listWorkstationComputeForAllocation = vi.hoisted(() => vi.fn());
const applyWorkstationComputeCostAllocation = vi.hoisted(() => vi.fn());

vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	applyWorkstationComputeCostAllocation,
	listWorkstationComputeForAllocation,
}));

const { allocateContainerCostForPeriod, planContainerCostAllocation } =
	await import("./workstation-cost-allocation");

const db = {} as never;
const period = {
	evidenceRef:
		"cloudflare-billable-usage:acct:containers:2026-08-03..2026-08-04",
	now: "2026-08-04T00:00:00.000Z",
	periodEnd: "2026-08-04T00:00:00.000Z",
	periodStart: "2026-08-03T00:00:00.000Z",
};

describe("planContainerCostAllocation", () => {
	it("never allocates more than Cloudflare charged", () => {
		// The whole point of allocation: a duration-based estimate can exceed
		// the bill; a share of a real charge cannot.
		const plan = planContainerCostAllocation({
			rows: [
				{ id: "a", quantity: 18_000_000 },
				{ id: "b", quantity: 200_000 },
			],
			totalCostMicros: 410_000,
		});

		expect(plan.allocatedMicros).toBe(410_000);
		expect(plan.unallocatedMicros).toBe(0);
		const summed = plan.allocations.reduce(
			(total, allocation) => total + allocation.costMicros,
			0,
		);
		expect(summed).toBe(410_000);
	});

	it("distributes remainders so nothing is lost to flooring", () => {
		// Three equal rows over 10 micros floors to 3 each and drops 1. Across
		// many rows that rounding is real money and shows up as
		// permanent reconciliation variance.
		const plan = planContainerCostAllocation({
			rows: [
				{ id: "a", quantity: 1 },
				{ id: "b", quantity: 1 },
				{ id: "c", quantity: 1 },
			],
			totalCostMicros: 10,
		});

		expect(plan.allocatedMicros).toBe(10);
		expect(plan.allocations.map((a) => a.costMicros).sort()).toEqual([3, 3, 4]);
	});

	it("is stable across replays of a settled period", () => {
		const rows = [
			{ id: "a", quantity: 5 },
			{ id: "b", quantity: 5 },
			{ id: "c", quantity: 5 },
		];
		const first = planContainerCostAllocation({ rows, totalCostMicros: 100 });
		const second = planContainerCostAllocation({ rows, totalCostMicros: 100 });

		expect(second.allocations).toEqual(first.allocations);
	});

	it("leaves the charge unallocated when no lease carries it", () => {
		// Containers billed with no lease row is the one condition worth
		// alerting on. Spreading the charge over nothing would erase it.
		const plan = planContainerCostAllocation({
			rows: [],
			totalCostMicros: 410_000,
		});

		expect(plan.allocatedMicros).toBe(0);
		expect(plan.unallocatedMicros).toBe(410_000);
		expect(plan.allocations).toEqual([]);
	});

	it("ignores zero-quantity rows rather than gifting them cost", () => {
		const plan = planContainerCostAllocation({
			rows: [
				{ id: "real", quantity: 10 },
				{ id: "empty", quantity: 0 },
			],
			totalCostMicros: 1_000,
		});

		expect(plan.allocations).toEqual([
			{ costMicros: 1_000, id: "real", shareBasisPoints: 10_000 },
		]);
	});
});

describe("allocateContainerCostForPeriod", () => {
	beforeEach(() => {
		listWorkstationComputeForAllocation.mockReset();
		applyWorkstationComputeCostAllocation.mockReset();
		applyWorkstationComputeCostAllocation.mockImplementation(
			async (_db: unknown, updates: unknown[]) => updates.length,
		);
	});

	it("writes the share basis onto each row without dropping metadata", async () => {
		listWorkstationComputeForAllocation.mockResolvedValue([
			{
				id: "row-1",
				metadata: { leaseId: "lease-1", pricingStatus: "pending_allocation" },
				organizationId: "org-1",
				quantity: 75,
			},
			{
				id: "row-2",
				metadata: { leaseId: "lease-2" },
				organizationId: "org-2",
				quantity: 25,
			},
		]);

		const result = await allocateContainerCostForPeriod(db, {
			...period,
			totalCostMicros: 400_000,
		});

		expect(result).toMatchObject({
			allocatedMicros: 400_000,
			rows: 2,
			unallocatedMicros: 0,
			updated: 2,
		});
		const updates = applyWorkstationComputeCostAllocation.mock
			.calls[0]?.[1] as {
			id: string;
			providerCostMicros: number;
			metadata: Record<string, unknown>;
		}[];
		expect(updates[0]?.providerCostMicros).toBe(300_000);
		expect(updates[1]?.providerCostMicros).toBe(100_000);
		// The lease key must survive; it is the attribution the allocation prices.
		expect(updates[0]?.metadata.leaseId).toBe("lease-1");
		expect(updates[0]?.metadata.pricingStatus).toBe("allocated");
		expect(updates[0]?.metadata.allocation).toMatchObject({
			basis: "workstation_lease_wall_clock_share",
			chargeSourceRef: period.evidenceRef,
			chargeTotalMicros: 400_000,
			shareBasisPoints: 7_500,
		});
	});

	it("writes nothing when the period has no rows", async () => {
		listWorkstationComputeForAllocation.mockResolvedValue([]);

		const result = await allocateContainerCostForPeriod(db, {
			...period,
			totalCostMicros: 410_000,
		});

		expect(result.updated).toBe(0);
		expect(result.unallocatedMicros).toBe(410_000);
		expect(applyWorkstationComputeCostAllocation).toHaveBeenCalledWith(db, []);
	});
});
