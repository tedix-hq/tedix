import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import {
	WorkReadNotice,
	useWorkReadFailure,
} from "@/components/work-read-region";
import { workRefreshOptions } from "@/lib/work-refresh";
import { DeckCardSkeleton } from "@/components/deck-progress";
import { useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/components/kumo/link";
import {
	WorkDecisionCard,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import { ApprovalFieldEdits } from "@/components/approval-field-edits";
import { osApi } from "@/lib/api";
import { osQuery, osQueryKeys } from "@/lib/os-query-options";

export function ApprovalDecisionCard({
	id,
	onNext,
	onPrevious,
}: {
	id: string;
	onNext: () => void;
	onPrevious: () => void;
}) {
	const client = useQueryClient();
	const optimistic = useContext(OptimisticDeckDecisionContext);
	const query = useQuery({
		...osQuery.tediApprovals.getById.queryOptions({ input: { id } }),
		...workRefreshOptions,
	});
	const failed = query.isError || query.failureCount > 0;
	const inRegion = useWorkReadFailure(
		failed
			? {
					error: query.error ?? query.failureReason,
					retrying: query.isFetching,
					retry: query.refetch,
				}
			: undefined,
	);
	const notice = !inRegion && (
		<WorkReadNotice
			failed={failed}
			partial={Boolean(query.data)}
			retry={query.refetch}
			retrying={query.isFetching}
			errors={[query.error ?? query.failureReason]}
		/>
	);
	if (query.isPending) return <DeckCardSkeleton />;
	if (!query.data) return notice;
	const approval = query.data;
	const active =
		approval.status === "pending" &&
		approval.review.decisionMode === "approve_or_reject" &&
		!approval.review.timeout.expired;
	const toolName =
		typeof approval.payload.toolName === "string"
			? approval.payload.toolName
			: null;
	const appSlug =
		typeof approval.payload.appSlug === "string"
			? approval.payload.appSlug
			: null;
	const toolSlug = appSlug && toolName ? `${appSlug}.${toolName}` : null;
	const verb =
		typeof approval.payload.verb === "string"
			? approval.payload.verb
			: toolName
					?.replace(/([a-z])([A-Z])/g, "$1_$2")
					.toLowerCase()
					.split(/[^a-z0-9]+/)[0];
	const decide = async (feedback: DecisionCardFeedback) => {
		if (feedback.action === "always" && toolSlug && verb) {
			await osApi.osApprovalRules.create({
				actionKind: approval.actionType,
				toolSlug,
				verb,
			});
			if (!optimistic)
				await client.invalidateQueries({
					queryKey: osQueryKeys.approvalRules(),
				});
		}
		await osApi.tediApprovals.resolve({
			id,
			status: feedback.action === "reject" ? "rejected" : "approved",
			resolution: [
				feedback.action === "reject" ? "Rejected" : "Approved as shown",
				feedback.feedback,
			]
				.filter(Boolean)
				.join(". "),
		});
		if (!optimistic)
			await Promise.all([
				client.invalidateQueries({ queryKey: osQueryKeys.approvals() }),
				client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() }),
			]);
		return {
			learningClientEventId: `approval:${id}:${feedback.action === "reject" ? "rejected" : "approved"}`,
		};
	};
	return (
		<>
			{notice}
			<WorkDecisionCard
				autoFocus
				kind="approval"
				title={approval.review.operatorQuestion || approval.description}
				askedBy="Your tedi"
				actor={{ type: "tedi", id: approval.tediId }}
				at={approval.createdAt}
				body={approval.review.summary}
				why={
					<div className="grid gap-2">
						<p>{approval.description}</p>
						<Link href="/work/approvals">
							Review full action and execution history
						</Link>
					</div>
				}
				actions={
					active
						? [
								{ id: "approve", label: "Approve", intent: "approve" },
								{ id: "reject", label: "Reject", intent: "reject" },
								...(toolSlug && verb
									? [
											{
												id: "always",
												label: "Always allow this",
												confirm: `Automatically approve future ${verb} requests from ${toolSlug} across this organization? Other tools and destructive actions still require review. You can disable the rule in Approvals.`,
											},
										]
									: []),
							]
						: []
				}
				disabled={!active}
				onDecision={decide}
				onNext={onNext}
				onPrevious={onPrevious}
			/>
			<ApprovalFieldEdits approval={approval} active={active} />
		</>
	);
}
