import type {
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
	useWorkspaceEventStreamOpen,
	workspacePollMs,
} from "@/lib/workspace-event-stream";
import { AppDraftEditor } from "@/components/app-draft-editor";
import { AppSharedDraftEditor } from "@/components/app-shared-draft-editor";
import { AppRuntimeSandbox } from "@/components/app-runtime-panel";
import { ProposalDiff } from "@/components/canvas-proposals";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Input } from "@/components/kumo/input";
import { Surface } from "@/components/kumo/surface";
import { Text } from "@/components/kumo/text";
import { createAppRuntimeServerCall } from "@/lib/app-runtime-session";
import { osApi, osAppRuntimeCall } from "@/lib/api";
import {
	APP_DRAFT_STATUSES,
	type AppDraft,
	type AppDraftFileChange,
	appDraftFileChanges,
	appDraftsFrom,
} from "@/lib/app-runtime-drafts";
import { relativeTime } from "@/lib/time";
import {
	appRuntimeCodeQueryOptions,
	collaborationProposalsQueryOptions,
	osQueryKeys,
	osQuery,
} from "@/lib/os-query-options";

const DRAFT_LIST_LIMIT = 20;
/**
 * Drafts arrive from chat and agents while the panel is open. The workspace
 * event stream announces them; this poll is the fast path only until it opens.
 */
const DRAFT_POLL_MS = 15_000;

/** Open and approved drafts of one runtime app, in the order the API lists them. */
export function useAppDrafts(
	workspaceId: string,
	gadgetId: string,
	enabled: boolean,
): AppDraft[] {
	const streamOpen = useWorkspaceEventStreamOpen();
	const proposals = useQuery({
		...collaborationProposalsQueryOptions({
			workspaceId,
			documentType: "gadget",
			documentId: gadgetId,
			statuses: APP_DRAFT_STATUSES,
			limit: DRAFT_LIST_LIMIT,
		}),
		enabled,
		refetchInterval: enabled
			? workspacePollMs(streamOpen, DRAFT_POLL_MS)
			: false,
	});
	return useMemo(
		() => appDraftsFrom(proposals.data?.items ?? []),
		[proposals.data],
	);
}

/** Where a suggested change came from, as a person would say it. */
const DRAFT_ORIGIN: Record<AppDraft["proposal"]["sourceKind"], string> = {
	user: "Edited in Code",
	chat: "Made in a chat",
	run: "Made by a skill run",
	agent_session: "Made by a coding agent",
};

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
				{drafts.length === 1
					? "A change to this app is waiting for you."
					: `${drafts.length} changes to this app are waiting for you.`}{" "}
				Everyone keeps using version {revision.revision} until you publish one.
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
					only={drafts.length === 1}
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
	only,
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
	only: boolean;
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
	const { content } = draft;
	// Keep the approval receipt while the proposals query catches up.
	const [approval, setApproval] = useState<typeof draft.proposal>();
	const proposal =
		draft.proposal.status === "open" &&
		approval?.sequence === draft.proposal.sequence
			? approval
			: draft.proposal;
	const [reason, setReason] = useState("");
	const [noting, setNoting] = useState(false);
	const [editing, setEditing] = useState(false);
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
			queryClient.invalidateQueries({
				queryKey:
					osQuery.osWorkspaces.collaboration.previewBlueprintAppUpdate.key(),
			}),
		]);
	const accept = useMutation({
		retry: false,
		mutationFn: async () => {
			if (mergeBlockedReason) throw new Error(mergeBlockedReason);
			const rationale =
				reason.trim() || "Accepted and published from the app's review.";
			let sequence = proposal.sequence;
			if (proposal.status === "open") {
				const accepted = await osApi.osWorkspaces.collaboration.accept({
					proposalId: proposal.id,
					expectedSequence: sequence,
					rationale,
					evidenceRefs: [],
				});
				sequence = accepted.proposal.sequence;
				setApproval(accepted.proposal);
			}
			const input = {
				proposalId: proposal.id,
				expectedSequence: sequence,
				rationale,
				evidenceRefs: [],
			};
			const delays = [250, 500];
			for (const delay of delays) {
				try {
					return await osApi.osWorkspaces.collaboration.merge(input);
				} catch (error) {
					const failure = error as { code?: string; message?: string } | null;
					const transient =
						failure?.code === "SERVICE_UNAVAILABLE" ||
						(!failure?.code &&
							failure?.message?.includes("Database temporarily unavailable"));
					if (!transient) throw error;
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
			return osApi.osWorkspaces.collaboration.merge(input);
		},
		onSuccess: async ({ revision: next }) => {
			await settle();
			onMerged(next.revision, next.id);
		},
		onError: () => {
			void settle();
		},
	});
	const reject = useMutation({
		mutationFn: () =>
			osApi.osWorkspaces.collaboration.reject({
				proposalId: proposal.id,
				expectedSequence: proposal.sequence,
				rationale: reason.trim() || "Discarded from the app's review.",
				evidenceRefs: [],
			}),
		onSuccess: settle,
	});
	const busy = accept.isPending || reject.isPending || editing;
	const error = accept.error ?? reject.error ?? rebase.error;
	const approved = proposal.status === "accepted";
	const applyFailed = approved && accept.isError;
	const title = `Suggested change ${number}`;
	const made = relativeTime(proposal.updatedAt);

	return (
		<Surface
			className="grid min-w-0 gap-3 rounded-lg p-3"
			data-app-draft={proposal.id}
			aria-label={title}
			role="group"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
				<Text as="h3" role="body" weight="semibold" className="m-0">
					{only ? "Suggested change" : title}
				</Text>
				<Badge variant={proposal.status === "accepted" ? "info" : "secondary"}>
					{baseMoved
						? "Out of date"
						: proposal.status === "accepted"
							? "Approved · not published yet"
							: "Waiting for you"}
				</Badge>
				<Text as="span" role="label" tone="secondary">
					{DRAFT_ORIGIN[proposal.sourceKind]}
					{made ? ` · ${made}` : ""}
				</Text>
			</div>
			{editing && (
				<AppSharedDraftEditor
					workspaceId={workspaceId}
					gadgetId={gadget.id}
					proposal={proposal}
					content={content}
					onClose={() => setEditing(false)}
				/>
			)}
			{baseMoved && (
				<Text as="p" role="label" tone="warning" className="m-0">
					The app was updated after this change was suggested. Publishing still
					works when the two touched different files. If they overlap, ask the
					agent to make the change again.
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
			{changes.length === 0 ? (
				<Text as="p" role="label" tone="secondary" className="m-0">
					This change matches the app as it is now.
				</Text>
			) : (
				<Collapsible className="type-tedix-control">
					<CollapsibleDefaultTrigger className="group/disclosure">
						{`See what changed · ${changes.length} ${changes.length === 1 ? "file" : "files"}`}
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<div
							className="grid min-w-0 gap-2 pt-2"
							aria-label={`${title} files`}
						>
							{changes.map((change) => (
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
							))}
						</div>
					</CollapsibleDefaultContent>
				</Collapsible>
			)}
			{previewing && (
				<div className="grid min-w-0 gap-2" data-app-draft-preview>
					<Text as="p" role="label" tone="secondary" className="m-0">
						This is the app with the change applied. The preview keeps its own
						app storage, so what you save here stays out of the live app.
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
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					disabled={busy || !!mergeBlockedReason || (baseMoved && approved)}
					onClick={() => accept.mutate()}
				>
					{approved
						? accept.isPending
							? "Publishing…"
							: "Publish now"
						: accept.isPending
							? "Publishing…"
							: "Accept and publish"}
				</Button>
				<Button
					size="sm"
					variant="secondary"
					aria-pressed={previewing}
					disabled={editing}
					onClick={() => onPreviewChange(!previewing)}
				>
					{previewing ? "Hide preview" : "Preview"}
				</Button>
				{proposal.status === "open" && !baseMoved && !mergeBlockedReason && (
					<Button
						size="sm"
						variant="secondary"
						disabled={busy}
						onClick={() => setEditing(true)}
					>
						Edit
					</Button>
				)}
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					onClick={() => reject.mutate()}
				>
					{reject.isPending ? "Discarding…" : "Discard"}
				</Button>
				{!noting && (
					<Button size="sm" variant="ghost" onClick={() => setNoting(true)}>
						Add a note
					</Button>
				)}
			</div>
			{noting && (
				<Input
					aria-label={`Note on your decision about ${title}`}
					placeholder="Why you are publishing or discarding this (optional)"
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					maxLength={4000}
				/>
			)}
			<Text as="p" role="label" tone="secondary" className="m-0">
				Publishing updates the app for everyone in this workspace. Earlier
				versions stay in History.
			</Text>
			{error && (
				<Alert variant="destructive">
					<AlertTitle>
						{applyFailed
							? "This change is approved but not published yet"
							: "Could not complete your decision"}
					</AlertTitle>
					<AlertDescription>{(error as Error).message}</AlertDescription>
				</Alert>
			)}
		</Surface>
	);
}
