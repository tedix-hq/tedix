import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	credits: vi.fn(),
	reservations: vi.fn(),
	periods: vi.fn(),
	ingest: vi.fn(),
	settle: vi.fn(),
	outbox: vi.fn(),
	stripe: vi.fn(),
	config: vi.fn(),
	health: vi.fn(),
	freshness: vi.fn(),
}));
vi.mock("@tedix/db/client", () => ({
	createDbClient: (binding: unknown) => binding,
}));
vi.mock("@tedix/db/queries/billing/credits", () => ({
	expireBillingCredits: mocks.credits,
}));
vi.mock("@tedix/db/queries/billing/reservations", () => ({
	expireBillingReservations: mocks.reservations,
	getBillingReservationFreshness: async () => ({
		count30d: 0,
		maxCreatedAt: null,
	}),
}));
vi.mock("@tedix/db/queries/billing/plans", () => ({
	rollBillingPeriods: mocks.periods,
}));
vi.mock("@tedix/db/queries/tedi-usage", () => ({
	getCostLedgerFreshness: async () => ({ maxSnapshotAt: null }),
}));
vi.mock("./gateway-cost-ingestion", () => ({
	ingestGatewayLogCosts: mocks.ingest,
}));
vi.mock("./billing-metering", () => ({
	settleUnbilledGatewayCosts: mocks.settle,
	drainStripeMeterOutbox: mocks.outbox,
}));
vi.mock("../lib/stripe-environment", () => ({
	resolveStripeEnvironment: mocks.stripe,
	getStripeEnvironmentConfig: mocks.config,
}));
vi.mock("../lib/cloudflare-credential-health", () => ({
	reconcileCloudflareCredentialFinding: mocks.health,
}));
vi.mock("../lib/billing-metering-health", () => ({
	reconcileBillingMeteringFreshness: mocks.freshness,
}));
import { runBillingAndGatewayCostTick } from "./billing-cron";
beforeEach(() => {
	vi.clearAllMocks();
	mocks.ingest.mockResolvedValue([
		{ gatewayId: "gateway", ingested: 3, skipped: 0 },
	]);
	mocks.periods.mockResolvedValue({ renewed: 1, suspendedTrials: 0 });
	mocks.credits.mockResolvedValue(0);
	mocks.reservations.mockResolvedValue(0);
	mocks.settle.mockResolvedValue({
		settled: 1,
		failed: 0,
		quarantined: 0,
		remainingAtLeast: 0,
	});
	mocks.outbox.mockResolvedValue({ failed: 0 });
	mocks.stripe.mockReturnValue("live");
	mocks.config.mockReturnValue({ secretKey: "offline-fixture" });
});
describe("whole billing tick settlement isolation", () => {
	it.each(["external", "disabled"])(
		"observes %s without any financial mutation",
		async (mode) => {
			const env = {
				DB: { owner: "tenant" },
				TEDIX_BILLING_SETTLEMENT_MODE: mode,
			} as unknown as CloudflareEnv;
			expect(await runBillingAndGatewayCostTick(env)).toMatchObject({
				gatewayRowsIngested: 3,
				periodsRenewed: 0,
			});
			expect(mocks.ingest).toHaveBeenCalledWith(env.DB, env);
			expect(mocks.health).toHaveBeenCalledOnce();
			expect(mocks.freshness).toHaveBeenCalledOnce();
			for (const operation of [
				mocks.credits,
				mocks.reservations,
				mocks.periods,
				mocks.settle,
				mocks.outbox,
				mocks.stripe,
				mocks.config,
			])
				expect(operation).not.toHaveBeenCalled();
		},
	);
	it("retains managed maintenance, settlement and outbox", async () => {
		await runBillingAndGatewayCostTick({
			DB: {},
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		} as CloudflareEnv);
		for (const operation of [
			mocks.credits,
			mocks.reservations,
			mocks.periods,
			mocks.settle,
			mocks.outbox,
		])
			expect(operation).toHaveBeenCalledOnce();
	});
	it("keeps health reconciliation fail-soft without logging thrown text", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.health.mockRejectedValue(
			new Error("credential-secret", {
				cause: new TypeError("provider-response-secret"),
			}),
		);
		mocks.freshness.mockRejectedValue(new Error("billing-account-secret"));
		try {
			expect(
				await runBillingAndGatewayCostTick({
					DB: {},
					TEDIX_BILLING_SETTLEMENT_MODE: "external",
				} as CloudflareEnv),
			).toMatchObject({ gatewayRowsIngested: 3 });
			expect(warn).toHaveBeenCalledWith({
				component: "api.billing-cron",
				event: "billing_credential_health_reconciliation_failed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			});
			expect(warn).toHaveBeenCalledWith({
				component: "api.billing-cron",
				event: "billing_metering_freshness_reconciliation_failed",
				exception: { type: "Error" },
			});
			const logged = JSON.stringify(warn.mock.calls);
			for (const secret of [
				"credential-secret",
				"provider-response-secret",
				"billing-account-secret",
			])
				expect(logged).not.toContain(secret);
		} finally {
			warn.mockRestore();
		}
	});
	it("reports gateway ingestion failure counts without provider content", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.ingest.mockResolvedValue([
			{
				gatewayId: "gateway-secret",
				ingested: 0,
				skipped: 0,
				failure: "Bearer provider-response-secret",
			},
		]);
		try {
			await expect(
				runBillingAndGatewayCostTick({
					DB: {},
					TEDIX_BILLING_SETTLEMENT_MODE: "external",
				} as CloudflareEnv),
			).rejects.toThrow("Gateway cost ingestion failed for 1/1 gateway(s)");
			expect(error).toHaveBeenCalledWith({
				component: "api.billing-cron",
				event: "gateway_cost_ingestion_failed",
				failedGateways: 1,
				totalGateways: 1,
			});
			expect(warn).toHaveBeenCalledWith({
				component: "api.billing-cron",
				event: "billing_gateway_cost_tick_failed",
				exception: { type: "Error" },
			});
			const logged = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
			expect(logged).not.toContain("gateway-secret");
			expect(logged).not.toContain("provider-response-secret");
		} finally {
			error.mockRestore();
			warn.mockRestore();
		}
	});
	it("rethrows a provider failure while logging only its cause topology", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const providerError = new Error("provider-response-secret", {
			cause: new TypeError("credential-secret"),
		});
		mocks.ingest.mockRejectedValue(providerError);
		try {
			await expect(
				runBillingAndGatewayCostTick({
					DB: {},
					TEDIX_BILLING_SETTLEMENT_MODE: "external",
				} as CloudflareEnv),
			).rejects.toBe(providerError);
			expect(warn).toHaveBeenCalledWith({
				component: "api.billing-cron",
				event: "billing_gateway_cost_tick_failed",
				exception: { type: "Error", cause: { type: "TypeError" } },
			});
			const logged = JSON.stringify(warn.mock.calls);
			expect(logged).not.toContain("provider-response-secret");
			expect(logged).not.toContain("credential-secret");
		} finally {
			warn.mockRestore();
		}
	});
});
