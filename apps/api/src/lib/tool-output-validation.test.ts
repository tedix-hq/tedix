import { describe, expect, it } from "vite-plus/test";
import { validateToolOutput } from "./test-input-generator";

describe("validateToolOutput", () => {
	it("rejects MCP isError results even when their content is non-empty", () => {
		expect(
			validateToolOutput({
				isError: true,
				content: [{ type: "text", text: "The upstream rejected the call" }],
			}),
		).toEqual({ valid: false, issues: ["Output is an MCP tool error"] });
	});
});
