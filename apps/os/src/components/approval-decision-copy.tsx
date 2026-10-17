import { approvalDecision } from "@tedix/api-contract/utils/approval-decision";
import { Text } from "@/components/kumo/text";

export function ApprovalDecisionCopy({
	approval,
}: {
	approval: { actionType: string; review: { intent: string } };
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
