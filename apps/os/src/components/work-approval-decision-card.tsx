import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type * as z from "zod";
import type { WorkApprovalInboxRowSchema } from "@tedix/api-contract/schemas/work-approvals";
import { WorkDecisionCard } from "@/components/work-decision-card";
import { Textarea } from "@/components/kumo/textarea";
import { Text } from "@/components/kumo/text";
import { Link } from "@/components/kumo/link";
import { osApi } from "@/lib/api";
import {
	osQuery,
	workItemReadinessQueryOptions,
	workSchedulerQueryOptions,
	workFleetQueryOptions,
} from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";

export function WorkApprovalDecisionCard({
	row,
	onNext,
	onPrevious,
}: {
	row: z.infer<typeof WorkApprovalInboxRowSchema>;
	onNext: () => void;
	onPrevious: () => void;
}) {
	const client = useQueryClient();
	const [rationale, setRationale] = useState("");
	const copy = OS_COPY.workHome;
	return (
		<WorkDecisionCard
			autoFocus
			kind="approval"
			title={row.workItem.title}
			askedBy={copy.approvalRequester}
			at={row.proposal.requestedAt}
			body={row.proposal.requestRationale}
			why={
				<div className="grid gap-2">
					<Link href={`/work/items/${row.workItem.id}`}>{copy.openWork}</Link>
					<details>
						<summary>{copy.exactProposal}</summary>
						<pre className="overflow-x-auto whitespace-pre-wrap break-words">
							{JSON.stringify(row.proposal.proposal, null, 2)}
						</pre>
					</details>
				</div>
			}
			content={
				<div className="grid gap-3">
					<Text>{row.proposal.requestRationale}</Text>
					<Textarea
						aria-label={copy.decisionReason}
						placeholder={copy.reasonRequired}
						value={rationale}
						maxLength={10000}
						onChange={(event) => setRationale(event.target.value)}
					/>
				</div>
			}
			disabled={
				!row.canDecide || row.effectiveStatus !== "pending" || !rationale.trim()
			}
			actions={[
				{
					id: "approve",
					label: copy.approveExact,
					intent: "approve",
					confirm: copy.approvalConfirmation,
				},
				{ id: "reject", label: copy.reject, intent: "reject" },
			]}
			onNext={onNext}
			onPrevious={onPrevious}
			onDecision={async (feedback) => {
				if (!rationale.trim()) throw new Error(copy.reasonRequired);
				const result = await osApi.workApprovals.decide({
					proposalId: row.proposal.id,
					expectedProposalVersion: row.proposal.version,
					decision: feedback.action === "approve" ? "approved" : "rejected",
					rationale: rationale.trim(),
				});
				await Promise.all([
					client.invalidateQueries({ queryKey: osQuery.workApprovals.key() }),
					client.invalidateQueries({
						queryKey: osQuery.learningFeedback.key(),
					}),
					client.invalidateQueries(
						workItemReadinessQueryOptions(row.workItem.id),
					),
					client.invalidateQueries(workSchedulerQueryOptions()),
					client.invalidateQueries(workFleetQueryOptions()),
				]);
				return { learningClientEventId: `work-approval:${result.decision.id}` };
			}}
		/>
	);
}
