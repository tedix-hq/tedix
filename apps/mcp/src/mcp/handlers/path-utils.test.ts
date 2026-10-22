import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	applyStripField,
	applyToNestedArrays,
	getByPath,
	redactByPath,
	setByPath,
} from "./path-utils";

afterEach(() => {
	delete (Object.prototype as Record<string, unknown>).polluted;
	delete (Array.prototype as unknown as Record<string, unknown>)[1];
	delete (Object.prototype as Record<string, unknown>).inherited;
});

describe("path-utils prototype safety", () => {
	it("still sets and redacts ordinary nested paths", () => {
		const obj: Record<string, unknown> = { a: { secret: "x" } };
		setByPath(obj, "price.formatted", "$9.99");
		redactByPath(obj, "a.secret");
		expect(obj).toEqual({
			a: { secret: "<redacted>" },
			price: { formatted: "$9.99" },
		});
	});

	it("refuses setByPath paths that reach a prototype", () => {
		for (const path of [
			"__proto__.polluted",
			"constructor.prototype.polluted",
			"a.__proto__.polluted",
		]) {
			setByPath({ a: {} }, path, "yes");
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it("refuses redactByPath paths that reach a prototype", () => {
		(Object.prototype as Record<string, unknown>).polluted = "keep";
		redactByPath({}, "__proto__.polluted");
		redactByPath({}, "constructor.prototype.polluted");
		expect(({} as Record<string, unknown>).polluted).toBe("keep");
	});

	it("only reads own response fields", () => {
		(Object.prototype as Record<string, unknown>).inherited = { secret: "x" };
		const obj: Record<string, unknown> = {};

		expect(getByPath(obj, "inherited.secret")).toBeUndefined();
		redactByPath(obj, "inherited.secret");
		applyStripField(obj, "inherited.secret");
		expect(obj).toEqual({});
	});

	it("keeps unsafe wildcard segments and inherited arrays inert", () => {
		const obj: Record<string, unknown> = {
			items: [{ secret: "x" }],
			groups: [{ items: [{ secret: "nested" }] }],
		};
		(Object.prototype as Record<string, unknown>).items = [
			{ secret: "inherited" },
		];
		(Array.prototype as unknown as Record<string, unknown>)[1] = {
			items: [{ secret: "inherited" }],
		};
		const visited: unknown[][] = [];

		redactByPath(obj, "constructor[*].secret");
		applyStripField(obj, "items[].secret");
		applyToNestedArrays(obj, "groups[].items", (arr) => visited.push(arr));

		expect(obj).toEqual({
			items: [{}],
			groups: [{ items: [{ secret: "nested" }] }],
		});
		expect(visited).toEqual([[{ secret: "nested" }]]);
	});
});
