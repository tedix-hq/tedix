import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	OsGadget,
	OsGadgetManifest,
	OsGadgetRevision,
	OsCollaborationProposal,
	OsOutput,
	OsOutputContent,
	OsOutputRevision,
	OsWorkspace,
} from "@tedix/api-contract/schemas/os-workspaces";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

vi.mock("@/components/canvas-repository-workpiece", () => ({
	CanvasRepositoryWorkpiece: ({
		workItemId,
		attemptId,
	}: {
		workItemId: string;
		attemptId: string;
	}) => (
		<div data-repository-work={workItemId} data-repository-attempt={attemptId}>
			Repository snapshot
		</div>
	),
}));

const osWorkspacesApi = vi.hoisted(() => ({
	workspaces: {
		list: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		archive: vi.fn(),
	},
	blueprints: { get: vi.fn() },
	workspacePreferences: {
		list: vi.fn(),
		setFavorite: vi.fn(),
		touch: vi.fn(),
	},
	gadgets: {
		list: vi.fn(),
		get: vi.fn(),
		revise: vi.fn(),
		getCode: vi.fn(),
		installOutputEditor: vi.fn(),
	},
	outputs: {
		list: vi.fn(),
		library: vi.fn(),
		get: vi.fn(),
		revise: vi.fn(),
		rename: vi.fn(),
	},
	resources: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
	schedules: { list: vi.fn() },
	collaboration: {
		list: vi.fn(),
		accept: vi.fn(),
		reject: vi.fn(),
		merge: vi.fn(),
	},
}));

const osComputeApi = vi.hoisted(() => ({
	posture: vi.fn(),
}));

const osSharesApi = vi.hoisted(() => ({
	shares: {
		list: vi.fn(),
		create: vi.fn(),
		previewRevoke: vi.fn(),
		revoke: vi.fn(),
	},
}));

const kernelRuntimeApi = vi.hoisted(() => ({
	listConversations: vi.fn(),
}));

const webPushApi = vi.hoisted(() => ({
	getStatus: vi.fn(),
	setPreferences: vi.fn(),
}));

const routing = vi.hoisted(() => ({
	navigate: vi.fn(),
	search: {} as {
		conversation?: string;
		workpiece?: string;
		view?: "workpiece" | "edit" | "history" | "connections" | "activity";
		pane?: "resources" | "work" | "chat" | "workpiece";
		focus?: true;
	},
}));

const collab = vi.hoisted(() => ({
	useCollabDoc: vi.fn(),
}));

/** The user's explicit, warned replacement. Stable identity, like the session. */
const replaceWithCanonical = vi.hoisted(() => vi.fn());

/**
 * The commit-grounding pair, with STABLE identities for the same reason the session has one.
 * `commitBasis` is what the panel takes BEFORE a commit; `groundCommit` is what it hands back
 * afterwards so the room is re-grounded on the revision the commit produced.
 */
const collabCommit = vi.hoisted(() => ({
	basis: null as CollabCommitBasis | null,
	commitBasis: vi.fn(),
	groundCommit: vi.fn(),
	/**
	 * Whether the OT client still holds edits the server has not agreed to.
	 *
	 * MUTABLE AND READ AT RENDER TIME, so a test can land the acknowledgement mid-test without
	 * swapping the session identity (which would remount the editor). It is deliberately tied to
	 * `commitBasis` below, because the real hook ties them: while this is true no stream position
	 * describes the displayed text, so there is no basis to take.
	 */
	unacknowledged: false,
}));

const chatHarness = vi.hoisted(() => ({
	onSelect: null as ((conversationId: string | null) => void) | null,
	onConversationCreated: null as ((conversationId: string) => void) | null,
}));

const organization = vi.hoisted(() => ({
	logoUrl: "https://images.example.test/org.png" as string | null,
	name: "Example",
}));
vi.mock("@/components/os-organization-identity", () => ({
	useOsWorkspaceDirectory: () => ({ current: { org: organization } }),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: osWorkspacesApi,
		osCompute: osComputeApi,
		osShares: osSharesApi,
		kernelRuntime: kernelRuntimeApi,
		webPush: webPushApi,
		// Connected source cards read app logos from the provider catalog.
		connections: { listProviders: vi.fn(async () => ({ data: [] })) },
		// The Review tab asks who is signed in before offering review rounds.
		userSettings: {
			getContext: vi.fn(async () => ({ authority: { role: "member" } })),
		},
	},
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => routing.navigate,
	useSearch: () => routing.search,
}));

vi.mock("@/components/app-runtime-panel", () => ({
	AppRuntimePreview: () => <div data-app-runtime-preview />,
}));
vi.mock("@/lib/use-collab-doc", () => ({
	useCollabDoc: collab.useCollabDoc,
}));

vi.mock("@/components/canvas-editor", () => ({
	CanvasCodeEditor: (props: {
		session: OtEditSession;
		path: string;
		readOnly?: boolean;
	}) => (
		<div data-collab-editor data-read-only={String(props.readOnly === true)}>
			{props.session.text(props.path)}
		</div>
	),
}));

vi.mock("@/components/canvas-gadget-executions", () => ({
	CanvasGadgetExecutions: ({
		workspaceId,
		gadgetId,
	}: {
		workspaceId: string;
		gadgetId: string;
	}) => (
		<div
			data-execution-gadget-id={gadgetId}
			data-execution-workspace-id={workspaceId}
			data-gadget-executions
		/>
	),
}));
vi.mock("@/components/approval-notifications", () => ({
	ApprovalNotifications: () => null,
}));

vi.mock("@/components/widget-frame", () => ({
	WidgetFrame: ({
		appSlug,
		resourceUri,
		title,
	}: {
		appSlug: string;
		resourceUri: string;
		title?: string;
	}) => (
		<div
			data-app-slug={appSlug}
			data-resource-uri={resourceUri}
			data-widget-frame
		>
			{title}
		</div>
	),
}));

vi.mock("@/components/workspace-chat", () => ({
	WorkspaceChat: ({
		conversationId,
		listOpen,
		onOpenList,
		onSelectConversation,
		onConversationCreated,
	}: {
		conversationId: string | null;
		listOpen: boolean;
		onOpenList: () => void;
		onSelectConversation: (conversationId: string | null) => void;
		onConversationCreated?: (conversationId: string) => void;
	}) => {
		chatHarness.onSelect = onSelectConversation;
		chatHarness.onConversationCreated = onConversationCreated ?? null;
		return (
			<div data-chat-thread={conversationId ?? "new"} data-list-open={listOpen}>
				Workspace chat
				{listOpen ? (
					<nav
						aria-label="Conversations"
						data-active-conversation={conversationId ?? "new"}
					>
						<button
							type="button"
							onClick={() => onSelectConversation("conv-second")}
						>
							Second conversation
						</button>
						<button type="button" onClick={() => onSelectConversation(null)}>
							New
						</button>
					</nav>
				) : (
					<div
						data-testid="conversation-header"
						data-conversation={conversationId}
					>
						<button
							aria-label="Back to conversations"
							onClick={onOpenList}
							type="button"
						>
							All conversations
						</button>
					</div>
				)}
			</div>
		);
	},
}));

vi.mock("@/components/apps-page", () => ({
	ConnectionsPanel: ({ contextNote }: { contextNote?: string }) => (
		<div data-connections-panel>{contextNote}</div>
	),
}));

vi.mock("@/components/workspace-resources-panel", () => ({
	WorkspaceResourcesPanel: ({ workspaceId }: { workspaceId: string }) => (
		<div data-workspace-resources-panel={workspaceId}>Workspace resources</div>
	),
	availabilityLabel: () => "App connected",
}));

vi.mock("@/components/workspace-work-panel", () => ({
	WorkspaceWorkPanel: ({ workspaceId }: { workspaceId: string }) => (
		<div data-workspace-work-panel={workspaceId}>Workspace work items</div>
	),
}));

vi.mock("@/components/output-export-buttons", () => ({
	OutputExportButtons: ({
		outputId,
		compact,
	}: {
		outputId: string;
		compact?: boolean;
	}) => (
		<div data-compact={compact} data-export-buttons={outputId}>
			Export
		</div>
	),
}));

import { ConnectionChip } from "./canvas-doc-panel";
import {
	CANVAS_CHAT_WIDTH_DEFAULT,
	CANVAS_STAGE_CLOSE_SETTLE_MS,
	persistCanvasStageClosed,
	restoreCanvasStageClosed,
	CANVAS_CHAT_COLLAPSED_KEY,
	CANVAS_CHAT_WIDTH_KEY,
	persistCanvasChatCollapsed,
	restoreCanvasChatCollapsed,
	CANVAS_CHAT_WIDTH_MAX,
	CANVAS_CHAT_WIDTH_MIN,
	CANVAS_STAGE_MIN_WIDTH,
	CanvasPage,
	isCanvasSimpleMode,
	canvasArtifactPaneLabel,
	clampCanvasChatWidth,
	linkedOutputIdFromManifest,
	nextCanvasDocAfterClose,
	primaryCanvasDoc,
	restoreCanvasChatWidth,
	workspaceConnectionContext,
} from "./canvas-page";
import { canvasWorkpieceModeOptions } from "./canvas-workpiece-tabs";
import {
	outputKindError,
	parseDraft,
	parseOutputDraft,
} from "@/lib/canvas-draft";
import {
	type CanvasDocSelection,
	canvasDocKey,
	validateWorkspaceSearch,
} from "@/lib/canvas-search";
import { CAPACITY_MESSAGE } from "@/collab/ot/authority";
import { type CodeChange, diffFiles } from "@/collab/ot/code-change";
import type { OtBlockedState } from "@/collab/ot/client";
import type { OtEditSession } from "@/collab/ot/edit-session";
import { COLLAB_DOC_PATH } from "@/collab/protocol";
import { gadgetWidgetTargetFromManifest } from "@/lib/gadget-widget-target";
import type { CollabCommitBasis } from "@/lib/use-collab-doc";
import { groupWorkspaceLibrary } from "@/lib/workspace-library";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GADGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GADGET_REVISION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OUTPUT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OUTPUT_REVISION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const PROPOSAL_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

function workspaceFixture(overrides: Partial<OsWorkspace> = {}): OsWorkspace {
	return {
		id: WORKSPACE_ID,
		organizationId: "org-1",
		name: "Ops room",
		description: null,
		status: "active",
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-12T10:00:00.000Z",
		visibility: "org",
		ownerUserId: null,
		...overrides,
	};
}

function gadgetFixture(overrides: Partial<OsGadget> = {}): OsGadget {
	return {
		id: GADGET_ID,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		name: "Report gadget",
		description: null,
		status: "active",
		currentRevisionId: GADGET_REVISION_ID,
		sourceBlueprintRevisionId: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-12T10:00:00.000Z",
		...overrides,
	};
}

function gadgetRevisionFixture(
	overrides: Partial<OsGadgetRevision> = {},
): OsGadgetRevision {
	return {
		id: GADGET_REVISION_ID,
		organizationId: "org-1",
		gadgetId: GADGET_ID,
		revision: 3,
		manifest: {
			capabilities: ["outputs.write"],
			entry: "gadgets/report.tsx",
		},
		sourceArtifactRef: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-10T10:00:00.000Z",
		...overrides,
	};
}

const baseContent: OsOutputContent = {
	kind: "document",
	blocks: [{ type: "paragraph", text: "hello" }],
};

const sheetContent: OsOutputContent = {
	kind: "sheet",
	columns: ["Region", "Revenue"],
	rows: [["North", 12]],
};

function outputFixture(overrides: Partial<OsOutput> = {}): OsOutput {
	return {
		id: OUTPUT_ID,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		kind: "document",
		title: "Weekly report",
		status: "active",
		currentRevisionId: OUTPUT_REVISION_ID,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-12T10:00:00.000Z",
		...overrides,
	};
}

function outputRevisionFixture(
	overrides: Partial<OsOutputRevision> = {},
): OsOutputRevision {
	return {
		id: OUTPUT_REVISION_ID,
		organizationId: "org-1",
		outputId: OUTPUT_ID,
		revision: 2,
		producedBy: null,
		content: baseContent,
		note: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-10T10:00:00.000Z",
		...overrides,
		accessEnvelope: overrides.accessEnvelope ?? null,
	};
}

function proposalFixture(
	overrides: Partial<OsCollaborationProposal> = {},
): OsCollaborationProposal {
	return {
		id: PROPOSAL_ID,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		documentType: "output",
		documentId: OUTPUT_ID,
		baseRevisionId: OUTPUT_REVISION_ID,
		baseRevision: 2,
		status: "open",
		sourceKind: "agent_session",
		sourceId: "codex:session-1",
		content: {
			kind: "document",
			blocks: [{ type: "paragraph", text: "agent preview" }],
		},
		sequence: 3,
		createdByKind: "external_agent",
		createdById: "agent-1",
		createdAt: "2026-08-10T10:00:00.000Z",
		updatedAt: "2026-08-10T10:01:00.000Z",
		decisionRationale: null,
		decisionEvidenceRefs: [],
		decidedByKind: null,
		decidedById: null,
		decidedAt: null,
		mergeRationale: null,
		mergeEvidenceRefs: [],
		mergedByKind: null,
		mergedById: null,
		mergedAt: null,
		resultRevisionId: null,
		resultRevision: null,
		...overrides,
	};
}

const DEFAULT_GADGET_MANIFEST: OsGadgetManifest = {
	capabilities: [],
	entry: "main.tsx",
};

/** JSON exactly as the panel seeds and commits it. */
function docJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * A hand-written `OtEditSession`: the whole contract the panel talks to, with
 * no socket, no OT client, and no CRDT. `remote` is how a peer's change arrives.
 *
 * Its identity is STABLE for the life of a test — an unstable hook-mock
 * identity sends this app's effects into an infinite render loop.
 */
class FakeEditSession implements OtEditSession {
	local: CodeChange[] = [];
	#files = new Map<string, string>();
	#listeners = new Set<(change: CodeChange) => void>();
	#blocked: ReturnType<OtEditSession["blocked"]> = null;

	constructor(initial: string) {
		this.#files.set(COLLAB_DOC_PATH, initial);
	}

	text(path: string): string {
		return this.#files.get(path) ?? "";
	}

	applyLocal(change: CodeChange, path: string, newText: string): void {
		this.local.push(change);
		this.#files.set(path, newText);
	}

	onRemote(listener: (change: CodeChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	blocked() {
		return this.#blocked;
	}

	/** A peer replaced the document; deliver it the way the sync layer would. */
	remote(text: string): void {
		const before = new Map(this.#files);
		this.#files.set(COLLAB_DOC_PATH, text);
		const change = diffFiles(before, this.#files);
		for (const listener of this.#listeners) listener(change);
	}
}

/**
 * The hook's result, with a STABLE session identity for the life of a test.
 *
 * `canonical` is the ROOM's grounding stamp — WHICH canonical revision the
 * shared text is — and is deliberately separate from the revision the document
 * query reports. A commit pinned to the query instead of to this is the silent
 * overwrite `canvas-doc-panel.tsx`'s header describes.
 */
function mockCollab({
	status = "connected",
	peers = 1,
	initial = "",
	canonicalRevision,
	recoveryRequired = false,
	unsynced = false,
	unacknowledged = false,
	discarded = 0,
	blocked = null,
	tooLarge = false,
}: {
	status?: string;
	/** The saved version is too long for a room, so none is opened. */
	tooLarge?: boolean;
	peers?: number;
	initial?: string;
	/** `undefined` means "whatever the loaded document says"; set it to diverge. */
	canonicalRevision?: number | null;
	recoveryRequired?: boolean;
	/** Unacknowledged local edits are stuck behind a failing submission. */
	unsynced?: boolean;
	/**
	 * This client still holds edits the server has not agreed to, so `commitBasis()` is null and
	 * the panel must not commit at all — a commit with no basis cannot re-ground the room on the
	 * revision it produces, which is the wedge.
	 */
	unacknowledged?: boolean;
	/** How many times local edits were discarded and the draft rebuilt. */
	discarded?: number;
	/** Editing is blocked in a way the user must act on; `capacity` is the only one today. */
	blocked?: OtBlockedState | null;
} = {}): FakeEditSession {
	collabCommit.unacknowledged = unacknowledged;
	const session = new FakeEditSession(initial);
	collab.useCollabDoc.mockImplementation(
		(hookInput: { canonical: { revision: number } | null }) => ({
			// NOT gated on `status`: a transient disconnect must not unmount the
			// editor and destroy its view.
			session,
			status,
			tooLarge,
			peers,
			participants: [],
			blocked,
			unsynced,
			unacknowledged: collabCommit.unacknowledged,
			discarded,
			canonical:
				canonicalRevision === undefined
					? hookInput.canonical === null
						? null
						: {
								revision: hookInput.canonical.revision,
								revisionId: `rev-${hookInput.canonical.revision}`,
							}
					: canonicalRevision === null
						? null
						: {
								revision: canonicalRevision,
								revisionId: `rev-${canonicalRevision}`,
							},
			recoveryRequired,
			replaceWithCanonical,
			commitBasis: collabCommit.commitBasis,
			groundCommit: collabCommit.groundCommit,
		}),
	);
	return session;
}

function mockLists() {
	osWorkspacesApi.workspaces.list.mockResolvedValue({
		items: [workspaceFixture()],
		truncated: false,
	});
	osWorkspacesApi.workspacePreferences.list.mockResolvedValue({
		items: [
			{
				workspaceId: WORKSPACE_ID,
				favorite: true,
				lastOpenedAt: "2026-08-17T12:00:00.000Z",
				updatedAt: "2026-08-17T12:00:00.000Z",
			},
		],
	});
	osWorkspacesApi.workspacePreferences.setFavorite.mockResolvedValue({
		preference: {
			workspaceId: WORKSPACE_ID,
			favorite: false,
			lastOpenedAt: "2026-08-17T12:00:00.000Z",
			updatedAt: "2026-08-17T12:01:00.000Z",
		},
	});
	osWorkspacesApi.workspacePreferences.touch.mockResolvedValue({
		preference: {
			workspaceId: WORKSPACE_ID,
			favorite: true,
			lastOpenedAt: "2026-08-17T12:02:00.000Z",
			updatedAt: "2026-08-17T12:02:00.000Z",
		},
	});
	osWorkspacesApi.gadgets.list.mockResolvedValue({
		items: [gadgetFixture()],
		truncated: false,
	});
	osWorkspacesApi.gadgets.getCode.mockResolvedValue({ code: null });
	osWorkspacesApi.outputs.list.mockResolvedValue({
		items: [outputFixture()],
		truncated: false,
	});
	osWorkspacesApi.outputs.library.mockResolvedValue({
		items: [
			{
				output: outputFixture(),
				workspace: {
					id: WORKSPACE_ID,
					name: "Acme Video Production",
					status: "active",
				},
				currentRevision: {
					id: OUTPUT_REVISION_ID,
					revision: 2,
					createdAt: "2026-08-10T10:00:00.000Z",
				},
				scope: "mine",
				preview: { kind: "document", lines: ["hello"], blockCount: 1 },
			},
		],
		truncated: false,
	});
	osWorkspacesApi.resources.list.mockResolvedValue({
		items: [
			{
				id: "12121212-1212-4121-8121-121212121212",
				organizationId: "org-1",
				workspaceId: WORKSPACE_ID,
				slot: null,
				providerId: "acme",
				connectionScope: "tenant",
				requiredScopes: [],
				resourceType: "product_listing",
				providerResourceId: "cube-reaction-hybrid",
				name: "Cube Reaction Hybrid Pro 800",
				metadata: {},
				status: "active",
				createdByKind: "user",
				createdById: "user-1",
				createdAt: "2026-08-01T10:00:00.000Z",
				updatedAt: "2026-08-12T10:00:00.000Z",
				removedAt: null,
			},
		],
		truncated: false,
	});
	osWorkspacesApi.schedules.list.mockResolvedValue({ items: [] });
	osWorkspacesApi.collaboration.list.mockResolvedValue({
		items: [],
		truncated: false,
	});
}

// ---------------------------------------------------------------------------
// Interactive harness
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function createPageHarness(workspaceId = WORKSPACE_ID): {
	container: HTMLElement;
	rerender: () => void;
	leave: () => void;
} {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const rerender = () =>
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<CanvasPage workspaceId={workspaceId} />
				</QueryClientProvider>,
			);
		});
	rerender();
	cleanups.push(() => {
		act(() => root.unmount());
		client.clear();
		container.remove();
	});
	return {
		container,
		rerender,
		leave: () => act(() => root.render(null)),
	};
}

function renderPage(workspaceId = WORKSPACE_ID): HTMLElement {
	return createPageHarness(workspaceId).container;
}

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function findButton(container: Element, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find(
		(button) =>
			(button.textContent ?? "").includes(label) ||
			button.getAttribute("aria-label") === `Open ${label}`,
	);
	if (!match) throw new Error(`button not found: ${label}`);
	return match;
}

function click(element: Element) {
	if (!(element instanceof HTMLElement))
		throw new Error("click target missing");
	act(() => {
		element.click();
	});
}

function fieldByLabel(container: Element, label: string): HTMLInputElement {
	const node = container.querySelector(`[aria-label="${label}"]`);
	const field =
		node instanceof HTMLInputElement ? node : node?.querySelector("input");
	if (!(field instanceof HTMLInputElement)) {
		throw new Error(`field not found: ${label}`);
	}
	return field;
}

/** Prototype-setter write + input event so React's value tracker sees the change. */
function setFieldValue(field: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLInputElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("value setter missing");
	act(() => {
		setter.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

/** The Resources "Open app" control for a workspace app, by app name. */
function appOpenButton(container: Element, name: string): Element {
	const match = [...container.querySelectorAll("[data-workspace-app]")]
		.find((card) => card.querySelector("h3")?.textContent === name)
		?.querySelector(".workspace-app-footer button");
	if (!match) throw new Error(`app not found: ${name}`);
	return match;
}

/** A row of the Files panel on the right, by its title. */
function filesPanelRow(container: Element, title: string): Element {
	const match = [
		...container.querySelectorAll('ul[aria-label="Files"] button'),
	].find(
		(row) =>
			row.querySelector(".workspace-outputs-title")?.textContent === title,
	);
	if (!match) throw new Error(`files row not found: ${title}`);
	return match;
}

/** An entry of the open workspace menu, which renders in a portal. */
function findMenuItem(label: string): Element {
	const match = [...document.body.querySelectorAll('[role="menuitem"]')].find(
		(item) => (item.textContent ?? "").includes(label),
	);
	if (!match) throw new Error(`menu item not found: ${label}`);
	return match;
}

/**
 * Opens a workpiece from the Resources pane. A bare URL opens the
 * workspace's app on its own, so these start from Resources.
 */
async function openDoc(label: string): Promise<HTMLElement> {
	routing.search = { pane: "resources" };
	const container = renderPage();
	await flush();
	const isApp = [...container.querySelectorAll("[data-workspace-app] h3")].some(
		(title) => title.textContent === label,
	);
	click(isApp ? appOpenButton(container, label) : findButton(container, label));
	await flush();
	return container;
}

beforeEach(() => {
	for (const namespace of Object.values(osWorkspacesApi)) {
		for (const mock of Object.values(namespace)) {
			mock.mockReset();
		}
	}
	for (const mock of Object.values(osSharesApi.shares)) mock.mockReset();
	osSharesApi.shares.list.mockResolvedValue({ items: [], truncated: false });
	// The header's compute chip reads the org posture through its generated
	// option. Nothing here asserts on it, so it stays pending forever.
	osComputeApi.posture.mockReset();
	osComputeApi.posture.mockReturnValue(new Promise(() => {}));
	for (const mock of Object.values(webPushApi)) mock.mockReset();
	webPushApi.getStatus.mockResolvedValue({
		enabled: false,
		publicKey: null,
		preferences: { mutedProjectIds: [], mutedWorkspaceIds: [] },
	});
	collab.useCollabDoc.mockReset();
	replaceWithCanonical.mockReset().mockResolvedValue({ ok: true });
	// THE DEFAULT ROOM HAS NOTHING UNACKNOWLEDGED, which is what makes Commit live: a client
	// holding unsent keystrokes has no stream position to commit from, and the panel refuses.
	collabCommit.unacknowledged = false;
	collabCommit.basis = { text: "", position: { generation: 0, revision: 0 } };
	collabCommit.commitBasis.mockReset();
	collabCommit.commitBasis.mockImplementation(() =>
		collabCommit.unacknowledged ? null : collabCommit.basis,
	);
	collabCommit.groundCommit.mockReset();
	chatHarness.onSelect = null;
	chatHarness.onConversationCreated = null;
	routing.navigate.mockReset();
	routing.search = {};
	mockCollab({ initial: docJson(baseContent) });
});

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("canvasDocKey", () => {
	it("builds the gadget:/output: room keys", () => {
		expect(canvasDocKey({ type: "gadget", id: GADGET_ID })).toBe(
			`gadget:${GADGET_ID}`,
		);
		expect(canvasDocKey({ type: "output", id: OUTPUT_ID })).toBe(
			`output:${OUTPUT_ID}`,
		);
	});
});

describe("Canvas workbench state", () => {
	it("opens the workspace's app first, then the newest durable output", () => {
		expect(primaryCanvasDoc([outputFixture()], [gadgetFixture()])).toEqual({
			type: "gadget",
			id: GADGET_ID,
		});
		expect(primaryCanvasDoc([outputFixture()], [])).toEqual({
			type: "output",
			id: OUTPUT_ID,
		});
		expect(primaryCanvasDoc([], [])).toBeNull();
	});

	it("opens the owner's chosen app when several are available", () => {
		expect(
			primaryCanvasDoc([], [{ id: "first" }, { id: "chosen" }], "chosen"),
		).toEqual({ type: "gadget", id: "chosen" });
		expect(primaryCanvasDoc([], [{ id: "first" }], "unavailable")).toEqual({
			type: "gadget",
			id: "first",
		});
	});

	it("keeps app views visible and shows other menu views when opened", () => {
		expect(
			canvasWorkpieceModeOptions({ type: "gadget", id: GADGET_ID }).map(
				(option) => option.value,
			),
		).toEqual(["workpiece", "edit", "history", "connections"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "output", id: OUTPUT_ID },
				"document",
			).map((option) => option.label),
		).toEqual(["Document"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "output", id: OUTPUT_ID },
				"sheet",
			).map((option) => option.label),
		).toEqual(["Sheet"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "output", id: OUTPUT_ID },
				"presentation",
				0,
				"activity",
			).map((option) => option.label),
		).toEqual(["Slides", "Review"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "gadget", id: GADGET_ID },
				null,
				0,
				"connections",
			).map((option) => option.label),
		).toEqual(["App", "Code", "History", "Connections"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "gadget", id: GADGET_ID },
				null,
				0,
				"workpiece",
				"sheet",
			).map((option) => option.label),
		).toEqual(["Sheet", "Code", "Connections"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "gadget", id: GADGET_ID },
				null,
				0,
				"workpiece",
				"document",
			)[0]?.label,
		).toBe("Doc");
	});

	it("clamps and restores the persisted chat width", () => {
		expect(clampCanvasChatWidth(100)).toBe(CANVAS_CHAT_WIDTH_MIN);
		expect(clampCanvasChatWidth(1000)).toBe(CANVAS_CHAT_WIDTH_MAX);
		expect(
			restoreCanvasChatWidth({
				getItem: (key) => (key === CANVAS_CHAT_WIDTH_KEY ? "428" : null),
			}),
		).toBe(428);
		expect(restoreCanvasChatWidth({ getItem: () => "invalid" })).toBe(
			CANVAS_CHAT_WIDTH_DEFAULT,
		);
	});

	it("remembers whether the chat was hidden beside an open item", () => {
		const store = new Map<string, string>();
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		};
		expect(restoreCanvasChatCollapsed(storage)).toBe(false);
		persistCanvasChatCollapsed(storage, true);
		expect(store.get(CANVAS_CHAT_COLLAPSED_KEY)).toBe("true");
		expect(restoreCanvasChatCollapsed(storage)).toBe(true);
		expect(
			restoreCanvasChatCollapsed({
				getItem: () => {
					throw new Error("blocked");
				},
			}),
		).toBe(false);
	});

	it("selects the neighboring workpiece when the active tab closes", () => {
		const gadget: CanvasDocSelection = { type: "gadget", id: GADGET_ID };
		const output: CanvasDocSelection = { type: "output", id: OUTPUT_ID };
		expect(
			nextCanvasDocAfterClose(
				[gadget, output],
				canvasDocKey(gadget),
				canvasDocKey(gadget),
			),
		).toEqual(output);
		expect(
			nextCanvasDocAfterClose(
				[gadget, output],
				canvasDocKey(output),
				canvasDocKey(gadget),
			),
		).toEqual(gadget);
	});
});

describe("linkedOutputIdFromManifest", () => {
	it("recognizes a first-party output route and rejects generic entries", () => {
		expect(
			linkedOutputIdFromManifest({
				capabilities: ["os.outputs.write"],
				entry: `/outputs/${OUTPUT_ID}`,
			}),
		).toBe(OUTPUT_ID);
		expect(
			linkedOutputIdFromManifest({ capabilities: [], entry: "main.tsx" }),
		).toBeNull();
	});
});

describe("workspaceConnectionContext", () => {
	it("distinguishes executable Gadgets from inert outputs without copying credentials", () => {
		expect(workspaceConnectionContext("gadget")).toContain(
			"required permissions and approvals",
		);
		expect(workspaceConnectionContext("gadget")).toContain(
			"attach the resources",
		);
		expect(workspaceConnectionContext("output")).toContain(
			"does not access connected apps itself",
		);
	});
});

describe("gadgetWidgetTargetFromManifest", () => {
	it("recognizes a standard MCP Apps resource URI", () => {
		expect(
			gadgetWidgetTargetFromManifest({
				capabilities: ["orders.read"],
				entry: "ui://widgets/mcp-app/acme/r/orders.html",
			}),
		).toEqual({
			appSlug: "acme",
			resourceUri: "ui://widgets/mcp-app/acme/r/orders.html",
		});
	});

	it("keeps arbitrary and malformed manifest entries source-only", () => {
		for (const entry of [
			"gadgets/report.tsx",
			"https://widgets/mcp-app/acme/r/orders.html",
			"ui://elsewhere/mcp-app/acme/r/orders.html",
			"ui://widgets/mcp-app/Acme/r/orders.html",
			"ui://widgets/mcp-app/acme",
			"ui://user@widgets/mcp-app/acme/r/orders.html",
		]) {
			expect(
				gadgetWidgetTargetFromManifest({ capabilities: [], entry }),
			).toBeNull();
		}
	});
});

describe("parseDraft", () => {
	it("returns the parsed value for valid JSON", () => {
		expect(parseDraft('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
	});

	it("surfaces the parse error for invalid JSON", () => {
		const result = parseDraft("not json{");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
	});
});

describe("outputKindError", () => {
	it("accepts a matching kind and rejects everything else", () => {
		expect(outputKindError(baseContent, "document")).toBeNull();
		expect(outputKindError({ kind: "sheet" }, "document")).toContain(
			'"kind": "document"',
		);
		expect(outputKindError("nope", "document")).toContain('"kind": "document"');
		expect(outputKindError(null, "document")).toContain('"kind": "document"');
	});
});

describe("parseOutputDraft", () => {
	it("distinguishes invalid JSON, invalid content, and a wrong output kind", () => {
		expect(parseOutputDraft("not json{", "document")).toEqual({
			ok: false,
			issue: "invalid_json",
		});
		expect(parseOutputDraft("{}", "document")).toEqual({
			ok: false,
			issue: "invalid_content",
		});
		expect(parseOutputDraft(JSON.stringify(sheetContent), "document")).toEqual({
			ok: false,
			issue: "wrong_kind",
		});
	});
});

describe("groupWorkspaceLibrary", () => {
	it("keeps favorites personal, orders recents, and searches workspace text", () => {
		const secondId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		const groups = groupWorkspaceLibrary(
			[
				workspaceFixture(),
				workspaceFixture({
					id: secondId,
					name: "Research",
					description: "Customer evidence",
				}),
			],
			[
				{
					workspaceId: WORKSPACE_ID,
					favorite: true,
					lastOpenedAt: "2026-08-16T12:00:00.000Z",
					updatedAt: "2026-08-16T12:00:00.000Z",
				},
				{
					workspaceId: secondId,
					favorite: false,
					lastOpenedAt: "2026-08-17T12:00:00.000Z",
					updatedAt: "2026-08-17T12:00:00.000Z",
				},
			],
			"",
		);

		expect(groups.favorites.map((entry) => entry.workspace.name)).toEqual([
			"Ops room",
		]);
		expect(groups.recent.map((entry) => entry.workspace.name)).toEqual([
			"Research",
			"Ops room",
		]);
		expect(
			groupWorkspaceLibrary(
				groups.all.map((entry) => entry.workspace),
				groups.all.flatMap((entry) =>
					entry.preference ? [entry.preference] : [],
				),
				"evidence",
			).all.map((entry) => entry.workspace.name),
		).toEqual(["Research"]);
	});
});

describe("ConnectionChip", () => {
	it("shows the status and peer count when connected", () => {
		const html = renderToStaticMarkup(
			<ConnectionChip status="connected" peers={2} />,
		);
		expect(html).toContain('data-connection="connected"');
		expect(html).toContain("2 peers");
	});

	it("hides the peer count while not connected", () => {
		const html = renderToStaticMarkup(
			<ConnectionChip status="disconnected" peers={0} />,
		);
		expect(html).toContain('data-connection="disconnected"');
		expect(html).not.toContain("peers");
	});
});

describe("canvasArtifactPaneLabel", () => {
	it("uses the artifact format instead of exposing the internal workpiece noun", () => {
		expect(
			canvasArtifactPaneLabel({ type: "output", id: OUTPUT_ID }, "video"),
		).toBe("Video");
		expect(
			canvasArtifactPaneLabel({ type: "gadget", id: GADGET_ID }, null),
		).toBe("Automation");
	});
});

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe("CanvasPage listing", () => {
	it("opens a repository session without querying Output content or creating Work", async () => {
		mockLists();
		const workId = "11111111-1111-4111-8111-111111111111";
		const attemptId = "22222222-2222-4222-8222-222222222222";
		routing.search = {
			workpiece: `repository:${workId}:${attemptId}`,
			pane: "workpiece",
		};
		const container = renderPage();
		await flush();
		expect(
			container
				.querySelector("[data-repository-work]")
				?.getAttribute("data-repository-work"),
		).toBe(workId);
		expect(
			container
				.querySelector("[data-repository-attempt]")
				?.getAttribute("data-repository-attempt"),
		).toBe(attemptId);
		expect(osWorkspacesApi.outputs.get).not.toHaveBeenCalled();
		expect(osWorkspacesApi.collaboration.list).not.toHaveBeenCalled();
		expect(osWorkspacesApi.workspaces.create).not.toHaveBeenCalled();
	});

	it.each(["Dispatch", "Studio", "People", "Choices", "Updates"])(
		"uses the configured app name %s above a quiet workspace breadcrumb",
		async (name) => {
			mockLists();
			osWorkspacesApi.gadgets.list.mockResolvedValue({
				items: [gadgetFixture({ name })],
				truncated: false,
			});
			osWorkspacesApi.gadgets.get.mockResolvedValue({
				gadget: gadgetFixture({ name }),
				currentRevision: gadgetRevisionFixture(),
			});
			routing.search = { workpiece: `gadget:${GADGET_ID}`, pane: "workpiece" };
			const { container, rerender } = createPageHarness();
			await flush();

			expect(
				container.querySelector(".canvas-workspace-title h1")?.textContent,
			).toBe(name);
			expect(
				container.querySelector(
					'nav[aria-label="breadcrumb"] a[href^="/workspace/"]',
				)?.textContent,
			).toBe("Ops room");

			osWorkspacesApi.outputs.get.mockResolvedValue({
				output: outputFixture(),
				currentRevision: outputRevisionFixture(),
			});
			mockCollab({ initial: docJson(baseContent) });
			routing.search = { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" };
			rerender();
			await flush();
			expect(
				container.querySelector(".canvas-workspace-title h1")?.textContent,
			).toBe("Ops room");
			expect(
				container.querySelector(".canvas-workspace-breadcrumb"),
			).toBeNull();
		},
	);

	it("uses the selected workspace's stable placeholder beside its breadcrumb", async () => {
		mockLists();
		const container = renderPage();
		await flush();
		const avatar = container.querySelector(
			'.canvas-workspace-header [data-entity-kind="workspace"]',
		);
		expect(avatar).not.toBeNull();
		expect(avatar?.textContent).toBe("OR");
		expect(container.querySelector(".canvas-workspace-header img")).toBeNull();
	});
	it("waits for file bindings before presenting duplicate or native navigation choices", async () => {
		mockLists();
		const sources = await osWorkspacesApi.resources.list();
		const bound = {
			...sources,
			items: [
				{
					...sources.items[0],
					providerId: "tedix",
					resourceType: "output",
					providerResourceId: OUTPUT_ID,
					slot: "document",
					metadata: { gadgetId: GADGET_ID, kind: "document" },
				},
			],
		};
		let finish!: (value: typeof bound) => void;
		osWorkspacesApi.resources.list.mockReturnValue(
			new Promise<typeof bound>((resolve) => {
				finish = resolve;
			}),
		);
		routing.search = { pane: "resources" };
		const container = renderPage();
		await flush();
		expect(
			container.querySelectorAll('ul[aria-label="Files"] button'),
		).toHaveLength(0);
		expect(container.querySelector(".canvas-resource-apps")).toBeNull();
		expect(container.querySelector(".canvas-resource-outputs")).toBeNull();
		await act(async () => finish(bound));
		await flush();
		expect(
			container.querySelectorAll('ul[aria-label="Files"] button'),
		).toHaveLength(1);
		expect(container.querySelector(".canvas-resource-apps")).toBeNull();
	});

	it("shows a bound file once in Files and the library, and opens its gadget from both", async () => {
		mockLists();
		const sources = await osWorkspacesApi.resources.list();
		osWorkspacesApi.resources.list.mockResolvedValue({
			items: [
				{
					...sources.items[0],
					providerId: "tedix",
					resourceType: "output",
					providerResourceId: OUTPUT_ID,
					name: "Weekly report",
					slot: "document",
					metadata: { gadgetId: GADGET_ID, kind: "document" },
				},
			],
			truncated: false,
		});
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({ initial: docJson(gadgetRevisionFixture().manifest) });
		routing.search = { pane: "resources" };
		const container = renderPage();
		await flush();
		expect(
			container.querySelectorAll('ul[aria-label="Files"] button'),
		).toHaveLength(1);
		expect(container.querySelector(".canvas-resource-apps")).toBeNull();
		expect(
			container.querySelectorAll(
				".canvas-resource-outputs [data-workspace-output-preview]",
			),
		).toHaveLength(1);
		click(findButton(container, "Weekly report"));
		await flush();
		expect(routing.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ workpiece: `gadget:${GADGET_ID}` }),
			}),
		);
		routing.navigate.mockClear();
		click(filesPanelRow(container, "Weekly report"));
		await flush();
		expect(routing.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ workpiece: `gadget:${GADGET_ID}` }),
			}),
		);
	});

	it("opens an output deep link in the file's gadget editor", async () => {
		mockLists();
		const sources = await osWorkspacesApi.resources.list();
		osWorkspacesApi.resources.list.mockResolvedValue({
			items: [
				{
					...sources.items[0],
					providerId: "tedix",
					resourceType: "output",
					providerResourceId: OUTPUT_ID,
					slot: "document",
					metadata: { gadgetId: GADGET_ID, kind: "document" },
				},
			],
			truncated: false,
		});
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(baseContent) });
		routing.search = { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" };
		renderPage();
		await flush();
		expect(routing.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					workpiece: `gadget:${GADGET_ID}`,
					pane: "workpiece",
				}),
				replace: true,
			}),
		);
	});

	it("opens an output without an editor read-only with an action to attach one", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(baseContent) });
		routing.search = { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" };
		const container = renderPage();
		await flush();
		expect(routing.search.workpiece).toBe(`output:${OUTPUT_ID}`);
		expect(container.querySelector("[data-canvas-output-view]")).not.toBeNull();
		expect(findButton(container, "Open in editor")).not.toBeNull();
		expect(container.querySelector("[data-collab-editor]")).toBeNull();
	});

	it("keeps multiple workpieces open as closeable deterministic tabs", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({
				manifest: { capabilities: [], entry: "main.tsx" },
			}),
		});
		mockCollab({ initial: docJson(baseContent) });
		routing.search = { pane: "resources" };
		const container = renderPage();
		await flush();

		click(findButton(container, "Weekly report"));
		await flush();
		// The library gave way to the open file; the Files panel still lists the app.
		click(filesPanelRow(container, "Report gadget"));
		await flush();

		const tabs = [...container.querySelectorAll('[role="tab"]')];
		expect(tabs).toHaveLength(2);
		expect(tabs.map((tab) => tab.textContent)).toEqual([
			"Weekly report",
			"Report gadget",
		]);
		expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
		expect(tabs[1]?.parentElement?.getAttribute("data-selected")).toBe("true");
		expect(tabs[1]?.parentElement?.className).not.toContain("border");

		click(
			container.querySelector(
				`[aria-label="Close Report gadget (App, ${GADGET_ID})"]`,
			)!,
		);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("opens Work in the canvas beside the chat and the Files panel", async () => {
		mockLists();
		routing.search = { pane: "work" };
		const container = renderPage();
		await flush();
		expect(
			container.querySelector(".canvas-stage [data-workspace-work-panel]"),
		).not.toBeNull();
		expect(
			container.querySelector('[aria-label="Workspace chat"]'),
		).not.toBeNull();
		expect(
			container
				.querySelector("[data-workspace-outputs-work]")
				?.getAttribute("aria-current"),
		).toBe("true");
		// No second navigation row: the only pane switcher is the phone's.
		expect(container.querySelectorAll(".canvas-pane-switcher")).toHaveLength(1);
		expect(container.querySelector(".canvas-desktop-pane-switcher")).toBeNull();
	});

	it("shows the library and Work from the Files panel without remounting the open draft", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(outputRevisionFixture().content) });
		const container = await openDoc("Weekly report");
		const editor = container.querySelector("[data-canvas-output-view]");
		expect(editor).not.toBeNull();
		const stage = container.querySelector<HTMLElement>(".canvas-stage-content");
		expect(stage?.hidden).toBe(false);
		click(container.querySelector("[data-workspace-outputs-library]")!);
		await flush();
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-resource-rail-open"),
		).toBe("true");
		expect(container.querySelector(".canvas-resource-library")).not.toBeNull();
		expect(stage?.hidden).toBe(true);
		expect(container.querySelector("[data-canvas-output-view]")).toBe(editor);
		click(container.querySelector("[data-workspace-outputs-work]")!);
		await flush();
		expect(
			container.querySelector("[data-workspace-work-panel]"),
		).not.toBeNull();
		expect(container.querySelector(".canvas-resource-library")).toBeNull();
		expect(container.querySelector("[data-canvas-output-view]")).toBe(editor);
		// The open item's own tab brings it back.
		click(container.querySelector('[role="tab"]')!);
		await flush();
		expect(stage?.hidden).toBe(false);
		expect(container.querySelector("[data-workspace-work-panel]")).toBeNull();
		expect(container.querySelector("[data-canvas-output-view]")).toBe(editor);
	});

	it("switches between the responsive resource rail and distraction-free editor", async () => {
		mockLists();
		// A scheduled-skill link is a schedule, not a connected source.
		const skillLink = {
			id: "13131313-1313-4131-8131-131313131313",
			organizationId: "org-1",
			workspaceId: WORKSPACE_ID,
			slot: null,
			providerId: "tedix",
			connectionScope: "tenant",
			requiredScopes: [],
			resourceType: "skill",
			providerResourceId: "skill-digest",
			name: "Morning digest",
			metadata: {},
			status: "active",
			createdByKind: "user",
			createdById: "user-1",
			createdAt: "2026-08-01T10:00:00.000Z",
			updatedAt: "2026-08-01T10:00:00.000Z",
			removedAt: null,
		};
		const sources = await osWorkspacesApi.resources.list();
		osWorkspacesApi.resources.list.mockResolvedValue({
			...sources,
			items: [...sources.items, skillLink],
		});
		osWorkspacesApi.schedules.list.mockResolvedValue({
			items: [
				{
					resourceId: skillLink.id,
					skillId: "skill-digest",
					name: "Morning digest",
					purpose: "Sums up the night's mail.",
					enabled: true,
					cron: "17 6 * * *",
					dailyTimes: ["2026-08-13T06:17:00.000Z"],
					nextRunAt: "2026-08-13T06:17:00.000Z",
					lastRun: {
						runId: "run-1",
						status: "failed",
						startedAt: "2026-08-12T06:17:00.000Z",
						completedAt: "2026-08-12T06:18:00.000Z",
						cards: null,
						summary: null,
						error: "Mail search failed",
					},
				},
			],
		});
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		const linkedRevision = outputRevisionFixture();
		mockCollab({ initial: docJson(linkedRevision.content) });
		const container = await openDoc("Weekly report");
		const surface = container.querySelector(".canvas-surface");

		expect(surface?.getAttribute("data-resource-rail-open")).toBe("false");
		expect(surface?.hasAttribute("data-full-height")).toBe(true);
		expect(surface?.getAttribute("data-mobile-pane")).toBe("workpiece");
		expect(
			container.querySelector('[aria-label="Conversations"]'),
		).not.toBeNull();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		// The read-only view loads lazily on first use.
		for (
			let tries = 0;
			tries < 20 && !container.querySelector("[data-canvas-output-view]");
			tries++
		)
			await flush();
		expect(container.querySelector("[data-canvas-output-view]")).not.toBeNull();
		expect(container.querySelectorAll('[aria-label="Share"]')).toHaveLength(1);
		// No "Resources" control anywhere: the library opens from the Files
		// panel, and the one Files toggle lives in the top bar.
		expect(
			[...container.querySelectorAll("button")].filter(
				(button) =>
					button.textContent?.trim() === "Resources" ||
					button.getAttribute("aria-label") === "Resources",
			),
		).toHaveLength(0);
		expect(
			container.querySelectorAll('[aria-controls="workspace-outputs-panel"]'),
		).toHaveLength(1);
		expect(container.querySelectorAll('[aria-label="Focus"]')).toHaveLength(1);
		click(container.querySelector('[aria-label="Focus"]')!);
		expect(surface?.getAttribute("data-canvas-focus")).toBe("true");
		expect(surface?.getAttribute("data-full-height")).toBe("true");

		click(findButton(container, "Exit focus"));
		expect(surface?.hasAttribute("data-canvas-focus")).toBe(false);
		click(container.querySelector("[data-workspace-outputs-library]")!);
		expect(surface?.getAttribute("data-resource-rail-open")).toBe("true");
		expect(surface?.getAttribute("data-mobile-pane")).toBe("resources");
		expect(
			container.querySelector(".canvas-resource-library-header h2")
				?.textContent,
		).toBe("Overview");
		expect(
			container.querySelector("[data-workspace-output-preview]"),
		).not.toBeNull();
		expect(container.textContent).toContain("Connected sources");
		// Each source is a card: name, type chip, whose account, and Open.
		const source = container.querySelector("[data-workspace-source]");
		expect(source?.textContent).toContain("Cube Reaction Hybrid Pro 800");
		expect(source?.textContent).toContain("Product Listing");
		expect(source?.textContent).toContain("Acme · shared organization account");
		expect(
			source
				?.querySelector('[aria-label="Open Cube Reaction Hybrid Pro 800"]')
				?.getAttribute("href"),
		).toBe("/admin/connections");
		// Apps lead the pane as cards with an Open control; nothing calls them
		// automations.
		const apps = container.querySelector(".canvas-resource-apps");
		expect(
			apps?.compareDocumentPosition(
				container.querySelector(".canvas-resource-outputs")!,
			),
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(apps?.textContent).toContain("Report gadget");
		expect(apps?.textContent).toContain("Open app");
		expect(container.textContent).not.toContain("Automation");
		// Scheduled skills follow the apps, with their run times and last run.
		const schedules = container.querySelector(".canvas-resource-schedules");
		expect(
			apps?.compareDocumentPosition(schedules!) ??
				Node.DOCUMENT_POSITION_PRECEDING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(schedules?.textContent).toContain("Skills and schedules");
		expect(schedules?.textContent).toContain("Morning digest");
		expect(schedules?.textContent).toContain("Every day at");
		expect(schedules?.textContent).toContain(
			"Last run failed: Mail search failed",
		);
		expect(schedules?.textContent).toContain("See runs");
		expect(
			container.querySelectorAll(".canvas-resource-section")[
				[...container.querySelectorAll(".canvas-resource-section")].findIndex(
					(section) => section.textContent?.includes("Connected sources"),
				)
			]?.textContent,
		).not.toContain("Morning digest");
		// A source is added from the Resources pane itself, with the same
		// attach flow the document Connections tab uses.
		click(findButton(container, "Add source"));
		await flush();
		expect(
			document.body.querySelector(
				`[data-workspace-resources-panel="${WORKSPACE_ID}"]`,
			),
		).not.toBeNull();
		expect(document.body.textContent).toContain("Add a connected source");
		// This workspace holds a single ungated document. It files under
		// reference material, and the rail must NOT nag about a missing approved
		// deliverable when nothing was ever submitted to the quality gate.
		expect(container.textContent).toContain("Documents and files");
		expect(container.textContent).not.toContain("No approved result yet");
		expect(container.textContent).not.toContain("Latest draft");
		// State chips report honest counts that sum to the All chip.
		expect(container.textContent).toContain("Active1");
		expect(container.textContent).toContain("Archived0");
		expect(container.textContent).toContain("Cube Reaction Hybrid Pro 800");
	});

	it("does not open a file whose source access is unavailable", async () => {
		mockLists();
		routing.search = { pane: "resources" };
		osWorkspacesApi.outputs.library.mockResolvedValue({
			items: [
				{
					output: outputFixture(),
					workspace: { id: WORKSPACE_ID, name: "Ops room", status: "active" },
					currentRevision: {
						id: OUTPUT_REVISION_ID,
						revision: 2,
						createdAt: "2026-08-10T10:00:00.000Z",
					},
					scope: "mine",
					preview: { kind: "unavailable", reason: "source_access_unavailable" },
				},
			],
			truncated: false,
		});
		const container = renderPage();
		await flush();
		const preview = container.querySelector("[data-workspace-output-preview]");
		expect(preview?.textContent).toContain("Source access unavailable");
		expect(
			preview?.closest("[data-resource-card]")?.getAttribute("aria-disabled"),
		).toBe("true");
		expect(
			preview?.closest("[data-resource-card]")?.querySelector("button")
				?.disabled,
		).toBe(true);
	});

	it("distinguishes an approved video deliverable from newer candidates", async () => {
		mockLists();
		routing.search = { pane: "resources" };
		const approvedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const candidateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
		osWorkspacesApi.outputs.library.mockResolvedValue({
			items: [
				{
					output: outputFixture({
						id: candidateId,
						kind: "video",
						title: "Newest quality-gated candidate",
						updatedAt: "2026-08-23T12:00:00.000Z",
					}),
					workspace: { id: WORKSPACE_ID, name: "Ops room", status: "active" },
					currentRevision: {
						id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
						revision: 1,
						createdAt: "2026-08-23T12:00:00.000Z",
					},
					scope: "mine",
					preview: {
						kind: "video",
						mimeType: "video/mp4",
						delivery: { status: "candidate", verdict: "revise", score: 45 },
					},
				},
				{
					output: outputFixture({
						id: approvedId,
						kind: "video",
						title: "Approved campaign video",
						updatedAt: "2026-08-22T12:00:00.000Z",
					}),
					workspace: { id: WORKSPACE_ID, name: "Ops room", status: "active" },
					currentRevision: {
						id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
						revision: 1,
						createdAt: "2026-08-22T12:00:00.000Z",
					},
					scope: "mine",
					preview: {
						kind: "video",
						mimeType: "video/mp4",
						delivery: { status: "approved", verdict: "pass", score: 92 },
					},
				},
			],
			truncated: false,
		});

		const container = renderPage();
		await flush();
		expect(container.textContent).toContain("Approved result");
		expect(container.textContent).toContain("Approved campaign video");
		expect(container.textContent).toContain("Latest draft");
		expect(container.textContent).toContain("Newest quality-gated candidate");
		expect(container.textContent).not.toContain("No approved result yet");
		// The judge verdict and score are readable without opening the output.
		expect(container.textContent).toContain("Needs changes · 45");
	});

	it("hides archived iterations behind an honest state filter", async () => {
		mockLists();
		routing.search = { pane: "resources" };
		const activeId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
		const archivedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		const videoLibraryItem = (
			id: string,
			title: string,
			status: "active" | "archived",
			updatedAt: string,
		) => ({
			output: outputFixture({ id, kind: "video", title, status, updatedAt }),
			workspace: { id: WORKSPACE_ID, name: "Ops room", status: "active" },
			currentRevision: { id, revision: 1, createdAt: updatedAt },
			scope: "mine" as const,
			preview: {
				kind: "video" as const,
				mimeType: "video/mp4" as const,
				delivery: { status: "candidate" as const },
			},
		});
		osWorkspacesApi.outputs.library.mockResolvedValue({
			items: [
				videoLibraryItem(
					activeId,
					"Live candidate",
					"active",
					"2026-08-25T12:00:00.000Z",
				),
				videoLibraryItem(
					archivedId,
					"Superseded iteration",
					"archived",
					"2026-08-24T12:00:00.000Z",
				),
			],
			truncated: false,
		});

		const container = renderPage();
		await flush();
		// Archived work is out of the way by default, but its count is visible.
		expect(container.textContent).toContain("Live candidate");
		expect(container.textContent).not.toContain("Superseded iteration");
		expect(container.textContent).toContain("Active1");
		expect(container.textContent).toContain("Archived1");
		expect(container.textContent).toContain("All2");

		click(findButton(container, "All"));
		expect(container.textContent).toContain("Superseded iteration");
		expect(container.textContent).toContain("Live candidate");
	});

	it("browses, switches, and starts durable Home conversations inside a workspace", async () => {
		mockLists();
		const container = renderPage();
		await flush();

		expect(
			container.querySelector('[aria-label="Conversations"]'),
		).not.toBeNull();
		expect(container.textContent).not.toContain("Workspace conversations");
		expect(container.textContent).not.toContain("Organization Home threads");
		expect(
			container
				.querySelector('[aria-label="Conversations"]')
				?.getAttribute("data-active-conversation"),
		).toBe("new");

		click(findButton(container, "Second conversation"));
		expect(
			container.querySelector('[data-chat-thread="conv-second"]'),
		).not.toBeNull();
		// The selected conversation shows the Cloudflare-style sub-header -- back
		// chevron, its OWN title, rename and delete -- not a surface label. The
		// old header said "Kernel/Home conversation" and hid back-navigation
		// behind a same-icon toggle; that contract is deliberately gone.
		expect(
			container.querySelector('[data-testid="conversation-header"]'),
		).not.toBeNull();
		expect(
			container
				.querySelector('[data-testid="conversation-header"]')
				?.getAttribute("data-conversation"),
		).toBe("conv-second");

		click(container.querySelector('[aria-label="Back to conversations"]')!);
		// Opening the list preserves the subscription and its loaded summaries.
		expect(
			container.querySelector('[data-chat-thread="conv-second"]'),
		).not.toBeNull();
		expect(
			container.querySelector('[aria-label="Conversations"]'),
		).not.toBeNull();
		click(
			[...container.querySelectorAll("button")].find(
				(button) => button.textContent?.trim() === "New",
			)!,
		);
		// "New" closes the list onto a fresh thread; the first send creates it.
		expect(container.querySelector('[aria-label="Conversations"]')).toBeNull();
		expect(container.querySelector('[data-chat-thread="new"]')).not.toBeNull();

		act(() => chatHarness.onConversationCreated?.("conv-created"));
		expect(
			container.querySelector('[data-chat-thread="conv-created"]'),
		).not.toBeNull();
	});

	it("opens a conversation carried from general Chat directly in the Workspace", async () => {
		routing.search = {
			conversation: "home:os:11111111-1111-4111-8111-111111111111",
			pane: "chat",
		};
		mockLists();
		const container = renderPage();
		await flush();

		expect(
			container.querySelector(
				'[data-chat-thread="home:os:11111111-1111-4111-8111-111111111111"]',
			),
		).not.toBeNull();
		expect(container.textContent).not.toContain("Workspace conversations");
	});

	it("opens a populated workspace on its primary workpiece", async () => {
		mockLists();
		const container = renderPage();
		await flush();

		expect(osWorkspacesApi.workspaces.list).toHaveBeenCalledWith(
			{
				status: "active",
				limit: 100,
			},
			expect.anything(),
		);
		expect(osWorkspacesApi.gadgets.list).toHaveBeenCalledWith(
			{
				workspaceId: WORKSPACE_ID,
				status: "active",
				limit: 100,
			},
			expect.anything(),
		);
		expect(osWorkspacesApi.outputs.list).toHaveBeenCalledWith(
			{ workspaceId: WORKSPACE_ID, limit: 100 },
			expect.anything(),
		);
		expect(osWorkspacesApi.resources.list).toHaveBeenCalledWith(
			{ workspaceId: WORKSPACE_ID, status: "active", limit: 100 },
			expect.anything(),
		);
		expect(osWorkspacesApi.workspacePreferences.touch).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
		});
		expect(
			container.querySelector('[aria-label="All workspaces"]'),
		).not.toBeNull();
		expect(container.textContent).toContain("Ops room");
		expect(container.textContent).toContain("Report gadget");
		expect(container.textContent).toContain("Weekly report");
		expect(
			container.querySelector('[data-output-kind="document"]'),
		).not.toBeNull();
		expect(container.querySelector(".canvas-resource-library")).toBeNull();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector('[role="tab"]')?.textContent).toContain(
			"Report gadget",
		);
		expect(container.querySelector(".canvas-chat-resizer")).not.toBeNull();
		const stage = container.querySelector(".canvas-stage");
		expect(stage?.tagName).toBe("SECTION");
		expect(stage?.getAttribute("aria-label")).toBe("Workspace workpiece");
		expect(container.querySelector(".canvas-surface main")).toBeNull();
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-mobile-pane"),
		).toBe("workpiece");
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-resource-rail-open"),
		).toBe("false");
		expect(routing.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					workpiece: `gadget:${GADGET_ID}`,
					pane: "workpiece",
				}),
				replace: true,
			}),
		);
	});

	it("opens a default app that points at an output in that output's editor", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({
				manifest: { capabilities: [], entry: `/outputs/${OUTPUT_ID}` },
			}),
		});
		renderPage();
		await flush();
		await flush();

		expect(routing.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({
					workpiece: `output:${OUTPUT_ID}`,
					pane: "workpiece",
				}),
				replace: true,
			}),
		);
	});

	it("does not reopen a linked default app after leaving the workspace", async () => {
		mockLists();
		const detail = {
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({
				manifest: { capabilities: [], entry: `/outputs/${OUTPUT_ID}` },
			}),
		};
		let resolveDetail!: (value: typeof detail) => void;
		osWorkspacesApi.gadgets.get.mockReturnValue(
			new Promise<typeof detail>((resolve) => {
				resolveDetail = resolve;
			}),
		);
		const { leave } = createPageHarness();
		await flush();
		expect(osWorkspacesApi.gadgets.get).toHaveBeenCalled();
		leave();
		routing.navigate.mockClear();
		resolveDetail(detail);
		await flush();
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	it("preserves an explicit chat-first workspace link", async () => {
		mockLists();
		routing.search = { pane: "chat" };
		const container = renderPage();
		await flush();

		// Nothing opens by itself; the canvas offers the library instead.
		expect(container.querySelector(".canvas-resource-library")).not.toBeNull();
		expect(
			container.querySelector("[data-canvas-workpiece-missing]"),
		).toBeNull();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	it("opens the workspace named by the stable workspace route", async () => {
		const linkedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		osWorkspacesApi.workspaces.list.mockResolvedValue({
			items: [
				workspaceFixture(),
				workspaceFixture({ id: linkedId, name: "Research" }),
			],
			truncated: false,
		});
		osWorkspacesApi.gadgets.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		osWorkspacesApi.outputs.list.mockResolvedValue({
			items: [],
			truncated: false,
		});

		renderPage(linkedId);
		await flush();

		expect(osWorkspacesApi.gadgets.list).toHaveBeenCalledWith(
			{
				workspaceId: linkedId,
				status: "active",
				limit: 100,
			},
			expect.anything(),
		);
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	it("does not replace an unresolved explicit workspace route with a different workspace", async () => {
		const requestedId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		osWorkspacesApi.workspaces.list.mockResolvedValue({
			items: [workspaceFixture()],
			truncated: false,
		});

		renderPage(requestedId);
		await flush();

		expect(routing.navigate).not.toHaveBeenCalled();
		expect(osWorkspacesApi.gadgets.list).not.toHaveBeenCalled();
		expect(osWorkspacesApi.outputs.list).not.toHaveBeenCalled();
	});

	it("restores a deep-linked output, view, pane, and focus state on refresh", async () => {
		routing.search = {
			workpiece: `output:${OUTPUT_ID}`,
			view: "connections",
			pane: "workpiece",
			focus: true,
		};
		mockLists();

		const container = renderPage();
		await flush();

		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("true");
		expect(container.textContent).toContain("Weekly report");
		expect(container.querySelector("[data-connections-panel]")).not.toBeNull();
		const accountConnections = container.querySelector(
			".canvas-account-connections",
		);
		expect(accountConnections).not.toBeNull();
		expect(
			accountConnections
				?.querySelector("button")
				?.getAttribute("aria-expanded"),
		).toBe("false");
		expect(accountConnections?.textContent).toContain(
			"then attach the resources you need",
		);
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-canvas-focus"),
		).toBe("true");
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	/**
	 * A shared link to a workpiece that was deleted, archived, or that lives in
	 * another workspace used to rewrite itself to `?pane=chat` and render the
	 * generic picker, so a populated project read as an empty one and the reader
	 * had no way to tell a bad link from an untouched workspace.
	 */
	it("explains an unresolvable workpiece link instead of the empty picker", async () => {
		const foreignOutputId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		routing.search = {
			workpiece: `output:${foreignOutputId}`,
			view: "activity",
			pane: "workpiece",
			focus: true,
		};
		mockLists();

		const container = renderPage();
		await flush();

		const notice = container.querySelector("[data-canvas-workpiece-missing]");
		expect(notice).not.toBeNull();
		expect(notice?.textContent).toContain(
			"This output is not in this workspace",
		);
		expect(notice?.textContent).toContain(foreignOutputId);
		expect(container.textContent).not.toContain("Pick a document");
		expect(findButton(container, "Browse this workspace")).not.toBeNull();
		expect(findButton(container, "Search all outputs")).not.toBeNull();
		// The unresolvable param still leaves the URL, and never becomes a crash.
		expect(routing.navigate).toHaveBeenCalledWith({
			search: { pane: "workpiece" },
			replace: true,
		});
	});

	it("names the gadget kind when an unresolvable link asks for one", async () => {
		const foreignGadgetId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
		routing.search = {
			workpiece: `gadget:${foreignGadgetId}`,
			pane: "workpiece",
		};
		mockLists();

		const container = renderPage();
		await flush();

		expect(
			container.querySelector("[data-canvas-workpiece-missing]")?.textContent,
		).toContain("This app is not in this workspace");
		// A gadget only ever exists inside a workspace, so the org-wide Outputs
		// library is not a path forward for one.
		expect(container.textContent).not.toContain("Search all outputs");
	});

	it("keeps the safe empty picker when no workpiece is requested at all", async () => {
		routing.search = { pane: "chat" };
		mockLists();

		const container = renderPage();
		await flush();

		expect(
			container.querySelector("[data-canvas-workpiece-missing]"),
		).toBeNull();
		expect(container.querySelector(".canvas-resource-library")).not.toBeNull();
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	/**
	 * A malformed param never reaches the page as a selection — the route
	 * validator drops it (`canvas-search.test.ts`) — so the page sees the same
	 * shape as an absent one and must keep the ordinary fallback rather than
	 * accusing the user of a bad link.
	 */
	it("keeps the safe fallback for a malformed workpiece param", async () => {
		routing.search = {
			...validateWorkspaceSearch({
				workpiece: "output:not-a-uuid",
				pane: "chat",
			}),
		};
		mockLists();

		const container = renderPage();
		await flush();

		expect(routing.search.workpiece).toBeUndefined();
		expect(
			container.querySelector("[data-canvas-workpiece-missing]"),
		).toBeNull();
		expect(container.querySelector(".canvas-resource-library")).not.toBeNull();
	});

	it("replays back-forward search snapshots without stale local selection", async () => {
		routing.search = {
			workpiece: `output:${OUTPUT_ID}`,
			pane: "workpiece",
		};
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(outputRevisionFixture().content) });
		const { container, rerender } = createPageHarness();
		await flush();
		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("true");

		routing.search = { pane: "chat" };
		rerender();
		await flush();
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-mobile-pane"),
		).toBe("chat");
		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("false");

		routing.search = {
			workpiece: `output:${OUTPUT_ID}`,
			pane: "workpiece",
		};
		rerender();
		await flush();
		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("true");
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-mobile-pane"),
		).toBe("workpiece");
	});

	it("writes typed search when an output is selected", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(outputRevisionFixture().content) });
		routing.search = { pane: "resources" };
		const container = renderPage();
		await flush();

		click(findButton(container, "Weekly report"));
		await flush();

		expect(routing.navigate).toHaveBeenLastCalledWith({
			search: {
				workpiece: `output:${OUTPUT_ID}`,
				pane: "workpiece",
			},
			replace: false,
		});
	});

	it("opens a linked first-party Gadget's output read-only until its editor is attached", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({
				manifest: {
					capabilities: ["os.outputs.read", "os.outputs.write"],
					entry: `/outputs/${OUTPUT_ID}`,
				},
			}),
		});
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		const currentRevision = outputRevisionFixture();
		mockCollab({
			initial: docJson(currentRevision.content),
		});

		const container = await openDoc("Report gadget");

		expect(
			container.querySelector(".canvas-workspace-title h1")?.textContent,
		).toBe("Report gadget");
		expect(container.querySelector("[data-canvas-output-view]")).not.toBeNull();
		expect(osWorkspacesApi.outputs.get).toHaveBeenCalledWith(
			{ outputId: OUTPUT_ID },
			// The contract-derived option forwards TanStack Query's AbortSignal, so
			// navigating away cancels the in-flight read. The hand-written queryFn
			// this replaced passed no signal at all.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(
			container.querySelector(`[data-export-buttons="${OUTPUT_ID}"]`),
		).not.toBeNull();
		expect(
			container.querySelectorAll('button[aria-label="Share"]'),
		).toHaveLength(1);
		// The open file has its own Share button, outside focus mode too.
		expect(
			container.querySelectorAll('button[aria-label="Share this file"]'),
		).toHaveLength(1);
	});

	it("previews a standard MCP Apps Gadget and preserves its source editor", async () => {
		const resourceUri = "ui://widgets/mcp-app/acme/r/orders.html";
		mockLists();
		const currentRevision = gadgetRevisionFixture({
			manifest: {
				capabilities: ["orders.read"],
				entry: resourceUri,
			},
		});
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision,
		});
		mockCollab({
			initial: docJson(currentRevision.manifest),
		});

		const container = await openDoc("Report gadget");
		const widget = container.querySelector("[data-widget-frame]");

		expect(widget?.getAttribute("data-app-slug")).toBe("acme");
		expect(widget?.getAttribute("data-resource-uri")).toBe(resourceUri);
		expect(container.textContent).not.toContain("Full app");
		expect(container.querySelector("[data-collab-editor]")).toBeNull();
		expect(
			container
				.querySelector("[data-gadget-executions]")
				?.getAttribute("data-execution-gadget-id"),
		).toBeUndefined();
		expect(findButton(container, "App").getAttribute("aria-pressed")).toBe(
			"true",
		);

		click(findButton(container, "Code"));
		expect(container.querySelector("[data-widget-frame]")).toBeNull();
		expect(container.querySelector("[data-collab-editor]")).not.toBeNull();
		expect(
			container.querySelector("[data-canvas-code-workbench]"),
		).not.toBeNull();
		expect(
			container.querySelector('[aria-label="Code files"]')?.textContent,
		).toContain("manifest.json");
		expect(container.querySelector("[data-gadget-executions]")).toBeNull();
		click(findButton(container, "README.md"));
		const readme = container.querySelector("[data-canvas-app-readme]");
		expect(readme?.textContent).toContain("What it shows");
		expect(readme?.textContent).toContain("Tedix tools: orders.read");
		expect(readme?.textContent).toContain(`Client: the view at ${resourceUri}`);
		expect(container.querySelector("[data-collab-editor]")).toBeNull();
		click(findButton(container, "manifest.json"));
		expect(container.querySelector("[data-collab-editor]")).not.toBeNull();

		click(findButton(container, "History"));
		expect(
			container
				.querySelector("[data-gadget-executions]")
				?.getAttribute("data-execution-gadget-id"),
		).toBe(GADGET_ID);

		click(findButton(container, "App"));
		expect(container.querySelector("[data-widget-frame]")).not.toBeNull();
		expect(container.querySelector("[data-gadget-executions]")).toBeNull();

		// App resources are available directly from the workpiece view switcher.
		expect(
			[
				...container.querySelectorAll(
					'[aria-label="Active workpiece view"] button',
				),
			].map((button) => button.textContent?.trim()),
		).toEqual(["App", "Code", "History", "Connections"]);
		click(findButton(container, "Connections"));
		await flush();
		expect(
			findButton(container, "Connections").getAttribute("aria-pressed"),
		).toBe("true");
		// The connections panel is a lazy chunk; run alone, it is not loaded yet.
		await vi.waitFor(() =>
			expect(
				container.querySelector("[data-connections-panel]"),
			).not.toBeNull(),
		);
		const accountConnections = container.querySelector(
			".canvas-account-connections",
		);
		expect(accountConnections).not.toBeNull();
		expect(
			accountConnections
				?.querySelector("button")
				?.getAttribute("aria-expanded"),
		).toBe("false");
		expect(accountConnections?.textContent).toContain(
			"then attach the resources you need",
		);
		expect(container.textContent).toContain(
			"required permissions and approvals",
		);
		await vi.waitFor(() =>
			expect(
				container.querySelector("[data-app-connections]")?.textContent,
			).toContain("This app uses no external resources."),
		);
		click(findButton(container, "Connect an app"));
		expect(
			accountConnections
				?.querySelector("button")
				?.getAttribute("aria-expanded"),
		).toBe("true");
		expect(
			container.querySelector(
				'.canvas-secondary-view > [data-slot="section-header"]',
			),
		).not.toBeNull();

		click(container.querySelector('[aria-label="Workspace actions"]')!);
		await flush();
		click(findMenuItem("Review changes"));
		await flush();
		expect(container.textContent).toContain("Review changes");
		expect(container.textContent).toContain(
			"Your saved version stays unchanged until you apply a change",
		);
		expect(container.querySelector("#canvas-proposals-title")).not.toBeNull();
		expect(
			container
				.querySelector("#canvas-proposals-title")
				?.closest(".canvas-secondary-view"),
		).not.toBeNull();
		expect(container.textContent).toContain(
			"Check suggested edits, then approve and apply them",
		);

		click(findButton(container, "App"));
		expect(container.querySelector("[data-widget-frame]")).not.toBeNull();
	});

	it("directs built-in card review runs to scheduled skills instead of dispatch", async () => {
		mockLists();
		const currentRevision = gadgetRevisionFixture({
			manifest: {
				capabilities: [],
				entry: "tedix:app/card-review",
				config: {
					version: 1,
					sources: [
						{
							label: "Social",
							workspaceId: WORKSPACE_ID,
							cardSheetPrefix: "Social cards ",
							maxRuns: 2,
							columns: {
								source: "Source",
								why: "Why",
								useful: "Useful?",
								reason: "Reason",
								done: "Done?",
							},
							doIt: "copy_and_open",
						},
					],
				},
			},
		});
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision,
		});
		mockCollab({ initial: docJson(currentRevision.manifest) });
		routing.search = {
			workpiece: `gadget:${GADGET_ID}`,
			pane: "workpiece",
			view: "history",
		};
		const container = renderPage();
		await flush();

		expect(container.querySelector("[data-gadget-executions]")).toBeNull();
		expect(container.textContent).toContain("Cards come from scheduled skills");
		click(findButton(container, "Open Files"));
		expect(routing.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ pane: "resources" }),
			}),
		);
	});

	it("points built-in app history guidance at the App and Files controls", async () => {
		mockLists();
		const currentRevision = gadgetRevisionFixture({
			manifest: {
				capabilities: [],
				entry: "tedix:app/activity-feed",
				config: { version: 1, scope: "organization", projects: [] },
			},
		});
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision,
		});
		mockCollab({ initial: docJson(currentRevision.manifest) });
		routing.search = {
			workpiece: `gadget:${GADGET_ID}`,
			pane: "workpiece",
			view: "history",
		};
		const container = renderPage();
		await flush();

		expect(container.querySelector("[data-gadget-executions]")).toBeNull();
		expect(container.textContent).toContain("Activity comes from linked Work");
		expect(container.textContent).toContain(
			"Open App to see activity. Each item keeps its history with its originating Work.",
		);
		expect(container.textContent).not.toContain("Open Preview");
		expect(container.textContent).not.toContain("Open Resources");
		click(findButton(container, "Open Files"));
		expect(routing.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ pane: "resources" }),
			}),
		);
	});

	it("keeps the code room's connection out of a runtime app's App view", async () => {
		mockLists();
		const currentRevision = gadgetRevisionFixture({
			manifest: {
				capabilities: [],
				entry: "tedix:runtime/v1",
				config: { version: 1, settings: { slot: "sheet", editor: "sheet-v2" } },
			},
		});
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision,
		});
		// Between reconnect attempts the code room reports "disconnected"; the
		// sheet itself saves through its output and is unaffected.
		mockCollab({
			status: "disconnected",
			initial: docJson(currentRevision.manifest),
		});
		routing.search = { workpiece: `gadget:${GADGET_ID}`, pane: "workpiece" };
		const container = renderPage();
		await flush();

		expect(
			container.querySelector("[data-app-runtime-preview]"),
		).not.toBeNull();
		const status = container.querySelector(".canvas-document-status");
		expect(status?.classList.contains("hidden!")).toBe(true);

		// Edit view is where the code room matters, so its state shows there.
		routing.search = {
			workpiece: `gadget:${GADGET_ID}`,
			pane: "workpiece",
			view: "edit",
		};
		const edit = renderPage();
		await flush();
		expect(
			edit
				.querySelector(".canvas-document-status")
				?.classList.contains("hidden!"),
		).toBe(false);
		expect(
			edit.querySelector('[data-connection="disconnected"]'),
		).not.toBeNull();
	});

	it("keeps a non-resource Gadget in source mode", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		const currentRevision = gadgetRevisionFixture();
		mockCollab({
			initial: docJson(currentRevision.manifest),
		});

		const container = await openDoc("Report gadget");

		expect(container.querySelector("[data-collab-editor]")).not.toBeNull();
		expect(container.querySelector("[data-widget-frame]")).toBeNull();
		expect(container.textContent).not.toContain("Saved app");
		// Save sits beside the manifest it saves, not in a footer of its own.
		expect(
			findButton(container, "Save").closest("[data-canvas-code-save]"),
		).not.toBeNull();
		expect(
			container.querySelector('[data-slot="output-workshop-footer"]'),
		).toBeNull();
	});

	it("shows the empty state when no workspaces exist", async () => {
		osWorkspacesApi.workspaces.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		const container = renderPage();
		await flush();
		expect(container.textContent).toContain("No workspaces yet");
		expect(
			container
				.querySelector('[data-slot="empty"]')
				?.getAttribute("data-appearance"),
		).toBe("quiet");
		expect(osWorkspacesApi.gadgets.list).not.toHaveBeenCalled();
	});
});

describe("Canvas Cloudflare-reference composition", () => {
	it("keeps selected workpiece tabs and the embedded transcript borderless", () => {
		const styles =
			readFileSync("src/components/canvas-page.css", "utf8") +
			readFileSync("src/components/output-views.css", "utf8");
		expect(styles).toMatch(
			/\.canvas-workpiece-tab\[data-selected\][\s\S]*?background:\s*var\(--color-kumo-tint\);/,
		);
		expect(styles).toMatch(
			/\.canvas-chat-thread \[data-slot="conversation-transcript"\][\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/,
		);
		expect(styles).toMatch(/\.canvas-chat-thread\s*\{[\s\S]*?padding:\s*16px;/);
		expect(styles).toMatch(/\.canvas-workbench\s*\{[^}]*?overflow:\s*clip;/);
		expect(styles).toMatch(
			/\.canvas-chat-header\s*\{[\s\S]*?height:\s*48px;[\s\S]*?min-height:\s*48px;/,
		);
		expect(styles).toMatch(
			/\.canvas-workpiece-bar\s*\{[\s\S]*?height:\s*48px;[\s\S]*?min-height:\s*48px;/,
		);
		expect(styles).toMatch(
			/\.canvas-stage-content\[data-has-workpiece\]\s*\{[\s\S]*?padding:\s*0;/,
		);
		expect(styles).toMatch(
			/\.canvas-document-header\s*\{[\s\S]*?padding:\s*4px 8px;[\s\S]*?border-bottom:\s*1px solid var\(--border\);/,
		);
		expect(styles).toMatch(
			/\.editor-toolbar\s*\{[\s\S]*?min-height:\s*48px;[\s\S]*?padding:\s*8px 16px;[\s\S]*?border-radius:\s*0;/,
		);
		expect(styles).toMatch(
			/\.editor-toolbar > \[data-kumo-component="Toolbar"\]\s*\{[\s\S]*?gap:\s*8px;/,
		);
		/*
		 * Scoped to `[data-toolbar-control="icon"]` on purpose: the paragraph-style
		 * and font-family Selects are also direct `button` children of the Toolbar,
		 * so the unscoped rule this used to assert crushed them to 28x28 and hid
		 * their labels. Keep the square-target guarantee, keep it off the Selects.
		 */
		expect(styles).toMatch(
			// Descendant, not direct child: Kumo wraps a DISABLED toolbar button in a
			// tooltip <span>, and the `>` form this used to assert dropped those out
			// of the rule, leaving disabled icons at the 26px Kumo default beside
			// 28px enabled ones. `data-toolbar-control` is what keeps a Select
			// trigger out, so the combinator was never the guard.
			/\.editor-toolbar\s*\[data-kumo-component="Toolbar"\]\s*button\[data-toolbar-control="icon"\]\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border-radius:\s*6px;/,
		);
		expect(styles).not.toMatch(
			/\[data-kumo-component="Toolbar"\]\s*> button\s*\{/,
		);
		const resizerRule = styles.match(
			/^\.canvas-chat-resizer\s*\{([^}]*)\}/m,
		)?.[1];
		expect(resizerRule).toBeDefined();
		expect(resizerRule).toContain("width: 1px");
		expect(resizerRule).not.toContain("z-index");
		expect(styles).toMatch(
			/\.canvas-chat-resizer::after\s*\{[\s\S]*?right:\s*-6px;[\s\S]*?left:\s*-6px;/,
		);
	});

	it("keeps a 44px hit target on the workspace chrome through the tablet widths", () => {
		const styles = readFileSync("src/components/canvas-page.css", "utf8");
		const tablet = styles.match(
			/@media \(max-width: 819px\) \{([\s\S]*?)\n\}/,
		)?.[1];
		expect(tablet).toBeDefined();
		expect(tablet).toMatch(
			/\.canvas-workspace-header button,[\s\S]*?\.canvas-workpiece-bar button\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/,
		);
		expect(tablet).toMatch(
			/\.canvas-workpiece-bar\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*48px;/,
		);
	});
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe("room seeding and shared text", () => {
	it("shows a peer's change in the editor", async () => {
		mockLists();
		const currentRevision = gadgetRevisionFixture();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision,
		});
		const session = mockCollab({ initial: docJson(currentRevision.manifest) });

		const container = await openDoc("Report gadget");
		const peerManifest = { capabilities: ["kernel.read"], entry: "main.tsx" };
		await act(async () => {
			session.remote(docJson(peerManifest));
			await flush();
		});

		expect(container.querySelector("[data-collab-editor]")?.textContent).toBe(
			docJson(peerManifest),
		);
	});
});

describe("agent proposal review", () => {
	it("requires and submits an auditable rationale before acceptance", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		osWorkspacesApi.collaboration.list.mockResolvedValue({
			items: [proposalFixture()],
			truncated: false,
		});
		osWorkspacesApi.collaboration.accept.mockResolvedValue({
			proposal: proposalFixture({
				status: "accepted",
				decisionRationale: "Evidence supports this edit",
			}),
		});
		mockCollab();
		const container = await openDoc("Weekly report");

		expect(container.textContent).toContain("Suggested changes");
		expect(container.textContent).toContain("Needs review");
		const suggestion = container.querySelector(
			'[aria-label="Suggested changes"]',
		);
		const detailsTrigger = [
			...(suggestion?.querySelectorAll("button[aria-expanded]") ?? []),
		].find((button) => button.textContent === "Technical details");
		expect(detailsTrigger?.getAttribute("aria-expanded")).toBe("false");
		const details = detailsTrigger?.parentElement;
		expect(details?.textContent).toContain("codex:session-1");
		const comparison = [
			...(suggestion?.querySelectorAll("button[aria-expanded]") ?? []),
		].find((item) => item.textContent === "Compare changes");
		expect(comparison).toBeDefined();
		expect(comparison?.getAttribute("aria-expanded")).toBe("false");
		expect(
			comparison?.parentElement?.querySelector(
				'[aria-label="Proposed change"]',
			),
		).not.toBeNull();
		expect(
			suggestion?.querySelector('[data-slot="card-title"]')?.textContent,
		).toBe("Suggested change 1");
		expect(container.textContent).toContain("agent preview");
		const accept = findButton(container, "Approve change") as HTMLButtonElement;
		expect(accept.disabled).toBe(true);
		setFieldValue(
			fieldByLabel(container, "Reason for change 1"),
			"Evidence supports this edit",
		);
		expect(accept.disabled).toBe(false);
		click(accept);
		await flush();

		expect(osWorkspacesApi.collaboration.accept).toHaveBeenCalledWith({
			proposalId: PROPOSAL_ID,
			expectedSequence: 3,
			rationale: "Evidence supports this edit",
			evidenceRefs: [],
		});
	});
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commit(container: HTMLElement) {
	click(findButton(container, "Save"));
	click(findButton(container, "Save now"));
	await flush();
}

describe("gadget commit", () => {
	it("sends the parsed manifest with the loaded revision as the CAS guard", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 3 }),
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 4 }),
		});
		const currentRevision = gadgetRevisionFixture({ revision: 3 });
		const session = mockCollab({
			initial: docJson(currentRevision.manifest),
		});
		const edited = { capabilities: ["kernel.read"], entry: "main.tsx" };
		// The editor writes through the session; the panel commits what the
		// session holds, which is what every peer is looking at.
		session.remote(JSON.stringify(edited));

		const container = await openDoc("Report gadget");
		await commit(container);

		expect(osWorkspacesApi.gadgets.revise).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			manifest: edited,
			expectedRevision: 3,
		});
		expect(container.textContent).toContain("Saved version 4.");
	});

	it("guards an unrevised gadget with expectedRevision 0", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture({ currentRevisionId: null }),
			currentRevision: null,
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 1 }),
		});
		mockCollab({ initial: docJson(DEFAULT_GADGET_MANIFEST) });

		const container = await openDoc("Report gadget");
		await commit(container);

		expect(osWorkspacesApi.gadgets.revise).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			manifest: DEFAULT_GADGET_MANIFEST,
			expectedRevision: 0,
		});
	});

	it("renders the reload-and-retry alert on a lost CAS and refetches the detail", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		osWorkspacesApi.gadgets.revise.mockRejectedValue({
			code: "CONFLICT",
			data: { expectedRevision: 3, currentRevision: 4 },
		});
		mockCollab({ initial: docJson(gadgetRevisionFixture().manifest) });

		const container = await openDoc("Report gadget");
		const getCallsBefore = osWorkspacesApi.gadgets.get.mock.calls.length;
		await commit(container);

		expect(container.textContent).toContain("Someone saved a newer version");
		expect(container.textContent).toContain(
			"Your changes were not saved and are still here",
		);
		expect(osWorkspacesApi.gadgets.get.mock.calls.length).toBeGreaterThan(
			getCallsBefore,
		);
	});
});

describe("commit pins the compare-and-swap to the ROOM, not the query", () => {
	it("pins a gadget commit to the room's revision when a newer one landed out of band", async () => {
		mockLists();
		// THE FOUR STEPS. (1) The room seeded at revision 5 and is grounded there.
		// (2) Revision 6 landed out of band -- a CanvasProposals merge, a tedi tool
		// edit, the API. (3) The document query refetched and now reports 6.
		// (4) The user commits.
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 6 }),
		});
		osWorkspacesApi.gadgets.revise.mockRejectedValue({
			code: "CONFLICT",
			data: { expectedRevision: 5, currentRevision: 6 },
		});
		const session = mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 5 }).manifest),
			canonicalRevision: 5,
		});
		session.remote(
			docJson({ capabilities: ["kernel.read"], entry: "main.tsx" }),
		);

		const container = await openDoc("Report gadget");
		await commit(container);

		// Pinned to the QUERY, this commit would carry `expectedRevision: 6`, the
		// compare-and-swap would PASS, and revision 7 would be written from
		// revision-5 text with revision 6 destroyed -- silently and permanently.
		// The `unchanged` content hash does not catch it: the text genuinely
		// differs. Pinned to the ROOM, it carries 5 and the store refuses.
		expect(osWorkspacesApi.gadgets.revise).toHaveBeenCalledWith(
			expect.objectContaining({ expectedRevision: 5 }),
		);
		expect(container.textContent).toContain("Someone saved a newer version");
		expect(container.textContent).toContain(
			"Your changes were not saved and are still here",
		);
	});

	it("commits the SESSION's text, not a copy the panel happens to be holding", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 3 }),
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 4 }),
		});
		const session = mockCollab({
			initial: docJson(gadgetRevisionFixture().manifest),
		});
		const container = await openDoc("Report gadget");

		// A LOCAL keystroke: the editor writes straight through the session and
		// nothing republishes, so the panel's own `docText` mirror still holds the
		// text from before. A commit path that reads that mirror instead of the
		// session commits STALE TEXT for every gadget edit -- and every existing
		// test passes, because they all drive changes through `remote`, which does
		// republish.
		const typed = { capabilities: ["kernel.read"], entry: "typed.tsx" };
		act(() => {
			session.applyLocal(
				[[COLLAB_DOC_PATH, { set: docJson(typed) }]],
				COLLAB_DOC_PATH,
				docJson(typed),
			);
		});
		await commit(container);

		expect(osWorkspacesApi.gadgets.revise).toHaveBeenCalledWith(
			expect.objectContaining({ manifest: typed }),
		);
	});
});

describe("grounding a commit", () => {
	it("re-grounds the room on the revision the commit produced, from the basis it was written at", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 3 }),
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 4 }),
		});
		mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 3 }).manifest),
		});
		collabCommit.basis = {
			text: docJson(gadgetRevisionFixture({ revision: 3 }).manifest),
			position: { generation: 0, revision: 7 },
		};

		const container = await openDoc("Report gadget");
		await commit(container);

		// WITHOUT THIS the room stays grounded on revision 3, and the moment the
		// query refetches revision 4 the room refuses it -- the panel then says the
		// shared source is "behind" a revision the room itself just wrote, blocks
		// Commit, and offers only a replacement that discards everything typed
		// since. The basis is what makes the claim checkable server-side.
		expect(collabCommit.groundCommit).toHaveBeenCalledTimes(1);
		expect(collabCommit.groundCommit).toHaveBeenCalledWith(
			collabCommit.basis,
			4,
			gadgetRevisionFixture({ revision: 4 }).id,
		);
	});

	it("never commits without a basis: Commit waits while the room is still saving", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 3 }),
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 4 }),
		});
		// The client holds unacknowledged edits, so no stream position describes the text on
		// screen. COMMITTING ANYWAY IS THE WEDGE: the revision lands, the room stays grounded on
		// the one it superseded, the refetch is refused as `edited`, and the only action left is
		// the destructive Replace -- which a reload does not clear, because a fresh session
		// re-observes the same stamp.
		mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 3 }).manifest),
			unacknowledged: true,
		});

		const container = await openDoc("Report gadget");

		expect(findButton(container, "Save").disabled).toBe(true);
		// Transient and self-clearing, and it READS that way: not a refusal, not a dead button.
		expect(container.textContent).toContain("Sending your latest edits…");
		expect(
			container.querySelector("[data-canvas-commit-waiting]"),
		).not.toBeNull();
		// Nothing was written, so there is nothing to be wedged on...
		expect(osWorkspacesApi.gadgets.revise).not.toHaveBeenCalled();
		expect(collabCommit.groundCommit).not.toHaveBeenCalled();
		// ...and the user is NOT looking at a destructive escape.
		expect(container.querySelector("[data-canonical-recovery]")).toBeNull();
		expect(container.textContent).not.toContain("is behind revision");
	});

	it("refuses a commit whose basis vanished between the render and the click", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 3 }),
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 4 }),
		});
		// Commit is ENABLED: as far as the last render knew, nothing was unacknowledged. A keystroke
		// landed between that render and the click, so the basis is gone by the time it is taken.
		mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 3 }).manifest),
		});
		collabCommit.basis = null;

		const container = await openDoc("Report gadget");
		expect(findButton(container, "Save").disabled).toBe(false);
		await commit(container);

		// The read and this decision sit in ONE await-free span, so the commit cannot slip past on
		// a value that was true a moment ago. Nothing is written, and the answer is "in a moment".
		expect(osWorkspacesApi.gadgets.revise).not.toHaveBeenCalled();
		expect(collabCommit.groundCommit).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Sending your latest edits…");
	});

	it("commits with a basis the moment the room acknowledges, so typing cannot livelock Commit", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 3 }),
		});
		osWorkspacesApi.gadgets.revise.mockResolvedValue({
			gadget: gadgetFixture(),
			revision: gadgetRevisionFixture({ revision: 4 }),
		});
		const session = mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 3 }).manifest),
			unacknowledged: true,
		});
		const container = await openDoc("Report gadget");
		expect(findButton(container, "Save").disabled).toBe(true);

		// THE ACK LANDS. It is one round trip, not a queue: submissions COMPOSE, so everything
		// typed since the last acknowledgement rides a single submission however fast the user
		// types, and the wait cannot grow without bound.
		const typed = { capabilities: ["kernel.read"], entry: "typed.tsx" };
		const basis = {
			text: docJson(typed),
			position: { generation: 0, revision: 9 },
		};
		collabCommit.basis = basis;
		act(() => {
			collabCommit.unacknowledged = false;
			session.remote(docJson(typed));
		});

		expect(container.textContent).not.toContain("Sending your latest edits…");
		expect(findButton(container, "Save").disabled).toBe(false);
		await commit(container);

		// And the commit that follows carries the basis, so the room is re-grounded on the
		// revision it produced and never asks the user to resolve its own work.
		expect(osWorkspacesApi.gadgets.revise).toHaveBeenCalledTimes(1);
		expect(collabCommit.groundCommit).toHaveBeenCalledWith(
			basis,
			4,
			gadgetRevisionFixture({ revision: 4 }).id,
		);
		expect(container.textContent).toContain("Saved version 4.");
	});
});

describe("live-draft status the panel renders", () => {
	it("says the draft is syncing while unacknowledged edits are stuck", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({
			initial: docJson(gadgetRevisionFixture().manifest),
			unsynced: true,
		});

		const container = await openDoc("Report gadget");

		expect(container.textContent).toContain("Draft · Syncing…");
	});

	it("keeps the draft status quiet when nothing is stuck", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({ initial: docJson(gadgetRevisionFixture().manifest) });

		const container = await openDoc("Report gadget");

		expect(container.textContent).not.toContain("Draft ·");
		expect(findButton(container, "Save")).toBeTruthy();
	});

	it("warns, once, that unsent edits were discarded and the draft rebuilt", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({
			initial: docJson(gadgetRevisionFixture().manifest),
			discarded: 2,
		});

		const container = await openDoc("Report gadget");

		// OT cannot merge a stale local edit, so the client rebuilds from the room
		// and the user must be told rather than silently losing keystrokes.
		expect(container.textContent).toContain("Unsent edits were discarded");
		expect(container.textContent).toContain(
			"The document below is what every connected editor now sees",
		);
	});

	it("says the same thing about unsent edits in both places at once", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		// `capacity` IMPLIES an unacknowledged submission -- it is a refusal OF one -- so these
		// two render together, one above the other, describing the same keystrokes. They must
		// not contradict each other. The capacity copy used to promise the edits "will be sent
		// as soon as the room recovers" while the footer, correctly, said a dropped connection
		// discards them; a user reading both learns only that the product does not know.
		mockCollab({
			initial: docJson(gadgetRevisionFixture().manifest),
			unacknowledged: true,
			blocked: { code: "capacity", message: CAPACITY_MESSAGE },
		});

		const container = await openDoc("Report gadget");

		expect(container.textContent).toContain("Editing is paused");
		expect(container.textContent).toContain(CAPACITY_MESSAGE);
		expect(container.textContent).toContain("Sending your latest edits…");
		// Neither promises an outcome the transport does not guarantee, and BOTH name the one
		// condition that loses the edits -- in the same words, because it is the same condition.
		expect(CAPACITY_MESSAGE).not.toMatch(/will be sent/i);
		expect(
			container.textContent?.match(
				/If the connection drops first, they are discarded\./g,
			),
		).toHaveLength(2);
	});

	it("says nothing about discarded edits when none were", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({ initial: docJson(gadgetRevisionFixture().manifest) });

		const container = await openDoc("Report gadget");

		expect(container.textContent).not.toContain("Unsent edits were discarded");
	});
});

describe("adopting a newer canonical revision", () => {
	it("just works for an unedited room: no warning, no recovery, Commit live", async () => {
		mockLists();
		// The server carried the room forward as one ordinary change and told this
		// client its new grounding. There is nothing for the user to resolve.
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 6 }),
		});
		mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 6 }).manifest),
			canonicalRevision: 6,
		});

		const container = await openDoc("Report gadget");

		expect(container.querySelector("[data-canonical-recovery]")).toBeNull();
		expect(container.textContent).not.toContain("is behind revision");
		expect(findButton(container, "Save").disabled).toBe(false);
	});

	it("never silently replaces an edited room: it blocks Commit and requires two steps", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture({ revision: 6 }),
		});
		mockCollab({
			initial: docJson(gadgetRevisionFixture({ revision: 5 }).manifest),
			canonicalRevision: 5,
			recoveryRequired: true,
		});

		const container = await openDoc("Report gadget");

		expect(container.textContent).toContain(
			"A newer version (v6) was saved while you were editing",
		);
		// The room's text is preserved and NOT committable on top of revision 6.
		expect(findButton(container, "Save").disabled).toBe(true);

		// Two steps, and the destructive one is never the first thing on screen.
		expect(() =>
			findButton(container, "Discard my changes and load v6"),
		).toThrow();
		click(findButton(container, "Load v6"));
		expect(replaceWithCanonical).not.toHaveBeenCalled();
		click(findButton(container, "Discard my changes and load v6"));

		// One user-driven replacement, which lands as an ordinary server-authored
		// change so peers see the document converge rather than being reset.
		expect(replaceWithCanonical).toHaveBeenCalledTimes(1);
	});

	it("keeps the editor mounted and read-only across a transient disconnect", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({
			initial: docJson(gadgetRevisionFixture().manifest),
			status: "disconnected",
			peers: 0,
		});

		const container = await openDoc("Report gadget");

		// The document stays legible and the editor stays mounted -- a blip must
		// not destroy the user's cursor and scroll. It is READ-ONLY while the room
		// cannot accept anything, and Commit waits for a live room.
		const editor = container.querySelector("[data-collab-editor]");
		expect(editor?.textContent).toBe(docJson(gadgetRevisionFixture().manifest));
		expect(editor?.getAttribute("data-read-only")).toBe("true");
		expect(findButton(container, "Save").disabled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Chat-first workspace (simpleMode): the Workshop first-message experience
// ---------------------------------------------------------------------------

/** A workspace with no gadget and no output yet: exactly the first-send case. */
function mockEmptyWorkspace() {
	mockLists();
	osWorkspacesApi.gadgets.list.mockResolvedValue({
		items: [],
		truncated: false,
	});
	osWorkspacesApi.outputs.list.mockResolvedValue({
		items: [],
		truncated: false,
	});
	osWorkspacesApi.outputs.library.mockResolvedValue({
		items: [],
		truncated: false,
	});
}

describe("isCanvasSimpleMode", () => {
	const base = {
		documentsLoaded: true,
		documentCount: 0,
		requestedDoc: null,
		requestedPane: undefined,
		unresolvedWorkpiece: null,
	};
	const doc: CanvasDocSelection = { type: "output", id: OUTPUT_ID };

	it("is the document-less workspace with no explicit URL choice", () => {
		expect(isCanvasSimpleMode(base)).toBe(true);
	});

	it.each([
		["lists still loading", { documentsLoaded: false }],
		["any document", { documentCount: 1 }],
		["an explicit workpiece", { requestedDoc: doc }],
		["an explicit pane", { requestedPane: "chat" as const }],
		["an unresolved ?workpiece=", { unresolvedWorkpiece: doc }],
	])("opts out for %s", (_label, override) => {
		expect(isCanvasSimpleMode({ ...base, ...override })).toBe(false);
	});
});

describe("clampCanvasChatWidth viewport floor", () => {
	it("never lets the chat squeeze the stage below its floor", () => {
		expect(clampCanvasChatWidth(480, 700)).toBe(700 - CANVAS_STAGE_MIN_WIDTH);
		// The floor never pushes below the chat minimum on a tiny viewport.
		expect(clampCanvasChatWidth(480, 500)).toBe(CANVAS_CHAT_WIDTH_MIN);
		// A wide viewport keeps the ordinary cap.
		expect(clampCanvasChatWidth(9_999, 3_000)).toBe(CANVAS_CHAT_WIDTH_MAX);
		expect(clampCanvasChatWidth(CANVAS_CHAT_WIDTH_DEFAULT, 1_024)).toBe(
			CANVAS_CHAT_WIDTH_DEFAULT,
		);
	});
});

describe("CanvasPage chat-first workspace", () => {
	it("offers concrete next steps in an empty workspace overview", async () => {
		mockEmptyWorkspace();
		routing.search = { pane: "resources" };
		const container = renderPage();
		await flush();

		const overview = container.querySelector(".canvas-resource-library-header");
		expect(overview?.textContent).toContain("Choose New to create a document");
		expect(overview?.textContent).toContain("upload a file, or add a source");
		expect(overview?.textContent).toContain("ask this workspace to help");
	});

	it("gives chat the whole workbench and collapses the stage on a fresh workspace", async () => {
		mockEmptyWorkspace();
		routing.search = {
			conversation: "home:os:11111111-1111-4111-8111-111111111111",
		};
		const container = renderPage();
		const surface = container.querySelector(".canvas-surface");
		// Motion is for the later reveal: nothing is armed on first paint…
		expect(surface?.getAttribute("data-canvas-transition")).toBe("false");
		await flush();

		expect(surface?.getAttribute("data-simple-mode")).toBe("true");
		// …and it arms once the empty lists have painted, so the first
		// document's arrival animates the stage in.
		expect(surface?.getAttribute("data-canvas-transition")).toBe("true");

		const chat = container.querySelector(".canvas-chat-pane") as HTMLElement;
		expect(chat.getAttribute("data-simple-mode")).toBe("true");
		// The closed pane is one state, and the stylesheet sizes it.
		expect(surface?.getAttribute("data-stage-open")).toBe("false");
		const resizer = container.querySelector(".canvas-chat-resizer");
		expect(resizer?.getAttribute("aria-hidden")).toBe("true");
		expect(resizer?.getAttribute("tabindex")).toBe("-1");

		const stage = container.querySelector(".canvas-stage") as HTMLElement;
		expect(stage.getAttribute("aria-hidden")).toBe("true");
		expect(stage.hasAttribute("inert")).toBe(true);
		expect(stage.getAttribute("style")).toBeNull();
		// A fresh workspace has nothing to pick, so it never says so.
		expect(container.textContent).not.toContain("Pick a document");
		// The URL-carried conversation lands in the thread, not the list.
		expect(
			container.querySelector(
				'[data-chat-thread="home:os:11111111-1111-4111-8111-111111111111"]',
			),
		).not.toBeNull();
		expect(container.textContent).not.toContain("Workspace conversations");
		expect(routing.navigate).not.toHaveBeenCalled();
	});

	it("keeps the split layout, and the resizer, once the workspace has a document", async () => {
		mockLists();
		const container = renderPage();
		await flush();

		const surface = container.querySelector(".canvas-surface");
		expect(surface?.getAttribute("data-simple-mode")).toBe("false");
		expect(surface?.getAttribute("data-canvas-transition")).toBe("true");
		const chat = container.querySelector(".canvas-chat-pane") as HTMLElement;
		expect(surface?.getAttribute("data-stage-open")).toBe("true");
		expect(chat.style.getPropertyValue("--canvas-chat-width")).toBe(
			`${CANVAS_CHAT_WIDTH_DEFAULT}px`,
		);
		expect(
			container.querySelector(".canvas-chat-resizer")?.getAttribute("tabindex"),
		).toBe("0");
		expect(
			container.querySelector(".canvas-stage")?.getAttribute("aria-hidden"),
		).toBeNull();
	});

	it("removes the inert boundary when revealing the workpiece and restores it when hidden", async () => {
		mockEmptyWorkspace();
		const { container, rerender } = createPageHarness();
		await flush();
		const stage = container.querySelector(".canvas-stage") as HTMLElement;
		expect(stage.hasAttribute("inert")).toBe(true);

		routing.search = { pane: "workpiece" };
		rerender();
		await flush();
		expect(container.querySelector(".canvas-stage")).toBe(stage);
		expect(stage.hasAttribute("aria-hidden")).toBe(false);
		expect(stage.hasAttribute("inert")).toBe(false);

		routing.search = {};
		rerender();
		await flush();
		expect(container.querySelector(".canvas-stage")).toBe(stage);
		expect(stage.getAttribute("aria-hidden")).toBe("true");
		expect(stage.hasAttribute("inert")).toBe(true);
	});

	it("respects an explicit pane on a fresh workspace without inventing a document to pick", async () => {
		mockEmptyWorkspace();
		routing.search = { pane: "chat" };
		const container = renderPage();
		await flush();

		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-simple-mode"),
		).toBe("false");
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-stage-open"),
		).toBe("true");
		expect(container.textContent).not.toContain("Pick a document");
	});

	it("starts a conversation from the list composer without writing a pane override", async () => {
		mockEmptyWorkspace();
		const container = renderPage();
		await flush();
		expect(
			container.querySelector('[aria-label="Conversations"]'),
		).not.toBeNull();
		expect(container.textContent).not.toContain("Workspace conversations");
		const thread = container.querySelector('[data-chat-thread="new"]');
		act(() => chatHarness.onSelect?.(null));
		expect(container.querySelector('[aria-label="Conversations"]')).toBeNull();
		expect(container.querySelector('[data-chat-thread="new"]')).toBe(thread);
		const afterNew = routing.navigate.mock.calls.at(-1)?.[0].search;
		expect(afterNew?.conversation).toBeUndefined();
		expect(afterNew?.pane).toBeUndefined();

		act(() => chatHarness.onConversationCreated?.("conv-created"));
		expect(container.querySelector('[data-chat-thread="conv-created"]')).toBe(
			thread,
		);
		expect(
			container.querySelector('[data-chat-thread="conv-created"]'),
		).not.toBeNull();
		expect(routing.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ conversation: "conv-created" }),
			}),
		);
		const written = routing.navigate.mock.calls.at(-1)?.[0].search;
		expect(written.pane).toBeUndefined();
		// Still chat-first: no pane in the URL means the stage stays collapsed.
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-simple-mode"),
		).toBe("true");
	});
});

// ---------------------------------------------------------------------------
// The item pane opens and closes beside the chat
// ---------------------------------------------------------------------------

describe("canvas stage closed memory", () => {
	it("remembers the closed pane per workspace and forgets it on open", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
			removeItem: (key: string) => void values.delete(key),
		};
		expect(restoreCanvasStageClosed(storage, "one")).toBeNull();
		persistCanvasStageClosed(storage, "one", "output:abc");
		expect(restoreCanvasStageClosed(storage, "one")).toBe("output:abc");
		expect(restoreCanvasStageClosed(storage, "two")).toBeNull();
		persistCanvasStageClosed(storage, "one", null);
		expect(restoreCanvasStageClosed(storage, "one")).toBeNull();
	});

	it("treats unavailable storage as an open pane", () => {
		const broken = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		expect(restoreCanvasStageClosed(broken, "one")).toBeNull();
		expect(() => persistCanvasStageClosed(broken, "one", "")).not.toThrow();
		expect(restoreCanvasStageClosed(null, "one")).toBeNull();
	});
});

describe("CanvasPage item pane", () => {
	const stageOpen = (container: Element) =>
		container.querySelector(".canvas-surface")?.getAttribute("data-stage-open");
	const closeButton = (container: Element) =>
		container.querySelector('.canvas-workpiece-bar [aria-label="Close"]')!;

	async function openWeeklyReport() {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(outputRevisionFixture().content) });
		return openDoc("Weekly report");
	}

	it("closes with the Close button, keeps the tabs, and reopens the same item from Files", async () => {
		const container = await openWeeklyReport();
		const editor = container.querySelector("[data-canvas-output-view]");
		expect(editor).not.toBeNull();
		expect(stageOpen(container)).toBe("true");

		click(closeButton(container));
		expect(stageOpen(container)).toBe("false");
		const stage = container.querySelector(".canvas-stage") as HTMLElement;
		expect(stage.hasAttribute("inert")).toBe(true);
		expect(stage.getAttribute("aria-hidden")).toBe("true");
		// The tab and the item stay mounted behind the closed pane.
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector("[data-canvas-output-view]")).toBe(editor);
		// Without a composer in this harness, focus lands on the item's Files row.
		expect(document.activeElement).toBe(
			filesPanelRow(container, "Weekly report"),
		);

		click(filesPanelRow(container, "Weekly report"));
		await flush();
		expect(stageOpen(container)).toBe("true");
		expect(stage.hasAttribute("inert")).toBe(false);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector("[data-canvas-output-view]")).toBe(editor);
		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("closes the pane when the last tab closes, then drops the tab", async () => {
		const container = await openWeeklyReport();
		const tabClose = container.querySelector(
			`[aria-label="Close Weekly report (Document, ${OUTPUT_ID})"]`,
		)!;
		routing.navigate.mockClear();

		click(tabClose);
		// The pane closes around the item; the library does not swap in.
		expect(stageOpen(container)).toBe("false");
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector("[data-canvas-output-view]")).not.toBeNull();
		expect(routing.navigate).not.toHaveBeenCalled();

		await act(async () => {
			await new Promise((resolve) =>
				setTimeout(resolve, CANVAS_STAGE_CLOSE_SETTLE_MS + 50),
			);
		});
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		expect(stageOpen(container)).toBe("false");
		expect(routing.navigate).toHaveBeenLastCalledWith(
			expect.objectContaining({ search: { conversation: undefined } }),
		);

		// The library is still one click away, and it opens the pane.
		click(container.querySelector("[data-workspace-outputs-library]")!);
		await flush();
		expect(stageOpen(container)).toBe("true");
		expect(container.querySelector(".canvas-resource-library")).not.toBeNull();
	});

	it("keeps an item that is opened again while its last tab is closing", async () => {
		const container = await openWeeklyReport();
		click(
			container.querySelector(
				`[aria-label="Close Weekly report (Document, ${OUTPUT_ID})"]`,
			)!,
		);
		click(filesPanelRow(container, "Weekly report"));
		await act(async () => {
			await new Promise((resolve) =>
				setTimeout(resolve, CANVAS_STAGE_CLOSE_SETTLE_MS + 50),
			);
		});
		expect(stageOpen(container)).toBe("true");
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
	});
});
