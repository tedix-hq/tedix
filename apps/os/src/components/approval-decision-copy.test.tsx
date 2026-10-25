import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	ApprovalDecisionCopy,
	ApprovalDecisionResult,
} from "./approval-decision-copy";

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
		expect(html).not.toContain("no verified description");
		expect(html).toContain(
			"Approval alone does not start it or activate the proposal",
		);
	});
	it.each(["pending", "expired", "cancelled"])(
		"does not confirm a %s decision",
		(status) => {
			expect(
				renderToStaticMarkup(
					<ApprovalDecisionResult approval={{ ...approval, status }} />,
				),
			).toBe("");
		},
	);
	it("confirms the saved approval and explains the remaining retry", () => {
		const html = renderToStaticMarkup(
			<ApprovalDecisionResult approval={{ ...approval, status: "approved" }} />,
		);
		expect(html).toContain('role="status"');
		expect(html).toContain("Approved");
		expect(html).toContain(
			"Permission saved. The caller must retry the same action once to run it.",
		);
	});
	it("confirms a rejection without offering a retry", () => {
		const html = renderToStaticMarkup(
			<ApprovalDecisionResult approval={{ ...approval, status: "rejected" }} />,
		);
		expect(html).toContain("Rejected");
		expect(html).not.toContain("Permission saved");
	});
});
