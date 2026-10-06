import { describe, expect, it } from "vite-plus/test";
import { asRecord, isRecord } from "./is-record";

describe("isRecord", () => {
	it("accepts plain objects and rejects null, arrays and primitives", () => {
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(Object.create(null))).toBe(true);
		expect(isRecord(null)).toBe(false);
		expect(isRecord([])).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(undefined)).toBe(false);
	});
});

describe("asRecord", () => {
	it("returns the same object or null", () => {
		const value = { a: 1 };
		expect(asRecord(value)).toBe(value);
		expect(asRecord([1])).toBeNull();
		expect(asRecord(null)).toBeNull();
		expect(asRecord(0)).toBeNull();
	});
});
