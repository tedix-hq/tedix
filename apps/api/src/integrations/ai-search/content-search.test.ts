import { describe, expect, it, vi } from "vite-plus/test";
import { contentSearchInstanceId } from "./content-index";
import { searchContent } from "./content-search";

describe("content AI Search", () => {
	it("derives one valid 32-character instance ID per app UUID", () => {
		expect(
			contentSearchInstanceId("5eed0040-0000-4000-8000-000000000040"),
		).toBe("5eed0040000040008000000000000040");
	});

	it("returns the exact canonical URL carried by item metadata", async () => {
		const search = vi.fn().mockResolvedValue({
			search_query: "billing",
			chunks: [
				{
					id: "chunk-1",
					type: "text",
					score: 0.91,
					text: "# Billing guide\n\nUse the governed checkout.",
					item: {
						key: "ignored-lossy-filename.md",
						metadata: {
							canonicalUrl: "https://example.com/docs/billing?edition=2",
							sourceRevision: "sha256:abc",
							visibility: "private",
							objectKey: "app/sources/source/abc.md",
							digest: "abc",
						},
					},
				},
			],
		});
		const get = vi.fn().mockReturnValue({ search });

		const result = await searchContent(
			{ CONTENT_AI_SEARCH: { get } as unknown as AiSearchNamespace },
			"billing",
			{
				appId: "5eed0040-0000-4000-8000-000000000040",
				limit: 3,
				resolveDocuments: async () =>
					new Map([
						[
							"app/sources/source/abc.md",
							{
								canonicalUrl: "https://example.com/docs/billing?edition=2",
								sourceRevision: "sha256:abc",
								visibility: "private" as const,
								objectKey: "app/sources/source/abc.md",
								digest: "abc",
								title: "Billing guide",
								contentType: "docs",
							},
						],
					]),
			},
		);

		expect(get).toHaveBeenCalledWith("5eed0040000040008000000000000040");
		expect(result.sources).toEqual([
			{
				url: "https://example.com/docs/billing?edition=2",
				title: "Billing guide",
				snippet: "Use the governed checkout.",
				score: 0.91,
				category: "docs",
			},
		]);
	});

	it("drops chunks that cannot prove all citation metadata", async () => {
		const search = vi.fn().mockResolvedValue({
			search_query: "query",
			chunks: [
				{
					id: "chunk-1",
					type: "text",
					score: 0.5,
					text: "Unattributed",
					item: { key: "unknown.md", metadata: {} },
				},
			],
		});
		vi.spyOn(console, "error").mockImplementation(() => undefined);

		const result = await searchContent(
			{
				CONTENT_AI_SEARCH: {
					get: () => ({ search }),
				} as unknown as AiSearchNamespace,
			},
			"query",
			{
				appId: "5eed0040-0000-4000-8000-000000000040",
				resolveDocuments: async () => new Map(),
			},
		);

		expect(result.success).toBe(true);
		expect(result.sources).toEqual([]);
	});
});
