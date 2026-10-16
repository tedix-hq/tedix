import { describe, expect, it } from "vite-plus/test";
import {
	billingNeedsAttention,
	formatPlanLimit,
	formatPlanTokenAllowance,
	hasUnlimitedTokenUsage,
} from "./billing-display";

describe("billing display semantics", () => {
	it("treats zero-included, zero-priced overage as unlimited usage", () => {
		expect(
			hasUnlimitedTokenUsage(
				{ includedTokens: 0, allowOverage: true },
				{ overageUnitPriceMicros: 0 },
			),
		).toBe(true);
		expect(
			formatPlanTokenAllowance({
				includedMonthlyTokens: 0,
				overageUnitPriceMicros: 0,
			}),
		).toBe("Unlimited tokens");
	});

	it("does not hide a paid zero-included usage plan", () => {
		expect(
			hasUnlimitedTokenUsage(
				{ includedTokens: 0, allowOverage: true },
				{ overageUnitPriceMicros: 50_000 },
			),
		).toBe(false);
	});

	it("formats negative operating limits as unlimited", () => {
		expect(formatPlanLimit(-1)).toBe("Unlimited");
		expect(formatPlanLimit(64)).toBe("64");
	});
});

describe("billingNeedsAttention", () => {
	type Overview = Parameters<typeof billingNeedsAttention>[0];
	const healthy = {
		snapshot: {
			status: "active",
			includedTokens: 1_000_000,
			remainingIncludedTokens: 900_000,
			allowOverage: false,
			hardSpendLimitMicros: null,
			customerChargeMicros: 0,
		},
		plan: { overageUnitPriceMicros: 50_000 },
		credits: undefined,
		inferenceCapacity: { blockingReason: null, unblockAction: "none" },
	} as unknown as Overview;
	const withSnapshot = (snapshot: Partial<Overview["snapshot"]>): Overview => ({
		...healthy,
		snapshot: { ...healthy.snapshot, ...snapshot },
	});

	it("stays quiet for a healthy or unlimited plan", () => {
		expect(billingNeedsAttention(healthy)).toBe(false);
		expect(
			billingNeedsAttention({
				...withSnapshot({
					includedTokens: 0,
					remainingIncludedTokens: 0,
					allowOverage: true,
				}),
				plan: { ...healthy.plan, overageUnitPriceMicros: 0 },
			}),
		).toBe(false);
	});

	it("speaks up for low balance, a near limit, or required billing action", () => {
		expect(
			billingNeedsAttention(withSnapshot({ remainingIncludedTokens: 100_000 })),
		).toBe(true);
		expect(
			billingNeedsAttention(
				withSnapshot({
					hardSpendLimitMicros: 10_000_000,
					customerChargeMicros: 9_000_000,
				}),
			),
		).toBe(true);
		expect(billingNeedsAttention(withSnapshot({ status: "past_due" }))).toBe(
			true,
		);
		expect(
			billingNeedsAttention({
				...healthy,
				inferenceCapacity: {
					...healthy.inferenceCapacity,
					blockingReason: "payment_required",
					unblockAction: "manage_payment",
				},
			}),
		).toBe(true);
	});

	it("judges a monetary wallet by available credit and its monthly cap", () => {
		const credits = {
			billingMode: "monetary",
			includedMicros: 20_000_000,
			availableMicros: 15_000_000,
			spentMicros: 5_000_000,
			monthlyCapMicros: null,
		} as unknown as NonNullable<Overview["credits"]>;
		const wallet: Overview = { ...healthy, credits };
		expect(billingNeedsAttention(wallet)).toBe(false);
		expect(
			billingNeedsAttention({
				...wallet,
				credits: { ...credits, availableMicros: 500_000 },
			}),
		).toBe(true);
		expect(
			billingNeedsAttention({
				...wallet,
				credits: { ...credits, monthlyCapMicros: 6_000_000 },
			}),
		).toBe(true);
	});
});
