import { describe, expect, test } from "bun:test";
import { parseWorkOption } from "./work-options";
import type { CliOptions } from "./shared";

/**
 * `work_item_corroborations` began as duplicate suppression — "I hit this too"
 * — and every row meant the same thing. After-the-fact correctness ("a
 * settled outcome that turns out to be false is fixed when someone notices")
 * needs a second principal to be able to contradict, not only agree.
 */
describe("work confirm --contradicts", () => {
	function parse(args: string[]): CliOptions {
		const options = {} as CliOptions;
		let index = 0;
		while (index < args.length) {
			const next = parseWorkOption(args, index, options);
			if (next === undefined) throw new Error(`unparsed flag ${args[index]}`);
			index = next + 1;
		}
		return options;
	}

	test("sets the flag", () => {
		expect(parse(["--contradicts"]).workContradicts).toBe(true);
	});

	test("is absent by default, so confirm keeps meaning agreement", () => {
		expect(
			parse(["--evidence", "artifact://x"]).workContradicts,
		).toBeUndefined();
	});

	test("composes with the evidence flag it requires", () => {
		const o = parse(["--contradicts", "--evidence", "commit:abc123"]);
		expect(o.workContradicts).toBe(true);
		expect(o.workEvidence).toBe("commit:abc123");
	});
});
