import { afterEach, describe, expect, it } from "vite-plus/test";
import { redactByPath, setByPath } from "./path-utils";

afterEach(() => {
	delete (Object.prototype as Record<string, unknown>).polluted;
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
});
