import {
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import { resolveWorkActor, workActorReference } from "@/lib/work-actor";
import { WorkActorDirectoryContext } from "@/components/work-actor-avatar";
import { CardFaceContext } from "@/components/deck-presentation-context";
import { workApprovalDecision } from "@tedix/api-contract/utils/work-approval-decision";
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
	onPrevious?: () => void;
}) {
	const client = useQueryClient();
	const optimistic = useContext(OptimisticDeckDecisionContext);
	const directory = useContext(WorkActorDirectoryContext);
	const face = useContext(CardFaceContext);
	const [rationale, setRationale] = useState("");
	const copy = OS_COPY.workHome;
	const labels = copy.approvalLabels;
	const actor = workActorReference(
		row.proposal.requestedByType,
		row.proposal.requestedById,
		{},
		row.proposal.requestedBySessionId,
	);
	// A real name when the directory has one, otherwise the asker's role.
	const asker = resolveWorkActor(
		actor,
		copy.approvalAskers[row.proposal.requestedByType] ??
			copy.approvalAskers.user!,
		directory,
	).label;
	const decision = workApprovalDecision({
		action: row.proposal.action,
		proposal: row.proposal.proposal,
		taskTitle: row.workItem.title,
		proposalTaskVersion: row.proposal.workItemVersion,
		taskVersion: row.workItem.version,
		taskDisposition: row.workItem.disposition,
	});
	// In Decisions the card lists what each button does, and a written summary
	// tells the story; anywhere else this card says both itself.
	const answersListed =
		Boolean(face) && face?.preferences?.density !== "compact";
	const lines = [
		...(face?.presentation
			? []
			: [
					[labels.what, decision.what],
					[labels.whyNow, row.proposal.requestRationale],
				]),
		...(answersListed
			? []
			: [
					[labels.ifApproved, decision.ifApproved],
					[labels.ifRejected, decision.ifRejected],
				]),
		...(decision.recommendation
			? [[labels.suggests, `${copy.reject}. ${decision.recommendation.reason}`]]
			: []),
	];
	return (
		<WorkDecisionCard
			autoFocus
			kind="approval"
			title={decision.title}
			askedBy={asker}
			actor={actor}
			at={row.proposal.requestedAt}
			body={row.proposal.requestRationale}
			why={
				<Collapsible>
					<CollapsibleDefaultTrigger className="group/disclosure">
						{copy.approvalTechnicalDetails}
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<pre className="overflow-x-auto whitespace-pre-wrap break-words">
							{JSON.stringify(row.proposal.proposal, null, 2)}
						</pre>
					</CollapsibleDefaultContent>
				</Collapsible>
			}
			faceContent={
				<div className="grid gap-3">
					{lines.length > 0 && (
						<div className="grid gap-1">
							{lines.map(([label, text]) => (
								<Text key={label} as="p" role="body" className="m-0">
									<strong>{label}:</strong> {text}
								</Text>
							))}
						</div>
					)}
					{/* An approval is an act of authority: it is never saved without its reason. */}
					<label className="grid gap-1">
						<Text weight="semibold">{copy.decisionReason}</Text>
						<Text tone="secondary">{copy.reasonWhy}</Text>
						<Textarea
							aria-label={copy.decisionReason}
							placeholder={copy.reasonRequired}
							required
							value={rationale}
							maxLength={10000}
							onChange={(event) => setRationale(event.target.value)}
						/>
					</label>
				</div>
			}
			content={
				<Link href={`/work/items/${row.workItem.id}`}>{copy.openWork}</Link>
			}
			disabled={
				!row.canDecide || row.effectiveStatus !== "pending" || !rationale.trim()
			}
			actions={[
				{
					id: "approve",
					label: copy.approve,
					intent: "approve",
					description: decision.ifApproved,
					confirm: `${decision.ifApproved} ${copy.approvalConfirmation}`,
				},
				{
					id: "reject",
					label: copy.reject,
					intent: "reject",
					description: decision.ifRejected,
				},
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
