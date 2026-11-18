import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { osApi } from "@/lib/api";
import { osQueryKeys } from "@/lib/os-query-options";
import type { ChatApproval } from "@/lib/workspace-chat-state";

/** A file one approved change saved. Revision 1 means the change created it. */
export type ReplyChange = {
	approvalId: string;
	title: string;
	outputId: string;
	revision: number;
};

/** Proposals of one reply still waiting for a decision. */
export function waitingApprovals(approvals: ChatApproval[]): ChatApproval[] {
	return approvals.filter(
		(approval) => approval.decision === null && !approval.execution,
	);
}

/** The files a reply's approved changes saved, in the order they landed. */
export function appliedChanges(approvals: ChatApproval[]): ReplyChange[] {
	return approvals.flatMap((approval) => {
		const output = approval.execution?.output;
		if (approval.execution?.status !== "applied" || !output) return [];
		return [
			{
				approvalId: approval.approvalId,
				title: approval.target?.title ?? approval.title,
				...output,
			},
		];
	});
}

type UndoResult = { title: string; undone: boolean; reason?: string };

/**
 * Take one change back as a person's own save: a created file is archived
 * (it can be restored), a changed file gets the version before the change
 * as a new version. A file changed again since is left alone.
 */
async function undoChange(change: ReplyChange): Promise<UndoResult> {
	const { title, outputId, revision } = change;
	try {
		const current = await osApi.osWorkspaces.outputs.get({ outputId });
		if (current.output.status === "archived")
			return { title, undone: false, reason: "it is archived" };
		if (current.currentRevision.revision !== revision)
			return { title, undone: false, reason: "it changed again since" };
		if (revision === 1) {
			await osApi.osWorkspaces.outputs.archive({ outputId });
			return { title, undone: true };
		}
		const history = await osApi.osWorkspaces.outputs.history({
			outputId,
			revision: revision - 1,
		});
		const content = history.revisions.find(
			(item) => item.revision === revision - 1,
		)?.content;
		if (!content)
			return {
				title,
				undone: false,
				reason: "the earlier version is not available",
			};
		await osApi.osWorkspaces.outputs.revise({
			outputId,
			content,
			expectedRevisionId: current.currentRevision.id,
			note: "Undid an agent change from workspace chat",
		});
		return { title, undone: true };
	} catch (error) {
		return {
			title,
			undone: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function undoSummary(results: UndoResult[]): string {
	const undone = results.filter((result) => result.undone).length;
	const missed = results.filter((result) => !result.undone);
	const head =
		missed.length === 0
			? undone === 1
				? "Undid 1 change."
				: `Undid ${undone} changes.`
			: `Undid ${undone} of ${results.length} changes.`;
	return [
		head,
		...missed.map(
			(result) => `${result.title} was not undone: ${result.reason}.`,
		),
	].join(" ");
}

/**
 * Buttons for a whole reply: approve every waiting proposal at once, and
 * take back every change the reply applied. Each card keeps its own buttons.
 */
export function ReplyApprovalActions({
	approvals,
	approvingAll,
	onApproveAll,
}: {
	approvals: ChatApproval[];
	approvingAll: boolean;
	onApproveAll: (approvalIds: string[]) => void;
}) {
	const queryClient = useQueryClient();
	const waiting = waitingApprovals(approvals);
	const changes = appliedChanges(approvals);
	const [undoing, setUndoing] = useState(false);
	const [summary, setSummary] = useState<string | null>(null);
	const showApprove = waiting.length >= 2;
	const showUndo = waiting.length === 0 && changes.length > 0 && !summary;
	if (!showApprove && !showUndo && !summary) return null;
	const undoAll = async () => {
		setUndoing(true);
		const results: UndoResult[] = [];
		// Newest first, so a file changed twice by one reply ends where it began.
		for (const change of [...changes].reverse())
			results.push(await undoChange(change));
		await queryClient.invalidateQueries({ queryKey: osQueryKeys.outputs() });
		setUndoing(false);
		setSummary(undoSummary(results));
	};
	return (
		<div
			className="workspace-chat-reply-actions"
			data-testid="workspace-chat-reply-actions"
		>
			{showApprove ? (
				<Button
					disabled={approvingAll}
					onClick={() =>
						onApproveAll(waiting.map((approval) => approval.approvalId))
					}
					size="sm"
				>
					{approvingAll ? "Approving all…" : `Approve all (${waiting.length})`}
				</Button>
			) : null}
			{showUndo ? (
				<Button
					disabled={undoing}
					onClick={() => void undoAll()}
					size="sm"
					variant="outline"
				>
					{undoing ? "Undoing…" : "Undo all from this reply"}
				</Button>
			) : null}
			{summary ? <UndoSummary text={summary} /> : null}
		</div>
	);
}

function UndoSummary({ text }: { text: string }) {
	return (
		<Text role="caption" tone="secondary" aria-live="polite">
			{text}
		</Text>
	);
}
