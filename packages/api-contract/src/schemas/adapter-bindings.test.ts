import { describe, expect, it } from "vite-plus/test";
import { isUnsafePathSegment, setByPath } from "./adapter-bindings";

describe("setByPath", () => {
	it("creates nested config objects", () => {
		const config: Record<string, unknown> = {};
		setByPath(config, "auth.oauth2.clientId", "abc123");
		expect(config).toEqual({ auth: { oauth2: { clientId: "abc123" } } });
	});

	it("refuses config keys that would reach Object.prototype", () => {
		for (const key of [
			"__proto__.polluted",
			"constructor.prototype.polluted",
			"auth.__proto__",
		]) {
			expect(() => setByPath({}, key, "x")).toThrow("Unsafe config key path");
		}
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(isUnsafePathSegment("token")).toBe(false);
	});
});
