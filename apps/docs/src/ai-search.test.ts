import { describe, expect, it, vi } from "vite-plus/test";
import { indexPublicDocsBuild, searchPublicDocs } from "./ai-search";
import type { DocsBuild, DocsSite } from "./types";

const SITE: DocsSite = {
	id: "11111111-1111-4111-8111-111111111111",
	orgSlug: "tedix",
	slug: "tedix",
	title: "Tedix Docs",
	description: "Docs",
	locale: "en",
	canonicalUrl: "https://docs.tedix.dev",
	sourceProvider: "artifacts",
	sourceAuthMode: "public",
	repositoryUrl: null,
	artifactsRepository: "docs",
	branch: "main",
	contentRoot: "docs/public",
	accessMode: "public",
	status: "active",
	activeBuildId: "22222222-2222-4222-8222-222222222222",
	latestBuildId: "22222222-2222-4222-8222-222222222222",
	createdAt: "2026-08-09T00:00:00Z",
	updatedAt: "2026-08-09T00:00:00Z",
};

const BUILD: DocsBuild = {
	id: "22222222-2222-4222-8222-222222222222",
	siteId: SITE.id,
	status: "complete",
	phase: "ready",
	sourceBranch: "main",
	sourceRevision: "abc123",
	proposalId: null,
	manifestKey: `sites/${SITE.id}/builds/22222222-2222-4222-8222-222222222222/manifest.json`,
	error: null,
	requestedBy: null,
	createdAt: "2026-08-09T00:00:00Z",
	startedAt: null,
	finishedAt: "2026-08-09T00:00:00Z",
};

describe("Docs AI Search", () => {
	it("indexes only Markdown from one exact public immutable build", async () => {
		const upload = vi.fn(
			async (_key: string, _content: string, _options: unknown) => ({
				id: "item",
				status: "pending",
			}),
		);
		const searchInstance = {
			info: vi.fn(async () => ({
				custom_metadata: [
					"siteid",
					"buildid",
					"sourcerevision",
					"canonicalurl",
					"pagetitle",
				].map((field_name) => ({ field_name })),
				embedding_model: "@cf/qwen/qwen3-vl-embedding-2b",
				indexing_options: { use_ocr: true },
			})),
			update: vi.fn(),
			items: { upload },
		};
		const objects = new Map<string, unknown>([
			[
				BUILD.manifestKey as string,
				{
					json: async () => ({
						buildId: BUILD.id,
						sourceRevision: BUILD.sourceRevision,
						files: ["index.md", "guide/index.md", "pagefind/index.js"],
					}),
				},
			],
			[
				`sites/${SITE.id}/builds/${BUILD.id}/index.md`,
				{ text: async () => "Home" },
			],
			[
				`sites/${SITE.id}/builds/${BUILD.id}/guide/index.md`,
				{
					text: async () =>
						'---\ntitle: "Guide"\n---\n\n> Documentation Index\n> Fetch the complete documentation index at: https://docs.tedix.dev/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n# Guide\n\nUseful reader content.\n\nSource: https://example.com/guide.md\n',
				},
			],
		]);
		const projection = await indexPublicDocsBuild(
			{
				DOCS_BUILDS: {
					get: async (key: string) => objects.get(key) ?? null,
				} as never,
				DOCS_AI_SEARCH: { get: () => searchInstance } as never,
			},
			SITE,
			BUILD,
		);

		expect(projection.accepted).toBe(2);
		expect(searchInstance.update).not.toHaveBeenCalled();
		expect(upload).toHaveBeenCalledTimes(2);
		expect(upload.mock.calls[0]?.[2]).toMatchObject({
			metadata: {
				buildId: BUILD.id,
				sourceRevision: "abc123",
				canonicalUrl: "https://docs.tedix.dev/",
			},
		});
		expect(upload.mock.calls[1]?.[2]).toMatchObject({
			metadata: {
				canonicalUrl: "https://docs.tedix.dev/guide",
				pageTitle: "Guide",
			},
		});
		expect(upload.mock.calls[1]?.[1]).toBe("# Guide\n\nUseful reader content.");
	});

	it("uploads supported images and PDFs as native binary inputs with OCR enabled", async () => {
		const upload = vi.fn(
			async (_key: string, _content: string | Blob, _options: unknown) => ({
				id: "item",
				status: "pending",
			}),
		);
		const update = vi.fn(async (_config: unknown) => undefined);
		const searchInstance = {
			info: vi.fn(async () => ({
				custom_metadata: [],
				indexing_options: { keyword_tokenizer: "porter" },
			})),
			update,
			items: { upload },
		};
		const imageBytes = new Uint8Array([137, 80, 78, 71]);
		const pdfBytes = new Uint8Array([37, 80, 68, 70]);
		const objects = new Map<string, unknown>([
			[
				BUILD.manifestKey as string,
				{
					json: async () => ({
						buildId: BUILD.id,
						sourceRevision: BUILD.sourceRevision,
						files: ["media/diagram.png", "downloads/scanned.pdf", "app.js"],
					}),
				},
			],
			[
				`sites/${SITE.id}/builds/${BUILD.id}/media/diagram.png`,
				{
					size: imageBytes.byteLength,
					arrayBuffer: async () => imageBytes.buffer,
				},
			],
			[
				`sites/${SITE.id}/builds/${BUILD.id}/downloads/scanned.pdf`,
				{
					size: pdfBytes.byteLength,
					arrayBuffer: async () => pdfBytes.buffer,
				},
			],
		]);

		const projection = await indexPublicDocsBuild(
			{
				DOCS_BUILDS: {
					get: async (key: string) => objects.get(key) ?? null,
				} as never,
				DOCS_AI_SEARCH: { get: () => searchInstance } as never,
			},
			SITE,
			BUILD,
		);

		expect(projection.accepted).toBe(2);
		expect(update).toHaveBeenCalledWith({
			custom_metadata: expect.any(Array),
			embedding_model: "@cf/qwen/qwen3-vl-embedding-2b",
			indexing_options: { use_ocr: true },
		});
		expect(upload).toHaveBeenCalledTimes(2);
		const firstUpload = upload.mock.calls[0];
		const secondUpload = upload.mock.calls[1];
		expect(firstUpload?.[1]).toBeInstanceOf(Blob);
		expect((firstUpload?.[1] as Blob | undefined)?.type).toBe("image/png");
		expect(upload.mock.calls[0]?.[2]).toMatchObject({
			metadata: {
				buildId: BUILD.id,
				sourceRevision: BUILD.sourceRevision,
				canonicalUrl: "https://docs.tedix.dev/media/diagram.png",
				pageTitle: "Diagram",
			},
		});
		expect((secondUpload?.[1] as Blob | undefined)?.type).toBe(
			"application/pdf",
		);
	});

	it("rejects authenticated preview corpora before touching AI Search", async () => {
		const get = vi.fn();
		await expect(
			indexPublicDocsBuild(
				{
					DOCS_BUILDS: {} as R2Bucket,
					DOCS_AI_SEARCH: { get } as never,
				},
				{ ...SITE, accessMode: "organization" },
				BUILD,
			),
		).rejects.toThrow("cannot be AI indexed");
		expect(get).not.toHaveBeenCalled();
	});

	it("returns citations only from the active build and source revision", async () => {
		const search = vi.fn(async () => ({
			chunks: [
				{
					text: '---\ntitle: "Guide"\n---\n\n> Documentation Index\n> Fetch the complete documentation index at: https://docs.tedix.dev/llms.txt\n> Use this file to discover all available pages before exploring further.\n\n# Guide\n\n> **Availability:** Cloud access requires beta approval. An approved new user can create their own organization. See [Release status](./release-status.md).\n\n## Install\n\n```bash\ntedix login',
					score: 0.9,
					item: {
						metadata: {
							siteId: SITE.id,
							buildId: BUILD.id,
							sourceRevision: BUILD.sourceRevision,
							canonicalUrl: "https://docs.tedix.dev/guide",
							pageTitle: "Guide",
						},
					},
				},
				{
					text: "Stale preview",
					score: 1,
					item: {
						metadata: {
							siteId: SITE.id,
							buildId: "preview-build",
							sourceRevision: "preview-revision",
							canonicalUrl: "https://preview.invalid",
						},
					},
				},
			],
		}));
		const result = await searchPublicDocs(
			{ DOCS_AI_SEARCH: { get: () => ({ search }) } as never },
			SITE,
			BUILD,
			"durable agents",
			8,
		);

		expect(search).toHaveBeenCalledWith({
			query: "durable agents",
			ai_search_options: {
				retrieval: {
					retrieval_type: "hybrid",
					max_num_results: 24,
					match_threshold: 0.3,
					filters: {
						siteid: SITE.id,
						buildid: BUILD.id,
						sourcerevision: BUILD.sourceRevision,
					},
				},
			},
		});
		expect(result.citations).toHaveLength(1);
		expect(result.retrievalLatencyMs).toEqual(expect.any(Number));
		expect(result.citations[0]).toMatchObject({
			url: "https://docs.tedix.dev/guide",
			title: "Guide",
			snippet:
				"Availability: Cloud access requires beta approval. An approved new user can create their own organization. See Release status. tedix login",
			buildId: BUILD.id,
			sourceRevision: "abc123",
		});
	});
});
