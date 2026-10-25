import type { OsCollaborationProposal } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	APP_MANIFEST_PATH,
	appDraftContent,
	appDraftFileChanges,
	appDraftsFrom,
	isAppDraftProposal,
} from "./app-runtime-drafts";

const manifest = {
	entry: "tedix:runtime/v1",
	capabilities: [],
	config: { version: 1, settings: { reviewer: "Maya" } },
};
const files = {
	"server.js": "export default { async open() { return {}; } };",
	"client.js": "export default function mount() {}",
};

function proposal(
	overrides: Partial<OsCollaborationProposal> = {},
): OsCollaborationProposal {
	return {
		id: "00000033-0000-4000-8000-000000000001",
		organizationId: "org",
		workspaceId: "00000030-0000-4000-8000-000000000001",
		documentType: "gadget",
		documentId: "00000031-0000-4000-8000-000000000001",
		baseRevisionId: "00000032-0000-4000-8000-000000000001",
		baseRevision: 1,
		status: "open",
		sourceKind: "chat",
		sourceId: "chat-1",
		content: { manifest, files },
		sequence: 1,
		createdByKind: "tedi",
		createdById: "tedi-1",
		createdAt: "2026-10-25T00:00:00.000Z",
		updatedAt: "2026-10-25T00:00:00.000Z",
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
	} as OsCollaborationProposal;
}

describe("app drafts", () => {
	it("recognises a gadget proposal that carries a manifest and files", () => {
		expect(isAppDraftProposal(proposal())).toBe(true);
		expect(appDraftContent(proposal())?.files["client.js"]).toBe(
			files["client.js"],
		);
	});

	it("leaves settings-only and non-gadget proposals to the generic list", () => {
		expect(isAppDraftProposal(proposal({ content: { manifest } }))).toBe(false);
		expect(
			isAppDraftProposal(
				proposal({ content: { manifest, files: { "client.js": "x" } } }),
			),
		).toBe(false);
		expect(isAppDraftProposal(proposal({ documentType: "output" }))).toBe(
			false,
		);
	});

	it("keeps open and accepted drafts in API order and drops the rest", () => {
		const drafts = appDraftsFrom([
			proposal({ id: "00000033-0000-4000-8000-000000000001" }),
			proposal({
				id: "00000033-0000-4000-8000-000000000002",
				status: "merged",
			}),
			proposal({
				id: "00000033-0000-4000-8000-000000000003",
				status: "rejected",
			}),
			proposal({
				id: "00000033-0000-4000-8000-000000000004",
				status: "accepted",
			}),
			proposal({
				id: "00000033-0000-4000-8000-000000000005",
				content: { manifest },
			}),
		]);
		expect(drafts.map((draft) => draft.proposal.id)).toEqual([
			"00000033-0000-4000-8000-000000000001",
			"00000033-0000-4000-8000-000000000004",
		]);
	});

	it("lists what a draft changes: manifest first, then files by name", () => {
		const changes = appDraftFileChanges(
			{ manifest, files },
			{
				manifest: { ...manifest, description: "Reviewed cards" },
				files: {
					"server.js": files["server.js"],
					"client.js": "export default function mount() { /* v2 */ }",
					"styles.css": ".card {}",
				},
			},
		);
		expect(changes.map((change) => [change.path, change.kind])).toEqual([
			[APP_MANIFEST_PATH, "changed"],
			["client.js", "changed"],
			["styles.css", "added"],
		]);
		expect(changes[0]?.after).toContain("Reviewed cards");
		expect(changes[2]?.before).toBe("");
	});

	it("marks a file the draft drops as removed and treats no live code as empty", () => {
		const changes = appDraftFileChanges(
			{ manifest, files: { ...files, "old.js": "1" } },
			{ manifest, files },
		);
		expect(changes).toEqual([
			{ path: "old.js", kind: "removed", before: "1", after: "" },
		]);
		expect(
			appDraftFileChanges({ manifest, files: null }, { manifest, files }).map(
				(change) => change.kind,
			),
		).toEqual(["added", "added"]);
	});

	it("reports nothing for a draft identical to the live revision", () => {
		expect(
			appDraftFileChanges({ manifest, files }, { manifest, files }),
		).toEqual([]);
	});
});
