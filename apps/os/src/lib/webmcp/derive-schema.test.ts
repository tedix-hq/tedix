import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";
import {
	contractInputSchema,
	deriveToolSchema,
} from "@/lib/webmcp/derive-schema";

const contract = z
	.object({
		id: z.uuid(),
		title: z.string().min(1).max(500),
		kind: z.enum(["a", "b", "c"]).default("c"),
		note: z.string().max(2000).optional().describe("contract note"),
		expectedRevision: z.number().int().positive().optional(),
		when: z.iso.datetime().optional(),
	})
	.strict();

describe("deriveToolSchema", () => {
	it("derives picked fields with contract constraints and contract-required keys", () => {
		const schema = deriveToolSchema(contract, {
			pick: ["id", "title", "kind", "note"],
		});
		expect(schema["type"]).toBe("object");
		expect(schema["$schema"]).toBeUndefined();
		const props = schema["properties"] as Record<
			string,
			Record<string, unknown>
		>;
		expect(Object.keys(props)).toEqual(["id", "title", "kind", "note"]);
		expect(props["title"]).toMatchObject({
			type: "string",
			minLength: 1,
			maxLength: 500,
		});
		expect(props["kind"]).toMatchObject({ enum: ["a", "b", "c"] });
		// io:"input": a defaulted field is optional for the caller.
		expect(schema["required"]).toEqual(["id", "title"]);
		// A `.strict()` contract derives additionalProperties: false.
		expect(schema["additionalProperties"]).toBe(false);
	});

	it("sanitizes derived noise: format keeps no pattern, integer bounds read inclusively", () => {
		const schema = deriveToolSchema(contract, {
			pick: ["id", "expectedRevision", "when"],
		});
		const props = schema["properties"] as Record<
			string,
			Record<string, unknown>
		>;
		expect(props["id"]).toMatchObject({ type: "string", format: "uuid" });
		expect(props["id"]?.["pattern"]).toBeUndefined();
		expect(props["when"]).toMatchObject({
			type: "string",
			format: "date-time",
		});
		expect(props["when"]?.["pattern"]).toBeUndefined();
		// zod emits exclusiveMinimum 0 + maximum MAX_SAFE_INTEGER for
		// int().positive(); the tool schema states the equivalent minimum 1.
		expect(props["expectedRevision"]).toMatchObject({
			type: "integer",
			minimum: 1,
		});
		expect(props["expectedRevision"]?.["exclusiveMinimum"]).toBeUndefined();
		expect(props["expectedRevision"]?.["maximum"]).toBeUndefined();
	});

	it("applies the overlay: require, override merge, extra fields, additionalProperties", () => {
		const schema = deriveToolSchema(contract, {
			pick: ["id", "note", "expectedRevision"],
			require: ["expectedRevision", "confirm"],
			override: {
				note: { description: "tool note" },
			},
			extra: {
				confirm: { type: "boolean", description: "tool-only" },
				tediSlug: { type: "string" },
			},
			additionalProperties: true,
		});
		const props = schema["properties"] as Record<
			string,
			Record<string, unknown>
		>;
		// Override merges over the derived property — constraints survive.
		expect(props["note"]).toMatchObject({
			type: "string",
			maxLength: 2000,
			description: "tool note",
		});
		expect(props["confirm"]).toEqual({
			type: "boolean",
			description: "tool-only",
		});
		// Required = contract-required (id) + overlay, in property order.
		expect(schema["required"]).toEqual(["id", "expectedRevision", "confirm"]);
		expect(schema["additionalProperties"]).toBe(true);
	});

	it("omits required entirely when nothing is required", () => {
		const schema = deriveToolSchema(contract, { pick: ["note"] });
		expect(schema["required"]).toBeUndefined();
	});

	it("throws loudly on a pick/override/extra/require key the shape cannot satisfy", () => {
		expect(() => deriveToolSchema(contract, { pick: ["gone"] })).toThrow();
		expect(() =>
			deriveToolSchema(contract, {
				pick: ["id"],
				override: { title: { description: "not picked" } },
			}),
		).toThrow(/override key/);
		expect(() =>
			deriveToolSchema(contract, {
				pick: ["id"],
				extra: { id: { type: "string" } },
			}),
		).toThrow(/collides/);
		expect(() =>
			deriveToolSchema(contract, { pick: ["id"], require: ["absent"] }),
		).toThrow(/required key/);
	});
});

describe("contractInputSchema", () => {
	it("unwraps an optional oRPC input to its zod object", () => {
		const procedure = {
			"~orpc": { inputSchemas: [contract.pick({ id: true }).optional()] },
		};
		const input = contractInputSchema(procedure);
		expect(Object.keys(input.shape)).toEqual(["id"]);
	});

	it("rejects a procedure with no input schema", () => {
		expect(() => contractInputSchema({ "~orpc": {} })).toThrow(
			/no input schema/,
		);
	});
});
