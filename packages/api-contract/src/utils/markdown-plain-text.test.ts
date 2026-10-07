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
});
