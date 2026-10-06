import { describe, expect, it } from "vite-plus/test";
import {
	extractJsonBlock,
	type MinimalSchema,
	validateAgainstMinimalSchema,
	validateDelegationOutput,
} from "./output-schema-validate";

describe("extractJsonBlock", () => {
	it("extracts a single fenced json block", () => {
		const text = 'Here is my answer:\n```json\n{"status":"ok"}\n```\nDone.';
		const result = extractJsonBlock(text);
		expect(result).toEqual({ value: { status: "ok" }, source: "fenced" });
	});

	it("prefers the LAST fenced json block when several are present", () => {
		const text = [
			"For example:",
			"```json",
			'{"example":true}',
			"```",
			"My actual answer:",
			"```json",
			'{"status":"ok","count":3}',
			"```",
		].join("\n");
		const result = extractJsonBlock(text);
		expect(result).toEqual({
			value: { status: "ok", count: 3 },
			source: "fenced",
		});
	});

	it("falls back to whole-text JSON.parse when no fenced block exists", () => {
		const text = '  {"status":"ok"}  ';
		const result = extractJsonBlock(text);
		expect(result).toEqual({ value: { status: "ok" }, source: "whole-text" });
	});

	it("falls back to whole-text parse when the last fenced block fails to parse", () => {
		const text = "```json\nnot valid json at all\n```";
		const result = extractJsonBlock(text);
		expect(result).toBeUndefined();
	});

	it("falls back to whole-text parse when the fenced block is invalid but the whole text still is not JSON", () => {
		const text = "Some prose. ```json\n{broken\n``` more prose";
		const result = extractJsonBlock(text);
		expect(result).toBeUndefined();
	});

	it("returns undefined when neither a fenced block nor the whole text parses", () => {
		const text = "I finished the task successfully, no structured output here.";
		const result = extractJsonBlock(text);
		expect(result).toBeUndefined();
	});

	it("returns undefined for an empty string", () => {
		expect(extractJsonBlock("")).toBeUndefined();
		expect(extractJsonBlock("   ")).toBeUndefined();
	});

	it("parses arrays and primitives via the whole-text fallback", () => {
		expect(extractJsonBlock("[1,2,3]")).toEqual({
			value: [1, 2, 3],
			source: "whole-text",
		});
	});
});

describe("validateAgainstMinimalSchema — type checks", () => {
	const cases: Array<[MinimalSchema, unknown, boolean]> = [
		[{ type: "string" }, "hello", true],
		[{ type: "string" }, 42, false],
		[{ type: "number" }, 3.14, true],
		[{ type: "number" }, "3.14", false],
		[{ type: "integer" }, 5, true],
		[{ type: "integer" }, 5.5, false],
		[{ type: "boolean" }, true, true],
		[{ type: "boolean" }, "true", false],
		[{ type: "object" }, { a: 1 }, true],
		[{ type: "object" }, [1, 2], false],
		[{ type: "array" }, [1, 2], true],
		[{ type: "array" }, { a: 1 }, false],
		[{ type: "null" }, null, true],
		[{ type: "null" }, undefined, false],
	];

	for (const [schema, value, expected] of cases) {
		it(`type ${JSON.stringify(schema.type)} against ${JSON.stringify(value)} -> ${expected}`, () => {
			const result = validateAgainstMinimalSchema(value, schema);
			expect(result.valid).toBe(expected);
			if (!expected) {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.errors[0]).toContain("root:");
			}
		});
	}

	it("accepts an array of allowed types", () => {
		const schema: MinimalSchema = { type: ["string", "null"] };
		expect(validateAgainstMinimalSchema("hi", schema).valid).toBe(true);
		expect(validateAgainstMinimalSchema(null, schema).valid).toBe(true);
		expect(validateAgainstMinimalSchema(42, schema).valid).toBe(false);
	});
});

describe("validateAgainstMinimalSchema — required", () => {
	it("flags a missing required key", () => {
		const schema: MinimalSchema = {
			type: "object",
			required: ["status", "count"],
		};
		const result = validateAgainstMinimalSchema({ status: "ok" }, schema);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("root.count: required property is missing");
	});

	it("treats a key present with value undefined-equivalent (JSON has no undefined) as satisfied only when the key actually exists", () => {
		const schema: MinimalSchema = { type: "object", required: ["status"] };
		// JSON.parse never produces `undefined` values, but an explicit null
		// still counts as "present as an actual key".
		const result = validateAgainstMinimalSchema({ status: null }, schema);
		expect(result.valid).toBe(true);
	});

	it("passes when every required key is present", () => {
		const schema: MinimalSchema = {
			type: "object",
			required: ["a", "b"],
		};
		const result = validateAgainstMinimalSchema({ a: 1, b: 2, c: 3 }, schema);
		expect(result.valid).toBe(true);
	});
});

describe("validateAgainstMinimalSchema — enum", () => {
	it("flags a value outside the enum", () => {
		const schema: MinimalSchema = { enum: ["open", "closed"] };
		const result = validateAgainstMinimalSchema("pending", schema);
		expect(result.valid).toBe(false);
		expect(result.errors[0]).toContain("root:");
		expect(result.errors[0]).toContain("pending");
	});

	it("passes a value inside the enum", () => {
		const schema: MinimalSchema = { enum: ["open", "closed"] };
		expect(validateAgainstMinimalSchema("open", schema).valid).toBe(true);
	});

	it("supports non-string enum members (numbers, booleans, null)", () => {
		const schema: MinimalSchema = { enum: [1, 2, true, null] };
		expect(validateAgainstMinimalSchema(2, schema).valid).toBe(true);
		expect(validateAgainstMinimalSchema(true, schema).valid).toBe(true);
		expect(validateAgainstMinimalSchema(null, schema).valid).toBe(true);
		expect(validateAgainstMinimalSchema(3, schema).valid).toBe(false);
	});
});

describe("validateAgainstMinimalSchema — nested properties", () => {
	it("validates two levels of nested properties", () => {
		const schema: MinimalSchema = {
			type: "object",
			required: ["invoice"],
			properties: {
				invoice: {
					type: "object",
					required: ["id", "customer"],
					properties: {
						id: { type: "string" },
						customer: {
							type: "object",
							required: ["name"],
							properties: {
								name: { type: "string" },
							},
						},
					},
				},
			},
		};
		const value = {
			invoice: {
				id: "inv-1",
				customer: { name: 42 },
			},
		};
		const result = validateAgainstMinimalSchema(value, schema);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"root.invoice.customer.name: expected type string, got number",
		);
	});

	it("does not reject unknown extra properties (additionalProperties:true default)", () => {
		const schema: MinimalSchema = {
			type: "object",
			properties: { a: { type: "string" } },
		};
		const result = validateAgainstMinimalSchema({ a: "x", extra: "y" }, schema);
		expect(result.valid).toBe(true);
	});

	it("skips validating a declared property that is absent from the value (only required catches absence)", () => {
		const schema: MinimalSchema = {
			type: "object",
			properties: { a: { type: "string" } },
		};
		const result = validateAgainstMinimalSchema({}, schema);
		expect(result.valid).toBe(true);
	});
});

describe("validateAgainstMinimalSchema — array items", () => {
	it("validates every element against the items schema and names each index", () => {
		const schema: MinimalSchema = {
			type: "array",
			items: {
				type: "object",
				required: ["status"],
				properties: { status: { type: "string" } },
			},
		};
		const value = [{ status: "ok" }, { status: 5 }, { notStatus: true }];
		const result = validateAgainstMinimalSchema(value, schema);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"root[1].status: expected type string, got number",
		);
		expect(result.errors).toContain(
			"root[2].status: required property is missing",
		);
	});

	it("names a nested path through object -> array -> object -> property", () => {
		const schema: MinimalSchema = {
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						required: ["status"],
						properties: { status: { type: "string" } },
					},
				},
			},
		};
		const value = {
			items: [{ status: "ok" }, { status: "ok" }, { status: 1 }],
		};
		const result = validateAgainstMinimalSchema(value, schema);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"root.items[2].status: expected type string, got number",
		);
	});
});

describe("validateAgainstMinimalSchema — accumulation", () => {
	it("accumulates ALL violations, not just the first", () => {
		const schema: MinimalSchema = {
			type: "object",
			required: ["a", "b", "c"],
			properties: {
				a: { type: "string" },
				b: { type: "number" },
			},
		};
		const value = { a: 1, b: "not a number" };
		const result = validateAgainstMinimalSchema(value, schema);
		expect(result.valid).toBe(false);
		// missing "c", wrong type "a", wrong type "b" — three independent errors.
		expect(result.errors).toHaveLength(3);
		expect(result.errors).toContain("root.c: required property is missing");
		expect(result.errors).toContain("root.a: expected type string, got number");
		expect(result.errors).toContain("root.b: expected type number, got string");
	});

	it("a fully-valid complex value produces zero errors", () => {
		const schema: MinimalSchema = {
			type: "object",
			required: ["summary", "items"],
			properties: {
				summary: { type: "string" },
				items: {
					type: "array",
					items: {
						type: "object",
						required: ["id", "status"],
						properties: {
							id: { type: "string" },
							status: { type: "string", enum: ["open", "closed"] },
							meta: {
								type: "object",
								properties: {
									priority: { type: "integer" },
								},
							},
						},
					},
				},
			},
		};
		const value = {
			summary: "3 invoices reviewed",
			items: [
				{ id: "inv-1", status: "open", meta: { priority: 1 } },
				{ id: "inv-2", status: "closed" },
				{ id: "inv-3", status: "open", meta: { priority: 3 }, extra: true },
			],
		};
		const result = validateAgainstMinimalSchema(value, schema);
		expect(result).toEqual({ valid: true, errors: [] });
	});
});

describe("validateDelegationOutput", () => {
	const schema: MinimalSchema = {
		type: "object",
		required: ["status"],
		properties: { status: { type: "string", enum: ["ok", "partial"] } },
	};

	it("fails with a clear message when no JSON is found at all", () => {
		const result = validateDelegationOutput(
			"I finished the task, everything looks good.",
			schema,
		);
		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			"no JSON object found in the final message matching the required output schema",
		]);
	});

	it("extracts and validates a fenced json block, success case", () => {
		const message = 'All done.\n```json\n{"status":"ok"}\n```';
		const result = validateDelegationOutput(message, schema);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("extracts and validates a fenced json block, failure case", () => {
		const message = 'All done.\n```json\n{"status":"nope"}\n```';
		const result = validateDelegationOutput(message, schema);
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it("validates the whole message as JSON when unfenced", () => {
		const result = validateDelegationOutput('{"status":"partial"}', schema);
		expect(result).toEqual({ valid: true, errors: [] });
	});
});
