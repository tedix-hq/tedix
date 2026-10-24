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
