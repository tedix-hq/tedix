import { describe, expect, it } from "bun:test";
import { unknownOptionError } from "./unknown-option";

describe("unknownOptionError", () => {
	it("chooses the closest flag across insertion, deletion and substitution typos", () => {
		for (const flag of ["--dry-ru", "--dry-runn", "--dry-rum"]) {
			expect(
				unknownOptionError("learn profile", flag, ["--json", "--dry-run"])
					.message,
			).toBe(
				`Unknown option ${flag} for "tedix learn profile"; did you mean --dry-run? See tedix learn profile --help`,
			);
		}
	});

	it("keeps the existing distance threshold of three", () => {
		expect(unknownOptionError("chat", "--abc", ["--xyz"]).message).toContain(
			"did you mean --xyz?",
		);
		expect(unknownOptionError("chat", "--abcd", ["--wxyz"]).message).toBe(
			'Unknown option --abcd for "tedix chat"; See tedix chat --help',
		);
	});

	it("provides help without a hint for empty or unrelated candidates", () => {
		for (const candidates of [[], ["--json", "--dry-run"]]) {
			expect(
				unknownOptionError(
					"learn profile",
					"--completely-unrelated",
					candidates,
				).message,
			).toBe(
				'Unknown option --completely-unrelated for "tedix learn profile"; See tedix learn profile --help',
			);
		}
	});

	it("preserves candidate order when distances tie", () => {
		expect(
			unknownOptionError("chat", "--bat", new Set(["--cat", "--hat"])).message,
		).toContain("did you mean --cat?");
	});
});
