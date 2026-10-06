import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getOsOutput,
	getOsOutputRevision,
} from "@tedix/db/queries/os-workspaces/outputs";
import {
	projectWorkspaceDocument,
	authorizedWorkspaceDocumentContext,
	selectedWorkspaceDocumentContext,
} from "./workspace-output-context";
import type { BaseContext } from "../../orpc";

vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	getOsOutput: vi.fn(),
	getOsOutputRevision: vi.fn(),
}));

const source = {
	workspaceId: "workspace-1",
	outputId: "output-1",
	title: "Interview evidence",
	revisionId: "revision-1",
	revision: 3,
};

describe("projectWorkspaceDocument", () => {
	it("carries document text with immutable revision provenance", () => {
		const result = projectWorkspaceDocument({
			...source,
			content: {
				kind: "document",
				blocks: [
					{ type: "heading", level: 2, text: "Michael" },
					{ type: "paragraph", text: "Verify agent-created work." },
				],
			},
		});
		expect(JSON.parse(result!)).toMatchObject({
			source: "selected_workspace_document",
			untrusted: true,
			outputId: "output-1",
			revisionId: "revision-1",
			revision: 3,
			truncated: false,
			text: "## Michael\n\nVerify agent-created work.",
		});
	});

	it("bounds long bodies and refuses non-document content", () => {
		const result = projectWorkspaceDocument({
			...source,
			content: {
				kind: "document",
				blocks: [{ type: "paragraph", text: "x".repeat(20_000) }],
			},
		});
		const projected = JSON.parse(result!);
		expect(projected.truncated).toBe(true);
		expect(projected.text).toHaveLength(12_000);
		expect(
			projectWorkspaceDocument({
				...source,
				content: { kind: "sheet", columns: [], rows: [] },
			}),
		).toBeNull();
	});
});

describe("selectedWorkspaceDocumentContext", () => {
	beforeEach(() => vi.resetAllMocks());
	const db = {} as DbQueryClient;
	const selection = {
		workspaceId: "workspace-1",
		workpiece: { kind: "output", id: "output-1" },
	};
	it("denies callers without OS read authority before loading a document", async () => {
		vi.mocked(getOsOutput).mockClear();
		for (const context of [
			{
				organizationId: "org-1",
				authType: "apikey",
				apiKey: { scopes: ["tedis:write"] },
			},
			{
				organizationId: "org-1",
				authType: "user",
				user: { sub: "user-1", permissions: ["tedis:write"], roles: [] },
			},
			{
				organizationId: "org-other",
				authType: "apikey",
				apiKey: { scopes: ["apps:read"] },
			},
		]) {
			expect(
				await authorizedWorkspaceDocumentContext(
					{ ...context, db } as BaseContext,
					"org-1",
					selection,
				),
			).toBeNull();
		}
		expect(getOsOutput).not.toHaveBeenCalled();
	});

	it("loads an explicitly selected source-free document for an authorized actor", async () => {
		vi.mocked(getOsOutput).mockResolvedValue({
			id: "output-1",
			title: "Supplier review",
			workspaceId: "workspace-1",
			status: "active",
			currentRevisionId: "revision-1",
		} as never);
		vi.mocked(getOsOutputRevision).mockResolvedValue({
			id: "revision-1",
			outputId: "output-1",
			revision: 3,
			accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
			content: JSON.stringify({
				kind: "document",
				blocks: [{ type: "paragraph", text: "The price is 1080." }],
			}),
		} as never);
		const document = await authorizedWorkspaceDocumentContext(
			{
				db,
				organizationId: "org-1",
				authType: "apikey",
				apiKey: { scopes: ["apps:read"] },
			} as BaseContext,
			"org-1",
			selection,
		);
		expect(JSON.parse(document!)).toMatchObject({
			title: "Supplier review",
			outputId: "output-1",
			revisionId: "revision-1",
			revision: 3,
			text: "The price is 1080.",
			untrusted: true,
		});
	});

	it.each([null, "not-json", JSON.stringify({ version: 2, sources: [] })])(
		"rejects an invalid access envelope %s",
		async (accessEnvelope) => {
			vi.mocked(getOsOutput).mockResolvedValue({
				id: "output-1",
				workspaceId: "workspace-1",
				status: "active",
				currentRevisionId: "revision-1",
			} as never);
			vi.mocked(getOsOutputRevision).mockResolvedValue({
				id: "revision-1",
				outputId: "output-1",
				accessEnvelope,
				content: JSON.stringify({
					kind: "document",
					blocks: [{ type: "paragraph", text: "secret" }],
				}),
			} as never);
			expect(
				await selectedWorkspaceDocumentContext(db, "org-1", selection),
			).toBeNull();
		},
	);

	it("rejects archived selections and mismatched revision ownership", async () => {
		vi.mocked(getOsOutput)
			.mockResolvedValueOnce({
				id: "output-1",
				workspaceId: "workspace-1",
				status: "archived",
				currentRevisionId: "revision-1",
			} as never)
			.mockResolvedValueOnce({
				id: "output-1",
				workspaceId: "workspace-1",
				status: "active",
				currentRevisionId: "revision-1",
			} as never);
		vi.mocked(getOsOutputRevision).mockResolvedValue({
			id: "revision-1",
			outputId: "other-output",
		} as never);
		expect(
			await selectedWorkspaceDocumentContext(db, "org-1", selection),
		).toBeNull();
		expect(
			await selectedWorkspaceDocumentContext(db, "org-1", selection),
		).toBeNull();
	});
	it("requires the selected output to remain in the same organization and workspace", async () => {
		vi.mocked(getOsOutput)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce({
				id: "output-1",
				workspaceId: "another-workspace",
				status: "active",
				currentRevisionId: "revision-1",
			} as Awaited<ReturnType<typeof getOsOutput>>);
		expect(
			await selectedWorkspaceDocumentContext(db, "org-1", selection),
		).toBeNull();
		expect(
			await selectedWorkspaceDocumentContext(db, "org-1", selection),
		).toBeNull();
		expect(getOsOutput).toHaveBeenCalledWith(db, {
			organizationId: "org-1",
			outputId: "output-1",
		});
		expect(getOsOutputRevision).not.toHaveBeenCalled();
	});

	it("projects only a source-free current revision", async () => {
		vi.mocked(getOsOutput).mockResolvedValue({
			id: "output-1",
			workspaceId: "workspace-1",
			status: "active",
			title: "Interview",
			currentRevisionId: "revision-1",
		} as Awaited<ReturnType<typeof getOsOutput>>);
		vi.mocked(getOsOutputRevision)
			.mockResolvedValueOnce({
				id: "revision-1",
				outputId: "output-1",
				revision: 2,
				accessEnvelope: JSON.stringify({
					version: 1,
					sources: [
						{
							workspaceResourceId: "41111111-1111-4111-8111-111111111111",
							workspaceId: "42222222-2222-4222-8222-222222222222",
							providerId: "notion",
							resourceType: "page",
							providerResourceId: "page-1",
							connectionScope: "tenant",
							requiredScopes: [],
							operations: [],
						},
					],
				}),
				content: JSON.stringify({
					kind: "document",
					blocks: [{ type: "paragraph", text: "private" }],
				}),
			} as Awaited<ReturnType<typeof getOsOutputRevision>>)
			.mockResolvedValueOnce({
				id: "revision-1",
				outputId: "output-1",
				revision: 2,
				accessEnvelope: JSON.stringify({ version: 1, sources: [] }),
				content: JSON.stringify({
					kind: "document",
					blocks: [{ type: "paragraph", text: "Evidence" }],
				}),
			} as Awaited<ReturnType<typeof getOsOutputRevision>>);
		expect(
			await selectedWorkspaceDocumentContext(db, "org-1", selection),
		).toBeNull();
		const projected = await selectedWorkspaceDocumentContext(
			db,
			"org-1",
			selection,
		);
		expect(JSON.parse(projected!)).toMatchObject({
			revisionId: "revision-1",
			text: "Evidence",
		});
		expect(getOsOutputRevision).toHaveBeenCalledWith(db, {
			organizationId: "org-1",
			revisionId: "revision-1",
		});
	});
});
