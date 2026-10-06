import { describe, expect, it } from "vite-plus/test";
import {
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
