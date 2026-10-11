import { describe, expect, it } from "vite-plus/test";
import {
	formatUsageCredits,
	formatCreditWorth,
} from "./billing-credit-display";

describe("usage credit denomination", () => {
	it("shows wallet worth without rounding positive small charges to zero", () => {
		expect(formatUsageCredits(100_000_000)).toBe("10,000 credits");
		expect(formatCreditWorth(100_000_000)).toBe("$100");
		expect(formatUsageCredits(1)).toBe("<0.01 credits");
		expect(formatCreditWorth(1)).toBe("$0.000001");
	});
	it("preserves actual zero and negative wallet adjustments", () => {
		expect(formatUsageCredits(0)).toBe("0 credits");
		expect(formatCreditWorth(0)).toBe("$0");
		expect(formatUsageCredits(-50_000)).toBe("-5 credits");
	});
});
