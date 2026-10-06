import { describe, expect, it } from "vite-plus/test";
import { capacityRefundDelta } from "./capacity-allocations";

describe("capacity refund reconciliation", () => {
	it("appends only the missing cumulative compensating delta", () => {
		expect(
			capacityRefundDelta({
				tokenAmount: 5_000_000,
				spendAmountMicros: 25_000_000,
				amount: 2_500,
				amountRefunded: 1_250,
				currentTokenAdjustment: 0,
				currentSpendAdjustmentMicros: 0,
			}),
		).toEqual({ tokenDelta: -2_500_000, spendDelta: -12_500_000 });
		expect(
			capacityRefundDelta({
				tokenAmount: 5_000_000,
				spendAmountMicros: 25_000_000,
				amount: 2_500,
				amountRefunded: 2_500,
				currentTokenAdjustment: -2_500_000,
				currentSpendAdjustmentMicros: -12_500_000,
			}),
		).toEqual({ tokenDelta: -2_500_000, spendDelta: -12_500_000 });
	});

	it("is a no-op for a retried cumulative refund", () => {
		expect(
			capacityRefundDelta({
				tokenAmount: 5_000_000,
				spendAmountMicros: 25_000_000,
				amount: 2_500,
				amountRefunded: 2_500,
				currentTokenAdjustment: -5_000_000,
				currentSpendAdjustmentMicros: -25_000_000,
			}),
		).toEqual({ tokenDelta: 0, spendDelta: 0 });
	});
});
