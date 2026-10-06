/**
 * Tests for price-utils.ts
 */

import { describe, expect, it } from "vite-plus/test";
import { formatPrice, getCurrencySymbol } from "./price-utils";

describe("formatPrice", () => {
	it("should format EUR currency", () => {
		expect(formatPrice(1234.56, "EUR")).toBe("€1,234.56");
	});

	it("should format USD currency", () => {
		expect(formatPrice(1234.56, "USD")).toBe("$1,234.56");
	});

	it("should format GBP currency", () => {
		expect(formatPrice(1234.56, "GBP")).toBe("£1,234.56");
	});

	it("should format CHF with symbol after", () => {
		expect(formatPrice(1234.56, "CHF")).toBe("CHF 1,234.56");
	});

	it("should format JPY without decimals", () => {
		expect(formatPrice(1234.56, "JPY")).toBe("¥1,235");
	});

	it("should handle null/undefined", () => {
		expect(formatPrice(null, "EUR")).toBe("€0.00");
		expect(formatPrice(undefined, "EUR")).toBe("€0.00");
	});

	it("should handle NaN", () => {
		expect(formatPrice(Number.NaN, "EUR")).toBe("€0.00");
	});

	it("should respect locale formatting", () => {
		expect(formatPrice(1234.56, "EUR", "de-DE")).toBe("€1.234,56");
		expect(formatPrice(1234.56, "EUR", "en-US")).toBe("€1,234.56");
	});
});

describe("getCurrencySymbol", () => {
	it("should return correct symbols", () => {
		expect(getCurrencySymbol("EUR")).toBe("€");
		expect(getCurrencySymbol("USD")).toBe("$");
		expect(getCurrencySymbol("GBP")).toBe("£");
		expect(getCurrencySymbol("JPY")).toBe("¥");
		expect(getCurrencySymbol("CHF")).toBe("CHF");
	});
});
