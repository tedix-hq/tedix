import { describe, expect, it } from "vite-plus/test";
import {
	getContrastColor,
	getContrastRatio,
	getRelativeLuminance,
	isValidHexColor,
	normalizeHexColor,
} from "./color-contrast";

describe("normalizeHexColor", () => {
	it("should normalize 3-digit hex to 6-digit", () => {
		expect(normalizeHexColor("#f00")).toBe("#ff0000");
		expect(normalizeHexColor("abc")).toBe("#aabbcc");
	});

	it("should handle 6-digit hex", () => {
		expect(normalizeHexColor("#ff0000")).toBe("#ff0000");
		expect(normalizeHexColor("aabbcc")).toBe("#aabbcc");
	});

	it("should return null for invalid formats", () => {
		expect(normalizeHexColor("#12345")).toBe(null);
		expect(normalizeHexColor("invalid")).toBe(null);
	});
});

describe("isValidHexColor", () => {
	it("should validate correct hex colors", () => {
		expect(isValidHexColor("#ff0000")).toBe(true);
		expect(isValidHexColor("#f00")).toBe(true);
		expect(isValidHexColor("abc")).toBe(true);
	});

	it("should reject invalid hex colors", () => {
		expect(isValidHexColor("invalid")).toBe(false);
		expect(isValidHexColor("#12345")).toBe(false);
	});
});

describe("getRelativeLuminance", () => {
	it("should return 1 for white", () => {
		expect(getRelativeLuminance("#FFFFFF")).toBeCloseTo(1, 1);
	});

	it("should return 0 for black", () => {
		expect(getRelativeLuminance("#000000")).toBeCloseTo(0, 1);
	});

	it("should handle 3-digit hex", () => {
		const luminance = getRelativeLuminance("#f00");
		expect(luminance).toBeGreaterThan(0);
		expect(luminance).toBeLessThan(1);
	});

	it("should throw for invalid colors", () => {
		expect(() => getRelativeLuminance("invalid")).toThrow();
	});
});

describe("getContrastRatio", () => {
	it("should return 21:1 for black on white", () => {
		expect(getContrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 0);
	});

	it("should return 21:1 for white on black", () => {
		expect(getContrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 0);
	});

	it("should return 1:1 for same colors", () => {
		expect(getContrastRatio("#FF0000", "#FF0000")).toBeCloseTo(1, 0);
	});

	it("should handle blue on white", () => {
		const ratio = getContrastRatio("#0000FF", "#FFFFFF");
		expect(ratio).toBeGreaterThan(8);
		expect(ratio).toBeLessThan(9);
	});
});

describe("getContrastColor", () => {
	it("should return white for black background", () => {
		expect(getContrastColor("#000000")).toBe("#FFFFFF");
	});

	it("should return black for white background", () => {
		expect(getContrastColor("#FFFFFF")).toBe("#000000");
	});

	it("should return white for dark blue", () => {
		expect(getContrastColor("#0000FF")).toBe("#FFFFFF");
	});

	it("should return white for medium gray", () => {
		expect(getContrastColor("#888888")).toBe("#000000");
	});

	it("should throw for invalid colors", () => {
		expect(() => getContrastColor("invalid")).toThrow();
	});
});
