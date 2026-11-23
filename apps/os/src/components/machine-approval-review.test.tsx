import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	MachineApprovalReview,
	redactMachineApproval,
} from "./machine-approval-review";
import {
	collapseIdenticalItems,
	type ApprovalListItem,
} from "./approval-inbox";

const payload = {
	kind: "mcp_machine_tool_call",
	principalId: "agent-42",
	riskTier: "high_impact_write",
	descriptor: {
		mount: { sourceToolId: "delete_record", endpoint: "records/delete" },
	},
	args: {
		resourceId: "record-7",
		password: "short",
		nested: { token: "hidden", title: "Visible title" },
		authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
	},
};
describe("machine approval review", () => {
	it("shows the machine, operation, risk and meaningful arguments while hiding credential values", () => {
		const markup = renderToStaticMarkup(
			<MachineApprovalReview payload={payload} />,
		);
		for (const text of [
			"agent-42",
			"delete_record",
			"records/delete",
			"high impact write",
			"record-7",
			"Visible title",
			"[redacted]",
		])
			expect(markup).toContain(text);
		for (const secret of ["short", "hidden", "abcdefghijklmnopqrstuvwxyz"])
			expect(markup).not.toContain(secret);
		expect(JSON.stringify(redactMachineApproval(payload))).not.toContain(
			"abcdefghijklmnopqrstuvwxyz",
		);
	});
	it("shows each parked file argument in full before technical details", () => {
		const longPath = "reports/" + "a".repeat(90) + ".pdf";
		const markup = renderToStaticMarkup(
			<MachineApprovalReview
				payload={{
					...payload,
					args: { paths: ["reports/one.pdf", longPath], token: "secret-value" },
				}}
			/>,
		);
		const first = markup.split("<details")[0]!;
		expect(first).toContain("reports/one.pdf");
		expect(first).toContain(longPath);
		expect(markup).not.toContain("secret-value");
	});
	it("never combines distinct machine requests into one bulk approval", () => {
		const item = {
			key: "a",
			kind: "Tool call",
			chip: { label: "Needs review" },
			title: "Change",
			details: [],
			raw: { payload },
		} as unknown as ApprovalListItem;
		expect(collapseIdenticalItems([item, { ...item, key: "b" }])).toHaveLength(
			2,
		);
	});
});
