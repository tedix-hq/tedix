import { describe, expect, it } from "vite-plus/test";
import { resolveSponsorshipReadiness } from "./billing-sponsorship-readiness";

const overview = {
	budgetDay: "2026-09-02",
	usedTokens: 0,
	usedSpendMicros: 0,
	allocatedTokens: 0,
	allocatedSpendMicros: 0,
	earliestExpiryAt: null,
};
const policy = {
	enabled: true,
	maxTransfersPerBudgetDay: 1,
	lowWatermarkTokens: 250_000,
	lowWatermarkSpendMicros: 1_000_000,
	transferTokens: 5_000_000,
	transferSpendMicros: 25_000_000,
};

describe("resolveSponsorshipReadiness", () => {
	it("fails closed when the provider billing policy is unavailable", () => {
		expect(
			resolveSponsorshipReadiness({
				policy,
				provider: overview,
				customer: overview,
				providerPolicyAvailable: false,
				providerDailyTokenLimit: null,
				providerDailySpendLimitMicros: null,
				transfersUsed: 0,
			}),
		).toMatchObject({ status: "provider_capacity_insufficient" });
	});

	it("distinguishes configured sponsorship with insufficient recurring capacity", () => {
		expect(
			resolveSponsorshipReadiness({
				policy,
				provider: overview,
				customer: overview,
				providerPolicyAvailable: true,
				providerDailyTokenLimit: 2_000_000,
				providerDailySpendLimitMicros: null,
				transfersUsed: 0,
			}),
		).toMatchObject({
			status: "provider_capacity_insufficient",
			transfersRemaining: 1,
			resetsAt: "2026-09-03T00:00:00.000Z",
		});
	});

	it("reports customer coverage before a spent transfer allowance", () => {
		expect(
			resolveSponsorshipReadiness({
				policy,
				provider: overview,
				customer: {
					...overview,
					allocatedTokens: 5_000_000,
					allocatedSpendMicros: 25_000_000,
				},
				providerPolicyAvailable: true,
				providerDailyTokenLimit: 0,
				providerDailySpendLimitMicros: null,
				transfersUsed: 1,
			}),
		).toMatchObject({ status: "customer_funded", transfersRemaining: 0 });
	});

	it.each([
		[244_152, 4_555_683, "customer_funded"],
		[1, 1, "customer_funded"],
		[0, 1, "allowance_exhausted"],
		[1, 0, "allowance_exhausted"],
		[-1, 1, "allowance_exhausted"],
		[1, -1, "allowance_exhausted"],
	])(
		"distinguishes available credit from refill watermarks (%s, %s)",
		(tokens, spend, status) => {
			expect(
				resolveSponsorshipReadiness({
					policy,
					provider: overview,
					customer: {
						...overview,
						allocatedTokens: Number(tokens),
						allocatedSpendMicros: Number(spend),
					},
					providerPolicyAvailable: true,
					providerDailyTokenLimit: 0,
					providerDailySpendLimitMicros: 0,
					transfersUsed: 1,
				}),
			).toMatchObject({ status, transfersRemaining: 0 });
		},
	);

	it("reports a next transfer funded by the recurring provider allowance", () => {
		expect(
			resolveSponsorshipReadiness({
				policy,
				provider: overview,
				customer: overview,
				providerPolicyAvailable: true,
				providerDailyTokenLimit: 5_000_000,
				providerDailySpendLimitMicros: 25_000_000,
				transfersUsed: 0,
			}),
		).toMatchObject({ status: "ready", transfersRemaining: 1 });
	});
});
