import { describe, expect, it } from "vite-plus/test";
import { hashValue, stableStringify } from "./hash";

describe("stable argument serialization", () => {
	it("rejects object cycles before traversing them repeatedly", () => {
		let reads = 0;
		const cyclic = {
			get self(): unknown {
				reads++;
				return cyclic;
			},
		};
		expect(() => stableStringify(cyclic)).toThrow(TypeError);
		expect(reads).toBe(1);
	});

	it("rejects cycles through arrays and mixed containers", async () => {
		const array: unknown[] = [];
		array.push(array);
		const mixed: { children: unknown[] } = { children: [] };
		mixed.children.push(mixed);
		await expect(hashValue(array)).rejects.toThrow(TypeError);
		await expect(hashValue(mixed)).rejects.toThrow(TypeError);
	});

	it("allows shared references and sorts nested keys without changing JSON values", async () => {
		const shared = { z: 2, a: 1 };
		const input = {
			z: [shared, shared],
			a: { omitted: undefined, date: new Date("2026-01-01T00:00:00Z") },
		};
		expect(stableStringify(input)).toBe(
			'{"a":{"date":"2026-01-01T00:00:00.000Z"},"z":[{"a":1,"z":2},{"a":1,"z":2}]}',
		);
		expect(await hashValue({ b: shared, a: shared })).toBe(
			await hashValue({ a: { a: 1, z: 2 }, b: { z: 2, a: 1 } }),
		);
	});
});
