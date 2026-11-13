import { expect, test } from "vite-plus/test";
import { repairJsonUnicode } from "./repair-json-unicode";

test("repairs nested JSON strings and keys while preserving pairs and scalars", () => {
	const input = {
		values: ["\uD800\uD800\uDC00\uDC00", "😀", "\\ud800", null, true, 0],
		["\uDC00"]: "\uD800",
	};
	expect(repairJsonUnicode(input)).toEqual({
		values: ["�\uD800\uDC00�", "😀", "\\ud800", null, true, 0],
		"�": "�",
	});
	expect(input.values[0]).toBe("\uD800\uD800\uDC00\uDC00");
});
