import { describe, expect, it } from "vite-plus/test";
import { isImeComposing } from "./keyboard";

describe("isImeComposing", () => {
	it("recognizes native composition events", () => {
		expect(
			isImeComposing({ nativeEvent: { isComposing: true, keyCode: 13 } }),
		).toBe(true);
	});

	it("recognizes the legacy IME process key", () => {
		expect(
			isImeComposing({ nativeEvent: { isComposing: false, keyCode: 229 } }),
		).toBe(true);
	});

	it("leaves ordinary Enter events available to commit", () => {
		expect(
			isImeComposing({ nativeEvent: { isComposing: false, keyCode: 13 } }),
		).toBe(false);
	});
});
