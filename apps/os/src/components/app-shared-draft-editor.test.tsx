import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	OsAppDraftContent,
	OsCollaborationProposal,
} from "@tedix/api-contract/schemas/os-workspaces";
import type { UseCollabDocResult } from "@/lib/use-collab-doc";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const harness = vi.hoisted(() => ({
	room: {} as UseCollabDocResult,
	input: vi.fn(),
	save: vi.fn(),
	ground: vi.fn(),
}));
vi.mock("@/lib/use-collab-doc", () => ({
	useCollabDoc: (input: unknown) => {
		harness.input(input);
		return harness.room;
	},
}));
vi.mock("@/lib/api", () => ({
	osApi: { osAppRuntime: { saveDraft: harness.save } },
}));
vi.mock("@/lib/os-query-options", () => ({
	osQueryKeys: { collaborationProposals: () => ["proposals"] },
}));
vi.mock("@/components/canvas-editor", () => ({
	CanvasCodeEditor: () => <div>Code editor</div>,
}));
import { AppSharedDraftEditor } from "./app-shared-draft-editor";

const content = {
	manifest: { entry: "tedix:runtime/v1", capabilities: [] },
	files: { "client.js": "client", "server.js": "server" },
};
const proposal: OsCollaborationProposal = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "fictional-org",
	workspaceId: "22222222-2222-4222-8222-222222222222",
	documentType: "gadget",
	documentId: "33333333-3333-4333-8333-333333333333",
	baseRevisionId: "44444444-4444-4444-8444-444444444444",
	baseRevision: 1,
	status: "open",
	sourceKind: "user",
	sourceId: "builder",
	content,
	sequence: 7,
	createdByKind: "user",
	createdById: "builder",
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
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
};
let root: Root | null = null;
let host: HTMLDivElement;
function render(next = proposal, draft: OsAppDraftContent = content) {
	act(() =>
		root!.render(
			<QueryClientProvider client={new QueryClient()}>
				<AppSharedDraftEditor
					workspaceId={proposal.workspaceId}
					gadgetId={proposal.documentId}
					proposal={next}
					content={draft}
					onClose={() => {}}
				/>
			</QueryClientProvider>,
		),
	);
}
function saveButton() {
	return [...host.querySelectorAll("button")].find(
		(button) => button.textContent === "Save shared draft",
	)!;
}
beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	vi.clearAllMocks();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	harness.room = {
		status: "connected",
		peers: 2,
		session: null,
		canonical: { revision: 7, revisionId: proposal.baseRevisionId },
		unacknowledged: false,
		recoveryRequired: false,
		recoverableFiles: null,
		blocked: null,
		tooLarge: false,
		retry: vi.fn(),
		participants: [],
		unsynced: false,
		discarded: 0,
		clearRecoverableFiles: vi.fn(),
		replaceWithCanonical: async () => ({ ok: true }),
		setSelection: vi.fn(),
		groundCommit: harness.ground,
		commitBasis: () => ({
			text: "",
			files: [
				["manifest.json", JSON.stringify(content.manifest)],
				["client.js", "shared client"],
				["server.js", "shared server"],
			],
			position: { generation: 0, revision: 9 },
		}),
	};
	harness.save.mockResolvedValue({ proposal: { ...proposal, sequence: 8 } });
});
afterEach(() => {
	act(() => root?.unmount());
	host.remove();
});
describe("shared app draft save", () => {
	it("refuses a reserved source path instead of shadowing and saving it as the app manifest", () => {
		render(proposal, {
			...content,
			files: { ...content.files, "manifest.json": "source contents" },
		});
		expect(harness.input.mock.lastCall?.[0]).toMatchObject({ enabled: false });
		expect(saveButton().disabled).toBe(true);
		expect(host.textContent).toContain("source file named manifest.json");
		expect(harness.save).not.toHaveBeenCalled();
	});
	it("saves the synchronized whole-file basis with room base/sequence fences and grounds its result", async () => {
		render();
		await act(async () => {
			saveButton().click();
			await new Promise((resolve) => setTimeout(resolve, 10));
		});
		expect(harness.save).toHaveBeenCalledWith({
			workspaceId: proposal.workspaceId,
			gadgetId: proposal.documentId,
			proposalId: proposal.id,
			expectedRevisionId: proposal.baseRevisionId,
			expectedSequence: 7,
			content: {
				manifest: content.manifest,
				files: { "client.js": "shared client", "server.js": "shared server" },
			},
		});
		expect(harness.ground).toHaveBeenCalledWith(
			expect.objectContaining({ position: { generation: 0, revision: 9 } }),
			8,
			proposal.baseRevisionId,
		);
	});
	it.each(["unacknowledged", "recoveryRequired", "recoverableFiles"] as const)(
		"blocks saving during %s",
		(state) => {
			harness.room = {
				...harness.room,
				[state]:
					state === "recoverableFiles" ? { "client.js": "retained" } : true,
			};
			render();
			expect(saveButton().disabled).toBe(true);
			expect(harness.save).not.toHaveBeenCalled();
		},
	);
	it("pins the open room when another editor rebases the proposal", () => {
		render();
		render({
			...proposal,
			baseRevisionId: "55555555-5555-4555-8555-555555555555",
			sequence: 8,
		});
		expect(harness.input.mock.lastCall?.[0]).toMatchObject({
			docKey: `app-draft:${proposal.documentId}:${proposal.id}:${proposal.baseRevisionId}`,
			canonical: { revisionId: proposal.baseRevisionId, revision: 7 },
		});
		expect(saveButton().disabled).toBe(true);
		expect(host.textContent).toContain("Your editor stays open");
	});
});
