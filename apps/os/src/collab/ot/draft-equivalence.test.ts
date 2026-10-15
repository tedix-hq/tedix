import { describe, expect, it } from "vite-plus/test";
import { sameDraftContent, sameDraftText } from "./draft-equivalence";

const deck = (active: string, title = "One") =>
	JSON.stringify({
		kind: "presentation",
		slides: [{ title }],
		deck: { activeSlideId: active, slides: [{ id: "a" }, { id: "b" }] },
	});

describe("sameDraftText", () => {
	it("ignores which slide was being viewed", () => {
		expect(sameDraftText(deck("a"), deck("b"))).toBe(true);
	});

	it("ignores key order and formatting", () => {
		expect(
			sameDraftText('{"a":1,"b":[2]}', '{\n  "b": [2],\n  "a": 1\n}'),
		).toBe(true);
	});

	it("counts any real change, and anything unparseable, as an edit", () => {
		expect(sameDraftText(deck("a"), deck("b", "Two"))).toBe(false);
		expect(sameDraftText("not json", "not json ")).toBe(false);
	});
});

describe("sameDraftContent", () => {
	it("needs every file to match", () => {
		const saved = new Map([
			["doc.json", deck("a")],
			["notes.md", "x"],
		]);
		expect(
			sameDraftContent(
				saved,
				new Map([
					["doc.json", deck("b")],
					["notes.md", "x"],
				]),
			),
		).toBe(true);
		expect(sameDraftContent(saved, new Map([["doc.json", deck("a")]]))).toBe(
			false,
		);
	});
});
