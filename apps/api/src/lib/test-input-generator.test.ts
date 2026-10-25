import { describe, expect, it } from "vite-plus/test";
import { generateTestInput, type JSONSchema } from "./test-input-generator";

describe("generateTestInput name defaults", () => {
	it.each([
		["count", { type: "string" }, expect.any(String)],
		["name", { type: "array", items: { type: "integer" } }, [50]],
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
