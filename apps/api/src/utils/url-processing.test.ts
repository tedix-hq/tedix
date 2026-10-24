import { describe, expect, it } from "vite-plus/test";
import { getDomain } from "./url-processing";

describe("getDomain", () => {
	it("handles URL schemes case-insensitively", () => {
		expect(getDomain("HTTPS://WWW.EXAMPLE.TEST/path")).toBe("example.test");
		expect(getDomain("HTTP://EXAMPLE.TEST/path")).toBe("example.test");
	});
});
