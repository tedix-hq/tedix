import { describe, expect, it } from "vite-plus/test";
import { errorMessage } from "./error-message";

describe("errorMessage", () => {
	it("returns the message of an Error", () => {
		expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
	});

	it("stringifies any other thrown value", () => {
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(undefined)).toBe("undefined");
		expect(errorMessage({ message: "not an Error" })).toBe("[object Object]");
	});
});
