import { describe, expect, it } from "vite-plus/test";
import {
	evaluateTenantPolicyPredicate,
	isTenantPolicyPredicate,
	matchesTenantPolicyPredicate,
} from "./tenant-policy-predicate";

describe("tenant policy predicates", () => {
	const predicate = {
		version: 1,
		schema: {
			anyOf: [
				{
					type: "object",
					additionalProperties: false,
					required: ["target", "action"],
					properties: {
						target: { type: "string", nonBlank: true },
						action: { type: "string", const: "edit" },
						details: {
							type: "object",
							properties: {},
							additionalProperties: true,
						},
					},
				},
				{
					type: "object",
					additionalProperties: false,
					required: ["target", "action", "changes"],
					properties: {
						target: { type: "string", nonBlank: true },
						action: { type: "string", const: "append" },
						changes: {
							type: "array",
							minItems: 1,
							items: { type: "string", minLength: 1 },
						},
					},
				},
			],
		},
	};

	it("matches the declared alternatives and rejects undeclared or changed arguments", () => {
		expect(isTenantPolicyPredicate(predicate)).toBe(true);
		expect(
			matchesTenantPolicyPredicate(predicate, {
				target: "doc",
				action: "edit",
				details: { title: "example" },
			}),
		).toBe(true);
		expect(
			matchesTenantPolicyPredicate(predicate, {
				target: "doc",
				action: "append",
				changes: ["a"],
			}),
		).toBe(true);
		expect(
			matchesTenantPolicyPredicate(predicate, { target: " ", action: "edit" }),
		).toBe(false);
		expect(
			matchesTenantPolicyPredicate(predicate, {
				target: "doc",
				action: "edit",
				delete: true,
			}),
		).toBe(false);
		expect(
			matchesTenantPolicyPredicate(predicate, {
				target: "doc",
				action: "append",
				changes: [],
			}),
		).toBe(false);
	});

	it("rejects unsupported and malformed schema constructs", () => {
		for (const schema of [
			{ type: "string", pattern: ".*" },
			{ $ref: "https://example.test/schema" },
			{ anyOf: [] },
			{
				type: "object",
				properties: {},
				additionalProperties: false,
				required: ["missing"],
			},
			{ type: "array", items: { type: "string" }, minItems: 3, maxItems: 1 },
		]) {
			expect(isTenantPolicyPredicate({ version: 1, schema })).toBe(false);
			expect(
				matchesTenantPolicyPredicate({ version: 1, schema }, "anything"),
			).toBe(false);
		}
	});

	it("does not accept inherited fields as properties", () => {
		const input = Object.create({ target: "doc" });
		input.action = "edit";
		expect(matchesTenantPolicyPredicate(predicate, input)).toBe(false);
	});
	it("distinguishes an exhausted or invalid rule from a nonmatch and shares the budget", () => {
		const rule = { version: 1, schema: { type: "string", const: "safe" } };
		const budget = { remaining: 1 };
		expect(evaluateTenantPolicyPredicate(rule, "other", budget)).toBe(
			"no_match",
		);
		expect(evaluateTenantPolicyPredicate(rule, "safe", budget)).toBe("invalid");
		expect(
			evaluateTenantPolicyPredicate(
				{ version: 1, schema: { $ref: "unknown" } },
				"safe",
			),
		).toBe("invalid");
	});
});
