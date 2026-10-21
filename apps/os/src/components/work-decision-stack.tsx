import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import {
	WorkReadNotice,
	useWorkReadFailure,
} from "@/components/work-read-region";
import { workRefreshOptions } from "@/lib/work-refresh";
import { DeckCardSkeleton } from "@/components/deck-progress";
import { useContext, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import {
	WorkDecisionCard,
	type DecisionCardFeedback,
} from "@/components/work-decision-card";
import { WorkInteractionDecisionCard } from "@/components/work-interaction-decision-card";
import { ApprovalFieldEdits } from "@/components/approval-field-edits";
import type { NeedsYouItem } from "@/components/work-needs-you";
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
	const decide = async (feedback: DecisionCardFeedback) => {
		if (feedback.action === "always") {
			await osApi.osApprovalRules.create({ actionKind: approval.actionType });
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
								{
									id: "always",
									label: "Always allow this",
									confirm: `Allow all ${approval.actionType} actions across this organization when approval rules are applied? This covers every tedi, not just this request. You can disable the rule in Approvals.`,
								},
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

export function WorkDecisionStack({
	items,
}: {
	items: readonly NeedsYouItem[];
}) {
	const [selected, setSelected] = useState<string | null>(null);
	const root = useRef<HTMLDivElement>(null);
	const current = Math.max(
		0,
		items.findIndex((item) => item.key === selected),
	);
	const move = (index: number) => {
		const item = items[Math.max(0, Math.min(items.length - 1, index))];
		if (!item) return;
		setSelected(item.key);
		requestAnimationFrame(() => {
			const target = root.current?.querySelectorAll<HTMLElement>(
				"[data-decision-row]",
			)[Math.max(0, Math.min(items.length - 1, index))];
			(target?.querySelector<HTMLElement>("section") ?? target)?.focus();
			target?.scrollIntoView({ block: "nearest", behavior: "smooth" });
		});
	};
	return (
		<div
			ref={root}
			aria-label="Needs you"
			className="grid gap-3"
			onKeyDown={(event) => {
				if (
					(event.target as HTMLElement).closest(
						"input, textarea, [contenteditable=true]",
					) ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey
				)
					return;
				if (event.key === "j" || event.key === "k") {
					event.preventDefault();
					event.stopPropagation();
					move(current + (event.key === "j" ? 1 : -1));
				}
			}}
		>
			<p className="text-kumo-subtle">
				One decision at a time.{" "}
				<span className="hidden sm:inline">
					J/K next or previous · ←/→ decide · Enter approve
				</span>
				<span className="sm:hidden">
					Swipe left to decline, right to approve
				</span>
			</p>
			{items.map((item, index) => (
				<div
					key={item.key}
					data-decision-row
					data-needs-you={item.kind}
					tabIndex={-1}
					className="min-w-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
				>
					{index !== current ? (
						<Button
							variant="outline"
							className="h-auto min-h-16 w-full justify-start whitespace-normal px-4 py-3 text-left"
							onClick={() => move(index)}
						>
							<span className="grid gap-1">
								<span>{item.label}</span>
								<span className="font-normal text-kumo-subtle">
									{item.askedBy ?? item.kind}
								</span>
							</span>
						</Button>
					) : item.key.startsWith("interaction:") ? (
						<WorkInteractionDecisionCard
							autoFocus
							requestId={item.key.slice("interaction:".length)}
							askedBy={item.askedBy}
							onNext={() => move(index + 1)}
							onPrevious={() => move(index - 1)}
						/>
					) : item.key.startsWith("runtime-approval:") ? (
						<ApprovalDecisionCard
							id={item.key.slice("runtime-approval:".length)}
							onNext={() => move(index + 1)}
							onPrevious={() => move(index - 1)}
						/>
					) : (
						<WorkDecisionCard
							autoFocus
							kind="question"
							title={item.label}
							askedBy={item.askedBy ?? "Tedix"}
							at={item.at}
							body={item.detail ?? item.hint}
							content={
								<div className="grid gap-3">
									<p>{item.detail ?? item.hint}</p>
									<Button
										className="w-fit"
										render={
											<a
												href={
													item.action.type === "link"
														? item.action.href
														: item.href
												}
											/>
										}
									>
										Open {item.kind.toLowerCase()}
									</Button>
								</div>
							}
							disabled
							onDecision={async () => {}}
							onNext={() => move(index + 1)}
							onPrevious={() => move(index - 1)}
						/>
					)}
				</div>
			))}
		</div>
	);
}
