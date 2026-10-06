import type { DbClient } from "@tedix/db/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	meterWorkstationCompute,
	workstationMeteringWindow,
	workstationUsageId,
} from "./workstation-compute-metering";

const recordBillingProviderUsage = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ id: "usage" })),
);
const listWorkstationLeaseComputeWindows = vi.hoisted(() => vi.fn());
vi.mock("@tedix/db/queries/billing/provider-usage", () => ({
	recordBillingProviderUsage,
}));
vi.mock("@tedix/db/queries/workstations", () => ({
	listWorkstationLeaseComputeWindows,
}));

const db = {} as DbClient;
const options = {
	now: "2026-08-04T00:00:00.000Z",
	since: "2026-08-02T00:00:00.000Z",
	until: "2026-08-04T00:00:00.000Z",
};

function leaseWindow(overrides: Record<string, unknown> = {}) {
	return {
		computeSeconds: 3600,
		endedAt: "2026-08-03T13:00:00.000Z",
		leadTediId: "tedi-1",
		leaseId: "lease-1",
		orgId: "org-1",
		profileId: "general",
		startedAt: "2026-08-03T12:00:00.000Z",
		terminalStatus: "released",
		workItemId: "wi-1",
		...overrides,
	};
}

afterEach(() => {
	recordBillingProviderUsage.mockClear();
	listWorkstationLeaseComputeWindows.mockReset();
});

describe("workstation compute metering", () => {
	it("attributes a released lease to org, tedi, and work item", async () => {
		listWorkstationLeaseComputeWindows.mockResolvedValue([leaseWindow()]);

		const result = await meterWorkstationCompute(db, options);

		expect(result.recorded).toBe(1);
		expect(result.computeSeconds).toBe(3600);
		const call = recordBillingProviderUsage.mock.calls[0]?.[1] as {
			organizationId: string;
			tediId: string;
			usageKind: string;
			unit: string;
			providerCostQuality: string;
			metadata: Record<string, unknown>;
		};
		expect(call.organizationId).toBe("org-1");
		expect(call.tediId).toBe("tedi-1");
		expect(call.usageKind).toBe("workstation_compute");
		expect(call.unit).toBe("compute_seconds");
		expect(call.providerCostQuality).toBe("estimated");
		expect(call.metadata.workItemId).toBe("wi-1");
	});

	it("records attribution but NOT a fabricated cost", async () => {
		// Pricing lease wall-clock over-estimates by orders of magnitude.
		// Leases are D1 lifecycle records that
		// outlive the container, so the quantity is real and the derived cost is
		// not. The unit stays unpriced here until cost is ALLOCATED from
		// Cloudflare's actual charge rather than estimated from duration.
		listWorkstationLeaseComputeWindows.mockResolvedValue([leaseWindow()]);

		const result = await meterWorkstationCompute(db, options);

		expect(result.recorded).toBe(1);
		expect(result.computeSeconds).toBe(3600);
		const call = recordBillingProviderUsage.mock.calls[0]?.[1] as {
			providerCostMicros: number;
			metadata: Record<string, unknown>;
		};
		expect(call.providerCostMicros).toBe(0);
		expect(call.metadata.pricingStatus).toBe("pending_allocation");
		// No rate-card field at all. Leaving one would let estimation return
		// silently the moment a rate reappeared, and then double-count against
		// the allocated cost.
		expect(call.metadata).not.toHaveProperty("rateCardVersion");
	});

	it("meters an EXPIRED lease, which is the runaway case", async () => {
		// A reaped lease never runs release code. If metering hung off release,
		// exactly the leases worth catching would be invisible.
		listWorkstationLeaseComputeWindows.mockResolvedValue([
			leaseWindow({ leaseId: "lease-expired", terminalStatus: "expired" }),
		]);

		const result = await meterWorkstationCompute(db, options);

		expect(result.recorded).toBe(1);
		const call = recordBillingProviderUsage.mock.calls[0]?.[1] as {
			metadata: { terminalStatus: string };
			providerUsageId: string;
		};
		expect(call.metadata.terminalStatus).toBe("expired");
		expect(call.providerUsageId).toBe("workstation-lease:lease-expired");
	});

	it("still meters per-org when no lead tedi resolved", async () => {
		listWorkstationLeaseComputeWindows.mockResolvedValue([
			leaseWindow({ leadTediId: null }),
		]);

		const result = await meterWorkstationCompute(db, options);

		expect(result.recorded).toBe(1);
		expect(result.withoutTedi).toBe(1);
	});

	it("keys idempotency on the lease so replaying a window is a no-op", () => {
		expect(workstationUsageId("abc")).toBe("workstation-lease:abc");
	});

	it("does not let one unmeterable lease strand the rest of the window", async () => {
		listWorkstationLeaseComputeWindows.mockResolvedValue([
			leaseWindow({ leaseId: "bad" }),
			leaseWindow({ leaseId: "good" }),
		]);
		recordBillingProviderUsage.mockRejectedValueOnce(new Error("constraint"));

		const result = await meterWorkstationCompute(db, options);

		expect(result.recorded).toBe(1);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0]).toContain("bad");
	});

	it("windows a trailing range so a missed tick self-heals", () => {
		const w = workstationMeteringWindow(new Date("2026-08-04T00:00:00.000Z"));
		expect(w.until).toBe("2026-08-04T00:00:00.000Z");
		expect(w.since).toBe("2026-08-02T00:00:00.000Z");
	});
});
