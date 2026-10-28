import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ApprovalDecisionCopy } from "./approval-decision-copy";

const approval = {
	actionType: "mcp.tool_call",
	review: { intent: "unknown" },
	description:
		"Run skill: nightly-check improvement abc12345. Nothing has run yet; approving allows one identical retry of this call.",
	payload: {
		kind: "mcp_tool_call",
		target: { transport: "rpc", endpoint: "skills/runWorkflow" },
		args: { params: { probe: true } },
	},
};

describe("skill approval feedback", () => {
	it("renders the actual proposal action and retry consequence", () => {
		const html = renderToStaticMarkup(
			<ApprovalDecisionCopy approval={approval} />,
		);
		expect(html).toContain("Run a test of the nightly-check skill proposal.");
		expect(html).not.toContain("can't describe");
		expect(html).toContain("It does not activate the proposal");
	});
});
