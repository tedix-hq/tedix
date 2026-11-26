import { describe, expect, test } from "bun:test";
import { parseWorkOption } from "./work-options";
import type { CliOptions } from "./shared";

describe("work comment --contradicts", () => {
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

	test("is absent by default, so an explicit observation means agreement", () => {
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
