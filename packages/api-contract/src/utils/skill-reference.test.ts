import { describe, expect, it } from "vite-plus/test";
import { parseSkillReferences } from "./skill-reference";

describe("skill references in Markdown", () => {
	it.each([
		"```text\n/skill example\n```",
		"~~~text\n/skill example\n~~~",
		"````text\n```\n/skill example\n````",
		"```text\n/skill example",
		"    /skill example",
		"\t/skill example",
		"`example\n/skill example\n`",
		"- example\n\n  ~~~text\n  /skill example\n  ~~~",
	])("ignores code in %j", (example) => {
		expect(parseSkillReferences(example)).toEqual([]);
	});

	it("keeps real references around examples, in first-seen order", () => {
		expect(
			parseSkillReferences(
				"/skill first\n\n~~~text\n/skill example\n~~~\n\n/skill second\n/skill first",
			),
		).toEqual(["first", "second"]);
	});

	it("supports CRLF and standalone picker references", () => {
		expect(
			parseSkillReferences(
				"/skill real\r\n\r\n```text\r\n/skill example\r\n```",
			),
		).toEqual(["real"]);
	});
});
