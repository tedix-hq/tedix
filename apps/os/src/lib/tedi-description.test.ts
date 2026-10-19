import { describe, expect, it } from "vite-plus/test";
import { tediDescription } from "./tedi-description";

describe("tedi roster description", () => {
	it.each([
		[
			"# SOUL.md — Helper\n\nYou are Cedar, a support specialist. You handle tickets.",
			"Support specialist.",
		],
		["You are a helpful reviewer. Check all changes.", "Helpful reviewer."],
		["## SOUL.md\nPersonality.md", null],
		[
			"- **Writes** clear [drafts](https://example.test).",
			"Writes clear drafts.",
		],
		[null, null],
	])("cleans %s", (source, expected) =>
		expect(tediDescription(source)).toBe(expected),
	);
	it("limits long summaries to one line", () => {
		const summary = tediDescription("x".repeat(200));
		expect(summary).toHaveLength(80);
		expect(summary?.endsWith("…")).toBe(true);
	});
});
