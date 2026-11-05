import { describe, expect, it } from "vite-plus/test";
import {
	inferOutputSchema,
	mergeOutputSchemas,
} from "./output-schema-inference";

describe("output shape inference", () => {
	it("learns array items after an empty first sample", () => {
		expect(
			mergeOutputSchemas(
				inferOutputSchema([]),
				inferOutputSchema([{ id: "secret" }]),
			),
		).toEqual({
			type: "array",
			items: {
				type: "object",
				required: ["id"],
				properties: { id: { type: "string" } },
			},
		});
	});
	it("unions heterogeneous items without retaining literal values", () => {
		expect(inferOutputSchema([null, "secret", 3, true])).toEqual({
			type: "array",
			items: {
				anyOf: [
					{ type: "null" },
					{ type: "string" },
					{ type: "number" },
					{ type: "boolean" },
				],
			},
		});
	});
	it("bounds recursive samples and treats unsupported values as unknown", () => {
		const value: Record<string, unknown> = {};
		value.self = value;
		expect(() => inferOutputSchema(value)).not.toThrow();
		expect(inferOutputSchema(undefined)).toEqual({});
	});
});
