import { describe, expect, it } from "vite-plus/test";
import { stableStringify } from "./stable-json";

describe("stableStringify", () => {
	it("renders scalars exactly as JSON.stringify does", () => {
		expect(stableStringify(null)).toBe("null");
		expect(stableStringify(1)).toBe("1");
		expect(stableStringify('a"b')).toBe('"a\\"b"');
		expect(stableStringify(true)).toBe("true");
	});

	it("sorts object keys recursively", () => {
		expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}',
		);
	});

	it("produces the same text for the same value in any insertion order", () => {
		expect(stableStringify({ z: 1, y: [{ b: 2, a: 1 }] })).toBe(
			stableStringify({ y: [{ a: 1, b: 2 }], z: 1 }),
		);
	});

	it("keeps array order and nests arrays of objects", () => {
		expect(stableStringify([3, 1, [{ b: 1, a: 2 }], 2])).toBe(
			'[3,1,[{"a":2,"b":1}],2]',
		);
	});

	// Digests persisted before the helpers were unified were computed with
	// exactly this behaviour; changing it would invalidate stored hashes.
	it("renders undefined members literally, unlike canonicalJson", () => {
		expect(stableStringify({ a: undefined, b: 1 })).toBe(
			'{"a":undefined,"b":1}',
		);
	});
});
