import { EntityAvatar } from "@/shared/entity-avatar";
import "./canvas-page.css";
import "./output-editor.css";
import { OrganizationMark } from "@/shared/organization-mark";
import { useOsWorkspaceDirectory } from "@/components/os-organization-identity";
import {
	ArrowLeft,
	ArrowsOut,
	Books,
	FileX,
	Kanban,
	ListChecks,
	ChatCircle,
	FolderOpen,
	Plugs,
} from "@phosphor-icons/react";
import type {
	OsGadget,
	OsGadgetManifest,
	OsOutput,
	OsOutputKind,
	OsWorkspace,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	isCancelledError,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
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
import { AppReviewRounds } from "@/components/app-review-rounds";
import { CanvasProposals } from "@/components/canvas-proposals";
import { CanvasPresence } from "@/components/canvas-presence";
import { CanvasResourceRail } from "@/components/canvas-resource-rail";
import {
	CANVAS_WORKPIECE_PANEL_ID,
	CanvasWorkpieceTabs,
	canvasWorkpieceModeOptions,
	canvasWorkpieceTabId,
} from "@/components/canvas-workpiece-tabs";
import { CanvasWorkspaceControls } from "@/components/canvas-workspace-controls";
import { WorkspaceShareDialog } from "@/components/workspace-share-dialog";
import { useAppDrafts } from "@/components/app-runtime-drafts";
import { isAppRuntimeManifest } from "@tedix/api-contract/utils/app-runtime";
import { outputWorkshopKindLabel } from "@/components/output-workshop";
import { ApprovalNotifications } from "@/components/approval-notifications";
import { ChatOutputLinkContext } from "@/components/chat-markdown";
import { ChatThread } from "@/components/chat-thread";
import {
	ChatSidebar,
	MAIN_HOME_CONVERSATION_ID,
	ChatConversationHeader,
} from "@/components/chat-sidebar";
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
	Collapsible,
	CollapsibleDefaultTrigger,
	CollapsibleDefaultContent,
} from "@/components/kumo/collapsible";
import { Breadcrumbs } from "@/components/kumo/breadcrumbs";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/kumo/dialog";
import { DropdownMenuItem } from "@/components/kumo/dropdown-menu";
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
import {
	persistWorkspaceOutputsPanelExpanded,
	restoreWorkspaceOutputsPanelExpanded,
	WORKSPACE_OUTPUTS_PANEL_ID,
	WorkspaceOutputsPanel,
	workspaceOutputsPanelItems,
} from "@/components/workspace-outputs-panel";
import { useAppEditTools } from "@/components/app-edit-webmcp-tools";
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
	activeWorkspacesQueryOptions,
	canvasGadgetDetailQueryOptions,
	canvasGadgetsQueryOptions,
	canvasOutputLibraryQueryOptions,
	canvasOutputsQueryOptions,
	homeConversationsQueryKey,
	osQueryKeys,
	outputDetailQueryOptions,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
import { outputIdFromHref } from "@/lib/output-navigation";
import { useLiveWorkspace } from "@/lib/use-live-workspace";
import { useWorkspacePresence } from "@/lib/workspace-presence";
import { OS_COPY } from "@/shared/os-copy";

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
const WorkspaceAppConnections = lazy(async () => ({
	default: (await import("@/components/workspace-app-connections"))
		.WorkspaceAppConnections,
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

/** Whether the person last hid the chat beside an open item; remembered per browser. */
export const CANVAS_CHAT_COLLAPSED_KEY = "tedix-os:canvas-chat-collapsed";

export function restoreCanvasChatCollapsed(
	storage: Pick<Storage, "getItem"> | null,
): boolean {
	try {
		return storage?.getItem(CANVAS_CHAT_COLLAPSED_KEY) === "true";
	} catch {
		return false;
	}
}

export function persistCanvasChatCollapsed(
	storage: Pick<Storage, "setItem"> | null,
	collapsed: boolean,
) {
	try {
		storage?.setItem(CANVAS_CHAT_COLLAPSED_KEY, String(collapsed));
	} catch {
		// Remembering the chat's fold is a convenience; the toggle still works.
	}
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
 * no explicit user choice. An app is the workspace's front door for people,
 * so the first listed app opens before any file; without an app, the most
 * recently active Output opens. Explicit URL workpiece and pane state always
 * wins.
 */
export function primaryCanvasDoc(
	outputs: readonly Pick<OsOutput, "id">[],
	gadgets: readonly Pick<OsGadget, "id">[],
): CanvasDocSelection | null {
	const gadget = gadgets[0];
	if (gadget) return { type: "gadget", id: gadget.id };
	const output = outputs[0];
	return output ? { type: "output", id: output.id } : null;
}

/**
 * An app's detail, read through the cache. The library's app cards observe the
 * same query, and opening an app replaces the library with the app: when the
 * cards leave mid-fetch, TanStack Query cancels that fetch for everyone who
 * shared it. One retry starts a fetch of our own, so the app still opens on
 * its linked output rather than its raw manifest.
 */
async function fetchGadgetDetail(
	queryClient: ReturnType<typeof useQueryClient>,
	workspaceId: string,
	gadgetId: string,
	/** False once the page left or chose something else; then no retry. */
	stillWanted: () => boolean,
) {
	const options = canvasGadgetDetailQueryOptions(workspaceId, gadgetId);
	try {
		return await queryClient.fetchQuery(options);
	} catch (error) {
		if (!isCancelledError(error) || !stillWanted()) throw error;
		return queryClient.fetchQuery(options);
	}
}

/** First-party output entries open their semantic editor instead of raw manifest JSON. */
export function linkedOutputIdFromManifest(
	manifest: OsGadgetManifest | null | undefined,
): string | null {
	return outputIdFromHref(manifest?.entry);
}

/**
 * Explain the authority boundary behind the Workspace Connections tab.
 * Gadgets may call tools, while outputs are inert revisioned artifacts. Neither
 * owns a credential: the MCP gateway resolves the active user/tedi grant,
 * policy, and explicit resource arguments for each tool call.
 */
export function workspaceConnectionContext(
	documentType: CanvasDocSelection["type"] | null,
): string {
	if (documentType === null) {
		return "Connect an app, then attach the resources this workspace needs. Tedis can use them only with the required permissions and approvals.";
	}
	return documentType === "gadget"
		? "Connect an app, then attach the resources this workspace needs. This workspace app can use them only with the required permissions and approvals."
		: "This document does not access connected apps itself. Workers need the required permissions to read its sources or update it.";
}

/**
 * Attach resources and manage connected apps for a workspace. The document
 * Connections tab and the Resources pane's "Add source" dialog both render it,
 * so the two entry points share one flow.
 */
function WorkspaceConnectionsBody({
	workspaceId,
	documentType,
	gadgetId,
}: {
	workspaceId: string;
	documentType: CanvasDocSelection["type"] | null;
	/** The open app, whose declared resources lead the tab. */
	gadgetId?: string;
}) {
	const [appsOpen, setAppsOpen] = useState(false);
	const appsRef = useRef<HTMLDivElement>(null);
	const openConnectedApps = () => {
		setAppsOpen(true);
		// After the list has opened, so there is room to scroll it into view.
		requestAnimationFrame(() =>
			appsRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" }),
		);
	};
	return (
		<>
			{gadgetId ? (
				<Suspense fallback={null}>
					<WorkspaceAppConnections
						workspaceId={workspaceId}
						gadgetId={gadgetId}
						onConnect={openConnectedApps}
					/>
				</Suspense>
			) : null}
			<WorkspaceResourcesPanel workspaceId={workspaceId} />
			<div ref={appsRef} className="canvas-account-connections">
				<Collapsible open={appsOpen} onOpenChange={setAppsOpen}>
					<CollapsibleDefaultTrigger>
						Manage connected apps
					</CollapsibleDefaultTrigger>
					<CollapsibleDefaultContent keepMounted>
						<Text as="p" role="body" tone="secondary">
							Connect an app here, then attach the resources you need above.
						</Text>
						<ConnectionsPanel
							catalogAction
							contextNote={workspaceConnectionContext(documentType)}
						/>
					</CollapsibleDefaultContent>
				</Collapsible>
			</div>
		</>
	);
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
	const noun = doc.type === "gadget" ? "app" : "output";
	return {
		title: `This ${noun} is not in this workspace`,
		description: `Nothing here matches ${noun} ${doc.id}. It was deleted or archived, or it belongs to a different workspace than the link you followed.`,
	};
}

/**
 * What the canvas column shows. The open item leads; with nothing open, a
 * populated workspace shows its library rather than an empty "pick one" state,
 * and the library and Work are also reachable on purpose from the Files
 * panel and the workspace menu.
 */
export function canvasColumnView(input: {
	pane: CanvasMobilePane;
	libraryOpen: boolean;
	hasSelection: boolean;
	hasAnyDocuments: boolean;
	unresolvedWorkpiece: boolean;
	/** The directory resolved and this workspace is not in it. */
	workspaceMissing: boolean;
}): "work" | "library" | "doc" | "missing" | null {
	if (input.workspaceMissing) return "library";
	if (input.pane === "work") return "work";
	if (input.libraryOpen) return "library";
	if (input.hasSelection) return "doc";
	if (input.unresolvedWorkpiece) return "missing";
	return input.hasAnyDocuments ? "library" : null;
}

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
	const { current: organizationWorkspace } = useOsWorkspaceDirectory();
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
	const [addSourceOpen, setAddSourceOpen] = useState(false);
	const [resourceRailOpen, setResourceRailOpen] = useState(
		(requestedPane ?? (requestedDoc ? "workpiece" : "chat")) === "resources",
	);
	const [chatCollapsed, setChatCollapsed] = useState(() =>
		restoreCanvasChatCollapsed(window.localStorage),
	);
	const toggleChatCollapsed = () => {
		setChatCollapsed((value) => {
			persistCanvasChatCollapsed(window.localStorage, !value);
			return !value;
		});
	};
	// The open app's status and actions render into the tab row, so the app
	// view keeps one toolbar instead of stacking a second one under the tabs.
	const [workpieceActionsSlot, setWorkpieceActionsSlot] =
		useState<HTMLDivElement | null>(null);
	const [outputsPanelExpanded, setOutputsPanelExpanded] = useState(() =>
		restoreWorkspaceOutputsPanelExpanded(
			window.localStorage,
			window.innerWidth,
		),
	);
	// The header's approvals control is the one entry point to the workspace's
	// approvals; the Files panel's Approvals row opens that same control.
	const activityEntryRef = useRef<HTMLSpanElement>(null);
	const [newConversationKey, setNewConversationKey] = useState(0);
	const [focusMode, setFocusMode] = useState(requestedFocus === true);
	// Focus mode hides the top bar, so its Share opens this copy of the dialog.
	const [focusShareOpen, setFocusShareOpen] = useState(false);
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
	const [chatDetailsOpen, setChatDetailsOpen] = useState(false);
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
	const mountedRef = useRef(true);
	useEffect(
		() => () => {
			mountedRef.current = false;
		},
		[],
	);
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
	useAppEditTools(workspaceId, activeConversationId);

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
	const selectedAppId =
		selectedDoc?.type === "gadget"
			? selectedDoc.id
			: selectedDoc?.linkedGadgetId;
	const selectedApp = gadgets.data?.items.find(
		(gadget) => gadget.id === selectedAppId,
	);
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
	// A runtime app's open drafts add a Drafts view to the switcher.
	const selectedGadgetDetail = useQuery({
		...canvasGadgetDetailQueryOptions(workspaceId ?? "", selectedAppId ?? ""),
		enabled: workspaceId !== null && selectedDoc?.type === "gadget",
	});
	const selectedIsRuntimeApp =
		selectedDoc?.type === "gadget" &&
		isAppRuntimeManifest(
			selectedGadgetDetail.data?.currentRevision?.manifest ?? null,
		);
	const selectedAppDrafts = useAppDrafts(
		workspaceId ?? "",
		selectedAppId ?? "",
		workspaceId !== null && selectedIsRuntimeApp,
	);
	const selectedDraftCount = selectedIsRuntimeApp
		? selectedAppDrafts.length
		: 0;
	const selectedOutputKind =
		selectedDoc?.type === "output"
			? (outputs.data?.items.find((output) => output.id === selectedDoc.id)
					?.kind ??
				outputLibrary.data?.items.find(
					(item) => item.output.id === selectedDoc.id,
				)?.output.kind)
			: null;
	const selectedOutput =
		selectedDoc?.type === "output"
			? (outputs.data?.items.find((output) => output.id === selectedDoc.id) ??
				outputLibrary.data?.items.find(
					(item) => item.output.id === selectedDoc.id,
				)?.output)
			: null;
	const workspaceParticipants = useWorkspacePresence({
		workspaceId,
		location: {
			surface: "canvas",
			...(selectedApp
				? { artifactKind: "gadget" as const, artifactLabel: selectedApp.name }
				: selectedOutput
					? {
							artifactKind: "output" as const,
							artifactLabel: selectedOutput.title,
						}
					: {}),
			selectionLabel:
				mobilePane === "workpiece"
					? "Canvas"
					: mobilePane === "resources"
						? "Files"
						: mobilePane === "work"
							? "Work"
							: "Chat",
		},
	});

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
	// open the first app, else the newest durable Output. The ref prevents
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
		if (primary.type !== "gadget") return;
		// An app whose entry is one of this workspace's outputs opens in that
		// output's editor, exactly as clicking it in Resources does.
		const request = selectionRequestRef.current;
		const outputItems = outputs.data.items;
		const stillWanted = () =>
			mountedRef.current && selectionRequestRef.current === request;
		void fetchGadgetDetail(queryClient, workspaceId, primary.id, stillWanted)
			.then((detail) => {
				if (!stillWanted()) return;
				const linkedOutputId = linkedOutputIdFromManifest(
					detail.currentRevision?.manifest,
				);
				const linked = outputItems.find(
					(output) => output.id === linkedOutputId,
				);
				if (!linked) return;
				const doc: CanvasDocSelection = {
					type: "output",
					id: linked.id,
					linkedGadgetId: primary.id,
				};
				setSelectedDoc(doc);
				updateOpenedDocs(() => [doc]);
				writeCanvasSearch(
					{ workpiece: canvasDocKey(doc), pane: "workpiece" },
					true,
				);
			})
			.catch(() => {
				// The app's own view stays open; its detail query surfaces the failure.
			});
	}, [
		gadgets.data,
		outputs.data,
		queryClient,
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
		const stillWanted = () =>
			mountedRef.current && selectionRequestRef.current === request;
		try {
			const [detail, outputList] = await Promise.all([
				fetchGadgetDetail(queryClient, workspaceId, gadgetId, stillWanted),
				queryClient.fetchQuery(canvasOutputsQueryOptions(workspaceId)),
			]);
			if (!stillWanted()) return;
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

	/**
	 * Open an output named in this Workspace's chat in the editor pane, as a
	 * new tab beside the ones already open. A just-created output may not be
	 * in the cached list yet, and the URL reconciliation drops a workpiece the
	 * list does not hold, so an unknown id refreshes the list first. An output
	 * of another Workspace keeps the standalone page when it was clicked
	 * (`leaveIfElsewhere`) and is otherwise ignored.
	 */
	const openChatOutput = async (
		outputId: string,
		leaveIfElsewhere: boolean,
	) => {
		if (workspaceId === null) return;
		const listed = (items: readonly { id: string }[] | undefined) =>
			items?.some((output) => output.id === outputId) ?? false;
		let found = listed(outputs.data?.items);
		if (!found) {
			const fresh = await queryClient
				.fetchQuery({ ...canvasOutputsQueryOptions(workspaceId), staleTime: 0 })
				.catch(() => null);
			found = listed(fresh?.items);
		}
		if (found) {
			selectOutput(outputId);
		} else if (leaveIfElsewhere) {
			void navigate({ to: "/outputs/$outputId", params: { outputId } });
		}
	};
	const chatOutputLinks = {
		openOutput: (outputId: string) => void openChatOutput(outputId, true),
	};

	const showCanvasResources = () => {
		setFocusMode(false);
		setResourceRailOpen(true);
		setMobilePane("resources");
		writeCanvasSearch({ ...canvasSearch, pane: "resources", focus: undefined });
	};

	const outputsPanelItems = useMemo(
		() =>
			workspaceOutputsPanelItems(
				outputs.data?.items ?? [],
				gadgets.data?.items ?? [],
			),
		[gadgets.data?.items, outputs.data?.items],
	);
	const outputsPanelList = {
		items: outputsPanelItems,
		loading: workspaceId !== null && (outputs.isPending || gadgets.isPending),
		error: outputs.isError,
		selectedDoc,
	};
	const openOutputsPanelItem = (doc: CanvasDocSelection) => {
		setTransitionEnabled(true);
		if (doc.type === "gadget") void selectGadget(doc.id);
		else selectOutput(doc.id);
	};
	const openWorkspaceActivity = () => {
		activityEntryRef.current?.querySelector<HTMLElement>("button")?.click();
	};
	const changeOutputsPanelExpanded = (expanded: boolean) => {
		setOutputsPanelExpanded(expanded);
		persistWorkspaceOutputsPanelExpanded(window.localStorage, expanded);
	};
	/** A pane choice from the phone switcher, the Files panel or the menu. */
	const showPane = (pane: CanvasMobilePane) => {
		setTransitionEnabled(true);
		setMobilePane(pane);
		setResourceRailOpen(pane === "resources");
		if (pane !== "workpiece") setFocusMode(false);
		writeCanvasSearch({
			...canvasSearch,
			pane,
			focus: pane === "workpiece" ? canvasSearch.focus : undefined,
		});
	};
	const selectWorkpieceMode = (mode: CanvasWorkpieceMode) => {
		setWorkpieceMode(mode);
		setResourceRailOpen(false);
		setMobilePane("workpiece");
		writeCanvasSearch({
			...canvasSearch,
			view: mode === "workpiece" ? undefined : mode,
			pane: "workpiece",
		});
	};
	const enterFocusMode = () => {
		setFocusMode(true);
		setResourceRailOpen(false);
		setMobilePane("workpiece");
		writeCanvasSearch({ ...canvasSearch, pane: "workpiece", focus: true });
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

	const canvasView = canvasColumnView({
		pane: mobilePane,
		libraryOpen: resourceRailOpen,
		hasSelection: selectedDoc !== null,
		// A bare URL is about to open the workspace's first app (the effect
		// above); the library must not flash in before it does.
		hasAnyDocuments:
			hasAnyDocuments &&
			(requestedDoc !== null ||
				requestedPane !== undefined ||
				primaryWorkpieceWorkspaceRef.current === workspaceId),
		unresolvedWorkpiece: unresolvedWorkpiece !== null,
		workspaceMissing: workspaces.data !== undefined && workspaceId === null,
	});

	const workpieceViewControls = selectedDoc ? (
		<SegmentedControl
			ariaLabel="Active workpiece view"
			className="canvas-workpiece-mode-switcher"
			compact
			onValueChange={selectWorkpieceMode}
			options={canvasWorkpieceModeOptions(
				selectedDoc,
				selectedOutputKind,
				selectedDraftCount,
				workpieceMode,
			)}
			value={workpieceMode}
		/>
	) : null;

	const workspaceMenuItems = (
		<>
			<DropdownMenuItem onClick={showCanvasResources}>
				<Books size={14} /> {OS_COPY.workspace.overview}
			</DropdownMenuItem>
			<DropdownMenuItem onClick={() => showPane("work")}>
				<Kanban size={14} /> Work
			</DropdownMenuItem>
			{selectedDoc ? (
				<>
					<DropdownMenuItem onClick={() => selectWorkpieceMode("connections")}>
						<Plugs size={14} /> Connections
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => selectWorkpieceMode("activity")}>
						<ListChecks size={14} /> Review changes
					</DropdownMenuItem>
				</>
			) : null}
		</>
	);

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
				<div
					className="canvas-workspace-identity"
					data-open-item={selectedApp ? "" : undefined}
				>
					<Button
						aria-label={OS_COPY.workspace.allWorkspaces}
						className="canvas-workspace-back"
						title={OS_COPY.workspace.allWorkspaces}
						onClick={() => void navigate({ to: "/workspaces" })}
						size="icon-sm"
						variant="ghost"
					>
						<ArrowLeft size={16} />
					</Button>
					{selectedWorkspace ? (
						<EntityAvatar
							id={selectedWorkspace.id}
							name={selectedWorkspace.name}
							role={
								selectedWorkspace.visibility === "private"
									? "private"
									: undefined
							}
							image={selectedWorkspace.iconUrl}
							imageFit="contain"
							kind="workspace"
							className="canvas-workspace-avatar size-6 rounded-md"
						/>
					) : (
						<OrganizationMark
							className="canvas-workspace-mark"
							logoUrl={organizationWorkspace?.org.logoUrl}
							name={organizationWorkspace?.org.name ?? "Tedix"}
						/>
					)}
					<span className="canvas-workspace-separator" aria-hidden="true">
						/
					</span>
					<div className="canvas-workspace-title">
						{selectedWorkspace ? (
							<Breadcrumbs
								items={[
									{ label: "Workspaces", href: "/workspaces" },
									{
										label: selectedWorkspace.name,
										...(selectedApp
											? { href: `/workspace/${selectedWorkspace.id}` }
											: {}),
									},
									...(selectedApp ? [{ label: selectedApp.name }] : []),
								]}
							/>
						) : null}
						<h1 className="type-tedix-body">
							{selectedApp?.name ?? selectedWorkspace?.name ?? surface.label}
						</h1>
						<p className="sr-only">
							{selectedWorkspace?.description || surface.description}
						</p>
					</div>
				</div>
				<PageActions className="canvas-workspace-actions">
					<CanvasPresence
						participants={workspaceParticipants}
						openItem={
							selectedApp
								? { kind: "gadget", label: selectedApp.name }
								: selectedOutput
									? { kind: "output", label: selectedOutput.title }
									: null
						}
					/>
					<span
						className="contents"
						data-workspace-activity-entry=""
						ref={activityEntryRef}
					>
						<ApprovalNotifications conversationId={activeConversationId} />
					</span>
					<TransportStatus />
					{/* The chat and Files panel toggles on a wide screen; phones
					    switch panes from the bottom switcher instead. */}
					{openedDocs.length > 0 && !simpleMode ? (
						<Button
							aria-expanded={!chatCollapsed}
							aria-label={chatCollapsed ? "Show chat" : "Hide chat"}
							className="canvas-chat-toggle"
							icon={<ChatCircle size={16} />}
							onClick={toggleChatCollapsed}
							size="icon-sm"
							title={chatCollapsed ? "Show chat" : "Hide chat"}
							variant="ghost"
						/>
					) : null}
					<Button
						aria-controls={WORKSPACE_OUTPUTS_PANEL_ID}
						aria-expanded={outputsPanelExpanded}
						aria-label={outputsPanelExpanded ? "Hide files" : "Show files"}
						className="canvas-files-toggle"
						icon={<FolderOpen size={16} />}
						onClick={() => changeOutputsPanelExpanded(!outputsPanelExpanded)}
						size="icon-sm"
						title={outputsPanelExpanded ? "Hide files" : "Show files"}
						variant="ghost"
					/>
					{canvasView === "doc" ? (
						<Button
							aria-label="Focus"
							className="canvas-workspace-focus"
							icon={<ArrowsOut size={16} />}
							onClick={enterFocusMode}
							size="icon-sm"
							title="Focus on the open item"
							variant="ghost"
						/>
					) : null}
					<CanvasWorkspaceControls
						workspace={selectedWorkspace as OsWorkspace | undefined}
						showCreate={false}
						compactActions
						openItem={
							selectedDoc
								? {
										type: selectedDoc.type,
										id: selectedDoc.id,
										onOpenReview: () => selectWorkpieceMode("activity"),
									}
								: undefined
						}
						menuItems={workspaceMenuItems}
						onSelected={selectWorkspace}
						onArchived={() => selectWorkspace()}
					/>
				</PageActions>
			</PageHeader>
			<div className="canvas-workbench min-w-0">
				{workspaceId !== null ? (
					<Dialog open={addSourceOpen} onOpenChange={setAddSourceOpen}>
						<DialogContent size="lg">
							<DialogHeader>
								<DialogTitle>Add a connected source</DialogTitle>
								<DialogDescription>
									Attach an account or file from a connected app. Tedis still
									need permission and approval to use it.
								</DialogDescription>
							</DialogHeader>
							{addSourceOpen ? (
								<Suspense fallback={<CanvasStagePending />}>
									<WorkspaceConnectionsBody
										workspaceId={workspaceId}
										documentType={null}
									/>
								</Suspense>
							) : null}
						</DialogContent>
					</Dialog>
				) : null}
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
								detailsOpen={chatDetailsOpen}
								onToggleDetails={() => setChatDetailsOpen((open) => !open)}
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
									if (conversationId === null)
										setNewConversationKey((key) => key + 1);
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
						<ChatOutputLinkContext.Provider value={chatOutputLinks}>
							<ChatThread
								key={newConversationKey}
								composerOnly={conversationListOpen}
								detailsOpen={chatDetailsOpen}
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
									selectedDoc
										? {
												kind: selectedDoc.type,
												id: selectedDoc.id,
												label: `${selectedDoc.type === "gadget" ? "App" : "Output"} resource`,
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
										queryKey: homeConversationsQueryKey(
											workspaceId ?? undefined,
										),
									});
								}}
								onOutputCreated={(outputId) =>
									void openChatOutput(outputId, false)
								}
							/>
						</ChatOutputLinkContext.Provider>
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
					inert={simpleMode}
					style={
						simpleMode ? { width: 0, flex: "0 0 0px", opacity: 0 } : undefined
					}
				>
					{openedDocs.length > 0 ? (
						<div className="canvas-workpiece-bar" data-focus-ring="inset">
							<CanvasWorkpieceTabs
								gadgets={gadgets.data?.items ?? []}
								onClose={closeCanvasDoc}
								onSelect={openCanvasDoc}
								opened={openedDocs}
								outputs={outputs.data?.items ?? []}
								selectedKey={selectedDoc ? canvasDocKey(selectedDoc) : null}
							/>
							{/* Actions that come and go with the view (Translate, Save)
							    sit before the view tabs, so the tabs keep their place. */}
							<div
								className="canvas-workpiece-actions"
								ref={setWorkpieceActionsSlot}
							/>
							{workpieceViewControls}
						</div>
					) : null}
					{canvasView === "library" ? (
						<CanvasResourceRail
							workspaces={workspaces}
							workspaceId={workspaceId}
							gadgets={gadgets}
							outputs={outputLibrary}
							resources={resources}
							selectedDoc={selectedDoc}
							onSelectGadget={(gadgetId) => void selectGadget(gadgetId)}
							onSelectOutput={selectOutput}
							onAddSource={() => setAddSourceOpen(true)}
						/>
					) : canvasView === "work" && workspaceId ? (
						<section
							aria-label="Workspace work"
							className="canvas-work-view flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
						>
							<Suspense fallback={<CanvasStagePending />}>
								<WorkspaceWorkPanel workspaceId={workspaceId} />
							</Suspense>
						</section>
					) : null}
					{/* The open item stays mounted behind the library or Work, so an
					    unsaved draft is where the person left it on the way back. */}
					<div
						aria-labelledby={
							selectedDoc ? canvasWorkpieceTabId(selectedDoc) : undefined
						}
						className="canvas-stage-content"
						data-has-workpiece={selectedDoc ? "" : undefined}
						data-workpiece-mode={workpieceMode}
						hidden={canvasView === "library" || canvasView === "work"}
						id={CANVAS_WORKPIECE_PANEL_ID}
						role="tabpanel"
					>
						{workspaceId !== null && selectedDoc !== null ? (
							<Suspense fallback={<CanvasStagePending />}>
								{workpieceMode === "connections" ? (
									<div className="canvas-secondary-view">
										<SectionHeader className="border-b border-kumo-line pb-4">
											<SectionHeading>
												<SectionTitle>Connections</SectionTitle>
												<SectionDescription className="max-w-3xl">
													{selectedDoc.type === "gadget"
														? "What this app can use, then everything attached to the workspace. Workers still need permission and approval to use them."
														: "Add resources from your connected apps. Workers still need permission and approval to use them."}
												</SectionDescription>
											</SectionHeading>
										</SectionHeader>
										<WorkspaceConnectionsBody
											workspaceId={workspaceId}
											documentType={selectedDoc.type}
											gadgetId={
												selectedDoc.type === "gadget"
													? selectedDoc.id
													: undefined
											}
										/>
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
										{selectedDoc.type === "gadget" && (
											<AppReviewRounds gadgetId={selectedDoc.id} />
										)}
									</div>
								) : (
									<CanvasDocPanel
										key={canvasDocKey(selectedDoc)}
										workspaceId={workspaceId}
										doc={selectedDoc}
										gadgetViewOverride={
											selectedDoc.type === "gadget"
												? workpieceMode === "edit"
													? "source"
													: workpieceMode === "history"
														? "runs"
														: "preview"
												: undefined
										}
										focusMode={focusMode}
										onAppDraftSaved={() => selectWorkpieceMode("edit")}
										onOpenDrafts={() => selectWorkpieceMode("edit")}
										onAppDraftMerged={() => selectWorkpieceMode("workpiece")}
										actionsSlot={workpieceActionsSlot}
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
										onShare={
											selectedWorkspace
												? () => setFocusShareOpen(true)
												: undefined
										}
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
						) : /* A document-less workspace has nothing to show yet: the
						       stage stays blank (and, in simpleMode, collapsed). */ null}
					</div>
				</section>
				{workspaceId !== null ? (
					<WorkspaceOutputsPanel
						{...outputsPanelList}
						expanded={outputsPanelExpanded}
						canvasView={
							canvasView === "library" || canvasView === "work"
								? canvasView
								: null
						}
						onBrowseLibrary={showCanvasResources}
						onOpenWork={() => showPane("work")}
						onOpenActivity={openWorkspaceActivity}
						onSelect={openOutputsPanelItem}
					/>
				) : null}
			</div>
			{/* A phone shows one pane at a time and switches at the bottom, where
			    the thumb is. Work has no segment of its own: it opens from the
			    menu and shows here only while it is the pane. */}
			<SegmentedControl
				ariaLabel="Canvas pane"
				className="canvas-pane-switcher"
				compact
				fill
				onValueChange={showPane}
				options={[
					{ value: "chat", label: "Chat" },
					{ value: "workpiece", label: "Canvas" },
					{ value: "resources", label: "Files" },
					...(mobilePane === "work"
						? [{ value: "work" as const, label: "Work" }]
						: []),
				]}
				value={mobilePane}
			/>
			{focusShareOpen && selectedWorkspace ? (
				<WorkspaceShareDialog
					workspaceId={selectedWorkspace.id}
					workspaceName={selectedWorkspace.name}
					visibility={selectedWorkspace.visibility}
					item={
						selectedDoc
							? {
									type: selectedDoc.type,
									id: selectedDoc.id,
									onOpenReview: () => selectWorkpieceMode("activity"),
								}
							: undefined
					}
					open
					onOpenChange={setFocusShareOpen}
				/>
			) : null}
		</Page>
	);
}
