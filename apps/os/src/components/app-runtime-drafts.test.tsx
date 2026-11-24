import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	OsCollaborationProposal,
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const collaboration = vi.hoisted(() => ({
	accept: vi.fn(),
	list: vi.fn(),
	previewBlueprintAppUpdate: vi.fn(),
	merge: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: { collaboration, gadgets: { getCode: vi.fn() } } },
	osAppRuntimeCall: vi.fn(),
}));

vi.mock("@/components/app-runtime-panel", () => ({
	AppRuntimeSandbox: () => null,
}));
vi.mock("@/components/app-shared-draft-editor", () => ({
	AppSharedDraftEditor: () => null,
}));
vi.mock("@/components/app-draft-editor", () => ({
	AppDraftEditor: () => null,
}));
vi.mock("@/components/canvas-proposals", () => ({ ProposalDiff: () => null }));
import { AppRuntimeDrafts } from "./app-runtime-drafts";

const manifest = { entry: "tedix:runtime/v1", capabilities: [] };
const content = {
	manifest,
	files: { "server.js": "server", "client.js": "client" },
};
const gadget: OsGadget = {
	id: "33333333-3333-4333-8333-333333333333",
	organizationId: "fictional-org",
	workspaceId: "22222222-2222-4222-8222-222222222222",
	name: "Cards",
	description: null,
	status: "active",
	currentRevisionId: "latest",
	sourceBlueprintRevisionId: null,
	createdByKind: "user",
	createdById: "builder",
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
};
const proposal: OsCollaborationProposal = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: gadget.organizationId,
	workspaceId: gadget.workspaceId,
	documentType: "gadget",
	documentId: gadget.id,
	baseRevisionId: "base",
	baseRevision: 1,
	status: "open",
	sourceKind: "user",
	sourceId: "builder",
	content,
	sequence: 0,
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
const revision: OsGadgetRevision = {
	id: "latest",
	organizationId: gadget.organizationId,
	gadgetId: gadget.id,
	revision: 2,
	manifest,
	sourceArtifactRef: null,
	createdByKind: "user",
	createdById: "builder",
	createdAt: "2026-01-01",
};

describe("app draft stale status", () => {
	it.each([true, false])(
		"shows stale=%s before review and leaves open drafts available for server validation",
		(stale) => {
			const client = new QueryClient({
				defaultOptions: { queries: { enabled: false, retry: false } },
			});
			const view = document.createElement("div");
			view.innerHTML = renderToStaticMarkup(
				<QueryClientProvider client={client}>
					<AppRuntimeDrafts
						workspaceId={gadget.workspaceId}
						gadget={gadget}
						revision={
							stale ? revision : { ...revision, id: "base", revision: 1 }
						}
						drafts={[{ proposal, content }]}
						onMerged={() => {}}
					/>
				</QueryClientProvider>,
			);
			expect(view.textContent?.includes("Out of date")).toBe(stale);
			expect(view.textContent?.includes("Waiting for you")).toBe(!stale);
			const accept = [...view.querySelectorAll("button")].find(
				(button) => button.textContent === "Accept and publish",
			);
			expect(accept).toBeDefined();
			expect(accept?.disabled).toBe(false);
			client.clear();
		},
	);
});

describe("app draft approval and application", () => {
	let cleanup: (() => void) | undefined;
	const serviceUnavailable = Object.assign(
		new Error("Database temporarily unavailable; retry shortly"),
		{ code: "SERVICE_UNAVAILABLE" },
	);
	const next = { revision: { ...revision, revision: 2 } };

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
		vi.resetAllMocks();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	function mount() {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.useFakeTimers();
		const client = new QueryClient({
			defaultOptions: { queries: { enabled: false } },
		});
		const view = document.createElement("div");
		const root = createRoot(view);
		const onMerged = vi.fn();
		collaboration.accept.mockResolvedValue({
			proposal: { ...proposal, status: "accepted" },
		});
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<AppRuntimeDrafts
						workspaceId={gadget.workspaceId}
						gadget={gadget}
						revision={{ ...revision, id: "base", revision: 1 }}
						drafts={[{ proposal, content }]}
						onMerged={onMerged}
					/>
				</QueryClientProvider>,
			),
		);
		cleanup = () => {
			act(() => root.unmount());
			client.clear();
		};
		const click = async (label: string) => {
			const button = [...view.querySelectorAll("button")].find(
				(node) => node.textContent === label,
			);
			expect(button?.disabled).toBe(false);
			await act(async () => button?.click());
		};
		return { view, onMerged, click };
	}

	async function advance(ms: number) {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(ms);
		});
	}

	it("applies with one click after a transient merge failure", async () => {
		const { click, onMerged } = mount();
		collaboration.merge
			.mockRejectedValueOnce(serviceUnavailable)
			.mockResolvedValueOnce(next);

		await click("Accept and publish");
		expect(collaboration.merge).toHaveBeenCalledTimes(1);
		await advance(250);

		expect(collaboration.accept).toHaveBeenCalledTimes(1);
		expect(collaboration.merge).toHaveBeenCalledTimes(2);
		expect(collaboration.merge.mock.calls[0]?.[0]).toMatchObject({
			expectedSequence: proposal.sequence,
		});
		expect(collaboration.merge.mock.calls[1]).toEqual(
			collaboration.merge.mock.calls[0],
		);
		expect(onMerged).toHaveBeenCalledWith(
			next.revision.revision,
			next.revision.id,
		);
	});

	it("offers Apply now after the retries are exhausted without approving again", async () => {
		const { click, onMerged, view } = mount();
		collaboration.merge.mockRejectedValue(serviceUnavailable);

		await click("Accept and publish");
		await advance(751);

		expect(collaboration.merge).toHaveBeenCalledTimes(3);
		expect(view.querySelector('[role="alert"]')?.textContent).toContain(
			"This change is approved but not published yet",
		);
		collaboration.merge.mockResolvedValueOnce(next);
		await click("Publish now");

		expect(collaboration.accept).toHaveBeenCalledTimes(1);
		expect(collaboration.merge).toHaveBeenCalledTimes(4);
		expect(onMerged).toHaveBeenCalledWith(
			next.revision.revision,
			next.revision.id,
		);
	});

	it("surfaces a stale-base conflict without retrying the merge", async () => {
		const { click, view } = mount();
		collaboration.merge.mockRejectedValue(
			Object.assign(new Error("The app version changed"), { code: "CONFLICT" }),
		);

		await click("Accept and publish");
		await advance(751);

		expect(collaboration.merge).toHaveBeenCalledTimes(1);
		expect(view.querySelector('[role="alert"]')?.textContent).toContain(
			"The app version changed",
		);
	});
});
