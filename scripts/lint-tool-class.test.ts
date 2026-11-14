import { describe, expect, test } from "bun:test";
import {
	builtinPolicyFindings,
	homeToolFindings,
	operatorToolFindings,
} from "./lint-tool-class";

const bounded = {
	"com.tedix/policy": {
		riskTier: "bounded_write",
		blastRadius: "single_resource",
	},
};

describe("lint-tool-class", () => {
	test("an operator tool needs a kind", () => {
		expect(
			operatorToolFindings([
				{ toolId: "list_things", kind: "read" },
				{ toolId: "remove_thing", kind: "destructive" },
			]),
		).toEqual([]);
		expect(operatorToolFindings([{ toolId: "tidy_things" }])).toEqual([
			'operator tool tidy_things: kind must be "read", "write" or "destructive"',
		]);
	});

	test("a non-read Home tool needs a risk tier", () => {
		const read = { toolId: "read_x", annotations: { readOnlyHint: true } };
		const write = { toolId: "write_x", annotations: { readOnlyHint: false } };
		expect(homeToolFindings([read, { ...write, meta: bounded }])).toEqual([]);
		expect(homeToolFindings([write])[0]).toContain(
			"Home tool write_x has no risk tier",
		);
	});

	test("a pre-existing Home tool has no exemption for a missing tier", () => {
		expect(
			homeToolFindings([
				{ toolId: "ask", annotations: { readOnlyHint: false } },
			])[0],
		).toContain("has no risk tier");
	});

	test("a Home tool must state whether it writes", () => {
		expect(
			homeToolFindings([{ toolId: "mystery", annotations: {} }])[0],
		).toContain("Home tool mystery has no write class");
	});

	test("a built-in policy states tier and reach together", () => {
		expect(builtinPolicyFindings(bounded)).toEqual([]);
		expect(
			builtinPolicyFindings({ odd: { riskTier: "bounded_write" } }),
		).toHaveLength(1);
		expect(builtinPolicyFindings({ empty: {} })).toEqual([
			"builtinToolPolicies.empty: riskTier and blastRadius are required",
		]);
	});
});
