import { Check, Pulse, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { approvalsFromRunSet } from "@/components/chat-cards";
import { Button } from "@/components/kumo/button";
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
}: {
	conversationId?: string | null;
}) {
	const queryClient = useQueryClient();
	const runSet = useQuery({
		...homeRunSetQueryOptions(conversationId ?? ""),
		enabled: conversationId !== null,
		refetchInterval: 15_000,
	});
	const runtime = useQuery({
		...pendingApprovalsQueryOptions(),
		refetchInterval: 15_000,
	});
	const homeApprovals = runSet.data
		? approvalsFromRunSet(runSet.data.runSet).filter(isActionableHomeApproval)
		: [];
	const runtimeApprovals = runtime.data?.data ?? [];
	const count = approvalAttentionCount({
		home: homeApprovals.length,
		runtime: runtimeApprovals.length,
	});

	const respondHome = useMutation({
		mutationFn: ({
			runId,
			decision,
		}: {
			runId: string;
			decision: "approve" | "reject";
		}) => osChatMutationApi.kernelRuntime.respondApproval({ runId, decision }),
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
		}: {
			id: string;
			status: "approved" | "rejected";
		}) =>
			osApi.tediApprovals.resolve({
				id,
				status,
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
		<PopoverRoot>
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
							<span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-kumo-brand px-1 text-kumo-inverse type-tedix-caption">
								{count > 99 ? "99+" : count}
							</span>
						) : null}
					</Button>
				}
			/>
			<PopoverContent
				align="end"
				className="grid max-h-[min(36rem,var(--available-height))] w-[min(28rem,calc(100vw-2rem))] gap-3 overflow-y-auto p-3"
				side="bottom"
			>
				<div className="grid gap-1">
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
								<div className="grid min-w-0 gap-0.5">
									<Text as="strong" role="body" tone="strong">
										{approval.summary}
									</Text>
									{approval.detail ? (
										<Text role="label" tone="secondary">
											{approval.detail}
										</Text>
									) : null}
								</div>
								<div className="flex flex-wrap gap-2">
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
								<div className="grid min-w-0 gap-0.5">
									<Text as="strong" role="body" tone="strong">
										{approval.description}
									</Text>
									<Text role="label" tone="secondary">
										{approval.review.operatorQuestion}
									</Text>
								</div>
								{approval.review.decisionMode === "approve_or_reject" ? (
									<div className="flex flex-wrap gap-2">
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
