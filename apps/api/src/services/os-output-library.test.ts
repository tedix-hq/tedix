import { describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@tedix/db/queries/os-workspaces/outputs", () => ({
	listOsOutputLibraryRows: mocks.list,
}));
import {
	buildOsOutputLibrary,
	mapOsOutputRevisionRow,
	outputLibraryPreview,
} from "./os-output-library";

describe("buildOsOutputLibrary", () => {
	it("preserves inventory without parsing content when source access is unavailable", async () => {
		mocks.list.mockResolvedValue([
			{
				output: {
					id: "out-1",
					organizationId: "org-1",
					workspaceId: null,
					kind: "document",
					title: "Protected",
					status: "active",
					currentRevisionId: "rev-1",
					createdByKind: "service",
					createdById: "service-1",
					createdAt: "2026-09-22T00:00:00.000Z",
					updatedAt: "2026-09-22T00:00:00.000Z",
				},
				revision: {
					id: "rev-1",
					organizationId: "org-1",
					outputId: "out-1",
					revision: 1,
					content: "this is deliberately invalid JSON",
					createdAt: "2026-09-22T00:00:00.000Z",
				},
				workspace: null,
			},
		]);
		const result = await buildOsOutputLibrary({} as never, {
			organizationId: "org-1",
			creator: { kind: "user", id: "user-1" },
			limit: 20,
			canReadRevision: async () => false,
		});
		expect(result).toMatchObject({
			items: [
				{
					preview: { kind: "unavailable", reason: "source_access_unavailable" },
				},
			],
			truncated: false,
		});
	});
});

describe("outputLibraryPreview", () => {
	it("projects video outputs without exposing renderer storage details", () => {
		expect(
			outputLibraryPreview({
				kind: "video",
				renderId: "5860e069-c32c-4659-94b3-6169da778d2c",
				mimeType: "video/mp4",
				caption: "  Acme   candidate  ",
				delivery: {
					status: "candidate",
					verdict: "revise",
					score: 45,
					productRef: "808252",
				},
			}),
		).toEqual({
			kind: "video",
			mimeType: "video/mp4",
			caption: "Acme candidate",
			delivery: { status: "candidate", verdict: "revise", score: 45 },
		});
	});
});

describe("mapOsOutputRevisionRow producer lineage", () => {
	const row = {
		id: "3a1a4b5c-6d7e-4f80-9012-3456789abcde",
		organizationId: "org-1",
		outputId: "b2c3d4e5-f607-4189-a0b1-c2d3e4f50617",
		revision: 3,
		content: JSON.stringify({
			kind: "document",
			blocks: [{ type: "paragraph", text: "hello" }],
		}),
		note: null,
		createdByKind: "tedi" as const,
		createdById: "tedi-1",
		createdAt: "2026-08-25T00:00:00.000Z",
	};

	it("nests the run and skill ids under producedBy", () => {
		expect(
			mapOsOutputRevisionRow({
				...row,
				skillRunId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
				skillId: "acme-expert-opinion-video",
			}).producedBy,
		).toEqual({
			skillRunId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
			skillId: "acme-expert-opinion-video",
		});
	});

	it("reports no producer for a human-authored revision", () => {
		expect(
			mapOsOutputRevisionRow({ ...row, skillRunId: null, skillId: null })
				.producedBy,
		).toBeNull();
	});

	it("collapses a skill id with no run to null rather than half a receipt", () => {
		expect(
			mapOsOutputRevisionRow({
				...row,
				skillRunId: null,
				skillId: "acme-expert-opinion-video",
			}).producedBy,
		).toBeNull();
	});

	it("keeps the run id when only the skill id is missing", () => {
		expect(
			mapOsOutputRevisionRow({
				...row,
				skillRunId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
				skillId: null,
			}).producedBy,
		).toEqual({
			skillRunId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
			skillId: null,
		});
	});

	it("does not leak the flat columns alongside the nested envelope", () => {
		const mapped = mapOsOutputRevisionRow({
			...row,
			skillRunId: "9f1e2d3c-4b5a-4697-8899-aabbccddeeff",
			skillId: "s",
		});
		expect(mapped).not.toHaveProperty("skillRunId");
		expect(mapped).not.toHaveProperty("skillId");
	});
});
