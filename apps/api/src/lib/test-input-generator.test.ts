import { describe, expect, it } from "vite-plus/test";
import {
	generateTestInput,
	truncateOutput,
	validateToolOutput,
	type JSONSchema,
} from "./test-input-generator";

describe("generateTestInput name defaults", () => {
	it.each([
		["count", { type: "string" }, expect.any(String)],
		[
			"name",
			{
				type: "object",
				properties: { count: { type: "string" } },
				required: ["count"],
			},
			{ count: expect.any(String) },
		],
		["name", { type: "null" }, null],
		["active", { type: "number" }, 50],
		["latitude", { type: "integer" }, 50],
		["limit", { type: "integer", minimum: 20, maximum: 30 }, 25],
		["count", { type: "number", minimum: 0, maximum: 2 }, 1],
		["name", { type: "string", minLength: 20 }, "test_value".padEnd(30, "_")],
		["title", { type: "string", maxLength: 3 }, "tes"],
		[
			"name",
			{ type: "string", format: "uuid" },
			"550e8400-e29b-41d4-a716-446655440000",
		],
		["date", { type: "string", format: "time" }, "12:00:00"],
	] satisfies Array<
		[string, NonNullable<JSONSchema["properties"]>[string], unknown]
	>)("respects the schema for %s (%j)", (name, property, expected) => {
		expect(
			generateTestInput({ properties: { [name]: property }, required: [name] }),
		).toEqual({ [name]: expected });
	});

	it("keeps compatible name defaults, including optional properties and schemas without a type", () => {
		expect(
			generateTestInput({
				properties: {
					name: { type: "string", minLength: 1, maxLength: 20 },
					count: { type: "integer", minimum: 0, maximum: 20 },
					active: { type: "boolean" },
					query: {},
				},
			}),
		).toEqual({
			name: "Test Name",
			count: 10,
			active: true,
			query: "test search query",
		});
	});

	it("preserves explicit defaults and enum precedence", () => {
		expect(
			generateTestInput({
				properties: {
					count: { type: "integer", default: 4, enum: [2, 3] },
					name: { type: "string", enum: ["chosen"] },
				},
			}),
		).toEqual({ count: 4, name: "chosen" });
	});
});

function generateQuantity(
	schema: NonNullable<JSONSchema["properties"]>[string],
): number {
	return generateTestInput({
		type: "object",
		properties: { quantity: schema },
		required: ["quantity"],
	}).quantity as number;
}

describe("generateTestInput numeric bounds", () => {
	it("respects one-sided number bounds", () => {
		expect(
			generateQuantity({ type: "number", minimum: 1000 }),
		).toBeGreaterThanOrEqual(1000);
		expect(
			generateQuantity({ type: "number", maximum: -100 }),
		).toBeLessThanOrEqual(-100);
	});

	it("rounds fractional integer bounds into the valid range", () => {
		expect(generateQuantity({ type: "integer", minimum: 1000.25 })).toBe(1001);
		expect(generateQuantity({ type: "integer", maximum: -100.25 })).toBe(-101);
	});
});

describe("generateTestInput exclusive numeric bounds", () => {
	const bounds = [
		{ exclusiveMinimum: 50 },
		{ exclusiveMaximum: -50 },
		{ exclusiveMinimum: 0 },
		{ exclusiveMaximum: 0 },
		{ exclusiveMinimum: -10 },
		{ exclusiveMaximum: 10 },
		{ exclusiveMinimum: 10.25 },
		{ exclusiveMaximum: -10.25 },
		{ exclusiveMinimum: -10.75, exclusiveMaximum: -9.25 },
		{ exclusiveMinimum: 10, exclusiveMaximum: 12 },
		{ minimum: 10, exclusiveMinimum: 20, maximum: 30 },
		{ minimum: 20, exclusiveMinimum: 10, maximum: 30 },
		{ minimum: -30, maximum: -10, exclusiveMaximum: -20 },
		{ minimum: -30, maximum: -20, exclusiveMaximum: -10 },
		{ exclusiveMinimum: 1e20 },
		{ exclusiveMaximum: -1e20 },
	];

	for (const type of ["number", "integer"]) {
		it.each(bounds)(`respects ${type} bounds %j`, (constraints) => {
			const value = generateQuantity({ type, ...constraints });
			expect(Number.isFinite(value)).toBe(true);
			if (type === "integer") expect(Number.isInteger(value)).toBe(true);
			if (constraints.exclusiveMinimum !== undefined) {
				expect(value).toBeGreaterThan(constraints.exclusiveMinimum);
			}
			if (constraints.exclusiveMaximum !== undefined) {
				expect(value).toBeLessThan(constraints.exclusiveMaximum);
			}
			if (constraints.minimum !== undefined) {
				expect(value).toBeGreaterThanOrEqual(constraints.minimum);
			}
			if (constraints.maximum !== undefined) {
				expect(value).toBeLessThanOrEqual(constraints.maximum);
			}
		});
	}

	it.each([
		{ exclusiveMinimum: 1, exclusiveMaximum: 1 + Number.EPSILON * 2 },
		{ exclusiveMinimum: 0, exclusiveMaximum: Number.MIN_VALUE * 2 },
		{ minimum: 1 + Number.EPSILON, exclusiveMaximum: 1 + Number.EPSILON * 2 },
	])("handles narrow number intervals %j", (constraints) => {
		const value = generateQuantity({ type: "number", ...constraints });
		if (constraints.exclusiveMinimum !== undefined) {
			expect(value).toBeGreaterThan(constraints.exclusiveMinimum);
		}
		expect(value).toBeLessThan(constraints.exclusiveMaximum);
		if (constraints.minimum !== undefined) {
			expect(value).toBeGreaterThanOrEqual(constraints.minimum);
		}
	});

	it.each(["number", "integer"])(
		"checks optional named %s defaults against exclusive bounds",
		(type) => {
			const result = generateTestInput({
				properties: {
					limit: { type, exclusiveMinimum: 10 },
					offset: { type, exclusiveMaximum: 0 },
					count: { type, exclusiveMinimum: 9, exclusiveMaximum: 11 },
				},
			});
			expect(result.limit).toBeGreaterThan(10);
			expect(result.offset).toBeLessThan(0);
			expect(result.count).toBe(10);
			if (type === "integer") {
				for (const value of Object.values(result)) {
					expect(Number.isInteger(value)).toBe(true);
				}
			}
		},
	);
});

describe("generateTestInput example prompts", () => {
	const prompts = (cleanPrompt: string) => ({
		examplePrompts: [{ raw: cleanPrompt, cleanPrompt, appMention: "@Example" }],
	});

	it("uses prompt values that satisfy the schema", () => {
		expect(
			generateTestInput(
				{
					properties: {
						limit: { type: "integer", minimum: 1, maximum: 20 },
						query: { type: "string" },
					},
					required: ["limit", "query"],
				},
				prompts("Find the top 5 results for hiking boots"),
			),
		).toEqual({ limit: 5, query: "Find the top 5 results for hiking boots" });
	});

	it("falls back to schema generation for out-of-bounds, enum and type mismatches", () => {
		expect(
			generateTestInput(
				{
					properties: {
						limit: { type: "integer", maximum: 5 },
						count: { type: "integer", exclusiveMaximum: 100 },
						top: { type: "string", enum: ["a", "b"] },
						location: { type: "integer", minimum: 3, maximum: 3 },
						query: { type: "string", maxLength: 10 },
					},
					required: ["limit", "count", "top", "location", "query"],
				},
				prompts("Show the top 100 results for coffee in Berlin"),
			),
		).toEqual({
			limit: 5,
			count: 10,
			top: "a",
			location: 3,
			query: "test_value",
		});
	});

	it("keeps an enum query instead of substituting the prompt", () => {
		expect(
			generateTestInput(
				{
					properties: { q: { type: "string", enum: ["news", "images"] } },
					required: ["q"],
				},
				prompts("Look up the latest headlines"),
			),
		).toEqual({ q: "news" });
	});
});

describe("generateTestInput array cardinality", () => {
	it.each([
		[{ items: { type: "integer" }, minItems: 2, maxItems: 4 }, 2],
		[{ items: { type: "integer" }, minItems: 3 }, 3],
		[{ items: { type: "integer" }, maxItems: 0 }, 0],
		[{ items: { type: "integer" } }, 1],
		[{ minItems: 2, maxItems: 3 }, 2],
		[{}, 0],
	] satisfies Array<[NonNullable<JSONSchema["properties"]>[string], number]>)(
		"generates %j with length %i",
		(bounds, length) => {
			const { values } = generateTestInput({
				properties: { values: { type: "array", ...bounds } },
				required: ["values"],
			});
			expect(values).toHaveLength(length);
			if ("items" in bounds) {
				expect(values).toEqual(Array.from({ length }, () => 50));
			}
		},
	);

	it("generates independent objects with nested required arrays", () => {
		const { groups } = generateTestInput({
			properties: {
				groups: {
					type: "array",
					minItems: 2,
					maxItems: 2,
					items: {
						type: "object",
						properties: {
							values: {
								type: "array",
								minItems: 3,
								maxItems: 3,
								items: { type: "boolean" },
							},
						},
						required: ["values"],
					},
				},
			},
			required: ["groups"],
		});
		expect(groups).toEqual([
			{ values: [true, true, true] },
			{ values: [true, true, true] },
		]);
		const [first, second] = groups as Array<{ values: boolean[] }>;
		expect(first).not.toBe(second);
		expect(first?.values).not.toBe(second?.values);
	});
});

describe("validateToolOutput", () => {
	it("rejects MCP isError results even when their content is non-empty", () => {
		expect(
			validateToolOutput({
				isError: true,
				content: [{ type: "text", text: "The upstream rejected the call" }],
			}),
		).toEqual({ valid: false, issues: ["Output is an MCP tool error"] });
	});
});

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
	])("preserves exact boundaries and bounds truncation for %j", (output) => {
		const bytes = persistedBytes(output);
		expect(truncateOutput(output, bytes)).toBe(output);
		for (let budget = 12; budget < bytes; budget++) {
			expect(
				persistedBytes(truncateOutput(output, budget)),
			).toBeLessThanOrEqual(budget);
		}
	});

	it.each(["漢字😀e\u0301", '"\\\n', ["漢字"], { text: "😀" }])(
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
