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

	it("preserves all entries even when some lack a string name", () => {
		const sorted = sortToolsDeterministically([
			{ name: "beta" },
			{ notAName: true },
			{ name: "alpha" },
		]);
		// No entries dropped; nameless entries are tolerated (real tools/list
		// rows always carry a name).
		expect(sorted).toHaveLength(3);
		expect(sorted.some((t) => (t as { notAName?: boolean }).notAName)).toBe(
			true,
		);
	});
});
