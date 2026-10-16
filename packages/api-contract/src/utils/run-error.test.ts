import { describe, expect, it } from "vite-plus/test";
import { summarizeRunError } from "./run-error";

describe("summarizeRunError", () => {
	it("names the failed tool call instead of the envelope preamble", () => {
		const stored = `Error: McpToolError: MCP tool error: {
  "executionId": "847e9193-33fc-4025-9e2a-ff52f49ac2a3",
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
});
