import { describe, expect, it } from "vite-plus/test";
import { RUN_ERROR_HEADLINE_LENGTH, summarizeRunError } from "./run-error";

describe("summarizeRunError", () => {
	it("names the failed tool call instead of the envelope preamble", () => {
		const stored = `Error: McpToolError: MCP tool error: {
  "executionId": "00000000-0000-4000-8000-0000000000a2",
  "partial": true,
  "failures": [
    {
      "tool": "cto.work_item_create",
      "error": "BAD_REQUEST: Input validation failed: (root): Unrecognized key: \\"tediId\\""
    }
  ],
  "result": {`;
		expect(summarizeRunError(stored)).toBe(
			'cto.work_item_create failed: BAD_REQUEST: Input validation failed: (root): Unrecognized key: "tediId"',
		);
	});

	it("keeps a plain error on one bounded line", () => {
		expect(summarizeRunError("Error: boom\n  at step")).toBe(
			"Error: boom at step",
		);
		expect(summarizeRunError("x".repeat(500))?.length).toBe(300);
		expect(summarizeRunError(null)).toBeNull();
	});

	it("caps a headline at the requested length with an ellipsis", () => {
		const headline = summarizeRunError(
			`Error: ${"word ".repeat(80)}`,
			RUN_ERROR_HEADLINE_LENGTH,
		);
		expect(headline?.length).toBeLessThanOrEqual(RUN_ERROR_HEADLINE_LENGTH);
		expect(headline?.endsWith("…")).toBe(true);
		expect(summarizeRunError("Permission denied", 120)).toBe(
			"Permission denied",
		);
	});
});
