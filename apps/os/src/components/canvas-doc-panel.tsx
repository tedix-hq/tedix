import {
	ArrowsIn,
	ArrowsOut,
	FloppyDisk,
	SidebarSimple,
	X,
} from "@phosphor-icons/react";
import type {
	OsGadgetExecution,
	OsGadgetManifest,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { isConflictError } from "@/components/blueprints-page";
import { CanvasCodeEditor } from "@/components/canvas-editor";
import {
	CanvasGadgetExecutions,
	gadgetExecutionToolResult,
} from "@/components/canvas-gadget-executions";
import { CanvasPresence } from "@/components/canvas-presence";
import { CanvasDocumentRecovery } from "@/components/canvas-document-recovery";
import { CanvasProposals } from "@/components/canvas-proposals";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import { Input } from "@/components/kumo/input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { Surface } from "@/components/kumo/surface";
import { ListSkeleton } from "@/components/list-skeleton";
import { OutputEditor } from "@/components/output-editor";
import { OutputExportButtons } from "@/components/output-export-buttons";
import {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopFooter,
	OutputWorkshopIdentity,
	OutputWorkshopStatus,
} from "@/components/output-workshop";
import { ShareControls } from "@/components/share-controls";
import { WorkspaceGadgetReview } from "@/components/shared-review-batch";
import { WidgetFrame } from "@/components/widget-frame";
import { diffFiles } from "@/collab/ot/code-change";
import { COLLAB_DOC_PATH } from "@/collab/protocol";
import { osApi } from "@/lib/api";
import {
	outputKindError,
	parseDraft,
	parseOutputDraft,
} from "@/lib/canvas-draft";
import { type CanvasDocSelection, canvasDocKey } from "@/lib/canvas-search";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { sentenceCase } from "@/lib/format";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";
import {
	canvasGadgetDetailQueryOptions,
	canvasGadgetsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	type CollabCommitBasis,
	type CollabDocCanonical,
	useCollabDoc,
} from "@/lib/use-collab-doc";
import { useReviseOutput } from "@/lib/use-revise-output";

/**
 * The Canvas document panel: the gadget-detail domain owner, the OutputEditor
 * host, and the only place that authors shared changes for a workpiece draft.
 * Extracted whole from canvas-page.tsx — the route shell composes it, this
 * module owns the document lifecycle.
 *
 * There is one copy of the document, not two. The room's base is a
 * server-agreed revision of the change stream, so the panel tracks no separate
 * draft, diffs no two texts, and repairs no metadata. What it must still know
 * is which canonical revision the room's content represents — and that answer
 * comes from the room (`useCollabDoc().canonical`), never from the document
 * query.
 *
 * That distinction is the whole commit safety argument. A commit is a
 * compare-and-swap, and pinning it to `gadgetDetail.data.currentRevision` — a
 * live query that refetches — loses data silently and permanently: the room
 * seeds at revision 5, revision 6 lands out of band (a CanvasProposals merge, a
 * tedi tool edit, the API), the query refetches to 6, Commit pins 6, the CAS
 * passes, and revision 7 is written from stale revision-5 text with revision 6
 * destroyed. The `unchanged` content-hash guard does not catch it, because the
 * text genuinely differs. Pinned to the room's stamp, the same race pins 5, the
 * CAS fails, and the user is told their draft was not written.
 *
 * The other half is adoption, and it is the server's decision, not this
 * panel's. An unedited room offered a newer canonical revision carries forward
 * automatically as one ordinary server-authored change. A room holding real
 * edits is refused (`recoveryRequired`): this panel blocks Commit, says the
 * shared source is behind, and offers an explicit two-step replacement. It
 * never replaces a colleague's unsaved work on its own initiative.
 *
 * And the panel must ground its own commit, or that refusal fires on the room's
 * own work. A commit writes the room's text at one stream position; the user
 * keeps typing through the round trip; the refetched revision is then neither
 * unedited nor byte-identical, so the room refuses it and the panel would tell
 * the user the shared source is "behind" a revision the room is ahead of —
 * blocking Commit permanently and offering only a replacement that discards
 * everything typed since. So the commit path takes a `CollabCommitBasis` before
 * it writes and hands it back through `groundCommit` after: the room is
 * re-grounded on the revision at the position it came from, which the server
 * verifies against its own stream. The out-of-band case above is untouched —
 * nobody holds a basis for a revision they did not commit, so it still goes
 * through adoption and is still refused.
 *
 * So there is no commit without a basis. `commitBasis()` returns null while the
 * client holds unacknowledged edits, and committing anyway reproduced the wedge
 * from the other end: the revision lands ungrounded, the refetch is refused as
 * `edited`, Commit is blocked, and the only offered action is the destructive
 * Replace — which a reload does not clear, because a fresh session re-observes
 * the same stamp. Commit is therefore disabled while `unacknowledged`, with the
 * reason on screen, and `commitDraft` refuses a null basis outright. That waits
 * one round trip, not indefinitely: submissions compose, so everything typed
 * since the last acknowledgement rides one of them.
 */

/**
 * Why Commit is waiting while this client's latest keystrokes are unacknowledged.
 *
 * Phrased as a transient, self-clearing state rather than a refusal, because that is what it is:
 * the room is saving, and one round trip later Commit is live again. See `commitDisabled`.
 *
 * And it does not promise the room will GET them, because it cannot. There is no offline log (see
 * `@/lib/use-collab-doc`): if the socket dies before the acknowledgement, the client goes with it
 * and these exact edits are gone. The earlier wording — "as soon as the room has them" — asserted
 * an outcome the transport does not guarantee, and the reconnect that discarded them raised the
 * warning below to say the opposite. Name the condition instead, so the two surfaces agree.
 */
const UNACKNOWLEDGED_COMMIT_MESSAGE =
	"Saving your latest edits… Commit is available again once the room acknowledges them. If the connection drops first, they are discarded.";

/** A gadget with no revision yet seeds the smallest committable manifest. */
const DEFAULT_GADGET_MANIFEST: OsGadgetManifest = {
	capabilities: [],
	entry: "main.tsx",
};

const GADGET_VIEW_OPTIONS = [
	{ value: "preview", label: "App" },
	{ value: "source", label: "Code" },
	{ value: "runs", label: "Runs" },
] as const;

export type CollabConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected";

const CONNECTION_VARIANTS: Record<CollabConnectionStatus, BadgeVariant> = {
	connecting: "info",
	connected: "success",
	disconnected: "destructive",
};

export function ConnectionChip({
	status,
	peers,
}: {
	status: CollabConnectionStatus;
	peers: number;
}) {
	return (
		<Badge variant={CONNECTION_VARIANTS[status]} data-connection={status}>
			{sentenceCase(status)}
			{status === "connected" &&
				` · ${peers} ${peers === 1 ? "peer" : "peers"}`}
		</Badge>
	);
}

// ---------------------------------------------------------------------------
// Document panel: collab editor + commit bar
// ---------------------------------------------------------------------------

export function CanvasDocPanel({
	workspaceId,
	doc,
	gadgetViewOverride,
	focusMode,
	onFocusModeChange,
	onShowResources,
	onWidgetFollowUp,
	viewControls,
}: {
	workspaceId: string;
	doc: CanvasDocSelection;
	gadgetViewOverride?: "preview" | "source" | "runs";
	focusMode: boolean;
	viewControls?: ReactNode;
	onFocusModeChange: (focused: boolean) => void;
	onShowResources: () => void;
	onWidgetFollowUp?: (message: string) => void;
}) {
	const queryClient = useQueryClient();
	const isGadget = doc.type === "gadget";

	const gadgetDetail = useQuery({
		...canvasGadgetDetailQueryOptions(workspaceId, doc.id),
		enabled: isGadget,
	});
	const outputDetail = useQuery({
		// Contract-derived, not a hand-written key: `artifact.created` invalidates
		// the generated `osQueryKeys.outputs()` prefix, and a legacy
		// `["os-output", id]` literal sits in a disjoint namespace that the prefix
		// can never reach — so an open document silently kept showing the old
		// revision. See os-query-options.test.ts for the guard.
		...outputDetailQueryOptions(doc.id),
		enabled: !isGadget,
	});
	const detail = isGadget ? gadgetDetail : outputDetail;
	const title = isGadget
		? gadgetDetail.data?.gadget.name
		: outputDetail.data?.output.title;

	// Canonical truth as this client just loaded it: the text and which revision
	// it is. A room with no base yet is seeded from it; an already-grounded room
	// on an older revision is offered it, and the server decides.
	const canonicalDoc: CollabDocCanonical | null = isGadget
		? gadgetDetail.data
			? {
					text: JSON.stringify(
						gadgetDetail.data.currentRevision?.manifest ??
							DEFAULT_GADGET_MANIFEST,
						null,
						2,
					),
					revision: gadgetDetail.data.currentRevision?.revision ?? 0,
					revisionId: gadgetDetail.data.currentRevision?.id ?? null,
				}
			: null
		: outputDetail.data
			? {
					text: JSON.stringify(
						outputDetail.data.currentRevision.content,
						null,
						2,
					),
					revision: outputDetail.data.currentRevision.revision,
					revisionId: outputDetail.data.currentRevision.id,
				}
			: null;

	const {
		session,
		status,
		peers,
		participants,
		blocked,
		unsynced,
		unacknowledged,
		discarded,
		canonical: roomCanonical,
		recoveryRequired,
		replaceWithCanonical,
		commitBasis,
		groundCommit,
	} = useCollabDoc({
		workspaceId,
		docKey: canvasDocKey(doc),
		enabled: true,
		canonical: canonicalDoc,
		location: {
			surface: "canvas",
			artifactKind: doc.type,
			...(title ? { artifactLabel: title } : {}),
		},
	});
	const live = status === "connected";

	// The room's current text for this document. Remote changes republish it;
	// local edits update it at their source, so an editor is never fought for
	// control of its own buffer.
	const [docText, setDocText] = useState("");
	useEffect(() => {
		if (!session) {
			setDocText("");
			return;
		}
		setDocText(session.text(COLLAB_DOC_PATH));
		return session.onRemote(() => setDocText(session.text(COLLAB_DOC_PATH)));
	}, [session]);

	const outputKind = outputDetail.data?.output.kind;
	const outputParsed =
		!isGadget && outputKind && docText !== ""
			? parseOutputDraft(docText, outputKind)
			: null;
	const outputDraft = outputParsed?.ok ? outputParsed.content : null;
	const outputDraftIssue =
		outputParsed && !outputParsed.ok ? outputParsed.issue : null;

	/**
	 * Structured editors write the whole document, and expressing that as one
	 * DIFF-derived change is not a nicety.
	 *
	 * Expressed as a destroy-and-rebuild (delete the whole document, insert the
	 * new one), two peers writing concurrently can converge on concatenated
	 * duplicate JSON — two independent insert histories at the same position.
	 *
	 * A change stream cannot express that failure. This is one ordinary change
	 * against a named revision; if a peer's change lands first, the server
	 * transforms this one over it and both replicas converge on the same text.
	 * The corruption mode is structurally impossible, not merely avoided.
	 */
	const updateSharedOutput = (next: OsOutputContent) => {
		// A disconnected room accepts nothing: the OT client is gone, so writing
		// `docText` here would desync the panel from what every peer still sees.
		if (!session || !live) return;
		const serialized = JSON.stringify(next, null, 2);
		const current = session.text(COLLAB_DOC_PATH);
		if (current === serialized) return;
		const change = diffFiles(
			new Map([[COLLAB_DOC_PATH, current]]),
			new Map([[COLLAB_DOC_PATH, serialized]]),
		);
		if (change.length === 0) return;
		session.applyLocal(change, COLLAB_DOC_PATH, serialized);
		setDocText(serialized);
	};
	const [confirming, setConfirming] = useState(false);
	const [note, setNote] = useState("");
	const [draftError, setDraftError] = useState<string | null>(null);
	const [committedRevision, setCommittedRevision] = useState<number | null>(
		null,
	);
	const [gadgetView, setGadgetView] = useState<"preview" | "source" | "runs">(
		"preview",
	);
	const effectiveGadgetView = gadgetViewOverride ?? gadgetView;
	const [previewExecution, setPreviewExecution] =
		useState<OsGadgetExecution | null>(null);

	const reviseOutput = useReviseOutput(isGadget ? "" : doc.id);

	const gadgetCommit = useMutation({
		mutationFn: (variables: {
			manifest: OsGadgetManifest;
			basis: CollabCommitBasis;
		}) =>
			osApi.osWorkspaces.gadgets.revise({
				workspaceId,
				gadgetId: doc.id,
				manifest: variables.manifest,
				// The room'S stamp, not the query's: see this module's header.
				expectedRevision: roomCanonical?.revision ?? 0,
			}),
		onSuccess: ({ revision }, variables) => {
			// Re-ground the room on the revision this commit just produced, at the
			// position it was written from. Without it the room stays grounded on the
			// revision this one superseded and refuses its own commit as "behind".
			groundCommit(variables.basis, revision.revision, revision.id);
			setCommittedRevision(revision.revision);
			setConfirming(false);
			queryClient.invalidateQueries({
				queryKey: canvasGadgetDetailQueryOptions(workspaceId, doc.id).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: canvasGadgetsQueryOptions(workspaceId).queryKey,
				exact: true,
			});
		},
		onError: (error) => {
			// A lost CAS means the loaded revision is stale — refetch so a retry
			// carries the revision the store actually holds.
			if (isConflictError(error)) {
				queryClient.invalidateQueries({
					queryKey: canvasGadgetDetailQueryOptions(workspaceId, doc.id)
						.queryKey,
				});
			}
		},
	});

	const commitDraft = async () => {
		setDraftError(null);
		setCommittedRevision(null);
		// The session is the live buffer: an editor's keystrokes are already in it
		// (`applyLocal` is synchronous), so this is what every peer sees right now.
		const text = session ? session.text(COLLAB_DOC_PATH) : docText;
		// Taken here, before any await, and that placement is the point: it is the
		// position `text` came from, and by the time the commit answers, the room
		// has moved.
		//
		// And it is a hard guard, in the same await-free span as the read. A `null`
		// basis means this client still holds unacknowledged edits, so no stream
		// position describes `text` and nothing could re-ground the room on the
		// revision this commit would produce — which is precisely the wedge: the
		// revision lands, the room stays grounded on the one it superseded, the
		// refetch is refused as `edited`, and the only action left is the
		// destructive Replace. The button is already disabled on `unacknowledged`;
		// this catches the click that raced the state, and it is transient, so the
		// answer is "try again in a moment", not a failure.
		const basis = commitBasis();
		if (basis === null) {
			setDraftError(UNACKNOWLEDGED_COMMIT_MESSAGE);
			return;
		}
		const parsed = parseDraft(text);
		if (!parsed.ok) {
			setDraftError(`The draft is not valid JSON: ${parsed.error}`);
			return;
		}
		if (isGadget) {
			gadgetCommit.mutate({
				manifest: parsed.value as OsGadgetManifest,
				basis,
			});
			return;
		}
		const loaded = outputDetail.data;
		if (!loaded) return;
		const kindError = outputKindError(parsed.value, loaded.output.kind);
		if (kindError) {
			setDraftError(kindError);
			return;
		}
		const result = await reviseOutput.save({
			content: parsed.value as OsOutputContent,
			baseContent: loaded.currentRevision.content,
			// The room'S stamp, not the query's: see this module's header.
			expectedRevision: roomCanonical?.revision ?? 0,
			note,
		});
		if (result.kind === "saved") {
			// Same grounding as the gadget path, for the same reason.
			groundCommit(basis, result.revision, result.revisionId);
			setCommittedRevision(result.revision);
			setConfirming(false);
			setNote("");
		}
	};

	const committing = gadgetCommit.isPending || reviseOutput.saving;
	const conflicted =
		(isGadget && gadgetCommit.isError && isConflictError(gadgetCommit.error)) ||
		(!isGadget && reviseOutput.outcome?.kind === "conflict");
	const failureMessage = isGadget
		? gadgetCommit.isError && !isConflictError(gadgetCommit.error)
			? (gadgetCommit.error as Error).message
			: null
		: reviseOutput.outcome?.kind === "error"
			? reviseOutput.outcome.message
			: null;
	const draftParsed = parseDraft(docText);
	const savedParsed = canonicalDoc ? parseDraft(canonicalDoc.text) : null;
	const draftMatchesSaved =
		draftParsed.ok &&
		savedParsed?.ok &&
		canonicalJsonText(draftParsed.value) ===
			canonicalJsonText(savedParsed.value);
	const proposalMergeBlockedReason = !live
		? "Reconnect before applying a proposal."
		: recoveryRequired
			? "Review the updated version before applying a proposal."
			: unsynced || unacknowledged || committing
				? "Wait for your changes to finish syncing and saving."
				: !draftMatchesSaved
					? "Save your draft as a version before applying a proposal."
					: undefined;
	const documentSaveStatus = !live
		? status === "connecting"
			? "Connecting…"
			: "Disconnected · Changes paused"
		: recoveryRequired
			? "Updated version available · Review"
			: outputDraftIssue
				? "Draft needs recovery"
				: committing
					? "Saving version…"
					: unsynced || unacknowledged
						? "Syncing changes…"
						: draftMatchesSaved
							? "Saved"
							: "Draft synced · Save version";
	const revisionLabel = isGadget
		? gadgetDetail.data
			? gadgetDetail.data.currentRevision
				? `Revision ${gadgetDetail.data.currentRevision.revision}`
				: "No revision yet"
			: null
		: outputDetail.data
			? `Revision ${outputDetail.data.currentRevision.revision}`
			: null;
	const gadgetWidgetTarget = isGadget
		? gadgetWidgetTargetFromManifest(
				gadgetDetail.data?.currentRevision?.manifest,
			)
		: null;
	const executionGadgetId = isGadget ? doc.id : doc.linkedGadgetId;
	useEffect(() => {
		setPreviewExecution(null);
	}, [doc.id, doc.type, executionGadgetId, workspaceId]);

	const outputKindLabel = outputKind ? sentenceCase(outputKind) : "Output";
	/**
	 * Commit needs a live room, and a room that is not behind canonical truth.
	 *
	 * `recoveryRequired` means the server refused to carry this room onto a newer
	 * canonical revision because it holds edits that revision would replace. The
	 * room's text is therefore based on a revision that is no longer current, and
	 * committing it would ask for a compare-and-swap the store must reject. Block
	 * it here and make the user resolve it explicitly instead.
	 *
	 * `unacknowledged` is the other blocker, and it is nothing like that one: it is
	 * transient, it clears itself, and the user did nothing wrong. While this
	 * client holds edits the server has not agreed to, `commitBasis()` is null —
	 * and a commit with no basis cannot re-ground the room on the revision it
	 * produces, which lands the document in exactly the `recoveryRequired` state
	 * above with the destructive Replace as its only escape. So Commit waits, and
	 * says so. It cannot wait forever: submissions compose, so everything typed
	 * since the last acknowledgement rides one submission and this clears a single
	 * round trip after the last keystroke, however fast the user types. This also
	 * subsumes `blocked`, which is a stuck submission by another name.
	 */
	const commitDisabled =
		!detail.data ||
		!session ||
		!live ||
		roomCanonical === null ||
		recoveryRequired ||
		unacknowledged ||
		outputDraftIssue !== null;

	return (
		<div
			className="canvas-document-shell grid min-w-0 content-start gap-0"
			style={
				isGadget && gadgetWidgetTarget && effectiveGadgetView === "preview"
					? {
							display: "flex",
							flexDirection: "column",
							height: "100%",
							minHeight: 0,
						}
					: undefined
			}
		>
			<OutputWorkshopCommandBar className="canvas-document-header">
				<OutputWorkshopIdentity className="canvas-document-identity">
					{!focusMode && viewControls ? (
						viewControls
					) : (
						<>
							<Text
								as="h2"
								role="body"
								tone="strong"
								weight="semibold"
								className="canvas-document-title m-0 truncate"
								title={title ?? "Loading…"}
							>
								{title ?? "Loading…"}
							</Text>
						</>
					)}

					{doc.type === "output" && doc.linkedGadgetId && (
						<Badge variant="info">Gadget editor</Badge>
					)}
				</OutputWorkshopIdentity>
				<OutputWorkshopStatus className="canvas-document-status">
					{status !== "connected" && (
						<ConnectionChip status={status} peers={peers} />
					)}
					<CanvasPresence participants={participants ?? []} />
					<span className="sr-only" data-canvas-revision-status>
						{revisionLabel}
					</span>
					<Badge
						className={
							documentSaveStatus === "Saved" && !isGadget
								? "canvas-saved-status"
								: undefined
						}
						variant={unsynced ? "warning" : "info"}
						title={`${revisionLabel ?? "No canonical revision"}. Changes sync with connected editors. Save version records them in version history.`}
					>
						{isGadget
							? unsynced
								? "Live draft · Syncing…"
								: "Live draft · Commit to save"
							: documentSaveStatus}
					</Badge>
				</OutputWorkshopStatus>
				<OutputWorkshopActions className="canvas-document-actions">
					{isGadget && gadgetDetail.data && (
						<ShareControls
							resourceType="gadget"
							resourceId={gadgetDetail.data.gadget.id}
							currentRevisionId={gadgetDetail.data.currentRevision?.id}
							compact
						/>
					)}
					{!isGadget && outputDetail.data && (
						<>
							<OutputExportButtons
								outputId={doc.id}
								kind={outputDetail.data.output.kind}
								compact
							/>
							<ShareControls
								outputId={doc.id}
								currentRevisionId={outputDetail.data.currentRevision.id}
								compact
							/>
						</>
					)}
					<Button
						variant="outline"
						size="icon-sm"
						className="canvas-mobile-resources-button"
						aria-label="Resources"
						title="Resources"
						onClick={onShowResources}
					>
						<SidebarSimple size={14} />
						<span className="sr-only">Resources</span>
					</Button>
					<Button
						variant="outline"
						size="icon-sm"
						aria-pressed={focusMode}
						aria-label={focusMode ? "Exit focus" : "Focus"}
						title={focusMode ? "Exit focus" : "Focus"}
						onClick={() => onFocusModeChange(!focusMode)}
					>
						{focusMode ? <ArrowsIn size={14} /> : <ArrowsOut size={14} />}
						<span className="sr-only">
							{focusMode ? "Exit focus" : "Focus"}
						</span>
					</Button>
				</OutputWorkshopActions>
			</OutputWorkshopCommandBar>
			{detail.isPending && <ListSkeleton rows={2} />}
			{detail.isError && (
				<Alert variant="destructive">
					<AlertTitle>The document is unavailable</AlertTitle>
					<AlertDescription>{(detail.error as Error).message}</AlertDescription>
				</Alert>
			)}
			{blocked && (
				<Alert variant="warning">
					<AlertTitle>Editing is paused</AlertTitle>
					<AlertDescription>{blocked.message}</AlertDescription>
				</Alert>
			)}
			{(recoveryRequired || (!isGadget && outputDraftIssue)) &&
				canonicalDoc &&
				roomCanonical && (
					<CanvasDocumentRecovery
						draftText={docText}
						savedText={canonicalDoc.text}
						revision={canonicalDoc.revision}
						outputKind={outputKind}
						isGadget={isGadget}
						invalidDraft={!!outputDraftIssue}
						disabled={!live || unacknowledged || unsynced}
						onReplace={replaceWithCanonical}
					/>
				)}
			{discarded > 0 && (
				<Alert variant="warning">
					<AlertTitle>Unsent edits were discarded</AlertTitle>
					<AlertDescription>
						The live draft was rebuilt from the room and edits that had not
						reached the server were lost. The document below is what every
						connected editor now sees.
					</AlertDescription>
				</Alert>
			)}
			{!isGadget && outputDraftIssue && (
				<Alert variant="warning">
					<AlertTitle>
						{outputDraftIssue === "invalid_json"
							? `The shared ${outputKindLabel.toLowerCase()} draft is not valid JSON`
							: outputDraftIssue === "wrong_kind"
								? `The shared draft is not a ${outputKind}`
								: `The shared ${outputKindLabel.toLowerCase()} draft cannot be opened`}
					</AlertTitle>
					<AlertDescription>
						This draft contains content the editor cannot open. The saved
						version is unchanged. Use the recovery controls above to download
						the draft and restore the saved version.
					</AlertDescription>
				</Alert>
			)}
			{session && isGadget ? (
				<div
					className="grid min-w-0 gap-3"
					style={
						gadgetWidgetTarget && effectiveGadgetView === "preview"
							? {
									display: "flex",
									flexDirection: "column",
									flex: "1 1 0px",
									minHeight: 0,
								}
							: undefined
					}
				>
					{gadgetWidgetTarget && gadgetViewOverride === undefined && (
						<SegmentedControl
							ariaLabel="Gadget view"
							compact
							onValueChange={setGadgetView}
							options={GADGET_VIEW_OPTIONS}
							value={gadgetView}
						/>
					)}
					{gadgetWidgetTarget && effectiveGadgetView === "preview" ? (
						<Card
							data-canvas-gadget-preview
							size="sm"
							tone="raised"
							className="flex min-h-0 flex-1 flex-col"
						>
							<CardContent className="flex min-h-0 flex-1 flex-col gap-3">
								{/* A gadget with an active review link opens on the same
								    review app recipients use; its own app stays available. */}
								<WorkspaceGadgetReview
									workspaceId={workspaceId}
									gadgetId={doc.id}
									gadget={
										<>
											<div className="flex flex-wrap items-center gap-2">
												<Badge variant="secondary">Committed preview</Badge>
												<Text as="span" role="label" tone="secondary">
													Commit source changes to refresh this runnable view.
												</Text>
											</div>
											<WidgetFrame
												layout="fill"
												appSlug={gadgetWidgetTarget.appSlug}
												resourceUri={gadgetWidgetTarget.resourceUri}
												title={title ?? "Canvas Gadget"}
												onFollowUp={onWidgetFollowUp}
												toolInput={previewExecution?.input ?? undefined}
												toolResult={
													previewExecution
														? gadgetExecutionToolResult(previewExecution)
														: undefined
												}
											/>
										</>
									}
								/>
							</CardContent>
						</Card>
					) : effectiveGadgetView === "runs" && executionGadgetId ? (
						<CanvasGadgetExecutions
							key={`${workspaceId}:${executionGadgetId}`}
							workspaceId={workspaceId}
							gadgetId={executionGadgetId}
							exportDescriptors={
								gadgetDetail.data?.currentRevision?.manifest.exports ?? []
							}
							exportRevision={gadgetDetail.data?.currentRevision?.revision}
							onSelectedExecutionChange={setPreviewExecution}
						/>
					) : (
						<Surface
							className="canvas-code-workbench"
							data-canvas-code-workbench
						>
							<aside className="canvas-code-files" aria-label="Code files">
								<Text
									as="h3"
									role="label"
									tone="secondary"
									className="m-0 px-3 py-2"
								>
									Files
								</Text>
								<Button
									variant="secondary"
									className="w-full justify-start"
									aria-current="page"
								>
									manifest.json
								</Button>
								<Text
									as="p"
									role="label"
									tone="secondary"
									className="px-3 leading-relaxed"
								>
									Gadget configuration. App code is managed by the referenced
									widget provider.
								</Text>
							</aside>
							<div className="canvas-code-file">
								<div className="canvas-code-file-header">
									<Text as="span" role="label" tone="secondary">
										Editing <code>manifest.json</code>
									</Text>
									<Badge variant="secondary">JSON</Badge>
								</div>
								<CanvasCodeEditor
									session={session}
									path={COLLAB_DOC_PATH}
									readOnly={!live}
								/>
							</div>
						</Surface>
					)}
				</div>
			) : session && !isGadget && outputDraft ? (
				<OutputEditor
					value={outputDraft}
					onChange={updateSharedOutput}
					disabled={!live}
				/>
			) : (
				<ListSkeleton rows={1} rowClassName="h-64" />
			)}
			<OutputWorkshopFooter className="canvas-document-footer justify-end">
				{unacknowledged && live && !recoveryRequired && (
					<span className="text-kumo-subtle text-xs" data-canvas-commit-waiting>
						{isGadget
							? UNACKNOWLEDGED_COMMIT_MESSAGE
							: "Syncing your latest edits… Save version is available once they reach the shared draft. If the connection drops first, they are discarded."}
					</span>
				)}
				{!confirming ? (
					<Button
						size="sm"
						disabled={commitDisabled}
						onClick={() => {
							setDraftError(null);
							setCommittedRevision(null);
							gadgetCommit.reset();
							reviseOutput.clearOutcome();
							setConfirming(true);
						}}
					>
						<FloppyDisk size={14} /> {isGadget ? "Commit" : "Save version"}
					</Button>
				) : (
					<>
						{!isGadget && (
							<Input
								aria-label="Revision note"
								placeholder="Revision note (optional)"
								value={note}
								onChange={(event) => setNote(event.target.value)}
								maxLength={2000}
								className="max-w-sm"
							/>
						)}
						<Button
							size="sm"
							disabled={committing || commitDisabled}
							onClick={commitDraft}
						>
							<FloppyDisk size={14} />{" "}
							{committing
								? "Saving…"
								: isGadget
									? "Commit revision"
									: "Save version now"}
						</Button>
						<Button
							variant="ghost"
							size="sm"
							disabled={committing}
							onClick={() => {
								setConfirming(false);
								setDraftError(null);
							}}
						>
							<X size={14} /> Cancel
						</Button>
					</>
				)}
				{committedRevision !== null && (
					<Text as="span" role="label" tone="secondary">
						{isGadget ? "Committed revision" : "Saved version"}{" "}
						{committedRevision}.
					</Text>
				)}
			</OutputWorkshopFooter>
			{draftError && (
				<Alert variant="destructive">
					<AlertTitle>The draft could not be saved</AlertTitle>
					<AlertDescription>{draftError}</AlertDescription>
				</Alert>
			)}
			{conflicted && (
				<Alert variant="destructive">
					<AlertTitle>Someone saved a newer revision</AlertTitle>
					<AlertDescription>
						Your draft is preserved. Review the updated version before saving
						again.
					</AlertDescription>
				</Alert>
			)}
			{failureMessage && (
				<Alert variant="destructive">
					<AlertTitle>Save failed</AlertTitle>
					<AlertDescription>{failureMessage}</AlertDescription>
				</Alert>
			)}
			{!isGadget && reviseOutput.outcome?.kind === "unchanged" && (
				<Alert>
					<AlertTitle>Already saved</AlertTitle>
					<AlertDescription>
						The draft matches the loaded revision exactly, so no new revision
						was recorded.
					</AlertDescription>
				</Alert>
			)}
			<CanvasProposals
				mergeBlockedReason={proposalMergeBlockedReason}
				workspaceId={workspaceId}
				documentType={doc.type}
				documentId={doc.id}
				onMerged={(revision) => {
					setCommittedRevision(revision);
					if (isGadget) {
						void queryClient.invalidateQueries({
							queryKey: canvasGadgetDetailQueryOptions(workspaceId, doc.id)
								.queryKey,
						});
					} else {
						void queryClient.invalidateQueries({
							queryKey: outputDetailQueryOptions(doc.id).queryKey,
						});
					}
				}}
			/>
		</div>
	);
}
