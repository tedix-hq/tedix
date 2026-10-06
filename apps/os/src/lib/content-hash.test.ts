import { describe, expect, it } from "vite-plus/test";
import { canonicalJson, contentHash, shortHash } from "./content-hash";

describe("canonicalJson", () => {
	it("sorts object keys recursively", () => {
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}',
		);
	});

	it("preserves array order", () => {
		expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
	});

	it("drops undefined properties like JSON.stringify does", () => {
		expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
	});

	it("handles null and primitives", () => {
		expect(canonicalJson(null)).toBe("null");
		expect(canonicalJson("x")).toBe('"x"');
	});
});

describe("contentHash", () => {
	it("hashes semantically-equal bodies identically", async () => {
		const a = await contentHash({ kind: "document", blocks: [{ t: 1, u: 2 }] });
		const b = await contentHash({ blocks: [{ u: 2, t: 1 }], kind: "document" });
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	it("differs on content change", async () => {
		const a = await contentHash({ kind: "document", blocks: [] });
		const b = await contentHash({ kind: "document", blocks: [{ x: 1 }] });
		expect(a).not.toBe(b);
	});
});

describe("shortHash", () => {
	it("keeps the leading 12 hex chars", () => {
		expect(shortHash("abcdef0123456789ff")).toBe("abcdef012345");
	});
});
