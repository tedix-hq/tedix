import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	OsCollaborationProposal,
	OsGadget,
	OsGadgetRevision,
} from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it, vi } from "vite-plus/test";

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
			expect(view.textContent?.includes("Stale")).toBe(stale);
			expect(view.textContent?.includes("Needs you")).toBe(!stale);
			const accept = [...view.querySelectorAll("button")].find(
				(button) => button.textContent === "Accept",
			);
			expect(accept).toBeDefined();
			expect(accept?.disabled).toBe(false);
			client.clear();
		},
	);
});
