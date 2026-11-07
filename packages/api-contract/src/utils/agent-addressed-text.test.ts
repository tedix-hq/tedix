import { describe, expect, it } from "vite-plus/test";
import { agentAddressedIssue } from "./agent-addressed-text";

describe("agent-addressed card text", () => {
	it("flags the instructions a person saw on the D1 card", () => {
		expect(
			agentAddressedIssue(
				"Please open this Work item and click Reply on this Needs-you card.",
			),
		).toBe("card_mechanics");
		expect(
			agentAddressedIssue(
				"Provide a current read-only comparison of the source and target counts for every logs table.",
			),
		).toBe("agent_data");
		expect(
			agentAddressedIssue(
				"Call `respond_to_work_interaction` with the counts?",
			),
		).toBe("agent_command");
	});

	it("accepts plain questions a person can answer", () => {
		for (const text of [
			"Grant read access to the logs database?",
			"Only you can grant Cloudflare access; the check is blocked until then.",
			"Pick the launch date",
			"Let Codex work on “Export the audit logs”?",
			"Reply by Friday so the launch can go ahead?",
		])
			expect(agentAddressedIssue(text)).toBeUndefined();
	});
});
