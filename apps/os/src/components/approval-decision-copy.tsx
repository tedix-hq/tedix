import { approvalDecision } from "@tedix/api-contract/utils/approval-decision";
import { Text } from "@/components/kumo/text";

export function ApprovalDecisionResult({
	approval,
}: {
	approval: Parameters<typeof approvalDecision>[0] & { status: string };
}) {
	if (approval.status !== "approved" && approval.status !== "rejected")
		return null;
	return (
		<div role="status">
			<Text as="p" role="body" className="m-0">
				{approval.status === "approved" ? "Approved" : "Rejected"}:{" "}
				{approvalDecision(approval).what}{" "}
				{approval.actionType === "mcp.tool_call" &&
				approval.status === "approved"
					? "Permission saved. The caller must retry the same action once to run it."
					: "Decision saved."}
			</Text>
		</div>
	);
}

export function ApprovalDecisionCopy({
	approval,
}: {
	approval: Parameters<typeof approvalDecision>[0];
}) {
	const decision = approvalDecision(approval);
	return (
		<div className="grid gap-1">
			{[
				["What", decision.what],
				["Why now", decision.whyNow],
				["If you approve", decision.ifApproved],
				["If you reject", decision.ifRejected],
				[
					"Recommended",
					`${decision.recommendation === "approved" ? "Approve" : "Reject"} — ${decision.reason}`,
				],
			].map(([label, text]) => (
				<Text key={label} as="p" role="body" className="m-0">
					<strong>{label}:</strong> {text}
				</Text>
			))}
		</div>
	);
}
