import { ArrowLeft, FileX, SidebarSimple } from "@phosphor-icons/react";
import type {
	OsGadget,
	OsGadgetManifest,
	OsOutput,
	OsOutputKind,
	OsWorkspace,
} from "@tedix/api-contract/schemas/os-workspaces";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { getOsSurface } from "@/lib/os-navigation";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { CanvasStagePending } from "@/routes/-pending";
import { CanvasProposals } from "@/components/canvas-proposals";
import { CanvasResourceRail } from "@/components/canvas-resource-rail";
import {
	CanvasWorkpieceTabs,
	canvasWorkpieceModeOptions,
} from "@/components/canvas-workpiece-tabs";
import { CanvasWorkspaceControls } from "@/components/canvas-workspace-controls";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import { ApprovalNotifications } from "@/components/approval-notifications";
import { ChatThread } from "@/components/chat-thread";
import {
	ChatSidebar,
	MAIN_HOME_CONVERSATION_ID,
	ChatConversationHeader,
} from "@/components/chat-sidebar";
import { CostChip } from "@/components/cost-chip";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/kumo/empty";
import { Button } from "@/components/kumo/button";
import {
	Page,
	PageActions,
	PageHeader,
	PageSection,
	SectionDescription,
	SectionHeader,
	SectionHeading,
	SectionTitle,
} from "@/components/kumo/page";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Text } from "@/components/kumo/text";
import { TransportStatus } from "@/components/transport-status";
import { useWorkspaceWebMcpTools } from "@/components/workspace-webmcp-tools";
import { osApi } from "@/lib/api";
import {
	canvasDocFromSearch,
	canvasDocsFromSearch,
	canvasDocsSearchValue,
	canvasDocKey,
	canvasModeIsValidForDoc,
	type CanvasDocSelection,
	type CanvasMobilePane,
	type CanvasSearch,
	type CanvasWorkpieceMode,
} from "@/lib/canvas-search";
import {
	type CostReading,
	postureSpendReading,
	queryReading,
} from "@/lib/cost-reading";
import {
	activeWorkspacesQueryOptions,
	canvasGadgetDetailQueryOptions,
	canvasGadgetsQueryOptions,
	canvasOutputLibraryQueryOptions,
	canvasOutputsQueryOptions,
	computePostureQueryOptions,
	homeConversationsQueryKey,
	osQueryKeys,
	outputDetailQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import { SURFACE_ICONS } from "@/lib/surface-icons";
import { useLiveWorkspace } from "@/lib/use-live-workspace";

// ---------------------------------------------------------------------------
// Stage panels: deferred out of the route's first-paint chunk graph
// ---------------------------------------------------------------------------

/*
 * Every one of these renders ONLY inside `selectedDoc !== null`, i.e. only once
 * an operator has opened a workpiece — but a static import puts them on the
 * route's critical path regardless, because the router cannot render the route
 * until its whole chunk graph has loaded.
 *
 * Eagerly imported, `canvas-doc-panel`'s editor family (output
 * document/sheet/slides, the CodeMirror collab editor, the widget frame) is a
 * large share of the /workspace/$workspaceId graph — downloaded and parsed
 * before the workbench shell could paint, even when no document is open.
 *
 * `lazy` moves them behind the selection that actually needs them. The stage
 * renders its skeleton for the one tick the import takes; nothing else on the
 * route waits.
 */
const CanvasDocPanel = lazy(async () => ({
	default: (await import("@/components/canvas-doc-panel")).CanvasDocPanel,
}));
const ConnectionsPanel = lazy(async () => ({
	default: (await import("@/components/apps-page")).ConnectionsPanel,
}));
const WorkspaceResourcesPanel = lazy(async () => ({
	default: (await import("@/components/workspace-resources-panel"))
		.WorkspaceResourcesPanel,
}));
const WorkspaceWorkPanel = lazy(async () => ({
	default: (await import("@/components/workspace-work-panel"))
		.WorkspaceWorkPanel,
}));

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export const CANVAS_CHAT_WIDTH_KEY = "tedix-os:canvas-chat-width";
export const CANVAS_CHAT_WIDTH_MIN = 300;
export const CANVAS_CHAT_WIDTH_MAX = 480;
export const CANVAS_CHAT_WIDTH_DEFAULT = 420;
/**
 * The stage can never be squeezed out: whatever the persisted or dragged chat
 * width, at least this much of the viewport stays with the workpiece.
 */
export const CANVAS_STAGE_MIN_WIDTH = 400;

export function clampCanvasChatWidth(
	width: number,
	viewportWidth: number = typeof window === "undefined"
		? Number.POSITIVE_INFINITY
		: window.innerWidth,
): number {
	const viewportMax = Math.max(
		CANVAS_CHAT_WIDTH_MIN,
		viewportWidth - CANVAS_STAGE_MIN_WIDTH,
	);
	return Math.max(
		CANVAS_CHAT_WIDTH_MIN,
		Math.min(CANVAS_CHAT_WIDTH_MAX, viewportMax, Math.round(width)),
	);
}

/**
 * The chat-only layout of a workspace that has no document yet — the Workshop
 * "first message" experience: the thread fills the workbench and the stage is
 * not there until something arrives to show in it. An explicit URL choice
 * (`workpiece` or `pane`) and an unresolved `?workpiece=` both opt out, since
 * each names something the stage must say.
 */
export function isCanvasSimpleMode(input: {
	documentsLoaded: boolean;
	documentCount: number;
	requestedDoc: CanvasDocSelection | null;
	requestedPane: CanvasMobilePane | undefined;
	unresolvedWorkpiece: CanvasDocSelection | null;
}): boolean {
	return (
		input.documentsLoaded &&
		input.documentCount === 0 &&
		input.requestedDoc === null &&
		input.requestedPane === undefined &&
		input.unresolvedWorkpiece === null
	);
}

export function restoreCanvasChatWidth(
	storage: Pick<Storage, "getItem">,
): number {
	try {
		const stored = Number(storage.getItem(CANVAS_CHAT_WIDTH_KEY));
		return Number.isFinite(stored) && stored > 0
			? clampCanvasChatWidth(stored)
			: CANVAS_CHAT_WIDTH_DEFAULT;
	} catch {
		return CANVAS_CHAT_WIDTH_DEFAULT;
	}
}

export function nextCanvasDocAfterClose(
	opened: readonly CanvasDocSelection[],
	closingKey: string,
	selectedKey: string | null,
): CanvasDocSelection | null {
	if (selectedKey !== closingKey) {
		return opened.find((doc) => canvasDocKey(doc) === selectedKey) ?? null;
	}
	const closingIndex = opened.findIndex(
		(doc) => canvasDocKey(doc) === closingKey,
	);
	const remaining = opened.filter((doc) => canvasDocKey(doc) !== closingKey);
	return (
		remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)] ?? null
	);
}

/**
 * Choose the useful first view for a populated Workspace when its URL carries
 * no explicit user choice. Outputs are the durable project-facing artifact and
 * their server list is ordered by most recent activity; Gadgets are the
 * executable fallback. Explicit URL workpiece and pane state always wins.
 */
export function primaryCanvasDoc(
	outputs: readonly Pick<OsOutput, "id">[],
	gadgets: readonly Pick<OsGadget, "id">[],
): CanvasDocSelection | null {
	const output = outputs[0];
	if (output) return { type: "output", id: output.id };
	const gadget = gadgets[0];
	return gadget ? { type: "gadget", id: gadget.id } : null;
}

const OUTPUT_ENTRY_PATTERN =
	/^\/outputs\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:[?#].*)?$/i;

/** First-party output entries open their semantic editor instead of raw manifest JSON. */
export function linkedOutputIdFromManifest(
	manifest: OsGadgetManifest | null | undefined,
): string | null {
	return manifest?.entry.match(OUTPUT_ENTRY_PATTERN)?.[1] ?? null;
}

/**
 * Explain the authority boundary behind the Workspace Connections tab.
 * Gadgets may call tools, while outputs are inert revisioned artifacts. Neither
 * owns a credential: the MCP gateway resolves the active user/tedi grant,
 * policy, and explicit resource arguments for each tool call.
 */
export function workspaceConnectionContext(
	documentType: CanvasDocSelection["type"],
): string {
	return documentType === "gadget"
		? "Connect an app, then attach the resources this workspace needs. This app can use them only with the required permissions and approvals."
		: "This document does not access connected apps itself. Workers need the required permissions to read its sources or update it.";
}

/**
 * A `?workpiece=` param that parses but resolves to nothing in this workspace
 * is a different fact from "nothing selected yet", and the difference is the
 * whole reason a shared link is worth debugging: the target was deleted,
 * archived, or lives in another workspace. Saying "Pick a document" there
 * renders a populated project as an empty one.
 */
export function missingWorkpieceCopy(doc: CanvasDocSelection): {
	title: string;
	description: string;
} {
	const noun = doc.type === "gadget" ? "gadget" : "output";
	return {
		title: `This ${noun} is not in this workspace`,
		description: `Nothing here matches ${noun} ${doc.id}. It was deleted or archived, or it belongs to a different workspace than the link you followed.`,
	};
}

const CanvasIcon = SURFACE_ICONS.workspaces;

/**
 * Compute posture in the workspace header.
 *
 * Deliberately ORGANIZATION-scoped, and the chip's subject says so. Nothing
 * links a workspace to the call-cost ledger — gadget receipts carry effort, not
 * money — so a workspace-scoped figure would have to be invented. What IS true
 * and worth a header slot is the org's spend and whether its ledger is fresh,
 * which is the difference between "this workspace is cheap" and "cost ingestion
 * stopped four days ago".
 *
 * Shares `computePostureQueryOptions` with the Compute surface so React Query
 * serves one posture fetch across both.
 */
export function WorkspaceComputeChip() {
	const posture = useQuery({
		...computePostureQueryOptions("7d"),
		staleTime: 60_000,
	});
	const nonData = queryReading(posture);
	const reading: CostReading =
		nonData ??
		(posture.data
			? postureSpendReading(posture.data)
			: { kind: "pending" as const });
	return (
		<CostChip
			reading={reading}
			subject="Organization model spend over the last 7 days"
		/>
	);
}

const CANVAS_DESKTOP_PANES = [
	{ value: "workpiece", label: "Editor" },
	{ value: "resources", label: "Resources" },
	{ value: "work", label: "Work" },
] as const;

export function canvasArtifactPaneLabel(
	doc: CanvasDocSelection | null,
	outputKind: OsOutputKind | null | undefined,
) {
	if (!doc) return "Artifact";
	return doc.type === "gadget"
		? "Automation"
		: outputWorkshopKindLabel(outputKind);
}

export function CanvasPage({
	workspaceId: requestedWorkspaceId,
}: {
	workspaceId: string;
}) {
	const surface = getOsSurface("workspaces");
	const queryClient = useQueryClient();
	const navigate = useNavigate({ from: "/workspace/$workspaceId" });
	const canvasSearch: CanvasSearch = useSearch({
		from: "/_session/_chrome-free/workspace_/$workspaceId",
	});
	const {
		conversation: requestedConversation,
		workpiece: requestedWorkpiece,
		view: requestedView,
		pane: requestedPane,
		focus: requestedFocus,
	} = canvasSearch;
	const requestedDoc = useMemo(
		() => canvasDocFromSearch(requestedWorkpiece),
		[requestedWorkpiece],
	);
	const requestedDocs = useMemo(
		() => canvasDocsFromSearch(canvasSearch.workpieces),
		[canvasSearch.workpieces],
	);
	const [selectedDoc, setSelectedDoc] = useState<CanvasDocSelection | null>(
		null,
	);
	// An unresolvable URL selection, remembered against the workspace it failed
	// in so that switching workspaces cannot leave a stale notice behind.
	const [missingWorkpiece, setMissingWorkpiece] = useState<{
		workspaceId: string;
		doc: CanvasDocSelection;
	} | null>(null);
	const [resourceRailOpen, setResourceRailOpen] = useState(
		(requestedPane ?? (requestedDoc ? "workpiece" : "chat")) === "resources",
	);
	const [chatCollapsed, setChatCollapsed] = useState(false);
	const [focusMode, setFocusMode] = useState(requestedFocus === true);
	const [mobilePane, setMobilePane] = useState<CanvasMobilePane>(
		requestedPane ?? (requestedDoc ? "workpiece" : "chat"),
	);
	const [openedDocs, setOpenedDocs] = useState<CanvasDocSelection[]>([]);
	const [workpieceMode, setWorkpieceMode] = useState<CanvasWorkpieceMode>(
		requestedView ?? "workpiece",
	);
	const [chatWidth, setChatWidth] = useState(() =>
		restoreCanvasChatWidth(window.localStorage),
	);
	const [activeConversationId, setActiveConversationId] = useState<
		string | null
	>(requestedConversation ?? MAIN_HOME_CONVERSATION_ID);
	const widgetFollowUpRef = useRef<((content: string) => void) | null>(null);
	const registerWidgetFollowUp = useCallback(
		(send: (content: string) => void) => {
			widgetFollowUpRef.current = send;
		},
		[],
	);
	const sendWidgetFollowUp = useCallback((message: string) => {
		widgetFollowUpRef.current?.(message);
	}, []);
	const [conversationListOpen, setConversationListOpen] = useState(
		requestedConversation === undefined,
	);
	const [resizingChat, setResizingChat] = useState(false);
	// Width/opacity motion is for the later reveal of the stage, never for the
	// first paint: it starts off on mount and arms once the document lists have
	// painted or on the first manual pane change, and pointer resizing switches
	// it off so the drag tracks the cursor.
	const [transitionEnabled, setTransitionEnabled] = useState(false);
	const selectionRequestRef = useRef(0);
	const visitedWorkspaceRef = useRef<string | null>(null);
	const primaryWorkpieceWorkspaceRef = useRef<string | null>(null);
	const openedDocsRef = useRef<CanvasDocSelection[]>([]);
	const resizeStartRef = useRef({ pointerX: 0, width: chatWidth });
	const chatWidthRef = useRef(chatWidth);

	const writeCanvasSearch = useCallback(
		(next: CanvasSearch, replace = false) => {
			void navigate({
				search: Object.hasOwn(next, "conversation")
					? next
					: { ...next, conversation: canvasSearch.conversation },
				replace,
			});
		},
		[canvasSearch.conversation, navigate],
	);

	useEffect(() => {
		if (!requestedConversation) return;
		setActiveConversationId(requestedConversation);
		setConversationListOpen(false);
	}, [requestedConversation]);
	const updateOpenedDocs = useCallback(
		(update: (current: CanvasDocSelection[]) => CanvasDocSelection[]) => {
			setOpenedDocs((current) => {
				const next = update(current);
				openedDocsRef.current = next;
				return next;
			});
		},
		[],
	);

	const persistChatWidth = (width: number) => {
		const next = clampCanvasChatWidth(width);
		chatWidthRef.current = next;
		setChatWidth(next);
		try {
			window.localStorage.setItem(CANVAS_CHAT_WIDTH_KEY, String(next));
		} catch {
			// Width persistence is convenience only; the workbench remains usable.
		}
	};

	// A viewport that shrinks under a persisted width re-clamps it so the stage
	// keeps its floor.
	useEffect(() => {
		const reclamp = () => {
			const next = clampCanvasChatWidth(chatWidthRef.current);
			if (next !== chatWidthRef.current) {
				chatWidthRef.current = next;
				setChatWidth(next);
			}
		};
		window.addEventListener("resize", reclamp);
		return () => window.removeEventListener("resize", reclamp);
	}, []);

	useEffect(() => {
		if (!resizingChat) return;
		const resize = (event: PointerEvent) => {
			const next = clampCanvasChatWidth(
				resizeStartRef.current.width +
					event.clientX -
					resizeStartRef.current.pointerX,
			);
			chatWidthRef.current = next;
			setChatWidth(next);
		};
		const stop = () => {
			setResizingChat(false);
			persistChatWidth(chatWidthRef.current);
		};
		window.addEventListener("pointermove", resize);
		window.addEventListener("pointerup", stop, { once: true });
		return () => {
			window.removeEventListener("pointermove", resize);
			window.removeEventListener("pointerup", stop);
		};
	}, [resizingChat]);

	useEffect(() => {
		if (!focusMode) return;
		const exitFocus = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setFocusMode(false);
				writeCanvasSearch({ ...canvasSearch, focus: undefined });
			}
		};
		window.addEventListener("keydown", exitFocus);
		return () => window.removeEventListener("keydown", exitFocus);
	}, [canvasSearch, focusMode, writeCanvasSearch]);

	const workspaces = useQuery(activeWorkspacesQueryOptions());
	const touchWorkspace = useMutation({
		mutationFn: (workspaceId: string) =>
			osApi.osWorkspaces.workspacePreferences.touch({ workspaceId }),
		onSuccess: () =>
			queryClient.invalidateQueries({
				queryKey: osQueryKeys.workspacePreferences(),
			}),
	});
	const selectedWorkspace = workspaces.data?.items.find(
		(workspace) => workspace.id === requestedWorkspaceId,
	);
	const workspaceId = selectedWorkspace?.id ?? null;
	useLiveWorkspace(workspaceId, selectedDoc);
	useWorkspaceWebMcpTools(workspaceId, selectedDoc);

	const recordWorkspaceVisit = (nextWorkspaceId: string) => {
		if (visitedWorkspaceRef.current === nextWorkspaceId) return;
		visitedWorkspaceRef.current = nextWorkspaceId;
		touchWorkspace.mutate(nextWorkspaceId);
	};

	const selectWorkspace = (nextWorkspaceId?: string) => {
		selectionRequestRef.current += 1;
		setSelectedDoc(null);
		setMissingWorkpiece(null);
		updateOpenedDocs(() => []);
		setWorkpieceMode("workpiece");
		setFocusMode(false);
		setResourceRailOpen(false);
		setMobilePane("chat");
		if (nextWorkspaceId) recordWorkspaceVisit(nextWorkspaceId);
		if (!nextWorkspaceId) {
			void navigate({ to: "/workspaces" });
			return;
		}
		void navigate({
			to: "/workspace/$workspaceId",
			params: { workspaceId: nextWorkspaceId },
			search: {},
		});
	};

	// An explicit workspace route is authoritative. Do not replace it with the
	// directory or another workspace while a just-created workspace catches up
	// with a stale directory response.
	useEffect(() => {
		if (!workspaces.data) return;
		if (workspaceId === requestedWorkspaceId) return;
		if (!workspaceId) return;
		void navigate({
			to: "/workspace/$workspaceId",
			params: { workspaceId },
			search: {},
			replace: true,
		});
	}, [navigate, requestedWorkspaceId, workspaceId, workspaces.data]);

	useEffect(() => {
		if (workspaceId) recordWorkspaceVisit(workspaceId);
	}, [workspaceId]);

	const gadgets = useQuery({
		...canvasGadgetsQueryOptions(workspaceId ?? ""),
		enabled: workspaceId !== null,
	});
	const outputs = useQuery({
		...canvasOutputsQueryOptions(workspaceId ?? ""),
		enabled: workspaceId !== null,
	});
	const outputLibrary = useQuery({
		...canvasOutputLibraryQueryOptions(workspaceId ?? ""),
		enabled: workspaceId !== null,
	});
	const resources = useQuery({
		...workspaceResourcesQueryOptions(workspaceId ?? ""),
		enabled: workspaceId !== null,
	});
	const documentsLoaded =
		gadgets.data !== undefined && outputs.data !== undefined;
	const documentCount =
		(gadgets.data?.items.length ?? 0) + (outputs.data?.items.length ?? 0);
	const hasAnyDocuments = documentCount > 0;
	// Arms AFTER the first paint of whatever the lists resolved to: a populated
	// workspace paints its split instantly, and a document-less one paints
	// chat-only instantly and then animates the stage in when the first
	// document arrives.
	useEffect(() => {
		if (documentsLoaded) setTransitionEnabled(true);
	}, [documentsLoaded]);
	const selectedOutputKind =
		selectedDoc?.type === "output"
			? (outputs.data?.items.find((output) => output.id === selectedDoc.id)
					?.kind ??
				outputLibrary.data?.items.find(
					(item) => item.output.id === selectedDoc.id,
				)?.output.kind)
			: null;

	// URL search is the durable selection contract. Local state mirrors it so a
	// click feels immediate, while this effect replays refresh and history
	// changes and removes stale/deleted resource ids once their bounded list has
	// resolved.
	useEffect(() => {
		if (!requestedDoc) {
			const pane = requestedPane ?? "chat";
			setSelectedDoc(null);
			setWorkpieceMode("workpiece");
			setFocusMode(false);
			setMobilePane(pane);
			setResourceRailOpen(pane === "resources");
			if (requestedView || requestedFocus) {
				writeCanvasSearch(
					{
						pane: requestedPane,
					},
					true,
				);
			}
			return;
		}

		const candidates =
			requestedDoc.type === "gadget"
				? gadgets.data?.items
				: outputs.data?.items;
		if (!candidates) return;
		if (!candidates.some((candidate) => candidate.id === requestedDoc.id)) {
			// Drop the unresolvable param so the URL stays canonical and no
			// downstream query is issued for it, but land on the workbench and
			// keep the request itself so the stage can explain what was missing
			// instead of impersonating an untouched workspace.
			const pane = requestedPane === "resources" ? "resources" : "workpiece";
			if (workspaceId) setMissingWorkpiece({ workspaceId, doc: requestedDoc });
			setSelectedDoc(null);
			updateOpenedDocs(() => []);
			setWorkpieceMode("workpiece");
			setFocusMode(false);
			setMobilePane(pane);
			setResourceRailOpen(pane === "resources");
			writeCanvasSearch({ pane }, true);
			return;
		}

		const resolvedDoc =
			openedDocsRef.current.find(
				(candidate) => canvasDocKey(candidate) === canvasDocKey(requestedDoc),
			) ?? requestedDoc;
		const requestedMode = requestedView ?? "workpiece";
		const mode = canvasModeIsValidForDoc(requestedMode, resolvedDoc)
			? requestedMode
			: "workpiece";
		const pane = requestedFocus ? "workpiece" : (requestedPane ?? "workpiece");

		setMissingWorkpiece(null);
		setSelectedDoc(resolvedDoc);
		/*
		 * Replay the URL's whole tab set, not only the selection. Per-element
		 * validation: an entry is kept while its bounded list has not resolved,
		 * and dropped once the list proves it stale -- one dead id in a shared
		 * link must not discard the rest of the set. User-opened tabs that are
		 * not in the URL survive after it.
		 */
		const urlDocs = requestedDocs.filter((doc) => {
			const list =
				doc.type === "gadget" ? gadgets.data?.items : outputs.data?.items;
			return !list || list.some((candidate) => candidate.id === doc.id);
		});
		updateOpenedDocs((current) => {
			const next: CanvasDocSelection[] = [];
			const push = (doc: CanvasDocSelection) => {
				if (
					!next.some(
						(candidate) => canvasDocKey(candidate) === canvasDocKey(doc),
					)
				) {
					next.push(doc);
				}
			};
			for (const doc of urlDocs) {
				push(
					current.find(
						(candidate) => canvasDocKey(candidate) === canvasDocKey(doc),
					) ?? doc,
				);
			}
			push(resolvedDoc);
			for (const doc of current) push(doc);
			return next.length === current.length &&
				next.every(
					(doc, at) => canvasDocKey(doc) === canvasDocKey(current[at]!),
				)
				? current
				: next;
		});
		setWorkpieceMode(mode);
		setFocusMode(requestedFocus === true);
		setMobilePane(pane);
		setResourceRailOpen(pane === "resources" && !requestedFocus);

		if (mode !== requestedMode || (requestedFocus && requestedPane !== pane)) {
			writeCanvasSearch(
				{
					...canvasSearch,
					view: mode === "workpiece" ? undefined : mode,
					pane,
				},
				true,
			);
		}
	}, [
		canvasSearch,
		gadgets.data?.items,
		outputs.data?.items,
		requestedDoc,
		requestedDocs,
		requestedFocus,
		requestedPane,
		requestedView,
		updateOpenedDocs,
		workspaceId,
		writeCanvasSearch,
	]);

	// A bare Workspace URL is a first-open request, not an instruction to leave
	// a populated project blank. This deliberately follows the URL reconciliation
	// effect above so its local selection is not cleared in the same commit.
	// Keep every explicit URL pane intact, but once both bounded lists resolve,
	// open the newest durable Output or an executable Gadget. The ref prevents
	// reopening an item a user deliberately closed.
	useEffect(() => {
		if (
			requestedDoc ||
			requestedPane !== undefined ||
			workspaceId === null ||
			!gadgets.data ||
			!outputs.data ||
			primaryWorkpieceWorkspaceRef.current === workspaceId
		) {
			return;
		}
		const primary = primaryCanvasDoc(outputs.data.items, gadgets.data.items);
		if (!primary) return;

		primaryWorkpieceWorkspaceRef.current = workspaceId;
		selectionRequestRef.current += 1;
		setSelectedDoc(primary);
		updateOpenedDocs(() => [primary]);
		setWorkpieceMode("workpiece");
		setFocusMode(false);
		setResourceRailOpen(false);
		setMobilePane("workpiece");
		writeCanvasSearch(
			{ workpiece: canvasDocKey(primary), pane: "workpiece" },
			true,
		);
	}, [
		gadgets.data,
		outputs.data,
		requestedDoc,
		requestedPane,
		updateOpenedDocs,
		workspaceId,
		writeCanvasSearch,
	]);

	/** The `workpieces` value for a tab list -- single tabs travel as `workpiece` alone. */
	const openedDocsSearch = (docs: readonly CanvasDocSelection[]) =>
		canvasDocsSearchValue(docs);

	const openCanvasDoc = (doc: CanvasDocSelection) => {
		setMissingWorkpiece(null);
		setSelectedDoc(doc);
		setWorkpieceMode("workpiece");
		updateOpenedDocs((current) =>
			current.some((candidate) => canvasDocKey(candidate) === canvasDocKey(doc))
				? current
				: [...current, doc],
		);
		setResourceRailOpen(false);
		setMobilePane("workpiece");
		setFocusMode(false);
		const alreadyOpen = openedDocsRef.current.some(
			(candidate) => canvasDocKey(candidate) === canvasDocKey(doc),
		);
		writeCanvasSearch({
			workpiece: canvasDocKey(doc),
			workpieces: openedDocsSearch(
				alreadyOpen ? openedDocsRef.current : [...openedDocsRef.current, doc],
			),
			pane: "workpiece",
		});
	};

	const selectGadget = async (gadgetId: string) => {
		if (workspaceId === null) return;
		const request = ++selectionRequestRef.current;
		openCanvasDoc({ type: "gadget", id: gadgetId });
		try {
			const [detail, outputList] = await Promise.all([
				queryClient.fetchQuery(
					canvasGadgetDetailQueryOptions(workspaceId, gadgetId),
				),
				queryClient.fetchQuery(canvasOutputsQueryOptions(workspaceId)),
			]);
			if (selectionRequestRef.current !== request) return;
			const linkedOutputId = linkedOutputIdFromManifest(
				detail.currentRevision?.manifest,
			);
			const linkedOutput = outputList.items.find(
				(output) => output.id === linkedOutputId,
			);
			if (linkedOutput) {
				openCanvasDoc({
					type: "output",
					id: linkedOutput.id,
					linkedGadgetId: gadgetId,
				});
			}
		} catch {
			// The generic Gadget manifest editor remains the safe fallback; its
			// detail query will surface the original failure in the stage.
		}
	};

	const selectOutput = (outputId: string) => {
		selectionRequestRef.current += 1;
		openCanvasDoc({ type: "output", id: outputId });
	};

	const showCanvasResources = () => {
		setFocusMode(false);
		setResourceRailOpen(true);
		setMobilePane("resources");
		writeCanvasSearch({ ...canvasSearch, pane: "resources", focus: undefined });
	};

	const unresolvedWorkpiece =
		missingWorkpiece && missingWorkpiece.workspaceId === workspaceId
			? missingWorkpiece.doc
			: null;
	const simpleMode = isCanvasSimpleMode({
		documentsLoaded,
		documentCount,
		requestedDoc,
		requestedPane,
		unresolvedWorkpiece,
	});
	/**
	 * `pane` is a mobile/override param. A conversation change writes it only
	 * when a workpiece is open — there the URL reconciliation would otherwise
	 * flip the phone back to the workpiece — and never on a document-less
	 * workspace, where an explicit pane would end the chat-first layout.
	 */
	const conversationPane = selectedDoc ? "chat" : canvasSearch.pane;

	const closeCanvasDoc = (closingKey: string) => {
		const nextSelected = nextCanvasDocAfterClose(
			openedDocs,
			closingKey,
			selectedDoc ? canvasDocKey(selectedDoc) : null,
		);
		updateOpenedDocs((current) =>
			current.filter((doc) => canvasDocKey(doc) !== closingKey),
		);
		setSelectedDoc(nextSelected);
		setWorkpieceMode("workpiece");
		if (nextSelected === null) {
			setResourceRailOpen(false);
			setMobilePane("chat");
			setFocusMode(false);
			writeCanvasSearch({});
		} else {
			const remaining = openedDocsRef.current.filter(
				(doc) => canvasDocKey(doc) !== closingKey,
			);
			writeCanvasSearch({
				workpiece: canvasDocKey(
					selectedDoc && canvasDocKey(selectedDoc) === closingKey
						? nextSelected
						: (selectedDoc ?? nextSelected),
				),
				workpieces: openedDocsSearch(remaining),
				pane: "workpiece",
			});
		}
	};

	const workpieceViewControls = selectedDoc ? (
		<SegmentedControl
			ariaLabel="Active workpiece view"
			className="canvas-workpiece-mode-switcher"
			compact
			onValueChange={(mode) => {
				setWorkpieceMode(mode);
				writeCanvasSearch({
					...canvasSearch,
					view: mode === "workpiece" ? undefined : mode,
				});
			}}
			options={canvasWorkpieceModeOptions(selectedDoc, selectedOutputKind)}
			value={workpieceMode}
		/>
	) : null;

	return (
		<Page
			fullHeight
			width="bleed"
			className="canvas-surface"
			data-canvas-focus={focusMode || undefined}
			data-chat-collapsed={
				(chatCollapsed && openedDocs.length > 0 && !simpleMode) || undefined
			}
			data-mobile-pane={mobilePane}
			data-resource-rail-open={resourceRailOpen}
			data-resizing-chat={resizingChat || undefined}
			data-simple-mode={simpleMode}
			data-canvas-transition={transitionEnabled && !resizingChat}
		>
			<PageHeader className="canvas-workspace-header">
				<div className="canvas-workspace-identity">
					<Button
						aria-label="All workspaces"
						className="canvas-workspace-back"
						onClick={() => void navigate({ to: "/workspaces" })}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowLeft size={15} />
					</Button>
					<span className="brand-mark canvas-workspace-mark" aria-hidden="true">
						T
					</span>
					<span className="canvas-workspace-separator" aria-hidden="true">
						/
					</span>
					<div className="canvas-workspace-title">
						<h1>{selectedWorkspace?.name ?? surface.label}</h1>
						<p className="sr-only">
							{selectedWorkspace?.description || surface.description}
						</p>
					</div>
				</div>
				<PageActions className="canvas-workspace-actions">
					<ApprovalNotifications conversationId={activeConversationId} />
					<TransportStatus />
					<WorkspaceComputeChip />
					<CanvasWorkspaceControls
						workspace={selectedWorkspace as OsWorkspace | undefined}
						showCreate={false}
						compactActions
						onSelected={selectWorkspace}
						onArchived={() => selectWorkspace()}
					/>
				</PageActions>
			</PageHeader>
			<SegmentedControl
				ariaLabel="Canvas pane"
				className="canvas-pane-switcher canvas-desktop-pane-switcher"
				compact
				onValueChange={(pane) => {
					setTransitionEnabled(true);
					setMobilePane(pane);
					setResourceRailOpen(pane === "resources");
					if (pane !== "workpiece") setFocusMode(false);
					writeCanvasSearch({
						...canvasSearch,
						pane,
						focus: pane === "workpiece" ? canvasSearch.focus : undefined,
					});
				}}
				options={CANVAS_DESKTOP_PANES}
				value={
					mobilePane === "work"
						? "work"
						: resourceRailOpen
							? "resources"
							: "workpiece"
				}
			/>
			<SegmentedControl
				ariaLabel="Canvas pane"
				className="canvas-pane-switcher canvas-mobile-pane-switcher"
				compact
				onValueChange={(pane) => {
					setTransitionEnabled(true);
					setMobilePane(pane);
					setResourceRailOpen(pane === "resources");
					if (pane !== "workpiece") setFocusMode(false);
					writeCanvasSearch({
						...canvasSearch,
						pane,
						focus: pane === "workpiece" ? canvasSearch.focus : undefined,
					});
				}}
				options={[
					{ value: "workpiece", label: "Editor" },
					{ value: "resources", label: "Resources" },
					{ value: "work", label: "Work" },
					{ value: "chat", label: "Chat" },
				]}
				value={mobilePane}
			/>
			<div
				className="canvas-workbench min-w-0"
				style={{ display: mobilePane === "work" ? "none" : undefined }}
			>
				<CanvasResourceRail
					workspaces={workspaces}
					workspaceId={workspaceId}
					gadgets={gadgets}
					outputs={outputLibrary}
					resources={resources}
					selectedDoc={selectedDoc}
					onSelectGadget={(gadgetId) => void selectGadget(gadgetId)}
					onSelectOutput={selectOutput}
				/>
				<aside
					aria-label="Workspace chat"
					className="canvas-chat-pane"
					data-simple-mode={simpleMode}
					style={{ width: simpleMode ? "100%" : chatWidth }}
				>
					{!conversationListOpen && (
						<div className="canvas-chat-header">
							<ChatConversationHeader
								conversationId={activeConversationId}
								workspaceId={workspaceId ?? undefined}
								onBack={() => setConversationListOpen(true)}
								onDeleted={() => {
									setActiveConversationId(null);
									setConversationListOpen(true);
								}}
							/>
						</div>
					)}
					{conversationListOpen && (
						<div className="canvas-chat-conversations">
							<ChatSidebar
								activeConversationId={activeConversationId}
								workspaceId={workspaceId ?? undefined}
								onSelect={(conversationId) => {
									setActiveConversationId(conversationId);
									setConversationListOpen(false);
									writeCanvasSearch({
										...canvasSearch,
										conversation: conversationId ?? undefined,
										pane: conversationPane,
									});
								}}
							/>
						</div>
					)}
					<div
						className={
							conversationListOpen
								? "canvas-chat-list-composer"
								: "canvas-chat-thread"
						}
					>
						<ChatThread
							composerOnly={conversationListOpen}
							conversationId={
								conversationListOpen ? null : activeConversationId
							}
							onSendStarted={() => {
								if (conversationListOpen) setActiveConversationId(null);
								setConversationListOpen(false);
							}}
							workspaceId={workspaceId ?? undefined}
							autoFocusComposer={simpleMode}
							context={
								!conversationListOpen && selectedDoc
									? {
											kind: selectedDoc.type,
											id: selectedDoc.id,
											label: `${selectedDoc.type === "gadget" ? "Gadget" : "Output"} resource`,
										}
									: workspaceId && selectedWorkspace
										? {
												kind: "workspace",
												id: workspaceId,
												label: selectedWorkspace.name,
											}
										: undefined
							}
							onSendMessageReady={registerWidgetFollowUp}
							onConversationCreated={(conversationId) => {
								setActiveConversationId(conversationId);
								setConversationListOpen(false);
								writeCanvasSearch({
									...canvasSearch,
									conversation: conversationId,
									pane: conversationPane,
								});
								queryClient.invalidateQueries({
									queryKey: homeConversationsQueryKey(workspaceId ?? undefined),
								});
							}}
						/>
					</div>
				</aside>
				{simpleMode ? null : (
					<div
						aria-label="Resize workspace chat"
						aria-orientation="vertical"
						aria-valuemax={CANVAS_CHAT_WIDTH_MAX}
						aria-valuemin={CANVAS_CHAT_WIDTH_MIN}
						aria-valuenow={chatWidth}
						className="canvas-chat-resizer"
						onKeyDown={(event) => {
							if (event.key === "ArrowLeft") {
								event.preventDefault();
								persistChatWidth(chatWidth - 24);
							} else if (event.key === "ArrowRight") {
								event.preventDefault();
								persistChatWidth(chatWidth + 24);
							} else if (event.key === "Home") {
								event.preventDefault();
								persistChatWidth(CANVAS_CHAT_WIDTH_MIN);
							} else if (event.key === "End") {
								event.preventDefault();
								persistChatWidth(CANVAS_CHAT_WIDTH_MAX);
							}
						}}
						onPointerDown={(event) => {
							resizeStartRef.current = {
								pointerX: event.clientX,
								width: chatWidth,
							};
							setResizingChat(true);
						}}
						role="separator"
						tabIndex={0}
					/>
				)}
				<section
					aria-label="Workspace workpiece"
					aria-hidden={simpleMode || undefined}
					className="canvas-stage min-w-0 flex-1"
					data-simple-mode={simpleMode}
					style={
						simpleMode ? { width: 0, flex: "0 0 0px", opacity: 0 } : undefined
					}
				>
					{openedDocs.length > 0 ? (
						<div className="canvas-workpiece-bar">
							<Button
								className="canvas-chat-toggle"
								size="icon"
								variant="ghost"
								aria-label={
									chatCollapsed ? "Show conversations" : "Hide conversations"
								}
								title={
									chatCollapsed ? "Show conversations" : "Hide conversations"
								}
								aria-pressed={chatCollapsed}
								onClick={() => setChatCollapsed((value) => !value)}
								icon={<SidebarSimple size={16} />}
							/>
							<CanvasWorkpieceTabs
								gadgets={gadgets.data?.items ?? []}
								onClose={closeCanvasDoc}
								onSelect={openCanvasDoc}
								opened={openedDocs}
								outputs={outputs.data?.items ?? []}
								selectedKey={selectedDoc ? canvasDocKey(selectedDoc) : null}
							/>
							{selectedDoc &&
							(workpieceMode === "connections" || workpieceMode === "activity")
								? workpieceViewControls
								: null}
						</div>
					) : null}
					<div
						className="canvas-stage-content"
						data-has-workpiece={selectedDoc ? "" : undefined}
						data-workpiece-mode={workpieceMode}
					>
						{workspaceId !== null && selectedDoc !== null ? (
							<Suspense fallback={<CanvasStagePending />}>
								{workpieceMode === "connections" ? (
									<div className="canvas-secondary-view">
										<SectionHeader className="border-b border-kumo-line pb-4">
											<SectionHeading>
												<SectionTitle>Connections</SectionTitle>
												<SectionDescription className="max-w-3xl">
													Add resources from your connected apps. Workers still
													need permission and approval to use them.
												</SectionDescription>
											</SectionHeading>
										</SectionHeader>
										<WorkspaceResourcesPanel workspaceId={workspaceId} />
										<details className="canvas-account-connections">
											<summary>Manage connected apps</summary>
											<Text as="p" role="body" tone="secondary">
												Connect an app here, then attach the resources you need
												above.
											</Text>
											<ConnectionsPanel
												catalogAction
												contextNote={workspaceConnectionContext(
													selectedDoc.type,
												)}
											/>
										</details>
									</div>
								) : workpieceMode === "activity" ? (
									<div className="canvas-secondary-view">
										<SectionHeader className="border-b border-kumo-line pb-4">
											<SectionHeading>
												<SectionTitle id="canvas-proposals-title">
													Review changes
												</SectionTitle>
												<SectionDescription className="max-w-3xl">
													Check suggested edits, then approve and apply them.
													Your saved version stays unchanged until you apply a
													change.
												</SectionDescription>
											</SectionHeading>
										</SectionHeader>
										<PageSection aria-labelledby="canvas-proposals-title">
											<CanvasProposals
												showHeading={false}
												documentId={selectedDoc.id}
												documentType={selectedDoc.type}
												onMerged={() => {
													void queryClient.invalidateQueries({
														queryKey:
															selectedDoc.type === "gadget"
																? canvasGadgetDetailQueryOptions(
																		workspaceId,
																		selectedDoc.id,
																	).queryKey
																: outputDetailQueryOptions(selectedDoc.id)
																		.queryKey,
													});
												}}
												workspaceId={workspaceId}
											/>
										</PageSection>
									</div>
								) : (
									<CanvasDocPanel
										key={canvasDocKey(selectedDoc)}
										workspaceId={workspaceId}
										doc={selectedDoc}
										gadgetViewOverride={
											selectedDoc.type === "gadget"
												? workpieceMode === "source" || workpieceMode === "runs"
													? workpieceMode
													: "preview"
												: undefined
										}
										focusMode={focusMode}
										viewControls={workpieceViewControls}
										onFocusModeChange={(focused) => {
											setFocusMode(focused);
											if (focused) {
												setResourceRailOpen(false);
												setMobilePane("workpiece");
											}
											writeCanvasSearch({
												...canvasSearch,
												pane: focused ? "workpiece" : canvasSearch.pane,
												focus: focused ? true : undefined,
											});
										}}
										onShowResources={showCanvasResources}
										onWidgetFollowUp={sendWidgetFollowUp}
									/>
								)}
							</Suspense>
						) : unresolvedWorkpiece ? (
							<Empty appearance="quiet" data-canvas-workpiece-missing="">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<FileX size={20} />
									</EmptyMedia>
									<EmptyTitle>
										{missingWorkpieceCopy(unresolvedWorkpiece).title}
									</EmptyTitle>
									<EmptyDescription>
										{missingWorkpieceCopy(unresolvedWorkpiece).description}
									</EmptyDescription>
								</EmptyHeader>
								<EmptyContent>
									<div className="flex flex-wrap items-center justify-center gap-2">
										<Button onClick={showCanvasResources} size="sm">
											Browse this workspace
										</Button>
										{unresolvedWorkpiece.type === "output" ? (
											<Button
												onClick={() => void navigate({ to: "/outputs" })}
												size="sm"
												variant="secondary"
											>
												Search all outputs
											</Button>
										) : null}
									</div>
								</EmptyContent>
							</Empty>
						) : hasAnyDocuments ? (
							<Empty appearance="quiet">
								<EmptyHeader>
									<EmptyMedia variant="icon">
										<CanvasIcon size={20} />
									</EmptyMedia>
									<EmptyTitle>Pick a document</EmptyTitle>
									<EmptyDescription>
										Choose a gadget or output from Resources to open a shared
										live draft.
									</EmptyDescription>
								</EmptyHeader>
							</Empty>
						) : /* A document-less workspace has nothing to pick: the stage
						       stays blank (and, in simpleMode, collapsed). */ null}
					</div>
				</section>
			</div>
			{mobilePane === "work" && workspaceId ? (
				<section
					aria-label="Workspace work"
					className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
				>
					<Suspense fallback={<CanvasStagePending />}>
						<WorkspaceWorkPanel workspaceId={workspaceId} />
					</Suspense>
				</section>
			) : null}
		</Page>
	);
}
