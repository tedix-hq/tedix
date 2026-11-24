import type { StagedAppDraft } from "@tedix/api-contract/schemas/workspace-app-draft";
import { ListChecks } from "@phosphor-icons/react";
import { useState } from "react";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { ChatCard } from "@/components/workspace-chat-card";
import { WorkspaceChatAppDraft } from "@/components/workspace-chat-app-draft";
import type { ChatApproval } from "@/lib/workspace-chat-state";

type Decision = "approve" | "deny";

/** Where one staged change stands, in the person's words. */
export function stagedStatus(approval: ChatApproval): {
	label: string;
	variant: BadgeVariant;
	note?: string;
} {
	if (approval.expired)
		return {
			label: "Expired",
			variant: "secondary",
			note: "Nobody decided it in time. Nothing was applied.",
		};
	if (approval.execution?.status === "applied")
		return { label: "Applied", variant: "success" };
	if (approval.execution?.status === "failed")
		return {
			label: /stale/i.test(approval.execution.error ?? "")
				? "Stale"
				: "Not applied",
			variant: "destructive",
			note: approval.execution.error,
		};
	if (approval.decision === "deny")
		return approval.dependsOnRejected
			? {
					label: "Rejected",
					variant: "secondary",
					note: "It built on a change that was rejected. Nothing was applied.",
				}
			: { label: "Rejected", variant: "secondary" };
	if (approval.decision === "approve")
		return { label: "Applying…", variant: "secondary" };
	return { label: "Staged", variant: "warning" };
}

/**
 * The conversation's one review card: every change the agent staged in it,
 * plus its app drafts. Nothing listed here is applied until the person
 * accepts it; accepting applies it on the version it was staged on.
 */
export function StagedChangesCard({
	workspaceId,
	approvals,
	appDrafts,
	onDecide,
	onDecideAll,
}: {
	workspaceId: string;
	approvals: readonly ChatApproval[];
	appDrafts: readonly StagedAppDraft[];
	onDecide: (approvalId: string, decision: Decision) => void;
	onDecideAll: (approvalIds: string[], decision: Decision) => void;
}) {
	const [sent, setSent] = useState<Record<string, Decision>>({});
	const open = approvals.filter(
		(approval) => approval.decision === null && !sent[approval.approvalId],
	);
	const decide = (ids: string[], decision: Decision) =>
		setSent((current) => ({
			...current,
			...Object.fromEntries(ids.map((id) => [id, decision])),
		}));
	const titleOf = (approvalId: string) =>
		approvals.find((approval) => approval.approvalId === approvalId)?.title;
	return (
		<ChatCard
			attention={open.length > 0}
			data-testid="workspace-chat-staged-changes"
			icon={<ListChecks />}
			title="Staged changes for your review"
			status={
				<Badge variant={open.length ? "warning" : "secondary"}>
					{open.length ? `${open.length} waiting` : "All decided"}
				</Badge>
			}
			meta="Nothing here is applied until you accept it. Only this chat sees staged changes; they expire after 24 hours."
			actions={
				open.length ? (
					<>
						<Button
							size="sm"
							variant="outline"
							onClick={() => {
								const ids = open.map((approval) => approval.approvalId);
								decide(ids, "deny");
								onDecideAll(ids, "deny");
							}}
						>
							Discard all
						</Button>
						<Button
							size="sm"
							onClick={() => {
								const ids = open.map((approval) => approval.approvalId);
								decide(ids, "approve");
								onDecideAll(ids, "approve");
							}}
						>
							Accept all
						</Button>
					</>
				) : null
			}
		>
			<ul className="m-0 grid list-none gap-3 p-0">
				{approvals.map((approval) => {
					const status = stagedStatus(approval);
					const waiting =
						approval.decision === null && !sent[approval.approvalId];
					const base = approval.staged?.dependsOn;
					const baseOpen = base
						? approvals.some(
								(other) => other.approvalId === base && other.decision === null,
							)
						: false;
					const diff = approval.staged?.diff;
					return (
						<li
							key={approval.approvalId}
							id={`approval-${approval.approvalId}`}
							className="grid gap-1"
							data-testid="workspace-chat-staged-change"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Text as="strong" role="body">
									{approval.title}
								</Text>
								<Badge variant={status.variant}>
									{sent[approval.approvalId] && approval.decision === null
										? "Recording your decision…"
										: status.label}
								</Badge>
							</div>
							{base ? (
								<Text role="caption" tone="secondary">
									Builds on {titleOf(base) ?? "an earlier staged change"}
									{baseOpen ? "; accept that one first." : "."}
								</Text>
							) : null}
							{diff && (diff.added.length || diff.removed.length) ? (
								<pre className="workspace-chat-approval-preview m-0">
									{[
										...diff.removed.map((line) => `− ${line}`),
										...(diff.moreRemoved
											? [`− and ${diff.moreRemoved} more`]
											: []),
										...diff.added.map((line) => `+ ${line}`),
										...(diff.moreAdded ? [`+ and ${diff.moreAdded} more`] : []),
									].join("\n")}
								</pre>
							) : null}
							{status.note ? (
								<Text role="caption" tone="secondary">
									{status.note}
								</Text>
							) : null}
							{waiting ? (
								<div className="flex gap-2">
									<Button
										size="sm"
										variant="outline"
										aria-label={`Reject ${approval.title}`}
										onClick={() => {
											decide([approval.approvalId], "deny");
											onDecide(approval.approvalId, "deny");
										}}
									>
										Reject
									</Button>
									<Button
										size="sm"
										aria-label={`Accept ${approval.title}`}
										disabled={baseOpen}
										onClick={() => {
											decide([approval.approvalId], "approve");
											onDecide(approval.approvalId, "approve");
										}}
									>
										Accept
									</Button>
								</div>
							) : null}
						</li>
					);
				})}
			</ul>
			{appDrafts.map((draft) => (
				<WorkspaceChatAppDraft
					key={draft.proposalId}
					workspaceId={workspaceId}
					draft={draft}
				/>
			))}
		</ChatCard>
	);
}
