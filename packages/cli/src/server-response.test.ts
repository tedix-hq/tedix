import { describe, expect, test } from "bun:test";
import * as z from "zod";
import {
	parseServerResponse,
	safeParseServerResponse,
} from "./server-response";

const Row = z.strictObject({
	id: z.string(),
	owner: z.strictObject({ name: z.string() }).nullable(),
});
const Page = z.strictObject({
	data: z.array(Row),
	next: z.strictObject({ at: z.string() }).nullable(),
});

describe("server responses newer than this CLI", () => {
	test("ignores unknown fields at every depth and returns the known ones", () => {
		const value = {
			data: [{ id: "a", owner: { name: "Ada", team: "x" }, score: 1 }],
			next: { at: "t", page: 2 },
			total: 1,
		};
		const before = JSON.stringify(value);
		expect(parseServerResponse(Page, value, "The page")).toEqual({
			data: [{ id: "a", owner: { name: "Ada" } }],
			next: { at: "t" },
		});
		expect(JSON.stringify(value)).toBe(before);
	});

	test("names a missing or retyped field and suggests an update", () => {
		expect(() =>
			parseServerResponse(
				Page,
				{ data: [{ owner: null, added: 1 }], next: null },
				"The page",
			),
		).toThrow(
			"The page is not what this CLI expects: data.0.id is missing. The server may be newer than this CLI; run `tedix update` and retry.",
		);
		const retyped = safeParseServerResponse(Page, {
			data: [{ id: 7, owner: null }],
			next: null,
			added: 1,
		});
		expect(retyped).toMatchObject({ success: false });
		expect(JSON.stringify(retyped)).toContain("data.0.id: ");
	});

	test("follows the union branch that only lacks the unknown fields", () => {
		const Either = z.union([
			z.strictObject({ a: z.string() }),
			z.strictObject({ b: z.string(), c: z.string().optional() }),
		]);
		const wrapped = z.strictObject({ value: Either });
		expect(
			parseServerResponse(wrapped, { value: { b: "x", added: 1 } }, "It"),
		).toEqual({ value: { b: "x" } });
		const both = z.union([
			z.strictObject({ a: z.string(), kept: z.number().optional() }),
			z.strictObject({ a: z.string() }),
		]);
		expect(
			parseServerResponse(both, { a: "x", kept: 1, added: 1 }, "It"),
		).toEqual({ a: "x", kept: 1 });
		expect(safeParseServerResponse(wrapped, { value: { added: 1 } })).toEqual(
			expect.objectContaining({ success: false }),
		);
	});

	test("tolerates a live JSON schema that forbids additional properties", () => {
		const live = z.fromJSONSchema({
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		});
		expect(safeParseServerResponse(live, { id: "a", added: 1 }).success).toBe(
			true,
		);
		expect(safeParseServerResponse(live, { added: 1 })).toEqual({
			success: false,
			message: "id is missing",
		});
	});
});
