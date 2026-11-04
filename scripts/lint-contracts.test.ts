import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { classify, evaluateStrictness } from "./lint-contracts";

const loose = z.object({ id: z.string() });
const strict = z.strictObject({ native: z.string() });

describe("contract input strictness", () => {
	test("retains a loose union branch as existing collection debt", () => {
		const input = z.union([loose, strict]);
		expect(input.parse({ id: "item", filter: "unrecognized" })).toEqual({
			id: "item",
		});
		const entry = {
			file: "work-items.ts",
			procedure: "workItemsContract.listAttempts",
			method: "GET",
			strictness: classify(input),
		};
		expect(entry.strictness).toBe("loose");
		expect(
			evaluateStrictness(
				[entry],
				["work-items.ts::workItemsContract.listAttempts"],
			),
		).toEqual([]);
	});

	test("rejects new loose union debt without a baseline entry", () => {
		const findings = evaluateStrictness(
			[
				{
					file: "example.ts",
					procedure: "example.list",
					method: "GET",
					strictness: classify(z.union([strict, loose])),
				},
			],
			[],
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.message).toContain("new loose collection-read input");
	});

	test("finds loose branches through nested unions and wrappers", () => {
		expect(
			classify(
				z
					.union([strict, z.union([z.string(), loose]).optional()])
					.nullable()
					.readonly(),
			),
		).toBe("loose");
	});

	test("recognizes strict-only object unions", () => {
		const input = z.union([strict, z.strictObject({ id: z.string() })]);
		expect(
			input.safeParse({ id: "item", filter: "unrecognized" }).success,
		).toBe(false);
		expect(classify(input)).toBe("strict");
	});

	test("inspects discriminated union branches", () => {
		expect(
			classify(
				z.discriminatedUnion("kind", [
					z.strictObject({ kind: z.literal("native") }),
					z.object({ kind: z.literal("legacy") }),
				]),
			),
		).toBe("loose");
	});

	test("does not invent loose objects in primitive or mixed strict unions", () => {
		expect(classify(z.union([z.string(), z.number()]))).toBe("non-object");
		expect(classify(z.union([z.string(), strict]))).toBe("strict");
	});

	test("preserves ordinary objects, wrappers and absent inputs", () => {
		expect(classify(loose)).toBe("loose");
		expect(classify(strict.optional())).toBe("strict");
		expect(classify(loose.default({ id: "item" }))).toBe("loose");
		expect(classify(undefined)).toBe("absent");
	});
});
