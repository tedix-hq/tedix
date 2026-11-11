import {
	WorkspaceAppRenderer,
	WorkspaceAppRunsInfo,
} from "@/components/workspace-app-renderer";
import { ArrowsIn, FloppyDisk, X } from "@phosphor-icons/react";
import { ShareButton } from "@/components/share-controls";
import type {
	OsGadgetExecution,
	OsGadgetManifest,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { isConflictError } from "@/components/blueprints-page";
import { CanvasCodeEditor } from "@/components/canvas-editor";
import { ChatMarkdown } from "@/components/chat-markdown";
import {
	CanvasGadgetExecutions,
	gadgetExecutionToolResult,
} from "@/components/canvas-gadget-executions";
import { CanvasPresence } from "@/components/canvas-presence";
import { CanvasDocumentRecovery } from "@/components/canvas-document-recovery";
import { CanvasProposals } from "@/components/canvas-proposals";
import {
	LoadError,
	Alert,
	AlertDescription,
	AlertTitle,
} from "@/components/kumo/alert";
import { Badge, type BadgeVariant } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Card, CardContent } from "@/components/kumo/card";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { Surface } from "@/components/kumo/surface";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopIdentity,
	OutputWorkshopStatus,
} from "@/components/output-workshop";
import { WidgetFrame } from "@/components/widget-frame";
import { AppRuntimePreview } from "@/components/app-runtime-panel";
import { KeepAliveSlot } from "@/components/keep-alive";
import { AppTranslateButton } from "@/components/app-translate-button";
import { appRuntimeSettings } from "@/lib/app-runtime-host";
import { useAppRuntimeTranslation } from "@/lib/app-runtime-translation";
import {
	AppRuntimeDrafts,
	useAppDrafts,
} from "@/components/app-runtime-drafts";
import { isAppDraftProposal } from "@/lib/app-runtime-drafts";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import { useMediaQuery } from "@/lib/use-media-query";
import { COLLAB_DOC_PATH } from "@/collab/protocol";
import { AppCodeDraftEditor } from "@/components/app-draft-editor";
import { CanvasCodeFiles } from "@/components/canvas-code-files";
import { osApi } from "@/lib/api";
import { parseDraft } from "@/lib/canvas-draft";
import { type CanvasDocSelection, canvasDocKey } from "@/lib/canvas-search";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { sameDraftText } from "@/collab/ot/draft-equivalence";
import { sentenceCase } from "@/lib/format";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";
import {
	appRuntimeCodeQueryOptions,
	workAppsQueryOptions,
	canvasGadgetDetailQueryOptions,
	canvasGadgetsQueryOptions,
} from "@/lib/os-query-options";
import {
	type CollabCommitBasis,
	type CollabDocCanonical,
	useCollabDoc,
} from "@/lib/use-collab-doc";
import { workspaceAppReadme } from "@/lib/workspace-apps";

/**
 * The Canvas document panel: the gadget-detail domain owner, the app editor
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
	"Sending your latest edits… Save will be available when they arrive. If the connection drops first, they are discarded.";

/** A gadget with no revision yet seeds the smallest committable manifest. */
const DEFAULT_GADGET_MANIFEST: OsGadgetManifest = {
	capabilities: [],
	entry: "main.tsx",
};

/**
 * The Code view starts with a generated README and manifest; runtime apps
 * append their revision's source files.
 */
const APP_CODE_FILES = [
	{
		path: "README.md",
		hint: "What the app shows, how people use it, what it connects to and where its code lives. Generated from manifest.json.",
	},
	{
		path: "manifest.json",
		hint: "The app's settings, connections and notes.",
	},
] as const;

const GADGET_VIEW_OPTIONS: readonly {
	value: "preview" | "source" | "drafts" | "runs";
	label: ReactNode;
}[] = [
	{ value: "preview", label: "App" },
	{ value: "source", label: "Code" },
	{ value: "runs", label: "Runs" },
];

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
	onAppDraftSaved,
	onOpenDrafts,
	onAppDraftMerged,
	focusMode,
	onFocusModeChange,
	onShare,
	onShowResources,
	onWidgetFollowUp,
	actionsSlot,
}: {
	workspaceId: string;
	doc: Extract<CanvasDocSelection, { type: "gadget" }>;
	/**
	 * The host's view of an app. "source" is the host's Edit view, where the
	 * app's waiting drafts render above its code.
	 */
	gadgetViewOverride?: "preview" | "source" | "drafts" | "runs";
	onAppDraftSaved?: () => void;
	/** Opens the host's Edit view from the App view's drafts banner. */
	onOpenDrafts?: () => void;
	/** A draft accepted in the host's Edit view: show the app it became. */
	onAppDraftMerged?: () => void;
	focusMode: boolean;
	/**
	 * The tab row's action area. An app's status and actions render there, so
	 * the app view has one toolbar; without a slot (or in focus mode, where the
	 * tab row is hidden) they stay in this panel's own header.
	 */
	actionsSlot?: HTMLElement | null;
	onFocusModeChange: (focused: boolean) => void;
	/** Opens the workspace Share dialog; focus mode hides the top bar's. */
	onShare?: () => void;
	onShowResources: () => void;
	onWidgetFollowUp?: (message: string) => void;
}) {
	const queryClient = useQueryClient();
	const gadgetDetail = useQuery(
		canvasGadgetDetailQueryOptions(workspaceId, doc.id),
	);
	const builtinManifestEarly = gadgetDetail.data?.currentRevision?.manifest;
	const detail = gadgetDetail;
	const title = gadgetDetail.data?.gadget.name;

	// Canonical truth as this client just loaded it: the text and which revision
	// it is. A room with no base yet is seeded from it; an already-grounded room
	// on an older revision is offered it, and the server decides.
	const canonicalDoc: CollabDocCanonical | null = gadgetDetail.data
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
		: null;

	const {
		session,
		status,
		tooLarge,
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

	const [confirming, setConfirming] = useState(false);
	const saveFooter = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (confirming) saveFooter.current?.scrollIntoView?.({ block: "nearest" });
	}, [confirming]);
	const [draftError, setDraftError] = useState<string | null>(null);
	const [committedRevision, setCommittedRevision] = useState<number | null>(
		null,
	);
	const [gadgetView, setGadgetView] = useState<
		"preview" | "source" | "drafts" | "runs"
	>("preview");
	const [codeFile, setCodeFile] = useState<string>("manifest.json");
	const isRuntimeApp = isAppRuntimeManifest(builtinManifestEarly);
	// Drafts of a runtime app: the tab exists only while there is one to review.
	const appDrafts = useAppDrafts(workspaceId, doc.id, isRuntimeApp);
	const effectiveGadgetView =
		gadgetViewOverride ??
		(gadgetView === "drafts" && appDrafts.length === 0
			? "preview"
			: gadgetView);
	const gadgetViewOptions = useMemo(
		() =>
			isRuntimeApp && appDrafts.length > 0
				? [
						...GADGET_VIEW_OPTIONS.slice(0, 2),
						{
							value: "drafts" as const,
							label: (
								<span className="inline-flex items-center gap-1.5">
									Drafts
									<Badge variant="info">{appDrafts.length}</Badge>
								</span>
							),
						},
						...GADGET_VIEW_OPTIONS.slice(2),
					]
				: GADGET_VIEW_OPTIONS,
		[appDrafts.length, isRuntimeApp],
	);
	const runtimeSettings = useMemo(
		() => appRuntimeSettings(isRuntimeApp ? builtinManifestEarly : undefined),
		[builtinManifestEarly, isRuntimeApp],
	);
	const translation = useAppRuntimeTranslation(runtimeSettings);
	// A runtime app fills the stage beside the chat; on a phone the panel
	// scrolls, so the app takes its own content height instead.
	const runtimeAppFills = useMediaQuery("(min-width: 960px)") && isRuntimeApp;
	const runtimeCode = useQuery({
		...appRuntimeCodeQueryOptions(
			workspaceId,
			doc.id,
			gadgetDetail.data?.currentRevision?.id,
		),
		enabled: isRuntimeApp,
	});
	/** The Code view lists the generated README, the manifest, then the app's own files. */
	const codeFiles = useMemo(
		() => [
			...APP_CODE_FILES,
			...Object.keys(runtimeCode.data?.code?.files ?? {})
				.filter((path) => path !== "README.md")
				.map((path) => ({
					path,
					hint: "Edit app code and save as a draft for review and preview.",
				})),
		],
		[runtimeCode.data],
	);
	const appReadme = useMemo(
		() =>
			gadgetDetail.data
				? workspaceAppReadme({
						name: gadgetDetail.data.gadget.name,
						description: gadgetDetail.data.gadget.description,
						manifest: gadgetDetail.data.currentRevision?.manifest,
					})
				: "",
		[gadgetDetail.data],
	);
	// Unsaved edits to a runtime app's files, so Download saves what is on screen.
	const editedCodeTexts = useRef<Record<string, string> | null>(null);
	const setEditedCodeTexts = useCallback(
		(texts: Record<string, string> | null) => {
			editedCodeTexts.current = texts;
		},
		[],
	);
	const [previewExecution, setPreviewExecution] =
		useState<OsGadgetExecution | null>(null);

	// The newer saved version the user chose to save their changes on top of.
	// Only that exact version: a later one reopens the choice.
	const [keptChangesOver, setKeptChangesOver] = useState<number | null>(null);
	const keepingChanges =
		recoveryRequired &&
		canonicalDoc !== null &&
		keptChangesOver === canonicalDoc.revision;
	// The room's stamp, not the query's (see this module's header) -- unless the
	// user explicitly chose to keep their changes over the newer version, which
	// is then the version this save must replace.
	const expectedRevision =
		keepingChanges && canonicalDoc
			? canonicalDoc.revision
			: (roomCanonical?.revision ?? 0);

	const gadgetCommit = useMutation({
		mutationFn: (variables: {
			manifest: OsGadgetManifest;
			basis: CollabCommitBasis;
		}) =>
			osApi.osWorkspaces.gadgets.revise({
				workspaceId,
				gadgetId: doc.id,
				manifest: variables.manifest,
				expectedRevision,
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
			queryClient.invalidateQueries(workAppsQueryOptions());
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

	/** Saves the shared manifest draft as an app version. */
	const commitDraft = () => {
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
		gadgetCommit.mutate({
			manifest: parsed.value as OsGadgetManifest,
			basis,
		});
	};

	const committing = gadgetCommit.isPending;
	const conflicted =
		gadgetCommit.isError && isConflictError(gadgetCommit.error);
	const failureMessage =
		gadgetCommit.isError && !isConflictError(gadgetCommit.error)
			? (gadgetCommit.error as Error).message
			: null;
	const draftParsed = parseDraft(docText);
	const savedParsed = canonicalDoc ? parseDraft(canonicalDoc.text) : null;
	// View state (a deck's `activeSlideId`) is not an unsaved change; the room
	// applies the same rule when it decides whether a newer version may load.
	const draftMatchesSaved =
		draftParsed.ok &&
		savedParsed?.ok &&
		(canonicalJsonText(draftParsed.value) ===
			canonicalJsonText(savedParsed.value) ||
			sameDraftText(canonicalDoc!.text, docText));
	const proposalMergeBlockedReason = !live
		? "Reconnect before applying a proposal."
		: recoveryRequired
			? "A newer version was saved. Load it or keep your changes first."
			: unsynced || unacknowledged || committing
				? "Wait for your changes to finish syncing and saving."
				: !draftMatchesSaved
					? "Save your draft as a version before applying a proposal."
					: undefined;
	// A runtime app draft replaces the manifest and the files together, so only
	// unsaved manifest.json edits in this room hold it back.
	const appDraftMergeBlockedReason =
		unsynced || unacknowledged || committing
			? "Wait for your changes to finish syncing and saving."
			: live && (recoveryRequired || !draftMatchesSaved)
				? "Save or discard your manifest.json changes before accepting a draft."
				: undefined;
	const onProposalMerged = (revision: number) => {
		setCommittedRevision(revision);
		void queryClient.invalidateQueries({
			queryKey: canvasGadgetDetailQueryOptions(workspaceId, doc.id).queryKey,
		});
	};
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
		(recoveryRequired && !keepingChanges) ||
		unacknowledged;
	const documentSaveStatus = detail.isError
		? "Unavailable"
		: tooLarge
			? "Read-only"
			: !live
				? status === "connecting"
					? "Connecting…"
					: "Disconnected · Changes paused"
				: recoveryRequired && canonicalDoc
					? `Newer version saved (v${canonicalDoc.revision})`
					: committing
						? "Saving version…"
						: unsynced || unacknowledged
							? "Syncing changes…"
							: draftMatchesSaved
								? committedRevision !== null
									? `Saved version ${committedRevision}`
									: "Saved"
								: "Not saved yet";
	const revisionLabel = gadgetDetail.data
		? gadgetDetail.data.currentRevision
			? `App version ${gadgetDetail.data.currentRevision.revision}`
			: "No app version yet"
		: null;
	const gadgetWidgetTarget = gadgetWidgetTargetFromManifest(
		gadgetDetail.data?.currentRevision?.manifest,
	);
	const builtinManifest = gadgetDetail.data?.currentRevision?.manifest;
	const builtinAppView =
		builtinManifest?.entry.trim().startsWith("tedix:app/") &&
		effectiveGadgetView === "preview";
	// The room below syncs the app's code, not what the app edits. A runtime app
	// (Doc, Sheet, Slides) saves its own content, so in App view the room's
	// connection and draft status would describe something the user is not
	// editing; a reconnect between attempts would read as "Disconnected".
	const manifestStatusHidden =
		builtinAppView || (isRuntimeApp && effectiveGadgetView === "preview");
	const executionGadgetId = doc.id;
	// The host's Edit and History views own the whole pane: no inset, no card.
	const flushView =
		gadgetViewOverride !== undefined &&
		!builtinAppView &&
		(session !== null || isRuntimeApp) &&
		(effectiveGadgetView === "source" || effectiveGadgetView === "runs");
	/** A file's text as shown in the Edit view, for Download. */
	const codeFileText = (path: string) => {
		const files = runtimeCode.data?.code?.files ?? {};
		if (path === "README.md" && !Object.hasOwn(files, path)) return appReadme;
		const edited = editedCodeTexts.current?.[path];
		if (edited !== undefined) return edited;
		if (path !== "manifest.json") return files[path] ?? "";
		if (session && !isRuntimeApp) return docText;
		return gadgetDetail.data?.currentRevision
			? canonicalJsonText(gadgetDetail.data.currentRevision.manifest)
			: "";
	};
	useEffect(() => {
		setPreviewExecution(null);
	}, [doc.id, workspaceId]);

	const beginSave = () => {
		setDraftError(null);
		setCommittedRevision(null);
		gadgetCommit.reset();
		setConfirming(true);
	};

	const gadgetActionsInSlot = !focusMode && actionsSlot ? actionsSlot : null;
	const documentStatusActions = (
		<>
			{/* A built-in or runtime app saves its own content; the manifest's
				    draft and sync status belongs to the Code view only. */}
			<OutputWorkshopStatus
				className={
					manifestStatusHidden
						? "canvas-document-status hidden!"
						: "canvas-document-status"
				}
			>
				{detail.data && !detail.isError && (
					<>
						{status !== "connected" && (
							<ConnectionChip status={status} peers={peers} />
						)}
						{/* Who is here shows once, in the workspace top bar; focus
						    mode hides that bar, so the open item shows it instead. */}
						{focusMode && <CanvasPresence participants={participants ?? []} />}
					</>
				)}
				<span className="sr-only" data-canvas-revision-status>
					{revisionLabel}
				</span>
				{recoveryRequired && canonicalDoc && live ? (
					<Button
						size="xs"
						variant="outline"
						data-canvas-newer-version
						onClick={() =>
							document
								.querySelector<HTMLElement>("[data-canonical-recovery]")
								?.focus()
						}
					>
						{documentSaveStatus}
					</Button>
				) : !unsynced ? null : (
					<Badge
						variant="warning"
						title={`${revisionLabel ?? "No saved version"} · Edits are shared live. Save a version to keep them.`}
					>
						Draft · Syncing…
					</Badge>
				)}
			</OutputWorkshopStatus>
			<OutputWorkshopActions className="canvas-document-actions">
				{isRuntimeApp && effectiveGadgetView === "preview" && (
					<AppTranslateButton translation={translation} compact />
				)}
				{/* Entering focus is a workspace top-bar control; leaving it has
				    to live here, where the top bar is hidden. */}
				{focusMode && onShare && <ShareButton compact onClick={onShare} />}
				{focusMode && (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Exit focus"
						title="Exit focus"
						onClick={() => onFocusModeChange(false)}
					>
						<ArrowsIn size={16} />
						<span className="sr-only">Exit focus</span>
					</Button>
				)}
			</OutputWorkshopActions>
		</>
	);

	// A gadget saves beside the manifest its Code view edits.
	const saveControls = (
		<>
			{unacknowledged && live && !recoveryRequired && (
				<span className="text-kumo-subtle text-xs" data-canvas-commit-waiting>
					{UNACKNOWLEDGED_COMMIT_MESSAGE}
				</span>
			)}
			{!confirming ? (
				<Button size="sm" disabled={commitDisabled} onClick={beginSave}>
					<FloppyDisk size={14} />{" "}
					{keepingChanges && canonicalDoc
						? `Save as v${canonicalDoc.revision + 1}`
						: "Save"}
				</Button>
			) : (
				<>
					<Button
						size="sm"
						disabled={committing || commitDisabled}
						onClick={() => void commitDraft()}
					>
						<FloppyDisk size={14} />{" "}
						{committing
							? "Saving…"
							: keepingChanges && canonicalDoc
								? `Save as v${canonicalDoc.revision + 1} now`
								: "Save now"}
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
					Saved version {committedRevision}.
				</Text>
			)}
		</>
	);

	return (
		<div
			className="canvas-document-shell grid min-w-0 content-start gap-0"
			data-canvas-flush={flushView ? "" : undefined}
			style={
				(gadgetWidgetTarget || runtimeAppFills) &&
				effectiveGadgetView === "preview"
					? {
							display: "flex",
							flexDirection: "column",
							height: "100%",
							minHeight: 0,
						}
					: undefined
			}
		>
			{gadgetActionsInSlot ? (
				createPortal(documentStatusActions, gadgetActionsInSlot)
			) : (
				<OutputWorkshopCommandBar className="canvas-document-header">
					<OutputWorkshopIdentity className="canvas-document-identity">
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
					</OutputWorkshopIdentity>
					{documentStatusActions}
				</OutputWorkshopCommandBar>
			)}
			{detail.isPending && <ListSkeleton rows={2} />}
			{detail.isError && (
				<LoadError
					title="The document is unavailable"
					error={detail.error}
					onRetry={() => {
						void detail.refetch();
					}}
					retrying={detail.isFetching}
					help={
						(detail.error as Error).message ===
						"Output source access is unavailable"
							? "This document uses restricted sources. Workspace access does not grant access to those sources. Ask the document owner for a version they can share with you."
							: undefined
					}
				/>
			)}
			{blocked && (
				<Alert variant="warning">
					<AlertTitle>Editing is paused</AlertTitle>
					<AlertDescription>{blocked.message}</AlertDescription>
				</Alert>
			)}
			{recoveryRequired && canonicalDoc && roomCanonical && (
				<CanvasDocumentRecovery
					draftText={docText}
					revision={canonicalDoc.revision}
					keptChanges={keepingChanges}
					disabled={!live || unacknowledged || unsynced}
					onReplace={replaceWithCanonical}
					onKeepChanges={() => setKeptChangesOver(canonicalDoc.revision)}
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
			{builtinAppView ? (
				<div className="grid min-w-0 gap-3" data-canvas-builtin-app>
					{gadgetViewOverride === undefined && (
						<SegmentedControl
							ariaLabel="App view"
							compact
							onValueChange={setGadgetView}
							options={GADGET_VIEW_OPTIONS}
							value={gadgetView}
						/>
					)}
					<WorkspaceAppRenderer
						key={gadgetDetail.data?.currentRevision?.id}
						manifest={builtinManifest!}
						workspaceId={workspaceId}
					/>
				</div>
			) : session || isRuntimeApp ? (
				// A runtime app's live view, files and drafts come from its revision,
				// so they render before (or without) the editing room; only the
				// manifest editor needs the room.
				<div
					className={
						flushView ? "canvas-flush-body min-w-0" : "grid min-w-0 gap-3"
					}
					style={
						(gadgetWidgetTarget || runtimeAppFills) &&
						effectiveGadgetView === "preview"
							? {
									display: "flex",
									flexDirection: "column",
									flex: "1 1 0px",
									minHeight: 0,
								}
							: undefined
					}
				>
					{(gadgetWidgetTarget ||
						isRuntimeApp ||
						builtinManifest?.entry.trim().startsWith("tedix:app/")) &&
						gadgetViewOverride === undefined && (
							<SegmentedControl
								ariaLabel="App view"
								compact
								onValueChange={setGadgetView}
								options={gadgetViewOptions}
								value={effectiveGadgetView}
							/>
						)}
					{isRuntimeApp &&
						effectiveGadgetView === "preview" &&
						gadgetViewOverride !== undefined &&
						onOpenDrafts &&
						appDrafts.length > 0 && (
							<div
								className="canvas-drafts-banner"
								data-canvas-drafts-banner
								role="status"
							>
								<Text as="span" role="label">
									{appDrafts.length === 1
										? "1 change is waiting for your review."
										: `${appDrafts.length} changes are waiting for your review.`}
								</Text>
								<Button size="sm" variant="secondary" onClick={onOpenDrafts}>
									Review
								</Button>
							</div>
						)}
					{isRuntimeApp &&
					effectiveGadgetView === "preview" &&
					gadgetDetail.data?.currentRevision ? (
						// The app owns its surface: no card, edge to edge in the column.
						// Kept running while another tab or view is shown, so coming
						// back does not reload the app. One kept app per gadget: a new
						// revision replaces the old one instead of leaving it running hidden.
						<KeepAliveSlot
							id={`app:${workspaceId}:${gadgetDetail.data.gadget.id}`}
							data-canvas-gadget-preview
							data-canvas-runtime-app
							className={`canvas-runtime-app ${
								runtimeAppFills ? "flex min-h-0 flex-1 flex-col" : "grid"
							}`}
						>
							<AppRuntimePreview
								key={gadgetDetail.data.currentRevision.id}
								workspaceId={workspaceId}
								gadget={gadgetDetail.data.gadget}
								revision={gadgetDetail.data.currentRevision}
								layout={runtimeAppFills ? "fill" : "content"}
								translation={translation.channel}
							/>
						</KeepAliveSlot>
					) : isRuntimeApp &&
					  effectiveGadgetView === "drafts" &&
					  gadgetDetail.data?.currentRevision ? (
						<AppRuntimeDrafts
							workspaceId={workspaceId}
							gadget={gadgetDetail.data.gadget}
							revision={gadgetDetail.data.currentRevision}
							drafts={appDrafts}
							mergeBlockedReason={appDraftMergeBlockedReason}
							onMerged={(revision) => {
								onProposalMerged(revision);
								setGadgetView("preview");
							}}
						/>
					) : gadgetWidgetTarget && effectiveGadgetView === "preview" ? (
						<Card
							data-canvas-gadget-preview
							size="sm"
							tone="raised"
							className="flex min-h-0 flex-1 flex-col"
						>
							<CardContent className="flex min-h-0 flex-1 flex-col gap-3">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="secondary">Saved app</Badge>
									<Text as="span" role="label" tone="secondary">
										Save your changes to update the app.
									</Text>
								</div>
								<WidgetFrame
									layout="fill"
									appSlug={gadgetWidgetTarget.appSlug}
									resourceUri={gadgetWidgetTarget.resourceUri}
									title={title ?? "Canvas App"}
									onFollowUp={onWidgetFollowUp}
									toolInput={previewExecution?.input ?? undefined}
									toolResult={
										previewExecution
											? gadgetExecutionToolResult(previewExecution)
											: undefined
									}
								/>
							</CardContent>
						</Card>
					) : effectiveGadgetView === "runs" &&
					  builtinManifest?.entry.trim().startsWith("tedix:app/") &&
					  !gadgetDetail.data?.currentRevision?.manifest.skillSlug ? (
						<div className="canvas-flush-scroll">
							<WorkspaceAppRunsInfo
								manifest={builtinManifest!}
								onShowResources={onShowResources}
							/>
						</div>
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
						<>
							{/* The host's Edit view: what is waiting for review sits
							    above the code it changes. */}
							{isRuntimeApp &&
								gadgetViewOverride === "source" &&
								appDrafts.length > 0 &&
								gadgetDetail.data?.currentRevision && (
									<div className="canvas-code-drafts">
										<AppRuntimeDrafts
											workspaceId={workspaceId}
											gadget={gadgetDetail.data.gadget}
											revision={gadgetDetail.data.currentRevision}
											drafts={appDrafts}
											mergeBlockedReason={appDraftMergeBlockedReason}
											onMerged={(revision) => {
												onProposalMerged(revision);
												onAppDraftMerged?.();
											}}
										/>
									</div>
								)}
							<Surface
								className="canvas-code-workbench"
								data-canvas-code-workbench
							>
								<CanvasCodeFiles
									files={codeFiles}
									current={codeFile}
									onSelect={setCodeFile}
									textFor={codeFileText}
								/>
								{codeFile === "README.md" &&
								!Object.hasOwn(
									runtimeCode.data?.code?.files ?? {},
									"README.md",
								) ? (
									<div className="canvas-code-file" data-canvas-app-readme>
										<div className="canvas-code-file-header">
											<code className="canvas-code-file-name">README.md</code>
											<Text as="span" role="label" tone="secondary">
												Generated from manifest.json
											</Text>
										</div>
										<div className="overflow-y-auto px-4 py-3">
											<ChatMarkdown content={appReadme} />
										</div>
									</div>
								) : isRuntimeApp ? (
									<div className="canvas-code-file" data-canvas-app-code-file>
										{runtimeCode.data?.code &&
										gadgetDetail.data?.currentRevision ? (
											<AppCodeDraftEditor
												key={doc.id}
												workspaceId={workspaceId}
												gadgetId={doc.id}
												revisionId={runtimeCode.data.code.revisionId}
												content={{
													manifest: gadgetDetail.data.currentRevision.manifest,
													files: runtimeCode.data.code.files,
												}}
												selectedFile={codeFile}
												onTextsChange={setEditedCodeTexts}
												onSaved={() => {
													setGadgetView("drafts");
													onAppDraftSaved?.();
												}}
											/>
										) : (
											<Text as="p" role="label">
												{runtimeCode.error
													? "Could not load app code."
													: "Loading app code…"}
											</Text>
										)}
									</div>
								) : codeFile !== "manifest.json" ? (
									<div className="canvas-code-file" data-canvas-app-code-file>
										<div className="canvas-code-file-header">
											<code className="canvas-code-file-name">{codeFile}</code>
											<Text as="span" role="label" tone="secondary">
												Revision{" "}
												{runtimeCode.data?.code?.revision ??
													gadgetDetail.data?.currentRevision?.revision}
											</Text>
										</div>
										<pre className="m-0 overflow-auto px-4 py-3 text-xs leading-relaxed">
											{runtimeCode.data?.code?.files[codeFile] ?? ""}
										</pre>
									</div>
								) : (
									<div className="canvas-code-file">
										<div className="canvas-code-file-header">
											<code className="canvas-code-file-name">
												manifest.json
											</code>
											<div
												ref={saveFooter}
												className="canvas-code-file-actions"
												data-canvas-code-save
											>
												{saveControls}
											</div>
										</div>
										{session ? (
											<CanvasCodeEditor
												session={session}
												path={COLLAB_DOC_PATH}
												readOnly={!live}
											/>
										) : (
											<pre
												className="m-0 overflow-auto px-4 py-3 text-xs leading-relaxed"
												data-canvas-app-manifest-readonly
											>
												{gadgetDetail.data?.currentRevision
													? canonicalJsonText(
															gadgetDetail.data.currentRevision.manifest,
														)
													: ""}
											</pre>
										)}
									</div>
								)}
							</Surface>
						</>
					)}
				</div>
			) : (
				<ListSkeleton rows={1} rowClassName="h-64" />
			)}
			{draftError && (
				<Alert variant="destructive">
					<AlertTitle>The draft could not be saved</AlertTitle>
					<AlertDescription>{draftError}</AlertDescription>
				</Alert>
			)}
			{conflicted && (
				<Alert variant="destructive">
					<AlertTitle>Someone saved a newer version</AlertTitle>
					<AlertDescription>
						Your changes were not saved and are still here.
					</AlertDescription>
				</Alert>
			)}
			{failureMessage && (
				<Alert variant="destructive">
					<AlertTitle>Save failed</AlertTitle>
					<AlertDescription>{failureMessage}</AlertDescription>
				</Alert>
			)}
			<CanvasProposals
				mergeBlockedReason={proposalMergeBlockedReason}
				workspaceId={workspaceId}
				documentType={doc.type}
				documentId={doc.id}
				exclude={isRuntimeApp ? isAppDraftProposal : undefined}
				onMerged={onProposalMerged}
			/>
		</div>
	);
}
