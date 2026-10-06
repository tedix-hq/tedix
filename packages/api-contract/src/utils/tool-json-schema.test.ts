import * as z from "zod";
import { describe, expect, it } from "vite-plus/test";
import { zodToStructuredOutputJsonSchema } from "./tool-json-schema";

describe("zodToStructuredOutputJsonSchema", () => {
	it("wraps root arrays in the ToolHandler structuredContent envelope", () => {
		const schema = zodToStructuredOutputJsonSchema(
			z.array(z.object({ id: z.uuid(), label: z.string() })),
		);

		expect(schema).toMatchObject({
			type: "object",
			required: ["data"],
			additionalProperties: false,
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						required: ["id", "label"],
					},
				},
			},
		});
	});

	it("hoists root-array definitions so nested references remain valid", () => {
		const node = z.object({ value: z.string() }).meta({ id: "Node" });
		const schema = zodToStructuredOutputJsonSchema(z.array(node));
		const data = schema?.properties?.data as Record<string, unknown>;

		expect(schema).toHaveProperty("$defs.Node");
		expect(data).toMatchObject({
			type: "array",
			items: { $ref: "#/$defs/Node" },
		});
		expect(data).not.toHaveProperty("$defs");
	});

	it("wraps scalar and null roots in the ToolHandler data envelope", () => {
		expect(zodToStructuredOutputJsonSchema(z.string())).toMatchObject({
			type: "object",
			properties: { data: { type: "string" } },
			required: ["data"],
		});
		expect(zodToStructuredOutputJsonSchema(z.null())).toMatchObject({
			type: "object",
			properties: { data: { type: "null" } },
			required: ["data"],
		});
	});

	it("wraps only the null branch of nullable object outputs", () => {
		const entry = z.object({ id: z.uuid() }).meta({ id: "Entry" });
		const schema = zodToStructuredOutputJsonSchema(entry.nullable());

		expect(schema).toHaveProperty("$defs.Entry");
		expect(schema?.anyOf).toEqual([
			{ $ref: "#/$defs/Entry" },
			{
				type: "object",
				properties: { data: { type: "null" } },
				required: ["data"],
				additionalProperties: false,
			},
		]);
	});

	it("leaves object-only compositions unchanged", () => {
		const schema = zodToStructuredOutputJsonSchema(
			z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("ready"), value: z.string() }),
				z.object({ kind: z.literal("blocked"), reason: z.string() }),
			]),
		);

		expect(schema?.oneOf).toHaveLength(2);
		expect(schema?.oneOf).not.toContainEqual(
			expect.objectContaining({ properties: { data: expect.anything() } }),
		);
	});

	it("leaves root object outputs unchanged", () => {
		const schema = zodToStructuredOutputJsonSchema(
			z.object({
				data: z.array(z.string()),
				nextCursor: z.string().nullable(),
			}),
		);

		expect(schema).toMatchObject({
			type: "object",
			required: ["data", "nextCursor"],
			properties: {
				data: { type: "array", items: { type: "string" } },
				// zod emits a nullable scalar as a type UNION, not an `anyOf` pair.
				// Both are valid 2020-12 and both survive ToolJsonSchemaSchema; what
				// this test pins is that a root OBJECT output is passed through
				// untouched — `projectStructuredAlternative` must not wrap it in the
				// handler's `{ data: … }` envelope.
				nextCursor: { type: ["string", "null"] },
			},
		});
	});

	it("does not envelope a nullable scalar property of a root object", () => {
		const schema = zodToStructuredOutputJsonSchema(
			z.object({ nextCursor: z.string().nullable() }),
		);

		// The envelope is for root non-objects only. A nullable PROPERTY stays a
		// property however zod spells it, so this holds across zod's emission.
		expect(schema?.properties?.nextCursor).not.toHaveProperty("properties");
		expect(schema?.type).toBe("object");
	});
});
