import { describe, expect, it } from "vite-plus/test";
import { requireSavableText } from "./savable-text";

describe("savable text", () => {
	it.each(["\uD800", "\uDBFF", "\uDC00", "\uDFFF", "😀\uD800", "\uDC00😀"])(
		"refuses a half in nested values: %j",
		(text) => {
			expect(() => requireSavableText({ content: { rows: [[text]] } })).toThrow(
				"content.rows[0][0] holds half of a character",
			);
		},
	);
	it("refuses malformed field names and root text", () => {
		expect(() =>
			requireSavableText({ content: { "\uD800": "whole" } }),
		).toThrow("a field name under content holds half of a character");
		expect(() => requireSavableText("\uDC00")).toThrow(
			"the text holds half of a character",
		);
	});
	it("preserves whole characters including intentional replacement marks", () => {
		const value = { text: "😀𐀀􏿿 Grüße �", rows: [null, 2, true] };
		requireSavableText(value);
		expect(value.text).toBe("😀𐀀􏿿 Grüße �");
	});
});
