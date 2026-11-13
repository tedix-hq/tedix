import { describe, expect, test } from "bun:test";
import { evaluateCycles, findCycles } from "./import-cycle-policy";

describe("zero import cycles", () => {
	test("accepts acyclic workspaces", () => {
		const cycles = findCycles(
			new Map([
				["a.ts", ["b.ts"]],
				["b.ts", []],
			]),
		);
		expect(
			evaluateCycles([{ workspace: "packages/example/src", cycles }]).ok,
		).toBe(true);
	});

	test("rejects cycles in both existing and new workspaces", () => {
		const cycles = findCycles(
			new Map([
				["a.ts", ["b.ts"]],
				["b.ts", ["a.ts"]],
			]),
		);
		const verdict = evaluateCycles([
			{ workspace: "apps/api/src", cycles },
			{ workspace: "packages/new/src", cycles },
		]);
		expect(verdict.ok).toBe(false);
		expect(verdict.failures).toHaveLength(2);
		expect(verdict.failures.join("\n")).toContain("a.ts -> b.ts -> a.ts");
	});

	test("rejects self imports", () => {
		const cycles = findCycles(new Map([["a.ts", ["a.ts"]]]));
		expect(cycles).toEqual([["a.ts"]]);
		expect(evaluateCycles([{ workspace: "apps/example/src", cycles }]).ok).toBe(
			false,
		);
	});
});
