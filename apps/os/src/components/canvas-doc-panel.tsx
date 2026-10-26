import {
	WorkspaceAppRenderer,
	WorkspaceAppRunsInfo,
} from "@/components/workspace-app-renderer";
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
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isConflictError } from "@/components/blueprints-page";
import { CanvasCodeEditor } from "@/components/canvas-editor";
import { ChatMarkdown } from "@/components/chat-markdown";
import {
	CanvasGadgetExecutions,
	gadgetExecutionToolResult,
} from "@/components/canvas-gadget-executions";
import { CanvasOutputTitle } from "@/components/canvas-output-title";
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
import { OutputContentView } from "@/components/output-content";
import { OutputExportButtons } from "@/components/output-export-buttons";
import {
	OutputWorkshopActions,
	OutputWorkshopCommandBar,
	OutputWorkshopFooter,
	OutputWorkshopIdentity,
	OutputWorkshopStatus,
} from "@/components/output-workshop";
import { ShareControls } from "@/components/share-controls";
import { WidgetFrame } from "@/components/widget-frame";
import { AppRuntimePreview } from "@/components/app-runtime-panel";
import {
	AppRuntimeDrafts,
	useAppDrafts,
} from "@/components/app-runtime-drafts";
import { isAppDraftProposal } from "@/lib/app-runtime-drafts";
import { mergeAppPresence, useAppPresence } from "@/lib/app-runtime-presence";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import { useMediaQuery } from "@/lib/use-media-query";
import { diffFiles } from "@/collab/ot/code-change";
import { COLLAB_DOC_PATH } from "@/collab/protocol";
import { AppCodeDraftEditor } from "@/components/app-draft-editor";
import { osApi } from "@/lib/api";
import {
	outputKindError,
	parseDraft,
	parseOutputDraft,
} from "@/lib/canvas-draft";
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
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	type CollabCommitBasis,
	type CollabDocCanonical,
	useCollabDoc,
} from "@/lib/use-collab-doc";
import { useReviseOutput } from "@/lib/use-revise-output";
import { workspaceAppReadme } from "@/lib/workspace-apps";
import { useDocumentCollab } from "@/lib/use-document-collab";

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

/** What others see next to a person's name in a runtime app's presence. */
const GADGET_VIEW_LABELS = {
	preview: "App",
	source: "Code",
	drafts: "Drafts",
	runs: "Runs",
} as const;

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
	onOpenReview,
	focusMode,
	onFocusModeChange,
	onShowResources,
	onWidgetFollowUp,
	actionsSlot,
}: {
	workspaceId: string;
	doc: CanvasDocSelection;
	gadgetViewOverride?: "preview" | "source" | "drafts" | "runs";
	onAppDraftSaved?: () => void;
	/** Opens this app's Review tab. */
	onOpenReview?: () => void;
	focusMode: boolean;
	/**
	 * The tab row's action area. An app's status and actions render there, so
	 * the app view has one toolbar; without a slot (or in focus mode, where the
	 * tab row is hidden) they stay in this panel's own header.
	 */
	actionsSlot?: HTMLElement | null;
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
	const builtinManifestEarly = gadgetDetail.data?.currentRevision?.manifest;
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
		setSelection,
		retry,
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
	// Parse once per document text: re-parsing (and re-validating) a large
	// workbook on every render also gave editors a fresh object each time,
	// defeating their memoization.
	const outputParsed = useMemo(
		() =>
			!isGadget && outputKind && docText !== ""
				? parseOutputDraft(docText, outputKind)
				: null,
		[isGadget, outputKind, docText],
	);
	const outputDraft = outputParsed?.ok ? outputParsed.content : null;
	const documentCollab = useDocumentCollab({
		session,
		enabled: outputKind === "document",
		participants,
		setSelection,
	});
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
	const saveFooter = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (confirming) saveFooter.current?.scrollIntoView?.({ block: "nearest" });
	}, [confirming]);
	// Discarding unsaved changes asks once before it reloads the saved version.
	const [discarding, setDiscarding] = useState<"confirm" | "busy" | null>(null);
	const [discardError, setDiscardError] = useState<string | null>(null);
	const [note, setNote] = useState("");
	const [draftError, setDraftError] = useState<string | null>(null);
	const [committedRevision, setCommittedRevision] = useState<number | null>(
		null,
	);
	const [gadgetView, setGadgetView] = useState<
		"preview" | "source" | "drafts" | "runs"
	>("preview");
	const [codeFile, setCodeFile] = useState<string>("manifest.json");
	const isRuntimeApp = isGadget && isAppRuntimeManifest(builtinManifestEarly);
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
	const appParticipants = useAppPresence({
		workspaceId,
		gadgetId: doc.id,
		revision: gadgetDetail.data?.currentRevision,
		appName: gadgetDetail.data?.gadget.name,
		view: GADGET_VIEW_LABELS[effectiveGadgetView],
		enabled: isRuntimeApp,
	});
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
	const [previewExecution, setPreviewExecution] =
		useState<OsGadgetExecution | null>(null);

	const reviseOutput = useReviseOutput(isGadget ? "" : doc.id);
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
			expectedRevision,
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
		if (isGadget) {
			void queryClient.invalidateQueries({
				queryKey: canvasGadgetDetailQueryOptions(workspaceId, doc.id).queryKey,
			});
		} else {
			void queryClient.invalidateQueries({
				queryKey: outputDetailQueryOptions(doc.id).queryKey,
			});
		}
	};
	const documentSaveStatus = detail.isError
		? "Unavailable"
		: !live
			? status === "connecting"
				? "Connecting…"
				: "Disconnected · Changes paused"
			: recoveryRequired && canonicalDoc
				? `Newer version saved (v${canonicalDoc.revision})`
				: outputDraftIssue
					? "Draft can't be opened"
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
	const builtinManifest = isGadget
		? gadgetDetail.data?.currentRevision?.manifest
		: undefined;
	const builtinAppView =
		builtinManifest?.entry.trim().startsWith("tedix:app/") &&
		effectiveGadgetView === "preview";
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
		(recoveryRequired && !keepingChanges) ||
		unacknowledged ||
		outputDraftIssue !== null;
	const saveBlockedReason = !detail.data
		? "The saved version is still loading."
		: !session || !live
			? "Reconnect before saving a version."
			: roomCanonical === null
				? "The shared draft is still loading."
				: outputDraftIssue
					? "The shared draft cannot be opened. Download a copy or load the saved version."
					: recoveryRequired && !keepingChanges
						? "Choose whether to keep your changes or load the newer version."
						: unacknowledged
							? "Wait for your latest edits to reach the shared draft."
							: undefined;
	const beginSave = () => {
		setDraftError(null);
		setCommittedRevision(null);
		gadgetCommit.reset();
		reviseOutput.clearOutcome();
		setConfirming(true);
	};

	const gadgetActionsInSlot =
		isGadget && !focusMode && actionsSlot ? actionsSlot : null;
	const documentStatusActions = (
		<>
			{/* A built-in app saves each action itself; the manifest's draft and
				    sync status belongs to the Code view only. */}
			<OutputWorkshopStatus
				className={
					builtinAppView
						? "canvas-document-status hidden!"
						: "canvas-document-status"
				}
			>
				{detail.data && !detail.isError && (
					<>
						{status !== "connected" && (
							<ConnectionChip status={status} peers={peers} />
						)}
						<CanvasPresence
							participants={
								isRuntimeApp
									? mergeAppPresence(appParticipants, participants ?? [])
									: (participants ?? [])
							}
						/>
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
				) : isGadget && !unsynced ? null : (
					<Badge
						className={
							documentSaveStatus === "Saved" && !isGadget
								? "bg-transparent! text-kumo-subtle!"
								: undefined
						}
						variant={unsynced ? "warning" : "info"}
						title={`${revisionLabel ?? "No canonical revision"}. Changes sync with connected editors. Save version records them in version history.`}
					>
						{isGadget ? "Draft · Syncing…" : documentSaveStatus}
					</Badge>
				)}
			</OutputWorkshopStatus>
			<OutputWorkshopActions className="canvas-document-actions">
				{!isGadget && !confirming && (
					<Button
						size="sm"
						disabled={commitDisabled}
						title={saveBlockedReason ?? "Review and save this version."}
						aria-description={saveBlockedReason}
						aria-label={
							keepingChanges && canonicalDoc
								? `Save as v${canonicalDoc.revision + 1}`
								: "Save version"
						}
						onClick={beginSave}
						data-canvas-save-version
					>
						<FloppyDisk size={14} />{" "}
						{keepingChanges && canonicalDoc
							? `Save as v${canonicalDoc.revision + 1}`
							: "Save version"}
					</Button>
				)}
				{isGadget && gadgetDetail.data && (
					<ShareControls
						resourceType="gadget"
						resourceId={gadgetDetail.data.gadget.id}
						currentRevisionId={gadgetDetail.data.currentRevision?.id}
						workspaceId={workspaceId}
						guestEntry={isRuntimeApp}
						onOpenReview={onOpenReview}
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
							workspaceId={workspaceId}
							compact
						/>
					</>
				)}
				<Button
					variant="ghost"
					size="icon-sm"
					className="canvas-mobile-resources-button"
					aria-label="Resources"
					title="Resources"
					onClick={onShowResources}
				>
					<SidebarSimple size={16} />
					<span className="sr-only">Resources</span>
				</Button>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-pressed={focusMode}
					aria-label={focusMode ? "Exit focus" : "Focus"}
					title={focusMode ? "Exit focus" : "Focus"}
					onClick={() => onFocusModeChange(!focusMode)}
				>
					{focusMode ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}
					<span className="sr-only">{focusMode ? "Exit focus" : "Focus"}</span>
				</Button>
			</OutputWorkshopActions>
		</>
	);

	// Save sits where it acts: in the output footer, or beside the manifest an
	// app's Code view edits. Other app views have nothing for it to save.
	const discardOffered =
		!isGadget &&
		live &&
		canonicalDoc &&
		!draftMatchesSaved &&
		!recoveryRequired &&
		!outputDraftIssue &&
		!confirming &&
		!committing;
	const outputFooterShown =
		!isGadget &&
		(confirming ||
			discardOffered ||
			discardError !== null ||
			(unacknowledged && live && !recoveryRequired) ||
			committedRevision !== null);
	const saveControls = (
		<>
			{discardOffered &&
				canonicalDoc &&
				(discarding === null ? (
					<Button
						size="sm"
						variant="ghost"
						onClick={() => {
							setDiscardError(null);
							setDiscarding("confirm");
						}}
					>
						Discard changes
					</Button>
				) : (
					<>
						<Text as="span" role="label" tone="secondary">
							{`Discard your unsaved changes for everyone and reload v${canonicalDoc.revision}?`}
						</Text>
						<Button
							size="sm"
							variant="destructive"
							disabled={discarding === "busy" || unacknowledged || unsynced}
							onClick={async () => {
								setDiscarding("busy");
								const result = await replaceWithCanonical().catch(() => ({
									ok: false as const,
									message: `v${canonicalDoc.revision} did not load. Try again.`,
								}));
								setDiscarding(null);
								if (!result.ok) setDiscardError(result.message);
							}}
						>
							{discarding === "busy"
								? `Loading v${canonicalDoc.revision}…`
								: `Discard and reload v${canonicalDoc.revision}`}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={discarding === "busy"}
							onClick={() => setDiscarding(null)}
						>
							Cancel
						</Button>
					</>
				))}
			{discardError && (
				<Text as="span" role="label" tone="secondary">
					{discardError}
				</Text>
			)}
			{unacknowledged && live && !recoveryRequired && (
				<span className="text-kumo-subtle text-xs" data-canvas-commit-waiting>
					{isGadget
						? UNACKNOWLEDGED_COMMIT_MESSAGE
						: "Syncing your latest edits… Save version is available once they reach the shared draft. If the connection drops first, they are discarded."}
				</span>
			)}
			{/* An output's Save version already sits in its header. */}
			{!confirming ? (
				isGadget && (
					<Button size="sm" disabled={commitDisabled} onClick={beginSave}>
						<FloppyDisk size={14} />{" "}
						{keepingChanges && canonicalDoc
							? `Save as v${canonicalDoc.revision + 1}`
							: "Save"}
					</Button>
				)
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
							: keepingChanges && canonicalDoc
								? `Save as v${canonicalDoc.revision + 1} now`
								: isGadget
									? "Save now"
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
					Saved version {committedRevision}.
				</Text>
			)}
		</>
	);

	return (
		<div
			className="canvas-document-shell grid min-w-0 content-start gap-0"
			style={
				isGadget &&
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
						{!isGadget && outputDetail.data ? (
							<CanvasOutputTitle
								outputId={outputDetail.data.output.id}
								title={outputDetail.data.output.title}
							/>
						) : (
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
						)}

						{doc.type === "output" && doc.linkedGadgetId && (
							<Badge variant="info">App editor</Badge>
						)}
					</OutputWorkshopIdentity>
					{documentStatusActions}
				</OutputWorkshopCommandBar>
			)}
			{detail.isPending && <ListSkeleton rows={2} />}
			{detail.isError && (
				<Alert variant="destructive">
					<AlertTitle>The document is unavailable</AlertTitle>
					<AlertDescription>
						{(detail.error as Error).message}
						{(detail.error as Error).message ===
							"Output source access is unavailable" && (
							<p>
								This document uses restricted sources. Workspace access does not
								grant access to those sources. Ask the document owner for a
								version they can share with you.
							</p>
						)}
					</AlertDescription>
				</Alert>
			)}
			{!isGadget && detail.data && !live && (
				<Alert variant="warning">
					<AlertTitle>
						{status === "connecting"
							? "Connecting to the shared draft"
							: "Collaboration is unavailable"}
					</AlertTitle>
					<AlertDescription>
						{roomCanonical === null
							? `Showing saved version ${canonicalDoc?.revision} read-only. The shared draft may contain newer unsaved changes.`
							: "Your shared draft remains read-only while disconnected."}{" "}
						Editing and saving require a ready room. The connection retries
						automatically.
					</AlertDescription>
					<Button
						variant="outline"
						className="min-h-11 min-w-11"
						onClick={retry}
					>
						Retry connection
					</Button>
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
						revision={canonicalDoc.revision}
						invalidDraft={!!outputDraftIssue}
						keptChanges={keepingChanges}
						saveActionLabel={
							!isGadget ? `Save as v${canonicalDoc.revision + 1}` : undefined
						}
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
						The editor cannot open this draft. The saved version is unchanged:
						use the choices above to download a copy or load it.
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
			) : (session || isRuntimeApp) && isGadget ? (
				// A runtime app's live view, files and drafts come from its revision,
				// so they render before (or without) the editing room; only the
				// manifest editor needs the room.
				<div
					className="grid min-w-0 gap-3"
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
					gadgetDetail.data?.currentRevision ? (
						<Card
							data-canvas-gadget-preview
							data-canvas-runtime-app
							size="sm"
							tone="raised"
							className={
								runtimeAppFills ? "flex min-h-0 flex-1 flex-col" : undefined
							}
						>
							<CardContent
								className={
									runtimeAppFills
										? "flex min-h-0 flex-1 flex-col gap-3"
										: "grid gap-3"
								}
							>
								<AppRuntimePreview
									key={gadgetDetail.data.currentRevision.id}
									workspaceId={workspaceId}
									gadget={gadgetDetail.data.gadget}
									revision={gadgetDetail.data.currentRevision}
									layout={runtimeAppFills ? "fill" : "content"}
								/>
							</CardContent>
						</Card>
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
						<WorkspaceAppRunsInfo
							manifest={builtinManifest!}
							onShowResources={onShowResources}
						/>
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
									className="canvas-code-files-heading m-0"
								>
									Files
								</Text>
								{codeFiles.map((file) => (
									<Button
										key={file.path}
										size="sm"
										variant="ghost"
										className="canvas-code-file-button"
										aria-current={codeFile === file.path ? "page" : undefined}
										aria-label={file.path}
										title={file.hint}
										onClick={() => setCodeFile(file.path)}
									>
										{file.path}
									</Button>
								))}
							</aside>
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
										<code className="canvas-code-file-name">manifest.json</code>
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
					)}
				</div>
			) : !isGadget && roomCanonical === null && outputDetail.data ? (
				<section
					aria-label="Saved document (read-only)"
					data-canonical-document-view
				>
					<OutputContentView
						content={outputDetail.data.currentRevision.content}
					/>
				</section>
			) : session && !isGadget && outputDraft ? (
				<OutputEditor
					value={outputDraft}
					onChange={updateSharedOutput}
					disabled={!live}
					documentCollab={documentCollab.collab}
					remoteCursors={documentCollab.cursors}
					presence={
						outputKind === "sheet"
							? { participants, onSelectionChange: setSelection }
							: undefined
					}
				/>
			) : (
				<ListSkeleton rows={1} rowClassName="h-64" />
			)}
			{outputFooterShown && (
				<OutputWorkshopFooter
					ref={saveFooter}
					className="canvas-document-footer justify-end"
				>
					{saveControls}
				</OutputWorkshopFooter>
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
				exclude={isRuntimeApp ? isAppDraftProposal : undefined}
				onMerged={onProposalMerged}
			/>
		</div>
	);
}
