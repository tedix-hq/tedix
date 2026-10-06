import { describe, expect, it } from "vite-plus/test";
import {
	formatBillingAmount,
	formatBillingPrice,
	formatCurrencyAmount,
} from "./billing-price";

describe("formatBillingPrice", () => {
	it("keeps whole-dollar subscription prices compact", () => {
		expect(formatBillingPrice(249_000_000)).toBe("$249");
	});

	it("does not round sub-dollar metered prices to zero", () => {
		expect(formatBillingPrice(50_000)).toBe("$0.05");
	});

	it("preserves micros when a catalog uses a smaller unit price", () => {
		expect(formatBillingPrice(50)).toBe("$0.00005");
	});
});

describe("billing totals", () => {
	it("rounds storage precision to cents", () => {
		expect(formatBillingAmount(45_262_546)).toBe("$45.26");
	});

	it("omits unnecessary trailing decimals", () => {
		expect(formatBillingAmount(25_000_000)).toBe("$25");
		expect(formatCurrencyAmount(70)).toBe("$70");
		expect(formatCurrencyAmount(0)).toBe("$0");
	});
});
