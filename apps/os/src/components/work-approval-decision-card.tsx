import { CaretRight } from "@phosphor-icons/react";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import { workActorReference } from "@/lib/work-actor";
import { useContext, useState } from "react";
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
	const optimistic = useContext(OptimisticDeckDecisionContext);
	const [rationale, setRationale] = useState("");
	const copy = OS_COPY.workHome;
	return (
		<WorkDecisionCard
			autoFocus
			kind="approval"
			title={row.workItem.title}
			askedBy={copy.approvalRequester}
			actor={workActorReference(
				row.proposal.requestedByType,
				row.proposal.requestedById,
				{},
				row.proposal.requestedBySessionId,
			)}
			at={row.proposal.requestedAt}
			body={row.proposal.requestRationale}
			why={
				<div className="grid gap-2">
					<Link href={`/work/items/${row.workItem.id}`}>{copy.openWork}</Link>
					<Collapsible>
						<CollapsibleTrigger className="group/disclosure">
							<CaretRight
								size={14}
								aria-hidden
								className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
							/>
							{copy.exactProposal}
						</CollapsibleTrigger>
						<CollapsibleContent keepMounted>
							<pre className="overflow-x-auto whitespace-pre-wrap break-words">
								{JSON.stringify(row.proposal.proposal, null, 2)}
							</pre>
						</CollapsibleContent>
					</Collapsible>
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
				if (!optimistic)
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
