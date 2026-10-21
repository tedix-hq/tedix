import { CaretRight } from "@phosphor-icons/react";
import { useContext, useState } from "react";
import { createPortal } from "react-dom";
import { DropdownMenuItem } from "@/components/kumo/dropdown-menu";
import { OsTopbarMenuContext } from "@/components/os-topbar-actions-context";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
import { workRefreshOptions } from "@/lib/work-refresh";
import { approvalDecision } from "@tedix/api-contract/utils/approval-decision";
import { ApprovalDecisionCopy } from "@/components/approval-decision-copy";
import { Check, Pulse, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsFromRunSet } from "@/components/chat-cards";
import { Button } from "@/components/kumo/button";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import {
	PopoverContent,
	PopoverDescription,
	PopoverRoot,
	PopoverTitle,
	PopoverTrigger,
} from "@/components/kumo/popover";
import { Text } from "@/components/kumo/text";
import { osApi, osChatMutationApi } from "@/lib/api";
import {
	homeRunSetQueryOptions,
	osQueryKeys,
	pendingApprovalsQueryOptions,
} from "@/lib/os-query-options";

export function approvalAttentionCount(input: {
	home: number;
	runtime: number;
}): number {
	return input.home + input.runtime;
}

export function isActionableHomeApproval(approval: {
	decisionMode?: "approve_or_reject" | "no_action";
	expired?: boolean;
}): boolean {
	return (
		approval.expired !== true &&
		(approval.decisionMode ?? "approve_or_reject") === "approve_or_reject"
	);
}

export function ApprovalNotifications({
	conversationId = null,
	topbar = false,
}: {
	conversationId?: string | null;
	topbar?: boolean;
}) {
	const queryClient = useQueryClient();
	const topbarMenu = useContext(OsTopbarMenuContext);
	const menu = topbar ? topbarMenu : null;
	const [open, setOpen] = useState(false);
	const runSet = useQuery({
		...homeRunSetQueryOptions(conversationId ?? ""),
		enabled: conversationId !== null,
		...workRefreshOptions,
	});
	const runtime = useQuery({
		...pendingApprovalsQueryOptions(),
		...workRefreshOptions,
	});
	const homeApprovals = runSet.data
		? approvalsFromRunSet(runSet.data.runSet).filter(isActionableHomeApproval)
		: [];
	// A parked Home write is listed by both sources; show it once, as the
	// Home card that names the tool and arguments.
	const homeApprovalIds = new Set(homeApprovals.map((a) => a.approvalId));
	const runtimeApprovals = (runtime.data?.data ?? []).filter(
		(approval) => !homeApprovalIds.has(approval.id),
	);
	const count = approvalAttentionCount({
		home: homeApprovals.length,
		runtime: runtimeApprovals.length,
	});

	const respondHome = useMutation({
		mutationFn: ({
			runId,
			decision,
			delegateRecommendation,
		}: {
			runId: string;
			decision: "approve" | "reject";
			delegateRecommendation?: boolean;
		}) =>
			osChatMutationApi.kernelRuntime.respondApproval({
				runId,
				decision,
				delegateRecommendation,
			}),
		onSuccess: async () => {
			if (conversationId !== null) {
				await queryClient.invalidateQueries({
					queryKey: homeRunSetQueryOptions(conversationId).queryKey,
				});
			}
		},
	});
	const resolveRuntime = useMutation({
		mutationFn: ({
			id,
			status,
			delegateRecommendation,
		}: {
			id: string;
			status: "approved" | "rejected";
			delegateRecommendation?: boolean;
		}) =>
			osApi.tediApprovals.resolve({
				id,
				status,
				delegateRecommendation,
				resolution:
					status === "approved"
						? "Approved from the Tedix OS attention menu after reviewing the exact request."
						: "Rejected from the Tedix OS attention menu after reviewing the exact request.",
			}),
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: osQueryKeys.approvals(),
			});
		},
	});
	const error = respondHome.error ?? resolveRuntime.error;

	return (
		<PopoverRoot open={open} onOpenChange={setOpen}>
			{menu ? (
				menu.target &&
				createPortal(
					<DropdownMenuItem onClick={() => setOpen(true)}>
						<Pulse aria-hidden size={18} />
						Activity{count > 0 ? <Badge>{count} waiting</Badge> : null}
					</DropdownMenuItem>,
					menu.target,
				)
			) : (
				<PopoverTrigger
					render={
						<Button
							aria-label={
								count === 0
									? "Action approvals: none waiting"
									: `Action approvals: ${count} waiting`
							}
							className="relative"
							size="icon-sm"
							title="Action approvals"
							variant={count > 0 ? "secondary" : "ghost"}
						>
							<Pulse size={16} weight={count > 0 ? "bold" : "regular"} />
							{count > 0 ? (
								<Badge className="absolute -right-1 -top-1 h-4 min-w-4 justify-center rounded-full px-1 tabular-nums">
									{count > 99 ? "99+" : count}
								</Badge>
							) : null}
						</Button>
					}
				/>
			)}
			<PopoverContent
				anchor={menu?.anchor}
				finalFocus={menu?.anchor}
				align="end"
				className="grid max-h-[min(36rem,var(--available-height))] w-[min(28rem,calc(100vw-2rem))] gap-3 overflow-y-auto p-3"
				side="bottom"
			>
				<div className="sticky -top-3 z-10 -mx-3 -mt-3 grid gap-1 border-b border-kumo-line bg-kumo-base p-3">
					<PopoverTitle className="m-0 uppercase tracking-wide text-kumo-subtle type-tedix-caption font-semibold">
						Action approvals
					</PopoverTitle>
					<PopoverDescription className="m-0 text-kumo-subtle type-tedix-label">
						Actions waiting for your approval.
					</PopoverDescription>
				</div>

				{(conversationId !== null && runSet.isPending) || runtime.isPending ? (
					<Text className="m-0" role="label" tone="secondary">
						Checking for pending decisions…
					</Text>
				) : count === 0 ? (
					<Text className="m-0 py-2" role="body" tone="secondary">
						No action approvals waiting.
					</Text>
				) : (
					<ul className="m-0 grid list-none gap-2 p-0">
						{homeApprovals.map((approval) => (
							<li
								className="grid min-w-0 gap-2 rounded-lg border border-kumo-warning bg-kumo-warning-tint p-3"
								key={approval.approvalId}
							>
								<Text as="strong" role="body" tone="strong">
									{approval.summary}
								</Text>
								<ApprovalDecisionCopy
									approval={{
										actionType: "home_request",
										review: { intent: "home_request" },
									}}
								/>
								<Collapsible>
									<CollapsibleTrigger className="group/disclosure">
										<CaretRight
											size={14}
											aria-hidden
											className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
										/>
										Technical details
									</CollapsibleTrigger>
									<CollapsibleContent keepMounted>
										{approval.detail ? (
											<Text role="label" tone="secondary">
												{approval.detail}
											</Text>
										) : null}
									</CollapsibleContent>
								</Collapsible>
								<div className="flex flex-wrap gap-2">
									<Button
										size="sm"
										disabled={respondHome.isPending}
										onClick={() =>
											respondHome.mutate({
												runId: approval.runId,
												decision: "reject",
												delegateRecommendation: true,
											})
										}
									>
										Decide for me
									</Button>
									<Button
										disabled={respondHome.isPending}
										icon={<Check size={14} />}
										onClick={() =>
											respondHome.mutate({
												runId: approval.runId,
												decision: "approve",
											})
										}
										size="sm"
									>
										Approve
									</Button>
									<Button
										disabled={respondHome.isPending}
										icon={<X size={14} />}
										onClick={() =>
											respondHome.mutate({
												runId: approval.runId,
												decision: "reject",
											})
										}
										size="sm"
										variant="destructive"
									>
										Reject
									</Button>
								</div>
							</li>
						))}
						{runtimeApprovals.map((approval) => (
							<li
								className="grid min-w-0 gap-2 rounded-lg border border-kumo-hairline bg-kumo-tint p-3"
								key={approval.id}
							>
								<ApprovalDecisionCopy approval={approval} />
								<Collapsible>
									<CollapsibleTrigger className="group/disclosure">
										<CaretRight
											size={14}
											aria-hidden
											className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
										/>
										Technical details
									</CollapsibleTrigger>
									<CollapsibleContent keepMounted>
										<Text as="p" role="body">
											{approval.description}
										</Text>
									</CollapsibleContent>
								</Collapsible>
								{approval.review.decisionMode === "approve_or_reject" ? (
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											disabled={resolveRuntime.isPending}
											onClick={() =>
												resolveRuntime.mutate({
													id: approval.id,
													status: approvalDecision(approval).recommendation,
													delegateRecommendation: true,
												})
											}
										>
											Decide for me
										</Button>
										<Button
											disabled={resolveRuntime.isPending}
											onClick={() =>
												resolveRuntime.mutate({
													id: approval.id,
													status: "approved",
												})
											}
											size="sm"
										>
											Approve
										</Button>
										<Button
											disabled={resolveRuntime.isPending}
											onClick={() =>
												resolveRuntime.mutate({
													id: approval.id,
													status: "rejected",
												})
											}
											size="sm"
											variant="destructive"
										>
											Reject
										</Button>
									</div>
								) : null}
							</li>
						))}
					</ul>
				)}

				{error ? (
					<Text className="m-0" role="label" tone="error">
						The decision could not be recorded:{" "}
						{error instanceof Error ? error.message : "Unknown error"}
					</Text>
				) : null}
				<Link
					className="flex min-h-9 items-center justify-between rounded-md border border-kumo-hairline px-3 text-kumo-default no-underline hover:bg-kumo-tint"
					href="/work/approvals"
				>
					View all approvals
					<span aria-hidden>→</span>
				</Link>
			</PopoverContent>
		</PopoverRoot>
	);
}
