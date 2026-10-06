import { describe, expect, it } from "vite-plus/test";
import {
	BILLING_METERING_MAX_LAG_MS,
	classifyBillingMeteringFreshness,
} from "./billing-metering-health";

const NOW = Date.parse("2026-08-20T04:00:00.000Z");

describe("billing metering freshness", () => {
	it("fires when admitted inference is more than 30 minutes ahead of the ledger", () => {
		expect(
			classifyBillingMeteringFreshness(
				{
					reservationCount30d: 4,
					maxReservationAt: "2026-08-20T03:20:00.000Z",
					maxGatewaySnapshotAt: "2026-08-20T03:00:00.000Z",
				},
				NOW,
			),
		).toMatchObject({ status: "firing", lagMinutes: 40 });
	});

	it("waits through the normal ingestion delay", () => {
		expect(
			classifyBillingMeteringFreshness(
				{
					reservationCount30d: 1,
					maxReservationAt: new Date(
						NOW - BILLING_METERING_MAX_LAG_MS + 1,
					).toISOString(),
					maxGatewaySnapshotAt: null,
				},
				NOW,
			),
		).toEqual({ status: "indeterminate" });
	});

	it("is healthy once the gateway ledger catches the reservation", () => {
		expect(
			classifyBillingMeteringFreshness(
				{
					reservationCount30d: 1,
					maxReservationAt: "2026-08-20T03:20:00.000Z",
					maxGatewaySnapshotAt: "2026-08-20T03:20:01.000Z",
				},
				NOW,
			),
		).toEqual({ status: "healthy" });
	});

	it("does not invent an incident for an unused account", () => {
		expect(
			classifyBillingMeteringFreshness(
				{
					reservationCount30d: 0,
					maxReservationAt: null,
					maxGatewaySnapshotAt: null,
				},
				NOW,
			),
		).toEqual({ status: "indeterminate" });
	});
});
