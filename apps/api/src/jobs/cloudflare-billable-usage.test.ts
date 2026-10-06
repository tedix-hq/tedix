import type { DbClient } from "@tedix/db/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	type BillableUsageRow,
	billableUsageWindow,
	ingestCloudflareBillableUsage,
} from "./cloudflare-billable-usage";

const recordBillingProviderReconciliation = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ id: "rec" })),
);
vi.mock("@tedix/db/queries/billing/health", () => ({
	recordBillingProviderReconciliation,
}));

const db = {} as DbClient;
const env = {
	CF_ACCOUNT_ID: "acct-1",
	CF_BILLING_TOKEN: "tok-1",
};
const options = {
	from: "2026-07-27",
	to: "2026-08-03",
	now: "2026-08-03T02:00:00.000Z",
};

function respondWith(rows: BillableUsageRow[], init?: { status?: number }) {
	return vi.fn(() =>
		Promise.resolve(
			new Response(JSON.stringify({ success: true, result: rows }), {
				status: init?.status ?? 200,
				headers: { "content-type": "application/json" },
			}),
		),
	);
}

function workersAiRow(
	overrides: Partial<BillableUsageRow> = {},
): BillableUsageRow {
	return {
		BillingCurrency: "USD",
		ChargePeriodStart: "2026-08-01T00:00:00Z",
		ChargePeriodEnd: "2026-08-01T23:59:59Z",
		ServiceName: "Workers AI",
		ServiceFamilyName: "Workers AI",
		ContractedCost: 1.5,
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	recordBillingProviderReconciliation.mockClear();
});

describe("cloudflare billable usage ingestion", () => {
	it("records Workers AI cost as a provider reconciliation in USD micros", async () => {
		vi.stubGlobal("fetch", respondWith([workersAiRow()]));

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.reconciled).toBe(1);
		expect(result.workersAiCostMicros).toBe(1_500_000);
		expect(recordBillingProviderReconciliation).toHaveBeenCalledTimes(1);
		const call = recordBillingProviderReconciliation.mock
			.calls[0]?.[1] as Record<string, unknown>;
		expect(call.provider).toBe("workers-ai");
		expect(call.providerCostMicros).toBe(1_500_000);
		expect(call.reconciledBy).toBe("job:cloudflare-billable-usage");
	});

	it("sums several Workers AI service rows within one charge period", async () => {
		// Cloudflare can split a family across ServiceName rows; the
		// reconciliation compares family totals, so they must add up rather
		// than the last row winning the upsert key.
		vi.stubGlobal(
			"fetch",
			respondWith([
				workersAiRow({ ServiceName: "Workers AI", ContractedCost: 1 }),
				workersAiRow({
					ServiceName: "Workers AI Embeddings",
					ContractedCost: 0.25,
				}),
			]),
		);

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.reconciled).toBe(1);
		expect(result.workersAiCostMicros).toBe(1_250_000);
		const call = recordBillingProviderReconciliation.mock
			.calls[0]?.[1] as Record<string, unknown>;
		expect(call.providerCostMicros).toBe(1_250_000);
	});

	it("keeps non-inference products as evidence without minting variance rows", async () => {
		// R2/D1 have no per-tedi ledger to reconcile against. They must not
		// become `provider: cloudflare` reconciliations that read as a
		// permanent disagreement, but they must not vanish either.
		vi.stubGlobal(
			"fetch",
			respondWith([
				workersAiRow(),
				{
					BillingCurrency: "USD",
					ChargePeriodStart: "2026-08-01T00:00:00Z",
					ChargePeriodEnd: "2026-08-01T23:59:59Z",
					ServiceName: "R2 Storage",
					ServiceFamilyName: "R2",
					ContractedCost: 0.75,
				},
			]),
		);

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.reconciled).toBe(1);
		expect(result.otherCostMicros).toBe(750_000);
		expect(recordBillingProviderReconciliation).toHaveBeenCalledTimes(1);
		const call = recordBillingProviderReconciliation.mock.calls[0]?.[1] as {
			metadata: { nonInferenceCostMicrosByService: Record<string, number> };
		};
		expect(call.metadata.nonInferenceCostMicrosByService["R2 Storage"]).toBe(
			750_000,
		);
	});

	it("never converts a non-USD currency into the USD-micro ledger", async () => {
		vi.stubGlobal(
			"fetch",
			respondWith([workersAiRow({ BillingCurrency: "EUR" })]),
		);

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.reconciled).toBe(0);
		expect(result.workersAiCostMicros).toBe(0);
		expect(result.skipped["non-usd-currency:EUR"]).toBe(1);
		expect(recordBillingProviderReconciliation).not.toHaveBeenCalled();
	});

	it("fails soft and loudly when the Billing Read token is absent", async () => {
		const fetchSpy = respondWith([]);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await ingestCloudflareBillableUsage(
			db,
			{ CF_ACCOUNT_ID: "acct-1" },
			options,
		);

		expect(result.failure).toMatch(/CF_BILLING_TOKEN/);
		expect(result.reconciled).toBe(0);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reports an HTTP failure instead of reading it as zero spend", async () => {
		// A silent zero is the exact shape that once hid a dead Gateway cursor.
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response("forbidden", { status: 403 }))),
		);

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.failure).toMatch(/403/);
		expect(result.reconciled).toBe(0);
		expect(recordBillingProviderReconciliation).not.toHaveBeenCalled();
	});

	it("stays quiet when the account simply has no Workers AI charges", async () => {
		// Free-tier Workers AI bills at zero and Cloudflare may omit the row
		// entirely. Treating that as a failure would fire a console.error every
		// day and train everyone to ignore this job.
		vi.stubGlobal(
			"fetch",
			respondWith([
				{
					BillingCurrency: "USD",
					ChargePeriodStart: "2026-08-01T00:00:00Z",
					ChargePeriodEnd: "2026-08-01T23:59:59Z",
					ServiceName: "R2 Storage",
					ServiceFamilyName: "R2",
					ContractedCost: 0.75,
				},
			]),
		);

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.reconciled).toBe(0);
		expect(result.failure).toBeUndefined();
		expect(result.otherCostMicros).toBe(750_000);
	});

	it("still records free-tier Workers AI usage that costs nothing", async () => {
		// A real payload shape: Workers AI bills in Neurons, our usage is
		// inside the free allowance, so ConsumedQuantity is large while every
		// cost field is 0. Recording cost alone would store nothing but zeros
		// and hide how close we are to paying.
		vi.stubGlobal(
			"fetch",
			respondWith([
				{
					BillingCurrency: "USD",
					ChargePeriodStart: "2026-08-02T00:00:00Z",
					ChargePeriodEnd: "2026-08-03T00:00:00Z",
					ServiceName: "Regular Twitch Neurons (RTN)",
					ServiceFamilyName: "Workers AI",
					ConsumedQuantity: 23941,
					ConsumedUnit: "",
					PricingQuantity: 0,
					ContractedCost: 0,
				},
			]),
		);

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.reconciled).toBe(1);
		expect(result.workersAiCostMicros).toBe(0);
		const call = recordBillingProviderReconciliation.mock.calls[0]?.[1] as {
			providerCostMicros: number;
			metadata: { consumedQuantity: number };
		};
		expect(call.providerCostMicros).toBe(0);
		expect(call.metadata.consumedQuantity).toBe(23941);
	});

	it("treats an empty window as a broken window, not as zero spend", async () => {
		// The failure this encodes: a 7-day lookback returned `success: true`
		// with zero rows for most of every month, because the API keys on the
		// billing period start rather than filtering daily rows, so it read as
		// "Cloudflare billed nothing". An account that bills daily cannot legitimately return none.
		vi.stubGlobal("fetch", respondWith([]));

		const result = await ingestCloudflareBillableUsage(db, env, options);

		expect(result.rowsFetched).toBe(0);
		expect(result.reconciled).toBe(0);
		expect(result.failure).toContain("ZERO billable-usage rows");
	});

	it("reaches back past the billing period start, which is what the API keys on", () => {
		// A window beginning after the period start fetches nothing at all.
		const window = billableUsageWindow(new Date("2026-08-05T02:00:00.000Z"));
		expect(window.to).toBe("2026-08-05");
		expect(window.from).toBe("2026-06-21");
		// The invariant the constant has to satisfy, stated independently of it:
		// clear a ~monthly period boundary from any day inside the period.
		const spanDays =
			(Date.parse(window.to) - Date.parse(window.from)) / 86_400_000;
		expect(spanDays).toBeGreaterThanOrEqual(31);
	});
});
