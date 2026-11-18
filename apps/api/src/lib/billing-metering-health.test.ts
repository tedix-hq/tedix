import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	BILLING_METERING_MAX_LAG_MS,
	classifyBillingMeteringFreshness,
	reconcileBillingMeteringFreshness,
} from "./billing-metering-health";

const alerts = vi.hoisted(() => ({
	getAlertState: vi.fn(),
	markAlertsResolved: vi.fn(),
	recordAlertState: vi.fn(),
	sendOpsAlert: vi.fn(),
}));
vi.mock("@tedix/db/queries/ops-alert-state", () => alerts);
vi.mock("./ops-alert-egress", () => ({ sendOpsAlert: alerts.sendOpsAlert }));

beforeEach(() => vi.resetAllMocks());

const NOW = Date.parse("2026-08-20T04:00:00.000Z");

describe("billing metering freshness", () => {
	it("fires when admitted inference is more than 30 minutes ahead of the ledger", () => {
		expect(
			classifyBillingMeteringFreshness(
				{
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
					maxReservationAt: null,
					maxGatewaySnapshotAt: null,
				},
				NOW,
			),
		).toEqual({ status: "indeterminate" });
	});
});

describe("configured billing gateway", () => {
	it.each(["fictional-primary", "fictional-secondary"])(
		"tracks and resolves alerts for %s",
		async (gateway) => {
			const db = {} as Parameters<typeof reconcileBillingMeteringFreshness>[0];
			const env = { AI_GATEWAY_LLM_ID: gateway } as CloudflareEnv;
			const conditionKey = `billing-metering-dark:${gateway}`;
			const nowIso = new Date(NOW).toISOString();
			const snapshot = {
				maxReservationAt: "2026-08-20T03:20:00.000Z",
				maxGatewaySnapshotAt: "2026-08-20T03:00:00.000Z",
			};
			await expect(
				reconcileBillingMeteringFreshness(db, env, snapshot, nowIso),
			).resolves.toBe("new");
			expect(alerts.getAlertState).toHaveBeenCalledWith(db, conditionKey);
			expect(alerts.recordAlertState).toHaveBeenCalledWith(
				db,
				expect.objectContaining({ conditionKey, status: "open" }),
			);
			expect(alerts.sendOpsAlert).toHaveBeenCalledWith(
				env,
				expect.objectContaining({
					meta: expect.objectContaining({ conditionKey, lifecycle: "new" }),
				}),
			);
			alerts.getAlertState.mockResolvedValue({ status: "open" });
			await expect(
				reconcileBillingMeteringFreshness(
					db,
					env,
					{ ...snapshot, maxGatewaySnapshotAt: "2026-08-20T03:20:01.000Z" },
					nowIso,
				),
			).resolves.toBe("resolved");
			expect(alerts.markAlertsResolved).toHaveBeenCalledWith(
				db,
				[conditionKey],
				nowIso,
			);
			expect(alerts.sendOpsAlert).toHaveBeenLastCalledWith(
				env,
				expect.objectContaining({
					meta: { conditionKey, lifecycle: "resolved" },
				}),
			);
		},
	);
});
