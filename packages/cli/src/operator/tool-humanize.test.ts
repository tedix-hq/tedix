import { describe, expect, test } from "bun:test";
import { TOOL_VERB_MAP, VERB_PREFIX_MAP } from "./tool-humanize.ts";

describe("maps", () => {
	test("TOOL_VERB_MAP and VERB_PREFIX_MAP are exported and non-empty", () => {
		expect(Object.keys(TOOL_VERB_MAP).length).toBeGreaterThan(0);
		expect(Object.keys(VERB_PREFIX_MAP).length).toBeGreaterThan(0);
		expect(TOOL_VERB_MAP.code).toBe("running code");
		expect(VERB_PREFIX_MAP.list).toBe("listing");
	});
});
