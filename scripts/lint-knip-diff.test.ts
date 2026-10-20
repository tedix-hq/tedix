import { describe, expect, test } from "bun:test";
import {
	diffFindings,
	normalizeReport,
	parseKnipResult,
	readBaseline,
} from "./lint-knip-diff.ts";

describe("Knip differential gate", () => {
	test("sorts and deduplicates without source positions or owners", () => {
		const findings = normalizeReport({
			issues: [
				{
					file: "./b.ts",
					owners: [{ name: "team" }],
					exports: [
						{ name: "z", line: 1 },
						{ name: "z", line: 9 },
					],
				},
				{ file: "a.ts", exports: [{ name: "a", line: 20 }] },
			],
		});
		expect(findings).toEqual([
			{ path: "a.ts", symbol: "a", type: "exports" },
			{ path: "b.ts", symbol: "z", type: "exports" },
		]);
		expect(
			diffFindings(
				normalizeReport({
					issues: [{ file: "a.ts", exports: [{ name: "a", line: 500 }] }],
				}),
				findings,
			).added,
		).toEqual([]);
	});

	test("detects additions independently of removals and issue type", () => {
		const old = { path: "a.ts", symbol: "old", type: "exports" };
		const added = { path: "a.ts", symbol: "old", type: "types" };
		expect(diffFindings([added], [old])).toEqual({
			added: [added],
			removed: [old],
		});
	});

	test("keeps namespace members and grouped duplicate exports", () => {
		expect(
			normalizeReport({
				issues: [
					{
						file: "a.ts",
						enumMembers: [{ name: "x", namespace: "E" }],
						duplicates: [[{ name: "a" }, { name: "b" }]],
						files: [{ name: "a.ts" }],
					},
				],
			}),
		).toEqual([
			{ path: "a.ts", symbol: "E.x", type: "enumMembers" },
			{ path: "a.ts", symbol: "a", type: "duplicates" },
			{ path: "a.ts", symbol: "a.ts", type: "files" },
			{ path: "a.ts", symbol: "b", type: "duplicates" },
		]);
	});

	test("accepts findings exit 1 and clean exit 0, fails closed on tool errors", () => {
		expect(parseKnipResult('{"issues":[]}', 0)).toEqual([]);
		expect(
			parseKnipResult(
				'{"issues":[{"file":"x.ts","exports":[{"name":"x"}]}]}',
				1,
			),
		).toHaveLength(1);
		for (const [stdout, code] of [
			["oops", 1],
			['{"issues":[]}', 1],
			['{"issues":[]}', 2],
			["{}", 0],
		] as const) {
			expect(() => parseKnipResult(stdout, code)).toThrow();
		}
	});

	test("rejects malformed reports and baselines", () => {
		for (const value of [
			{ issues: [null] },
			{ issues: [{ file: "x", exports: {} }] },
			{ issues: [{ file: "x", exports: [{}] }] },
		]) {
			expect(() => normalizeReport(value)).toThrow();
		}
		for (const value of [
			null,
			{},
			[{ path: "x", symbol: "x" }],
			[{ path: "x", symbol: "x", type: "exports", line: 1 }],
		]) {
			expect(() => readBaseline(value)).toThrow();
		}
		expect(readBaseline([])).toEqual([]);
	});
});
