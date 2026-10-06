import { describe, expect, it } from "vite-plus/test";
import { toJsonRecord, toJsonValue } from "./json";

describe("JSON persistence boundary", () => {
	it("materializes structured objects and omits undefined fields", () => {
		expect(
			toJsonRecord({ nested: { enabled: true }, omitted: undefined }),
		).toEqual({
			nested: { enabled: true },
		});
	});

	it("preserves arrays and scalars as JSON values", () => {
		expect(toJsonValue(["one", 2, null])).toEqual(["one", 2, null]);
	});

	it("rejects non-objects at record boundaries", () => {
		expect(() => toJsonRecord(["not", "an", "object"])).toThrow("JSON object");
	});

	it("rejects values that JSON cannot represent", () => {
		expect(() => toJsonValue(undefined)).toThrow("represented as JSON");
		expect(() => toJsonValue(1n)).toThrow();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => toJsonValue(circular)).toThrow();
	});
});
