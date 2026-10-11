import { describe, expect, it } from "vite-plus/test";
import { markdownLineToPlainText } from "./markdown-plain-text";

describe("markdownLineToPlainText", () => {
	it("drops Markdown markup, keeps code text and collapses whitespace", () => {
		for (const [line, plain] of [
			[
				"It's deployed.** The live API runs commit `fc6b8f9`  now",
				"It's deployed. The live API runs commit fc6b8f9 now",
			],
			[
				"## **Done** — see [the run](https://example.test/run/1)",
				"Done — see the run",
			],
			["> - 1. _really_ ship __it__?", "really ship it?"],
			[
				"- [ ] check `__init__.py` and snake_case_name",
				"check __init__.py and snake_case_name",
			],
			["**", ""],
			["Plain line", "Plain line"],
		])
			expect(markdownLineToPlainText(line!)).toBe(plain!);
	});
	it("keeps link and autolink edge cases", () => {
		for (const [line, plain] of [
			["![alt](img.png) and [x [y](u)", "alt and x [y"],
			[
				"[a](b[c](d) <https://t.test/a> <http://x>",
				"a https://t.test/a http://x",
			],
			["<https://t.test/a b> [no](close", "<https://t.test/a b> [no](close"],
		])
			expect(markdownLineToPlainText(line!)).toBe(plain!);
	});
	it("stays linear on 100 KB of unclosed markup", () => {
		const n = 100_000;
		for (const line of [
			"[".repeat(n),
			"[](".repeat(n / 3),
			"<https://".repeat(n / 9),
			"*".repeat(n),
			" ".repeat(n),
			"\t".repeat(n) + "#",
			">".repeat(n),
			"- ".repeat(n / 2) + "x",
			"__a".repeat(n / 3),
		]) {
			const started = performance.now();
			markdownLineToPlainText(line);
			expect(performance.now() - started).toBeLessThan(250);
		}
	});
});
