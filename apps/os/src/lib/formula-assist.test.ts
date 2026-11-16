import { describe, expect, it } from "vite-plus/test";
import {
	callAt,
	cycleReference,
	functionSuggestions,
	referenceSlot,
} from "./formula-assist";

describe("formula help", () => {
	it("suggests functions for the word being typed, not for cell references or text", () => {
		expect(functionSuggestions("=su", 3)?.names).toEqual([
			"SUM",
			"SUMIF",
			"SUMIFS",
			"SUBSTITUTE",
		]);
		expect(functionSuggestions("=A1+co", 6)?.start).toBe(4);
		expect(functionSuggestions("=A1", 3)).toBeNull();
		expect(functionSuggestions('="su', 4)).toBeNull();
		expect(functionSuggestions("su", 2)).toBeNull();
		expect(functionSuggestions("=SUM", 4)?.names).toEqual([
			"SUM",
			"SUMIF",
			"SUMIFS",
		]);
	});
	it("knows which argument of which function the caret is in", () => {
		expect(callAt("=IF(A1>2, ", 10)).toEqual({ name: "IF", argument: 1 });
		expect(callAt("=SUM(MAX(1,2), ", 15)).toEqual({ name: "SUM", argument: 1 });
		expect(callAt('=IF(",", ', 9)).toEqual({ name: "IF", argument: 1 });
		expect(callAt("=A1+2", 5)).toBeNull();
	});
	it("finds where a clicked cell's reference goes", () => {
		expect(referenceSlot("=SUM(", 5)).toEqual({ start: 5, end: 5 });
		expect(referenceSlot("=SUM(B2", 7)).toEqual({ start: 5, end: 7 });
		expect(referenceSlot("=SUM(B2:C4", 10)).toEqual({ start: 5, end: 10 });
		expect(referenceSlot("=A1 ", 4)).toBeNull();
		expect(referenceSlot("hello", 5)).toBeNull();
	});
	it("cycles the reference at the caret through $ forms", () => {
		let text = "=SUM(B2)",
			caret = 7;
		const seen: string[] = [];
		for (let step = 0; step < 4; step++) {
			const next = cycleReference(text, caret)!;
			text = next.text;
			caret = next.caret;
			seen.push(text);
		}
		expect(seen).toEqual(["=SUM($B$2)", "=SUM(B$2)", "=SUM($B2)", "=SUM(B2)"]);
	});
});
