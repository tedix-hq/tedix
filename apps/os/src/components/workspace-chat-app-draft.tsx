import type { StagedAppDraft } from "@tedix/api-contract/schemas/workspace-app-draft";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ProposalDiff } from "@/components/canvas-proposals";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Text } from "@/components/kumo/text";
import { ChatCard } from "@/components/workspace-chat-card";
import { OpenCreatedApp } from "@/components/workspace-chat-step-detail";
import { osApi } from "@/lib/api";
import { appDraftContent, appDraftFileChanges } from "@/lib/app-runtime-drafts";
import {
	appRuntimeCodeQueryOptions,
	osQuery,
	osQueryKeys,
} from "@/lib/os-query-options";

/** The transcript keeps the draft's identity; the proposal owns its live decision. */
export function WorkspaceChatAppDraft({
	workspaceId,
	draft,
}: {
	workspaceId: string;
	draft: StagedAppDraft;
}) {
	const cache = useQueryClient();
	const [review, setReview] = useState(false);
	const proposalQuery = useQuery({
		...osQuery.osWorkspaces.collaboration.get.queryOptions({
			input: { proposalId: draft.proposalId },
		}),
		// A decision made in the app pane or by someone else reaches the card on
		// the next look at the window, and at most half a minute later while it
		// is in front. Every undecided card in an open chat polls, so a short
		// interval multiplies into steady load on the main database.
		refetchOnWindowFocus: true,
		refetchInterval: (query) =>
			["merged", "rejected"].includes(query.state.data?.proposal.status ?? "")
				? false
				: 30_000,
	});
	const proposal = proposalQuery.data?.proposal;
	useEffect(() => {
		void proposalQuery.refetch();
	}, [draft.sequence, proposalQuery.refetch]);
	const published = proposal?.status === "merged";
	const discarded = proposal?.status === "rejected";
	const pending = !!proposal && !published && !discarded;
	const changed = proposal?.sequence !== draft.sequence;
	const base = useQuery({
		...appRuntimeCodeQueryOptions(
			workspaceId,
			draft.appId,
			draft.baseRevisionId,
		),
		enabled: review,
	});
	const content = proposal ? appDraftContent(proposal) : null;
	const changes =
		base.data?.code && content
			? appDraftFileChanges(
					{
						manifest: content.manifest,
						files: base.data.code.files,
					},
					content,
				)
			: [];
	const decide = useMutation({
		retry: false,
		mutationFn: async (decision: "publish" | "discard") => {
			if (!proposal || changed || !pending)
				throw new Error("Draft changed or is closed");
			if (decision === "publish")
				return osApi.osAppRuntime.acceptEdit({
					workspaceId,
					gadgetId: draft.appId,
					proposalId: draft.proposalId,
					expectedSequence: draft.sequence,
					rationale:
						"Accepted and published from the workspace chat draft card.",
				});
			return osApi.osWorkspaces.collaboration.reject({
				proposalId: draft.proposalId,
				expectedSequence: draft.sequence,
				rationale: "Discarded from the workspace chat draft card.",
				evidenceRefs: [],
			});
		},
		onSuccess: async () => {
			await Promise.all([
				proposalQuery.refetch(),
				cache.invalidateQueries({
					queryKey: osQueryKeys.collaborationProposals(),
				}),
				cache.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
			]);
		},
	});
	return (
		<ChatCard
			data-app-draft-card={draft.proposalId}
			title={draft.name}
			attention={pending}
			status={
				<Badge variant={published ? "success" : "secondary"}>
					{published
						? `Published · version ${proposal.resultRevision}`
						: discarded
							? "Discarded"
							: "Draft"}
				</Badge>
			}
			meta={`${draft.files.length} ${draft.files.length === 1 ? "file" : "files"} changed: ${draft.files.join(", ")}`}
			actions={
				<>
					{pending && (
						<Button
							size="sm"
							disabled={changed || decide.isPending}
							onClick={() => decide.mutate("publish")}
						>
							Accept and publish
						</Button>
					)}
					<Button
						size="sm"
						variant="secondary"
						onClick={() => setReview(!review)}
					>
						{review ? "Close review" : "Review"}
					</Button>
					<OpenCreatedApp
						workspaceId={workspaceId}
						appId={draft.appId}
						name={draft.name}
					/>
					{pending && (
						<Button
							size="sm"
							variant="secondary"
							disabled={changed || decide.isPending}
							onClick={() => decide.mutate("discard")}
						>
							Discard
						</Button>
					)}
				</>
			}
		>
			{pending && changed && (
				<Text as="p" role="caption">
					The draft changed outside this chat. Review it in the app before
					publishing.
				</Text>
			)}
			{(decide.error || proposalQuery.error) && (
				<Text as="p" role="caption" tone="error">
					{(decide.error ?? proposalQuery.error)?.message}
				</Text>
			)}
			{review &&
				changes.map((change) => (
					<div key={change.path}>
						<Text as="p" role="label">
							{change.path}
						</Text>
						<ProposalDiff
							baseText={change.before}
							previewTextValue={change.after}
							baseMoved={false}
						/>
					</div>
				))}
			{review && base.error && (
				<Text as="p" role="caption" tone="error">
					{base.error.message}
				</Text>
			)}
		</ChatCard>
	);
}
