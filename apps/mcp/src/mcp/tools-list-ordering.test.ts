import { describe, expect, it } from "vite-plus/test";
import { sortToolsDeterministically } from "./tools-list-order";

describe("tools/list deterministic ordering (prompt-cache hits)", () => {
	it("sorts tools by name ascending regardless of input order", () => {
		const a = sortToolsDeterministically([
			{ name: "zebra" },
			{ name: "alpha" },
			{ name: "mike" },
		]);
		const b = sortToolsDeterministically([
			{ name: "mike" },
			{ name: "zebra" },
			{ name: "alpha" },
		]);
		expect(a.map((t) => (t as { name: string }).name)).toEqual([
			"alpha",
			"mike",
			"zebra",
		]);
		// Same set, different input order → identical output (cache-stable).
		expect(a).toEqual(b);
	});

	it("sorts named rows across a nameless middle row", () => {
		const z = Object.freeze({ name: "z" });
		const placeholder = Object.freeze({ other: true });
		const a = Object.freeze({ name: "a" });
		const tools = [z, placeholder, a];
		expect(sortToolsDeterministically(tools)).toBe(tools);
		expect(tools[0]).toBe(a);
		expect(tools[1]).toBe(placeholder);
		expect(tools[2]).toBe(z);
	});

	it("sorts every named permutation stably while preserving placeholder slots", () => {
		const named = ["a", "\uE000", "", "A", "\u{10000}", "a"].map((name, id) =>
			Object.freeze({ name, id }),
		);
		const placeholders = [
			Object.freeze({ other: true }),
			Object.freeze({ name: 42 }),
			Object.freeze({ name: null }),
		];
		function* permutations<T>(rows: T[]): Generator<T[]> {
			if (rows.length === 0) {
				yield [];
				return;
			}
			for (const [index, row] of rows.entries()) {
				const rest = rows.filter((_, i) => i !== index);
				for (const tail of permutations(rest)) yield [row, ...tail];
			}
		}
		for (const permutation of permutations(named)) {
			// U+10000 precedes U+E000 in UTF-16 code-unit order.
			const expectedNamed = ["", "A", "a", "\u{10000}", "\uE000"].flatMap(
				(name) => permutation.filter((row) => row.name === name),
			);
			for (const slots of [
				[0, 4, 8],
				[1, 3, 5],
				[2, 6, 7],
			]) {
				const tools: unknown[] = [...permutation];
				const expected: unknown[] = [...expectedNamed];
				for (const [index, slot] of slots.entries()) {
					tools.splice(slot, 0, placeholders[index]);
					expected.splice(slot, 0, placeholders[index]);
				}
				for (let pass = 0; pass < 2; pass++) {
					expect(sortToolsDeterministically(tools)).toBe(tools);
					expect(tools).toHaveLength(expected.length);
					for (const [index, row] of expected.entries()) {
						expect(tools[index]).toBe(row);
					}
				}
			}
		}
	});

	it("preserves identities and duplicate stability for all-named frozen rows", () => {
		const first = Object.freeze({ name: "beta", id: 1 });
		const second = Object.freeze({ name: "beta", id: 2 });
		const alpha = Object.freeze({ name: "alpha" });
		const tools = [first, alpha, second];
		for (let pass = 0; pass < 2; pass++) {
			expect(sortToolsDeterministically(tools)).toBe(tools);
			expect(tools[0]).toBe(alpha);
			expect(tools[1]).toBe(first);
			expect(tools[2]).toBe(second);
		}
	});

	it("keeps all-nameless frozen rows in place and handles an empty array", () => {
		const original = [
			Object.freeze({ other: true }),
			Object.freeze({ name: undefined }),
			Object.freeze({ name: null }),
			Object.freeze({ name: false }),
			Object.freeze({ name: 42 }),
		];
		const tools = [...original];
		for (let pass = 0; pass < 2; pass++) {
			expect(sortToolsDeterministically(tools)).toBe(tools);
			expect(tools).toHaveLength(original.length);
			for (const [index, row] of original.entries()) {
				expect(tools[index]).toBe(row);
			}
		}
		const empty: unknown[] = [];
		expect(sortToolsDeterministically(empty)).toBe(empty);
		expect(empty).toEqual([]);
	});
});
