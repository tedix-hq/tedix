import { describe, expect, it } from "vite-plus/test";
import { truncateOutput } from "./test-input-generator";

function persistedBytes(value: unknown): number {
	return new TextEncoder().encode(
		JSON.stringify(
			typeof value === "object" && value !== null && !Array.isArray(value)
				? value
				: { value },
		),
	).byteLength;
}

describe("truncateOutput", () => {
	it("preserves the original reference when its serialized output fits", () => {
		const output = { result: "ready" };

		expect(truncateOutput(output, persistedBytes(output))).toBe(output);
	});

	it("bounds Unicode output by persisted UTF-8 bytes", () => {
		const output = "😀";
		const truncated = truncateOutput(output, 15);

		expect(truncated).not.toBe(output);
		expect(persistedBytes(truncated)).toBeLessThanOrEqual(15);
	});

	it("accounts for serialization escaping and preserves Unicode boundaries", () => {
		const output = `${'😀"\\\n'.repeat(20)}end`;
		const truncated = truncateOutput(output, 100);

		expect(typeof truncated).toBe("string");
		expect(truncated).toContain(
			`[TRUNCATED, original size: ${persistedBytes(output)} bytes]`,
		);
		expect(persistedBytes(truncated)).toBeLessThanOrEqual(100);
		expect(truncated).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it.each([
		"ascii",
		"漢字",
		"😀",
		"e\u0301",
		'"\\\n',
		["漢字", "😀"],
		{ text: "漢字😀" },
		42,
		true,
	])("preserves exact boundaries and bounds truncation for %j", (output) => {
		const bytes = persistedBytes(output);
		expect(truncateOutput(output, bytes)).toBe(output);
		for (let budget = 12; budget < bytes; budget++) {
			expect(
				persistedBytes(truncateOutput(output, budget)),
			).toBeLessThanOrEqual(budget);
		}
	});

	it.each([
		"ASCII",
		"漢字",
		"😀",
		"e\u0301",
		'"\\\n',
		["漢字"],
		{ text: "😀" },
	])(
		"keeps the marker and original persisted size for large %j output",
		(value) => {
			const output = Array(100).fill(value);
			const truncated = truncateOutput(output, 150);
			expect(truncated).toContain(
				`[TRUNCATED, original size: ${persistedBytes(output)} bytes]`,
			);
			expect(persistedBytes(truncated)).toBeLessThanOrEqual(150);
		},
	);

	it("preserves unsupported JSON compatibility", () => {
		for (const value of [null, undefined, () => {}, Symbol("test")]) {
			expect(truncateOutput(value)).toBe(value);
		}
		expect(() => truncateOutput(1n)).toThrow(TypeError);
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(() => truncateOutput(circular)).toThrow(TypeError);
	});

	it("returns a deterministic smallest representation for tiny budgets", () => {
		expect(truncateOutput("output", 0)).toBe("");
		expect(truncateOutput("output", 1)).toBe("");
		expect(truncateOutput("output", 13)).toBe(".");
	});
});
