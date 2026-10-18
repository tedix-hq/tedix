import { describe, expect, test } from "bun:test";
import {
	facts,
	queries,
	corrections,
	lessonPrompts,
	longMemEval,
	orgs,
} from "./fixtures";
import { percentile, retrieval } from "./metrics";

describe("memory proof accounting", () => {
	test("ranks only the requested window and scores absence as zero", () => {
		expect(retrieval(["a", "b"], ["x", "a", "z"], 2)).toEqual({
			recall: 0.5,
			mrr: 0.5,
		});
		expect(retrieval(["a"], ["x", "y", "z", "w", "v", "a"])).toEqual({
			recall: 0,
			mrr: 0,
		});
		expect(percentile([9, 1, 2, 3, 4], 0.95)).toBe(9);
	});
	test("fixtures have independent labels and three isolated tenants", () => {
		expect(facts).toHaveLength(120);
		expect(queries).toHaveLength(40);
		expect(corrections).toHaveLength(30);
		expect(lessonPrompts).toHaveLength(20);
		expect(longMemEval).toHaveLength(50);
		expect(new Set(facts.map((f) => f.id)).size).toBe(120);
		for (const q of queries) {
			for (const id of q.expected) {
				const f = facts.find((f) => f.id === id)!;
				expect(f.org).toBe(q.org);
				expect(f.validTo).toBeUndefined();
				expect(q.forbidden).not.toContain(id);
			}
			expect(
				q.forbidden.some((id) => facts.find((f) => f.id === id)?.org !== q.org),
			).toBe(true);
		}
		expect(new Set(facts.map((f) => f.org))).toEqual(new Set(orgs));
	});
	test("LongMemEval answers point to sessions in the record", () => {
		for (const item of longMemEval)
			for (const id of item.answer_session_ids)
				expect(item.haystack_session_ids).toContain(id);
	});
});
