import { describe, expect, it, vi } from "vite-plus/test";
import { indexContentDocument } from "./content-index";

vi.mock("@tedix/db/queries/content-sources", () => ({
	upsertContentSourceDocument: vi.fn(async (_db, input) => ({
		...input,
		id: input.id,
	})),
	updateContentSourceDocumentProjection: vi.fn(async () => undefined),
}));

describe("content AI Search indexing", () => {
	it("stores and uploads native image bytes with immutable provenance", async () => {
		const put = vi.fn(async () => undefined);
		const upload = vi.fn(async () => ({ id: "image-item", status: "queued" }));
		const update = vi.fn(async () => undefined);
		const searchInstance = {
			info: vi.fn(async () => ({
				custom_metadata: [],
				indexing_options: null,
			})),
			update,
			items: { upload },
		};
		const bytes = new Uint8Array([137, 80, 78, 71]).buffer;

		const result = await indexContentDocument(
			{} as never,
			{
				CONTENT_CMS_BUCKET: { put } as never,
				CONTENT_AI_SEARCH: { get: () => searchInstance } as never,
			},
			{
				appId: "5eed0040-0000-4000-8000-000000000040",
				appSlug: "guide",
				canonicalUrl: "https://example.com/diagram.png",
				title: "System diagram",
				contentType: "docs",
				visibility: "public",
				sourceRevision: "asset-revision-7",
				nativeFile: {
					name: "diagram.png",
					content: bytes,
					mediaType: "image/png",
				},
			},
		);

		expect(result.objectKey).toMatch(/^guide\/documents\/[a-f0-9]{32}\.png$/);
		expect(put).toHaveBeenCalledWith(
			result.objectKey,
			expect.any(Blob),
			expect.objectContaining({
				httpMetadata: { contentType: "image/png" },
				customMetadata: expect.objectContaining({
					sourceRevision: "asset-revision-7",
					visibility: "public",
					digest: result.digest,
				}),
			}),
		);
		expect(update).toHaveBeenCalledWith({
			custom_metadata: expect.any(Array),
			embedding_model: "@cf/qwen/qwen3-vl-embedding-2b",
			indexing_options: { use_ocr: true },
		});
		expect(upload).toHaveBeenCalledWith(
			expect.stringMatching(/^[a-f0-9]{32}\.png$/),
			expect.any(Blob),
			{
				metadata: expect.objectContaining({
					canonicalUrl: "https://example.com/diagram.png",
					sourceRevision: "asset-revision-7",
					objectKey: result.objectKey,
				}),
			},
		);
	});

	it("keeps markdown indexing behavior while enabling OCR on creation", async () => {
		const upload = vi.fn(async () => ({
			id: "text-item",
			status: "completed",
		}));
		const create = vi.fn(async () => ({ items: { upload } }));

		await indexContentDocument(
			{} as never,
			{
				CONTENT_CMS_BUCKET: { put: vi.fn(async () => undefined) } as never,
				CONTENT_AI_SEARCH: {
					get: () => ({
						info: async () => {
							throw new Error("ai_search_not_found");
						},
					}),
					create,
				} as never,
			},
			{
				appId: "5eed0040-0000-4000-8000-000000000040",
				appSlug: "guide",
				canonicalUrl: "https://example.com/guide",
				title: "Guide",
				contentType: "docs",
				visibility: "public",
				markdown: "# Guide\n\nReader content.",
			},
		);

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ indexing_options: { use_ocr: true } }),
		);
		expect(upload.mock.calls[0]?.[1]).toContain("# Guide\n\nReader content.");
	});
});
