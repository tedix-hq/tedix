import { describe, expect, test } from "bun:test";
import { parseOptions } from "./options";

describe("unknown option guidance", () => {
	test.each([
		["--des", "--desc"],
		["--organizaton", "--organization"],
		["--worktre", "--worktree"],
		["--bogus", "--hours"],
	])("names work and suggests the nearest option for %s", (flag, nearest) => {
		expect(() => parseOptions(["work", flag])).toThrow(
			`Unknown option ${flag} for "tedix work"; did you mean ${nearest}? See tedix work --help`,
		);
	});

	test("omits distant suggestions", () => {
		expect(() => parseOptions(["work", "--completely-unrelated"])).toThrow(
			'Unknown option --completely-unrelated for "tedix work"; See tedix work --help',
		);
	});

	test("does not suggest another command's options", () => {
		expect(() => parseOptions(["chat", "--worktre"])).toThrow(
			'Unknown option --worktre for "tedix chat"; See tedix chat --help',
		);
	});

	test("organization selector works after the verb", () => {
		const { options } = parseOptions([
			"work",
			"list",
			"--organization",
			"example",
		]);
		expect(options.organization).toBe("example");
		expect(options.prompt).toBe("list");
	});
});

describe("comment text aliases", () => {
	test.each(["--body", "--message", "--text"])("accepts %s", (flag) => {
		const { options } = parseOptions(["work", "comment", "id", flag, " body "]);
		expect(options.prompt).toBe("comment id body");
	});

	test("first non-empty flag wins over positional text and later flags", () => {
		const { options } = parseOptions([
			"work",
			"comment",
			"id",
			"positional",
			"--body",
			" ",
			"--message",
			" first ",
			"--text",
			"second",
		]);
		expect(options.prompt).toBe("comment id first");
	});

	test("supports inline values", () => {
		expect(
			parseOptions(["work", "comment", "id", "--body=x"]).options.prompt,
		).toBe("comment id x");
	});

	test("preserves positional text", () => {
		expect(
			parseOptions(["work", "comment", "id", "original text"]).options.prompt,
		).toBe("comment id original text");
	});

	test("does not accept comment flags on other verbs", () => {
		expect(() =>
			parseOptions(["work", "create", "title", "--body", "x"]),
		).toThrow("--body, --message and --text are only valid with work comment");
	});
});
