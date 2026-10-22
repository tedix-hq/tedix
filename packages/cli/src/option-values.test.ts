import { describe, expect, test } from "bun:test";
import {
	readNumberOption,
	readPositiveNumberOption,
	requireValue,
} from "./option-values";

describe("readNumberOption", () => {
	test("accepts positive safe integers with trimming and leading zeros", () => {
		expect(readNumberOption("--limit", " 00042 ")).toBe(42);
		expect(readNumberOption("--limit", String(Number.MAX_SAFE_INTEGER))).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});

	test("rejects integers outside the safe integer range", () => {
		expect(() =>
			readNumberOption("--limit", String(Number.MAX_SAFE_INTEGER + 1)),
		).toThrow("--limit must be a positive integer");
	});

	test("preserves plain decimal integer validation", () => {
		for (const value of [undefined, "", "0", "1.5", "0x10", "1e2", "+5"]) {
			expect(() => readNumberOption("--limit", value)).toThrow(
				"--limit must be a positive integer",
			);
		}
	});
});

describe("other option value helpers", () => {
	test("keeps positive fractional numbers valid", () => {
		expect(readPositiveNumberOption("--budget-usd", " .5 ")).toBe(0.5);
	});

	test("keeps required-value validation unchanged", () => {
		expect(requireValue("--name", "value")).toBe("value");
		expect(() => requireValue("--name", "--next")).toThrow(
			"--name requires a value",
		);
	});
});
