import { describe, expect, it } from "vite-plus/test";
import { parseCreditBudget } from "./billing-credit-budget";
describe("credit budget input", () => {
	it("supports an explicit uncapped wallet and exact cents", () => {
		expect(parseCreditBudget("")).toBe(null);
		expect(parseCreditBudget("12.34")).toBe(12_340_000);
	});
	it.each(["0", "-5", "NaN", "Infinity", "1e3", "1.234", "1000000.01"])(
		"rejects unsafe cap %s",
		(value) => expect(parseCreditBudget(value)).toBeUndefined(),
	);
});
