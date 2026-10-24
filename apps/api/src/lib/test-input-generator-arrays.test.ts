import { describe, expect, it } from "vite-plus/test";
import { generateTestInput, type JSONSchema } from "./test-input-generator";

describe("generateTestInput array cardinality", () => {
	it.each([
		[{ items: { type: "integer" }, minItems: 2, maxItems: 4 }, 2],
		[{ items: { type: "integer" }, minItems: 3 }, 3],
		[{ items: { type: "integer" }, maxItems: 0 }, 0],
		[{ items: { type: "integer" }, minItems: 0, maxItems: 0 }, 0],
		[{ items: { type: "integer" }, minItems: 0, maxItems: 2 }, 1],
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
