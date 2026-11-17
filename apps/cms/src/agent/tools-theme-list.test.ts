import type { McpServer } from "@tedix/mcp-shared/server";
import { expect, it, vi } from "vite-plus/test";
import { registerThemeTools } from "./tools-theme";
import type { SiteBuilderToolContext } from "./tools-shared";

it("returns a bounded theme file page with a continuation cursor", async () => {
	let handler:
		| ((args: { cursor?: number; limit?: number }) => Promise<{
				structuredContent: {
					files: unknown[];
					nextCursor: number | null;
				};
		  }>)
		| undefined;
	const server = {
		registerTool: (
			name: string,
			_definition: unknown,
			call: typeof handler,
		) => {
			if (name === "theme_list_files") handler = call;
		},
	} as unknown as McpServer;
	const listThemeFiles = vi.fn(async () => ({
		entries: Array.from({ length: 100 }, (_, index) => ({
			relativePath: `pages/page-${index}.astro`,
			size: index,
		})),
		nextCursor: 100,
	}));
	registerThemeTools(server, {
		orgSlug: "acme",
		templateSlug: "tedix",
		sandbox: { listThemeFiles },
	} as unknown as SiteBuilderToolContext);

	const result = await handler!({});

	expect(listThemeFiles).toHaveBeenCalledWith("/workspace/src", {
		cursor: 0,
		limit: 100,
	});
	expect(result.structuredContent).toMatchObject({
		files: expect.arrayContaining([
			{
				path: "src/pages/page-0.astro",
				size: 0,
				status: "editable",
			},
		]),
		nextCursor: 100,
	});
	expect(result.structuredContent.files).toHaveLength(100);
});
