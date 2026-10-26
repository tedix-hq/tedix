import type {
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AppDraftEditor } from "@/components/app-draft-editor";
import { AppRuntimeSandbox } from "@/components/app-runtime-panel";
import { ProposalDiff } from "@/components/canvas-proposals";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { osApi, osAppRuntimeCall } from "@/lib/api";
import {
	APP_DRAFT_SOURCE_LABELS,
	APP_DRAFT_STATUSES,
	type AppDraft,
	type AppDraftFileChange,
	appDraftFileChanges,
	appDraftsFrom,
} from "@/lib/app-runtime-drafts";
import {
	appRuntimeCodeQueryOptions,
	collaborationProposalsQueryOptions,
	osQueryKeys,
} from "@/lib/os-query-options";

const DRAFT_LIST_LIMIT = 20;
/** Drafts arrive from chat and agents while the panel is open. */
const DRAFT_POLL_MS = 15_000;

/** Open and approved drafts of one runtime app, in the order the API lists them. */
export function useAppDrafts(
	workspaceId: string,
	gadgetId: string,
	enabled: boolean,
): AppDraft[] {
	const proposals = useQuery({
		...collaborationProposalsQueryOptions({
			workspaceId,
			documentType: "gadget",
			documentId: gadgetId,
			statuses: APP_DRAFT_STATUSES,
			limit: DRAFT_LIST_LIMIT,
		}),
		enabled,
		refetchInterval: enabled ? DRAFT_POLL_MS : false,
	});
	return useMemo(
		() => appDraftsFrom(proposals.data?.items ?? []),
		[proposals.data],
	);
}

const CHANGE_LABEL: Record<AppDraftFileChange["kind"], string> = {
	added: "New file",
	changed: "Changed",
	removed: "Removed",
};

const CHANGE_VARIANT: Record<
	AppDraftFileChange["kind"],
	"success" | "secondary" | "destructive"
> = {
	added: "success",
	changed: "secondary",
	removed: "destructive",
};

/**
 * The Drafts view of a runtime app: every open draft with what it changes,
 * a preview that runs the draft's screen in its own sandbox, and the decision.
 * Server calls use the proposal's isolated facet; accepting records its files
 * as the next revision.
 */
export function AppRuntimeDrafts({
	workspaceId,
	gadget,
	revision,
	drafts,
	mergeBlockedReason,
	onMerged,
}: {
	workspaceId: string;
	gadget: OsGadget;
	revision: OsGadgetRevision;
	drafts: readonly AppDraft[];
	mergeBlockedReason?: string;
	onMerged: (revision: number, revisionId: string) => void;
}) {
	const liveCode = useQuery(
		appRuntimeCodeQueryOptions(workspaceId, gadget.id, revision.id),
	);
	const [previewing, setPreviewing] = useState<string | null>(null);
	return (
		<section className="grid min-w-0 gap-3" aria-label="Drafts" data-app-drafts>
			<Text as="p" role="label" tone="secondary" className="m-0">
				Changes saved from Code, chat or an agent. The live app keeps running
				version {revision.revision} until you accept one.
			</Text>
			{mergeBlockedReason && (
				<Text as="p" role="label" tone="warning" className="m-0">
					{mergeBlockedReason}
				</Text>
			)}
			{drafts.map((draft, index) => (
				<AppDraftCard
					key={draft.proposal.id}
					number={index + 1}
					workspaceId={workspaceId}
					gadget={gadget}
					revision={revision}
					draft={draft}
					liveFiles={liveCode.data?.code?.files ?? null}
					previewing={previewing === draft.proposal.id}
					onPreviewChange={(open) =>
						setPreviewing(open ? draft.proposal.id : null)
					}
					mergeBlockedReason={mergeBlockedReason}
					onMerged={onMerged}
				/>
			))}
		</section>
	);
}

function AppDraftCard({
	number,
	workspaceId,
	gadget,
	revision,
	draft,
	liveFiles,
	previewing,
	onPreviewChange,
	mergeBlockedReason,
	onMerged,
}: {
	number: number;
	workspaceId: string;
	gadget: OsGadget;
	revision: OsGadgetRevision;
	draft: AppDraft;
	liveFiles: Parameters<typeof appDraftFileChanges>[0]["files"];
	previewing: boolean;
	onPreviewChange: (open: boolean) => void;
	mergeBlockedReason?: string;
	onMerged: (revision: number, revisionId: string) => void;
}) {
	const queryClient = useQueryClient();
	const { proposal, content } = draft;
	const [reason, setReason] = useState("");
	const changes = useMemo(
		() =>
			appDraftFileChanges(
				{ manifest: revision.manifest, files: liveFiles },
				content,
			),
		[content, liveFiles, revision.manifest],
	);
	const callServer = useMemo(
		() =>
			createAppRuntimeServerCall(
				{
					open: () =>
						osApi.osAppRuntime.draft({
							workspaceId,
							gadgetId: gadget.id,
							proposalId: proposal.id,
						}),
					call: osAppRuntimeCall,
				},
				{
					workspaceId,
					gadgetId: gadget.id,
					revisionId: proposal.baseRevisionId,
				},
			),
		[
			workspaceId,
			gadget.id,
			proposal.id,
			proposal.sequence,
			proposal.baseRevisionId,
		],
	);
	const baseMoved = proposal.baseRevisionId !== revision.id;
	const [merged, setMerged] = useState<{
		revisionId: string;
		manifest: string;
		files: Record<string, string>;
		conflicts: string[];
	} | null>(null);
	const rebase = useMutation({
		mutationFn: () =>
			osApi.osAppRuntime.mergeDraft({
				workspaceId,
				gadgetId: gadget.id,
				proposalId: proposal.id,
				expectedSequence: proposal.sequence,
			}),
		onSuccess: setMerged,
	});
	const settle = () =>
		Promise.all([
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.collaborationProposals(),
			}),
			queryClient.invalidateQueries({ queryKey: osQueryKeys.gadgets() }),
		]);
	const accept = useMutation({
		mutationFn: async () => {
			if (mergeBlockedReason) throw new Error(mergeBlockedReason);
			const rationale =
				reason.trim() || "Accepted after previewing the draft in the app.";
			let sequence = proposal.sequence;
			if (proposal.status === "open") {
				const accepted = await osApi.osWorkspaces.collaboration.accept({
					proposalId: proposal.id,
					expectedSequence: sequence,
					rationale,
					evidenceRefs: [],
				});
				sequence = accepted.proposal.sequence;
			}
			return osApi.osWorkspaces.collaboration.merge({
				proposalId: proposal.id,
				expectedSequence: sequence,
				rationale,
				evidenceRefs: [],
			});
		},
		onSuccess: async ({ revision: next }) => {
			await settle();
			onMerged(next.revision, next.id);
		},
	});
	const reject = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.collaboration.reject({
				proposalId: proposal.id,
				expectedSequence: proposal.sequence,
				rationale: reason.trim() || "Rejected after review in the app.",
				evidenceRefs: [],
			}),
		onSuccess: settle,
	});
	const busy = accept.isPending || reject.isPending;
	const error = accept.error ?? reject.error ?? rebase.error;
	const title = `Draft ${number}`;

	return (
		<Surface
			className="grid min-w-0 gap-3 rounded-lg p-3"
			data-app-draft={proposal.id}
			aria-label={title}
			role="group"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<Text as="h3" role="body" weight="semibold" className="m-0">
					{title}
				</Text>
				<Badge variant={proposal.status === "accepted" ? "info" : "secondary"}>
					{proposal.status === "accepted"
						? "Approved · not applied"
						: "Needs review"}
				</Badge>
				<Text as="span" role="label" tone="secondary">
					{APP_DRAFT_SOURCE_LABELS[proposal.sourceKind]} · from version{" "}
					{proposal.baseRevision}
				</Text>
			</div>
			{baseMoved && (
				<Text as="p" role="label" tone="warning" className="m-0">
					The app changed since this draft was made. Update to latest to combine
					changes and review any conflicts before accepting.
				</Text>
			)}
			{baseMoved && (
				<Button
					size="sm"
					disabled={busy || rebase.isPending || !!mergeBlockedReason}
					onClick={() => rebase.mutate()}
				>
					{rebase.isPending ? "Comparing…" : "Update to latest"}
				</Button>
			)}
			{merged && (
				<div className="grid gap-2" aria-label="Merge review">
					<Text
						as="p"
						role="label"
						tone={merged.conflicts.length ? "warning" : "secondary"}
					>
						{merged.conflicts.length
							? `Resolve conflicts in ${merged.conflicts.join(", ")}. Remove markers or delete the file, then save for review.`
							: "Changes combined cleanly. Save the updated draft for review."}
					</Text>
					<AppDraftEditor
						key={`${proposal.sequence}:${merged.revisionId}`}
						manifest={merged.manifest}
						files={merged.files}
						onSave={async (content) => {
							await osApi.osAppRuntime.saveDraft({
								workspaceId,
								gadgetId: gadget.id,
								expectedRevisionId: merged.revisionId,
								proposalId: proposal.id,
								expectedSequence: proposal.sequence,
								content,
							});
							setMerged(null);
							await settle();
						}}
					/>
				</div>
			)}
			<div className="grid min-w-0 gap-2" aria-label={`${title} files`}>
				{changes.length === 0 ? (
					<Text as="p" role="label" tone="secondary" className="m-0">
						This draft matches the live app.
					</Text>
				) : (
					changes.map((change) => (
						<div
							key={change.path}
							className="grid min-w-0 gap-1"
							data-app-draft-file={change.path}
						>
							<div className="flex min-w-0 flex-wrap items-center gap-2">
								<code className="truncate text-sm">{change.path}</code>
								<Badge variant={CHANGE_VARIANT[change.kind]}>
									{CHANGE_LABEL[change.kind]}
								</Badge>
							</div>
							<ProposalDiff
								baseText={change.before}
								previewTextValue={change.after}
								baseMoved={false}
							/>
						</div>
					))
				)}
			</div>
			{previewing && (
				<div className="grid min-w-0 gap-2" data-app-draft-preview>
					<Text as="p" role="label" tone="secondary" className="m-0">
						Preview runs with separate app storage. Changes here stay in this
						draft.
					</Text>
					<div className="min-w-0 overflow-hidden rounded-lg border border-kumo-line">
						<AppRuntimeSandbox
							key={`${proposal.id}:${proposal.sequence}`}
							workspaceId={workspaceId}
							gadget={gadget}
							manifest={content.manifest}
							revision={proposal.baseRevision}
							files={content.files}
							callServer={callServer}
							title={`${gadget.name} · ${title}`}
							layout="content"
						/>
					</div>
				</div>
			)}
			<Input
				aria-label={`Reason for your decision on ${title}`}
				placeholder="Reason (optional)"
				value={reason}
				onChange={(event) => setReason(event.target.value)}
				maxLength={4000}
			/>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="secondary"
					aria-pressed={previewing}
					onClick={() => onPreviewChange(!previewing)}
				>
					{previewing ? "Hide preview" : "Preview"}
				</Button>
				<Button
					size="sm"
					disabled={busy || !!mergeBlockedReason || baseMoved}
					onClick={() => accept.mutate()}
				>
					{accept.isPending ? "Accepting…" : "Accept"}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={() => reject.mutate()}
				>
					{reject.isPending ? "Rejecting…" : "Reject"}
				</Button>
			</div>
			{error && (
				<Alert variant="destructive">
					<AlertTitle>Could not complete your decision</AlertTitle>
					<AlertDescription>{(error as Error).message}</AlertDescription>
				</Alert>
			)}
		</Surface>
	);
}
