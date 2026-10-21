import { describe, expect, it } from "vite-plus/test";
import { canonicalDigest, canonicalJson } from "./blueprint-digest";

describe("blueprint content digests", () => {
	it.each(['{"marker":1}', "null", "0", "false", '"data"', "[2,1]"])(
		"preserves JSON-owned __proto__ with value %s at every depth",
		async (value) => {
			const json = `{"__proto__":${value}}`;
			for (const [input, empty] of [
				[json, "{}"],
				[`{"nested":${json}}`, '{"nested":{}}'],
				[`[${json}]`, "[{}]"],
			]) {
				const parsed = JSON.parse(input);
				expect(canonicalJson(parsed)).toBe(input);
				expect(canonicalJson(parsed)).not.toBe(
					canonicalJson(JSON.parse(empty)),
				);
				expect(await canonicalDigest(parsed)).not.toBe(
					await canonicalDigest(JSON.parse(empty)),
				);
			}
		},
	);

	it("distinguishes different values of a JSON-owned __proto__ key", async () => {
		const payloads = [
			"{}",
			'{"__proto__":null}',
			'{"__proto__":false}',
			'{"__proto__":0}',
			'{"__proto__":"data"}',
			'{"__proto__":{"marker":1}}',
			'{"__proto__":{"marker":2}}',
		].map((json) => JSON.parse(json));
		expect(new Set(payloads.map(canonicalJson)).size).toBe(payloads.length);
		expect(new Set(await Promise.all(payloads.map(canonicalDigest))).size).toBe(
			payloads.length,
		);
	});

	it("sorts recursively without losing prototype-related data keys", async () => {
		const input = JSON.parse(
			'{"toString":"text","prototype":null,"constructor":{"z":2,"a":1},"__proto__":{"z":2,"a":[{"y":2,"x":1},null]}}',
		);
		const expected =
			'{"__proto__":{"a":[{"x":1,"y":2},null],"z":2},"constructor":{"a":1,"z":2},"prototype":null,"toString":"text"}';
		expect(canonicalJson(input)).toBe(expected);
		expect(await canonicalDigest(input)).toBe(
			await canonicalDigest(JSON.parse(expected)),
		);
		expect(Object.hasOwn(input, "__proto__")).toBe(true);
		expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
	});

	it("keeps array order while sorting objects inside arrays", async () => {
		const input = { z: [3, { b: 2, a: 1 }, [2, 1]], a: null };
		const equivalent = { a: null, z: [3, { a: 1, b: 2 }, [2, 1]] };
		const reorderedArray = { a: null, z: [3, { a: 1, b: 2 }, [1, 2]] };
		expect(canonicalJson(input)).toBe('{"a":null,"z":[3,{"a":1,"b":2},[2,1]]}');
		expect(await canonicalDigest(input)).toBe(
			await canonicalDigest(equivalent),
		);
		expect(await canonicalDigest(input)).not.toBe(
			await canonicalDigest(reorderedArray),
		);
	});

	it("omits undefined object properties and keeps undefined array slots as null", async () => {
		const input = {
			["__proto__"]: undefined,
			missing: undefined,
			nested: { missing: undefined, present: null },
			values: [undefined, { missing: undefined, present: 1 }],
		};
		const expected =
			'{"nested":{"present":null},"values":[null,{"present":1}]}';
		expect(canonicalJson(input)).toBe(expected);
		expect(await canonicalDigest(input)).toBe(
			await canonicalDigest(JSON.parse(expected)),
		);
	});

	it("preserves canonical bytes and SHA-256 for ordinary blueprint exports", async () => {
		const definition = {
			requirements: null,
			gadgets: [
				{
					name: "Example",
					manifest: { entry: "main.ts", capabilities: [] },
				},
			],
		};
		expect(canonicalJson(definition)).toBe(
			'{"gadgets":[{"manifest":{"capabilities":[],"entry":"main.ts"},"name":"Example"}],"requirements":null}',
		);
		expect(await canonicalDigest(definition)).toBe(
			"0d5380f1d7106c87425bf0e9f832f56ab1b3bb7c6386e5ee0525addfc680b65e",
		);
	});
});
