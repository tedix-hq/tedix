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

const osWorkspacesApi = vi.hoisted(() => ({
	workspaces: {
		list: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
		archive: vi.fn(),
	},
	workspacePreferences: {
		list: vi.fn(),
		setFavorite: vi.fn(),
		touch: vi.fn(),
	},
	gadgets: { list: vi.fn(), get: vi.fn(), revise: vi.fn() },
	outputs: { list: vi.fn(), library: vi.fn(), get: vi.fn(), revise: vi.fn() },
	resources: { list: vi.fn(), create: vi.fn(), remove: vi.fn() },
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

const routing = vi.hoisted(() => ({
	navigate: vi.fn(),
	search: {} as {
		conversation?: string;
		workpiece?: string;
		view?: "workpiece" | "source" | "runs" | "connections" | "activity";
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

const outputEditorHarness = vi.hoisted(() => ({
	onChange: null as ((next: OsOutputContent) => void) | null,
}));

const chatHarness = vi.hoisted(() => ({
	onSendStarted: null as (() => void) | null,
	onSelect: null as ((conversationId: string | null) => void) | null,
	onConversationCreated: null as ((conversationId: string) => void) | null,
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: osWorkspacesApi,
		osCompute: osComputeApi,
		osShares: osSharesApi,
		kernelRuntime: kernelRuntimeApi,
	},
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	useNavigate: () => routing.navigate,
	useSearch: () => routing.search,
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

vi.mock("@/components/output-editor", () => ({
	OutputEditor: ({
		value,
		onChange,
		disabled,
	}: {
		value: OsOutputContent;
		onChange: (next: OsOutputContent) => void;
		disabled?: boolean;
	}) => {
		outputEditorHarness.onChange = onChange;
		return (
			<div data-output-editor data-readonly={disabled ? "true" : undefined}>
				{JSON.stringify(value)}
			</div>
		);
	},
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

vi.mock("@/components/chat-thread", () => ({
	ChatThread: ({
		conversationId,
		composerOnly,
		onSendStarted,
		onConversationCreated,
	}: {
		conversationId: string | null;
		composerOnly?: boolean;
		onSendStarted?: () => void;
		onConversationCreated?: (conversationId: string) => void;
	}) => {
		chatHarness.onSendStarted = onSendStarted ?? null;
		chatHarness.onConversationCreated = onConversationCreated ?? null;
		return (
			<div
				data-chat-thread={conversationId ?? "new"}
				data-composer-only={composerOnly}
			>
				Workspace chat
			</div>
		);
	},
}));

vi.mock("@/components/chat-sidebar", () => ({
	CHAT_CONVERSATIONS_QUERY_KEY: ["os-chat-conversations"],
	MAIN_HOME_CONVERSATION_ID: "home:main",
	ChatConversationHeader: ({
		conversationId,
		onBack,
	}: {
		conversationId: string | null;
		onBack: () => void;
	}) => (
		<div data-testid="conversation-header" data-conversation={conversationId}>
			<button aria-label="Back to conversations" onClick={onBack} type="button">
				back
			</button>
		</div>
	),
	ChatSidebar: ({
		activeConversationId,
		onSelect,
	}: {
		activeConversationId: string | null;
		onSelect: (conversationId: string | null) => void;
	}) => {
		chatHarness.onSelect = onSelect;
		return (
			<nav
				aria-label="Conversations"
				data-active-conversation={activeConversationId ?? "new"}
			>
				<button type="button" onClick={() => onSelect("home:os:second")}>
					Second conversation
				</button>
				<button type="button" onClick={() => onSelect(null)}>
					New
				</button>
			</nav>
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
	CANVAS_CHAT_WIDTH_KEY,
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
}: {
	status?: string;
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
		container.remove();
	});
	return { container, rerender };
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
	const match = [...container.querySelectorAll("button")].find((button) =>
		(button.textContent ?? "").includes(label),
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

async function openDoc(label: string): Promise<HTMLElement> {
	const container = renderPage();
	await flush();
	click(findButton(container, label));
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
	it("prefers the newest durable output, then an executable Gadget", () => {
		expect(primaryCanvasDoc([outputFixture()], [gadgetFixture()])).toEqual({
			type: "output",
			id: OUTPUT_ID,
		});
		expect(primaryCanvasDoc([], [gadgetFixture()])).toEqual({
			type: "gadget",
			id: GADGET_ID,
		});
		expect(primaryCanvasDoc([], [])).toBeNull();
	});

	it("offers Source only for Gadgets while sharing governed pane modes", () => {
		expect(
			canvasWorkpieceModeOptions({ type: "gadget", id: GADGET_ID }).map(
				(option) => option.label,
			),
		).toEqual(["App", "Code", "Runs", "Connections", "Review"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "output", id: OUTPUT_ID },
				"document",
			).map((option) => option.label),
		).toEqual(["Document", "Connections", "Review"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "output", id: OUTPUT_ID },
				"sheet",
			).map((option) => option.label),
		).toEqual(["Sheet", "Connections", "Review"]);
		expect(
			canvasWorkpieceModeOptions(
				{ type: "output", id: OUTPUT_ID },
				"presentation",
			).map((option) => option.label),
		).toEqual(["Slides", "Connections", "Review"]);
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
		const container = renderPage();
		await flush();

		click(findButton(container, "Weekly report"));
		await flush();
		click(findButton(container, "Report gadget"));
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

		click(container.querySelector('[aria-label="Close Report gadget"]')!);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(
			container.querySelector('[role="tab"]')?.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("opens Work without the library consuming its pane", async () => {
		mockLists();
		routing.search = { pane: "work" };
		const container = renderPage();
		await flush();
		const workbench = container.querySelector<HTMLElement>(".canvas-workbench");
		expect(workbench?.style.display).toBe("none");
		expect(
			container.querySelector("[data-workspace-work-panel]"),
		).not.toBeNull();
	});

	it("restores Resources after Work without remounting the selected draft", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab({ initial: docJson(outputRevisionFixture().content) });
		const container = await openDoc("Weekly report");
		const editor = container.querySelector("[data-output-editor]");
		expect(editor).not.toBeNull();
		const switcher = container.querySelector(".canvas-desktop-pane-switcher")!;
		expect(
			[...switcher.querySelectorAll("button")].map((button) =>
				button.textContent?.trim(),
			),
		).toEqual(["Editor", "Resources", "Work"]);
		click(findButton(switcher, "Resources"));
		click(findButton(switcher, "Work"));
		await flush();
		const workbench = container.querySelector<HTMLElement>(".canvas-workbench");
		expect(workbench?.style.display).toBe("none");
		expect(container.querySelector("[data-output-editor]")).toBe(editor);
		click(findButton(switcher, "Resources"));
		await flush();
		expect(workbench?.style.display).toBe("");
		expect(
			container
				.querySelector(".canvas-surface")
				?.getAttribute("data-resource-rail-open"),
		).toBe("true");
		expect(container.querySelector("[data-output-editor]")).toBe(editor);
		expect(container.querySelector("[data-workspace-work-panel]")).toBeNull();
	});

	it("switches between the responsive resource rail and distraction-free editor", async () => {
		mockLists();
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
		expect(
			container
				.querySelector("[data-export-buttons]")
				?.getAttribute("data-compact"),
		).toBe("true");
		expect(
			container.querySelector("[data-canvas-revision-status]")?.textContent,
		).toContain("Revision 2");
		expect(container.querySelector('[aria-label="Share"]')).not.toBeNull();
		expect(container.querySelector(".canvas-chat-resources-button")).toBeNull();
		expect(
			[...container.querySelectorAll(".canvas-chat-header button")].filter(
				(button) => button.textContent?.trim() === "Resources",
			),
		).toHaveLength(0);
		expect(findButton(container, "Resources")).not.toBeNull();
		expect(container.querySelector('[aria-label="Focus"]')).not.toBeNull();
		click(findButton(container, "Focus"));
		expect(surface?.getAttribute("data-canvas-focus")).toBe("true");
		expect(surface?.getAttribute("data-full-height")).toBe("true");

		click(findButton(container, "Exit focus"));
		expect(surface?.hasAttribute("data-canvas-focus")).toBe(false);
		click(findButton(container, "Resources"));
		expect(surface?.getAttribute("data-resource-rail-open")).toBe("true");
		expect(surface?.getAttribute("data-mobile-pane")).toBe("resources");
		expect(
			container.querySelector(".canvas-resource-library-header h2")
				?.textContent,
		).toBe("Resources");
		expect(
			container.querySelector("[data-workspace-output-preview]"),
		).not.toBeNull();
		expect(container.textContent).toContain("Connected sources");
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
		expect(preview?.closest("button")?.disabled).toBe(true);
	});

	it("distinguishes an approved video deliverable from newer candidates", async () => {
		mockLists();
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
		).toBe("home:main");

		click(findButton(container, "Second conversation"));
		expect(
			container.querySelector('[data-chat-thread="home:os:second"]'),
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
		).toBe("home:os:second");

		click(container.querySelector('[aria-label="Back to conversations"]')!);
		// The list view keeps a live composer whose first send creates the
		// conversation -- starting a chat is a send, not a button.
		expect(container.querySelector('[data-chat-thread="new"]')).not.toBeNull();
		click(
			[...container.querySelectorAll("button")].find(
				(button) => button.textContent?.trim() === "New",
			)!,
		);
		expect(container.querySelector('[data-chat-thread="new"]')).not.toBeNull();

		act(() => chatHarness.onConversationCreated?.("home:os:created"));
		expect(
			container.querySelector('[data-chat-thread="home:os:created"]'),
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
		expect(container.querySelector('[data-kind="document"]')).not.toBeNull();
		expect(container.textContent).not.toContain("Pick a document");
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector('[role="tab"]')?.textContent).toContain(
			"Weekly report",
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
				search: { workpiece: `output:${OUTPUT_ID}`, pane: "workpiece" },
				replace: true,
			}),
		);
	});

	it("preserves an explicit chat-first workspace link", async () => {
		mockLists();
		routing.search = { pane: "chat" };
		const container = renderPage();
		await flush();

		expect(container.textContent).toContain("Pick a document");
		expect(
			container
				.querySelector('[data-slot="empty"]')
				?.getAttribute("data-appearance"),
		).toBe("quiet");
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
			"details.canvas-account-connections",
		);
		expect(accountConnections).not.toBeNull();
		expect(accountConnections?.hasAttribute("open")).toBe(false);
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
		).toContain("This gadget is not in this workspace");
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
		expect(container.textContent).toContain("Pick a document");
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
		expect(container.textContent).toContain("Pick a document");
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

	it("opens a linked first-party Gadget in the semantic output editor", async () => {
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

		expect(container.textContent).toContain("Gadget editor");
		expect(container.querySelector("[data-output-editor]")).not.toBeNull();
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
			container.querySelector('button[aria-label="Share"]'),
		).not.toBeNull();
		expect(
			container
				.querySelector("[data-gadget-executions]")
				?.getAttribute("data-execution-gadget-id"),
		).toBeUndefined();
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

		click(findButton(container, "Runs"));
		expect(
			container
				.querySelector("[data-gadget-executions]")
				?.getAttribute("data-execution-gadget-id"),
		).toBe(GADGET_ID);

		click(findButton(container, "App"));
		expect(container.querySelector("[data-widget-frame]")).not.toBeNull();
		expect(container.querySelector("[data-gadget-executions]")).toBeNull();

		click(findButton(container, "Connections"));
		expect(container.querySelector("[data-connections-panel]")).not.toBeNull();
		const accountConnections = container.querySelector(
			"details.canvas-account-connections",
		);
		expect(accountConnections).not.toBeNull();
		expect(accountConnections?.hasAttribute("open")).toBe(false);
		expect(accountConnections?.textContent).toContain(
			"then attach the resources you need",
		);
		expect(container.textContent).toContain(
			"required permissions and approvals",
		);
		expect(
			container.querySelector(
				'.canvas-secondary-view > [data-slot="section-header"]',
			),
		).not.toBeNull();

		click(findButton(container, "Review"));
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
		expect(container.textContent).not.toContain("Committed preview");
		expect(
			findButton(container, "Commit").closest(
				'[data-slot="output-workshop-footer"]',
			),
		).not.toBeNull();
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
		const styles = readFileSync("src/styles.css", "utf8");
		expect(styles).toMatch(
			/\.canvas-workpiece-tab\[data-selected\][\s\S]*?background:\s*var\(--color-kumo-tint\);/,
		);
		expect(styles).toMatch(
			/\.canvas-chat-thread \[data-slot="conversation-transcript"\][\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/,
		);
		expect(styles).toMatch(/\.canvas-chat-thread\s*\{[\s\S]*?padding:\s*16px;/);
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
			/\.output-editor-toolbar\s*\{[\s\S]*?min-height:\s*48px;[\s\S]*?padding:\s*8px 16px;[\s\S]*?border-radius:\s*0;/,
		);
		expect(styles).toMatch(
			/\.output-editor-toolbar > \[data-kumo-component="Toolbar"\]\s*\{[\s\S]*?gap:\s*8px;/,
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
			/\.output-editor-toolbar\s*\[data-kumo-component="Toolbar"\]\s*button\[data-toolbar-control="icon"\]\s*\{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;[\s\S]*?border-radius:\s*6px;/,
		);
		expect(styles).not.toMatch(
			/\[data-kumo-component="Toolbar"\]\s*> button\s*\{/,
		);
		const resizerRule = styles.match(
			/\.canvas-chat-resizer\s*\{([^}]*)\}/,
		)?.[1];
		expect(resizerRule).toBeDefined();
		expect(resizerRule).toContain("width: 1px");
		expect(resizerRule).not.toContain("z-index");
		expect(styles).toMatch(
			/\.canvas-chat-resizer::after\s*\{[\s\S]*?right:\s*-6px;[\s\S]*?left:\s*-6px;/,
		);
	});
});

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

describe("room seeding and shared text", () => {
	it("offers the canonical body as the room's seed instead of writing it as an edit", async () => {
		mockLists();
		const currentRevision = outputRevisionFixture();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision,
		});
		const session = mockCollab({ initial: docJson(currentRevision.content) });

		await openDoc("Weekly report");

		// The seed rides the handshake, where the authority accepts the first
		// offer and ignores every later one. It states WHICH canonical revision it
		// is, not only what it says. The panel never authors an edit to establish
		// content.
		expect(collab.useCollabDoc).toHaveBeenCalledWith(
			expect.objectContaining({
				canonical: {
					text: docJson(currentRevision.content),
					revision: currentRevision.revision,
					revisionId: currentRevision.id,
				},
			}),
		);
		expect(session.local).toEqual([]);
	});

	it("waits for canonical truth before offering a seed at all", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockReturnValue(new Promise(() => {}));
		mockCollab({ status: "connecting" });

		await openDoc("Weekly report");

		expect(collab.useCollabDoc).toHaveBeenCalledWith(
			expect.objectContaining({ canonical: null }),
		);
	});

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

	it("authors no change when an output editor echoes identical bytes", async () => {
		mockLists();
		const currentRevision = outputRevisionFixture();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision,
		});
		const session = mockCollab({ initial: docJson(currentRevision.content) });
		await openDoc("Weekly report");

		act(() => outputEditorHarness.onChange?.(currentRevision.content));

		// A no-op submission is merely wasteful, never dangerous: a change stream
		// cannot produce the concatenated-duplicate-JSON convergence that a
		// delete-all-then-insert can.
		expect(session.local).toEqual([]);
		expect(session.text(COLLAB_DOC_PATH)).toBe(
			docJson(currentRevision.content),
		);
	});

	it("authors nothing from a structured editor while the room is not live", async () => {
		mockLists();
		const currentRevision = outputRevisionFixture();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision,
		});
		const session = mockCollab({
			initial: docJson(currentRevision.content),
			status: "disconnected",
			peers: 0,
		});
		const container = await openDoc("Weekly report");
		const edited: OsOutputContent = {
			kind: "document",
			blocks: [{ type: "paragraph", text: "typed while offline" }],
		};

		act(() => outputEditorHarness.onChange?.(edited));

		// The OT client is gone, so `applyLocal` is inert. Writing the panel's own
		// text anyway would desync it from what every peer still sees, and the
		// difference would be silently committed later as if it had been shared.
		expect(session.local).toEqual([]);
		expect(session.text(COLLAB_DOC_PATH)).toBe(
			docJson(currentRevision.content),
		);
		expect(
			container
				.querySelector("[data-output-editor]")
				?.getAttribute("data-readonly"),
		).toBe("true");
	});

	it("expresses a structured edit as one diff-derived change", async () => {
		mockLists();
		const currentRevision = outputRevisionFixture();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision,
		});
		const session = mockCollab({ initial: docJson(currentRevision.content) });
		await openDoc("Weekly report");
		const edited: OsOutputContent = {
			kind: "document",
			blocks: [{ type: "paragraph", text: "edited by the editor" }],
		};

		act(() => outputEditorHarness.onChange?.(edited));

		expect(session.local).toHaveLength(1);
		expect(session.local[0]?.[0]?.[0]).toBe(COLLAB_DOC_PATH);
		// An edit, not a wholesale replacement: the shared paragraph prefix is
		// retained rather than deleted and reinserted.
		expect(session.local[0]?.[0]?.[1]).toHaveProperty("edit");
		expect(session.text(COLLAB_DOC_PATH)).toBe(docJson(edited));
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
		const details = suggestion?.querySelector("details");
		expect(details?.hasAttribute("open")).toBe(false);
		expect(details?.textContent).toContain("codex:session-1");
		const comparison = [
			...(suggestion?.querySelectorAll("details") ?? []),
		].find(
			(item) =>
				item.querySelector("summary")?.textContent === "Compare changes",
		);
		expect(comparison).toBeDefined();
		expect(comparison?.hasAttribute("open")).toBe(false);
		expect(
			comparison?.querySelector('[aria-label="Proposed change"]'),
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

	it("keeps merge separate from acceptance and reports the immutable revision", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		osWorkspacesApi.collaboration.list.mockResolvedValue({
			items: [proposalFixture({ status: "accepted" })],
			truncated: false,
		});
		osWorkspacesApi.collaboration.merge.mockResolvedValue({
			proposal: proposalFixture({
				status: "merged",
				resultRevisionId: "11111111-1111-4111-8111-111111111111",
				resultRevision: 3,
			}),
			revision: outputRevisionFixture({
				id: "11111111-1111-4111-8111-111111111111",
				revision: 3,
			}),
		});
		mockCollab({ initial: docJson(outputRevisionFixture().content) });
		const container = await openDoc("Weekly report");
		const merge = findButton(container, "Apply change") as HTMLButtonElement;
		expect(merge.disabled).toBe(true);
		setFieldValue(
			fieldByLabel(container, "Reason for change 1"),
			"Ready for immutable history",
		);
		click(merge);
		await flush();

		expect(osWorkspacesApi.collaboration.merge).toHaveBeenCalledWith({
			proposalId: PROPOSAL_ID,
			expectedSequence: 3,
			rationale: "Ready for immutable history",
			evidenceRefs: [],
		});
		expect(container.textContent).toContain("Saved version 3.");
	});
});

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

async function commit(container: HTMLElement) {
	const isOutput = [...container.querySelectorAll("button")].some(
		(b) => b.textContent?.trim() === "Save version",
	);
	click(findButton(container, isOutput ? "Save version" : "Commit"));
	click(
		findButton(container, isOutput ? "Save version now" : "Commit revision"),
	);
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
		expect(container.textContent).toContain("Committed revision 4.");
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

		expect(container.textContent).toContain("Someone saved a newer revision");
		expect(container.textContent).toContain("Your draft is preserved");
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
		expect(container.textContent).toContain("Someone saved a newer revision");
		expect(container.textContent).toContain("Your draft is preserved");
	});

	it("pins an output commit to the room's revision when a newer one landed out of band", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture({ revision: 6 }),
		});
		osWorkspacesApi.outputs.revise.mockRejectedValue(
			new Error("Revision conflict"),
		);
		const session = mockCollab({
			initial: docJson(baseContent),
			canonicalRevision: 5,
		});
		session.remote(
			JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: "room text at revision 5" }],
			}),
		);

		const container = await openDoc("Weekly report");
		await commit(container);

		expect(osWorkspacesApi.outputs.revise).toHaveBeenCalledWith(
			expect.objectContaining({ expectedRevision: 5 }),
		);
		expect(container.textContent).toContain("Someone saved a newer revision");
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

	it("grounds an output commit on the revision it produced", async () => {
		mockLists();
		const currentRevision = outputRevisionFixture({ revision: 2 });
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision,
		});
		const saved = outputRevisionFixture({ revision: 3 });
		osWorkspacesApi.outputs.revise.mockResolvedValue({
			output: outputFixture(),
			revision: saved,
		});
		const session = mockCollab({ initial: docJson(currentRevision.content) });
		collabCommit.basis = {
			text: docJson(currentRevision.content),
			position: { generation: 0, revision: 2 },
		};

		const container = await openDoc("Weekly report");
		session.remote(
			JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: "edited" }],
			}),
		);
		await commit(container);

		expect(collabCommit.groundCommit).toHaveBeenCalledWith(
			collabCommit.basis,
			3,
			saved.id,
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

		expect(findButton(container, "Commit").disabled).toBe(true);
		// Transient and self-clearing, and it READS that way: not a refusal, not a dead button.
		expect(container.textContent).toContain("Saving your latest edits…");
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
		expect(findButton(container, "Commit").disabled).toBe(false);
		await commit(container);

		// The read and this decision sit in ONE await-free span, so the commit cannot slip past on
		// a value that was true a moment ago. Nothing is written, and the answer is "in a moment".
		expect(osWorkspacesApi.gadgets.revise).not.toHaveBeenCalled();
		expect(collabCommit.groundCommit).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Saving your latest edits…");
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
		expect(findButton(container, "Commit").disabled).toBe(true);

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

		expect(container.textContent).not.toContain("Saving your latest edits…");
		expect(findButton(container, "Commit").disabled).toBe(false);
		await commit(container);

		// And the commit that follows carries the basis, so the room is re-grounded on the
		// revision it produced and never asks the user to resolve its own work.
		expect(osWorkspacesApi.gadgets.revise).toHaveBeenCalledTimes(1);
		expect(collabCommit.groundCommit).toHaveBeenCalledWith(
			basis,
			4,
			gadgetRevisionFixture({ revision: 4 }).id,
		);
		expect(container.textContent).toContain("Committed revision 4.");
	});
});

describe("live-draft status the panel renders", () => {
	it.each([
		[{ initial: docJson(baseContent) }, "Saved"],
		[
			{
				initial: docJson({
					kind: "document",
					blocks: [{ type: "paragraph", text: "unsaved draft" }],
				}),
			},
			"Draft synced · Save version",
		],
		[
			{ initial: docJson(baseContent), unacknowledged: true },
			"Syncing changes…",
		],
		[
			{ initial: docJson(baseContent), status: "disconnected" },
			"Disconnected · Changes paused",
		],
	])("distinguishes the document save state %s", async (options, label) => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		mockCollab(options);
		const container = await openDoc("Weekly report");
		expect(
			container.querySelector(".canvas-document-status")?.textContent,
		).toContain(label);
	});

	it("blocks proposal application while a shared draft differs and unlocks when it matches the saved version", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture(),
		});
		osWorkspacesApi.collaboration.list.mockResolvedValue({
			items: [proposalFixture({ status: "accepted" })],
			truncated: false,
		});
		const session = mockCollab({
			initial: docJson({
				kind: "document",
				blocks: [{ type: "paragraph", text: "my draft" }],
			}),
		});
		const container = await openDoc("Weekly report");
		setFieldValue(fieldByLabel(container, "Reason for change 1"), "Reviewed");
		expect(findButton(container, "Apply change").disabled).toBe(true);
		expect(container.textContent).toContain(
			"Save your draft as a version before applying a proposal.",
		);
		click(findButton(container, "Apply change"));
		expect(osWorkspacesApi.collaboration.merge).not.toHaveBeenCalled();
		act(() => session.remote(docJson(baseContent)));
		expect(findButton(container, "Apply change").disabled).toBe(false);
	});

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

		expect(container.textContent).toContain("Live draft · Syncing…");
		expect(container.textContent).not.toContain("Live draft · Commit to save");
	});

	it("says the draft is saved-on-commit when nothing is stuck", async () => {
		mockLists();
		osWorkspacesApi.gadgets.get.mockResolvedValue({
			gadget: gadgetFixture(),
			currentRevision: gadgetRevisionFixture(),
		});
		mockCollab({ initial: docJson(gadgetRevisionFixture().manifest) });

		const container = await openDoc("Report gadget");

		expect(container.textContent).toContain("Live draft · Commit to save");
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
		expect(container.textContent).toContain("Saving your latest edits…");
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
	it("keeps recovery pending until acknowledged and leaves a failure visible with the backup", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture({ revision: 2 }),
		});
		mockCollab({ initial: "invalid json", canonicalRevision: 2 });
		let answer!: (result: { ok: false; message: string }) => void;
		replaceWithCanonical.mockReturnValue(
			new Promise((resolve) => {
				answer = resolve;
			}),
		);
		const container = await openDoc("Weekly report");
		click(findButton(container, "Compare versions"));
		click(findButton(container, "Load saved version 2"));
		expect(findButton(container, "Restoring…").disabled).toBe(true);
		expect(container.textContent).toContain("Your preserved draft");
		await act(async () => {
			answer({ ok: false, message: "Recovery was not confirmed" });
		});
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"Recovery was not confirmed",
		);
		expect(findButton(container, "Download draft backup")).toBeDefined();
		expect(findButton(container, "Load saved version 2").disabled).toBe(false);
	});

	it("offers draft backup and explicit restore when invalid content cannot open at the current saved version", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture({ revision: 2 }),
		});
		mockCollab({
			initial: docJson({
				kind: "document",
				blocks: [{ type: "paragraph", text: "x".repeat(20001) }],
			}),
			canonicalRevision: 2,
			recoveryRequired: false,
		});
		const container = await openDoc("Weekly report");
		expect(container.textContent).toContain("Recover this draft");
		expect(
			container.querySelector(".canvas-document-status")?.textContent,
		).toContain("Draft needs recovery");
		expect(
			container.querySelector(".canvas-document-status")?.textContent,
		).not.toContain("Draft synced · Save version");
		expect(findButton(container, "Download draft backup")).toBeDefined();
		expect(replaceWithCanonical).not.toHaveBeenCalled();
		click(findButton(container, "Compare versions"));
		expect(replaceWithCanonical).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Preview truncated");
		click(findButton(container, "Load saved version 2"));
		expect(replaceWithCanonical).toHaveBeenCalledTimes(1);
	});

	it("compares the preserved and saved document without replacing the draft", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture({ revision: 6 }),
		});
		mockCollab({
			initial: docJson({
				kind: "document",
				blocks: [{ type: "paragraph", text: "Keep this draft text" }],
			}),
			canonicalRevision: 5,
			recoveryRequired: true,
		});
		const container = await openDoc("Weekly report");
		click(findButton(container, "Compare versions"));
		expect(container.textContent).toContain("Your preserved draft");
		expect(container.textContent).toContain("Saved version 6");
		expect(container.textContent).toContain("Keep this draft text");
		expect(findButton(container, "Download draft backup")).toBeDefined();
		const createUrl = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:draft-backup");
		let downloadName = "";
		const download = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(function (this: HTMLAnchorElement) {
				downloadName = this.download;
			});
		click(findButton(container, "Download draft backup"));
		expect(createUrl).toHaveBeenCalledOnce();
		expect(downloadName).toBe("preserved-document-draft.json");
		const backupBlob = createUrl.mock.calls[0]?.[0];
		if (!(backupBlob instanceof Blob))
			throw new Error("Expected a full draft backup");
		expect(await backupBlob.text()).toContain("Keep this draft text");
		download.mockRestore();
		createUrl.mockRestore();

		expect(replaceWithCanonical).not.toHaveBeenCalled();
		click(findButton(container, "Load saved version 6"));
		expect(replaceWithCanonical).toHaveBeenCalledTimes(1);
	});

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
		expect(findButton(container, "Commit").disabled).toBe(false);
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

		expect(container.textContent).toContain("An updated version needs review");
		// The room's text is preserved and NOT committable on top of revision 6.
		expect(findButton(container, "Commit").disabled).toBe(true);

		// Two steps, and the destructive one is never the first thing on screen.
		expect(() => findButton(container, "Replace with revision 6")).toThrow();
		click(findButton(container, "Compare versions"));
		expect(replaceWithCanonical).not.toHaveBeenCalled();
		click(findButton(container, "Replace with revision 6"));

		// One user-driven replacement, which lands as an ordinary server-authored
		// change so peers see the document converge rather than being reset.
		expect(replaceWithCanonical).toHaveBeenCalledTimes(1);
	});

	it("lets the user keep the shared draft instead of replacing it", async () => {
		mockLists();
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision: outputRevisionFixture({ revision: 6 }),
		});
		mockCollab({
			initial: docJson(baseContent),
			canonicalRevision: 5,
			recoveryRequired: true,
		});

		const container = await openDoc("Weekly report");
		expect(container.textContent).toContain("An updated version needs review");
		click(findButton(container, "Compare versions"));
		click(findButton(container, "Keep the shared draft"));

		expect(replaceWithCanonical).not.toHaveBeenCalled();
		expect(() => findButton(container, "Replace with revision 6")).toThrow();
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
		expect(findButton(container, "Commit").disabled).toBe(true);
	});
});

describe("output commit", () => {
	function mockOutputDoc() {
		mockLists();
		const currentRevision = outputRevisionFixture({ revision: 2 });
		osWorkspacesApi.outputs.get.mockResolvedValue({
			output: outputFixture(),
			currentRevision,
		});
		return mockCollab({
			initial: docJson(currentRevision.content),
		});
	}

	it("sends the parsed content, note, and loaded revision as the CAS guard", async () => {
		const session = mockOutputDoc();
		osWorkspacesApi.outputs.revise.mockResolvedValue({
			output: outputFixture(),
			revision: outputRevisionFixture({ revision: 3 }),
		});
		const edited: OsOutputContent = {
			kind: "document",
			blocks: [{ type: "paragraph", text: "edited" }],
		};

		const container = await openDoc("Weekly report");
		session.remote(JSON.stringify(edited));
		click(findButton(container, "Save version"));
		setFieldValue(fieldByLabel(container, "Revision note"), "tweak");
		click(findButton(container, "Save version now"));
		await flush();

		expect(osWorkspacesApi.outputs.revise).toHaveBeenCalledWith({
			outputId: OUTPUT_ID,
			content: edited,
			expectedRevision: 2,
			note: "tweak",
		});
		expect(container.textContent).toContain("Saved version 3.");
	});

	it("refuses a draft whose kind differs from the output's", async () => {
		const session = mockOutputDoc();
		const wrongKind = JSON.stringify({
			kind: "sheet",
			columns: [],
			rows: [],
		});

		const container = await openDoc("Weekly report");
		act(() => session.remote(wrongKind));
		await flush();

		expect(osWorkspacesApi.outputs.revise).not.toHaveBeenCalled();
		expect(container.textContent).toContain(
			"The shared draft is not a document",
		);
		expect(findButton(container, "Save version").disabled).toBe(true);
	});

	it("surfaces invalid JSON inline and never sends it", async () => {
		const session = mockOutputDoc();

		const container = await openDoc("Weekly report");
		act(() => session.remote("not json{"));
		await flush();

		expect(osWorkspacesApi.outputs.revise).not.toHaveBeenCalled();
		expect(container.textContent).toContain(
			"The shared document draft is not valid JSON",
		);
		expect(findButton(container, "Save version").disabled).toBe(true);
	});

	it("renders the reload-and-retry alert on a revision conflict", async () => {
		const session = mockOutputDoc();
		osWorkspacesApi.outputs.revise.mockRejectedValue(
			new Error("Revision conflict"),
		);
		const racingEdit = JSON.stringify({
			kind: "document",
			blocks: [{ type: "paragraph", text: "racing edit" }],
		});

		const container = await openDoc("Weekly report");
		session.remote(racingEdit);
		await commit(container);

		expect(container.textContent).toContain("Someone saved a newer revision");
		expect(container.textContent).toContain("Your draft is preserved");
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
		expect(chat.style.width).toBe("100%");
		expect(container.querySelector(".canvas-chat-resizer")).toBeNull();

		const stage = container.querySelector(".canvas-stage") as HTMLElement;
		expect(stage.getAttribute("aria-hidden")).toBe("true");
		expect(stage.style.width).toBe("0px");
		expect(stage.style.opacity).toBe("0");
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
		expect(chat.style.width).toBe(`${CANVAS_CHAT_WIDTH_DEFAULT}px`);
		expect(container.querySelector(".canvas-chat-resizer")).not.toBeNull();
		expect(
			container.querySelector(".canvas-stage")?.getAttribute("aria-hidden"),
		).toBeNull();
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
		expect(container.querySelector(".canvas-chat-resizer")).not.toBeNull();
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
		act(() => chatHarness.onSendStarted?.());
		expect(container.querySelector('[aria-label="Conversations"]')).toBeNull();
		expect(container.querySelector('[data-chat-thread="new"]')).toBe(thread);
		expect(thread?.getAttribute("data-composer-only")).toBe("false");
		expect(routing.navigate).not.toHaveBeenCalled();

		act(() => chatHarness.onConversationCreated?.("home:os:created"));
		expect(
			container.querySelector('[data-chat-thread="home:os:created"]'),
		).toBe(thread);
		expect(
			container.querySelector('[data-chat-thread="home:os:created"]'),
		).not.toBeNull();
		expect(routing.navigate).toHaveBeenCalledWith(
			expect.objectContaining({
				search: expect.objectContaining({ conversation: "home:os:created" }),
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
