import { describe, expect, it, vi } from "vite-plus/test";
import { jsonToolResult } from "./image-generation";
import type { CmsProxyContext } from "./cms-proxy-runtime";
import { attachGeneratedImage } from "./image-generation-workflow";
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));

describe("image generation MCP results", () => {
	it("returns structuredContent for schema-backed status payloads", () => {
		const status = {
			jobId: "job-1",
			status: "complete",
			orgSlug: "tedix",
			result: {
				model: "gemini-3.1-flash-image-preview",
				prompt: "blue circle",
				mimeType: "image/png",
				filename: "blue-circle.png",
				media: { id: "media-1" },
				mediaValue: { type: "image", src: "media-1" },
			},
		};

		expect(jsonToolResult(status)).toMatchObject({
			content: [{ type: "text", text: expect.stringContaining("job-1") }],
			structuredContent: status,
		});
	});

	it("preserves structuredContent on failed status payloads", () => {
		const status = {
			jobId: "job-1",
			status: "failed",
			error: "Gemini returned no image part",
		};

		expect(jsonToolResult(status, true)).toMatchObject({
			isError: true,
			structuredContent: status,
		});
	});
});

describe("generated image attachment", () => {
	const media = { id: "media-one", meta: { storageKey: "image.png" } };
	const context = (
		fetch: (request: Request) => Promise<Response>,
	): CmsProxyContext => ({
		orgSlug: "tedix",
		environment: "production",
		forwardedAuth: undefined,
		serviceApiKey: undefined,
		internalAuthToken: "internal",
		cmsDispatch: { fetch } as unknown as Fetcher,
	});
	it("resolves the locale slug and guards the write with the revision it read", async () => {
		const seen: Request[] = [];
		const ctx = context(async (request) => {
			seen.push(request);
			return request.method === "GET"
				? Response.json({
						success: true,
						data: { item: { id: "canonical-ulid" }, _rev: "current-revision" },
					})
				: Response.json({
						success: true,
						data: { item: { id: "canonical-ulid" } },
					});
		});
		await attachGeneratedImage(
			ctx,
			{
				collection: "pages",
				id: "home",
				locale: "de",
				fieldName: "hero_image",
				updateSeoOgImage: true,
			},
			media,
		);
		expect(new URL(seen[0]!.url).search).toBe("?locale=de");
		expect(new URL(seen[1]!.url).pathname).toBe(
			"/_emdash/api/content/pages/canonical-ulid",
		);
		expect(await seen[1]!.json()).toEqual({
			data: { hero_image: media },
			seo: { ogImage: "image.png" },
			_rev: "current-revision",
		});
	});
	it.each([
		Response.json(
			{ success: false, error: { code: "NOT_FOUND", message: "Gone" } },
			{ status: 404 },
		),
		Response.json({ success: true, data: { item: { id: "canonical-ulid" } } }),
	])(
		"does not write after an unsuccessful or incomplete read",
		async (read) => {
			const seen: Request[] = [];
			const ctx = context(async (request) => {
				seen.push(request);
				return read;
			});
			await expect(
				attachGeneratedImage(ctx, { collection: "pages", id: "home" }, media),
			).rejects.toThrow();
			expect(seen.map((request) => request.method)).toEqual(["GET"]);
		},
	);
	it("surfaces a concurrent-edit conflict without retrying the mutation", async () => {
		const seen: Request[] = [];
		const ctx = context(async (request) => {
			seen.push(request);
			return request.method === "GET"
				? Response.json({
						success: true,
						data: { item: { id: "canonical-ulid" }, _rev: "stale-revision" },
					})
				: Response.json(
						{
							success: false,
							error: { code: "CONFLICT", message: "Concurrent edit" },
						},
						{ status: 409 },
					);
		});
		await expect(
			attachGeneratedImage(ctx, { collection: "pages", id: "home" }, media),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(seen.map((request) => request.method)).toEqual(["GET", "PUT"]);
	});
});
