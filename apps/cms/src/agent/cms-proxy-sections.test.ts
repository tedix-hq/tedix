import { describe, expect, it, vi } from "vite-plus/test";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import { CMS_PROXY_TOOL_SCHEMAS } from "./cms-proxy-schemas";
import { REST_ROUTES } from "./cms-proxy-rest-routes";
import type { McpServer } from "@tedix/mcp-shared/server";
import type { CmsProxyContext, ToolResult } from "./cms-proxy-runtime";

const section = {
	id: "section-id",
	slug: "link-directory",
	title: "Link directory",
	description: null,
	keywords: null,
	content: [],
	previewMediaId: null,
	source: "user",
	themeId: null,
	createdAt: "2026-01-01",
	updatedAt: "2026-01-01",
};

function toolsFor(fetch: (request: Request) => Promise<Response>) {
	const handlers = new Map<
		string,
		(args: Record<string, unknown>) => Promise<ToolResult>
	>();
	const server = {
		registerTool(
			name: string,
			_definition: unknown,
			handler: (args: Record<string, unknown>) => Promise<ToolResult>,
		) {
			handlers.set(name, handler);
		},
	};
	registerCmsProxyTools(server as unknown as McpServer, {
		orgSlug: "example",
		environment: "production",
		forwardedAuth: "human.jwt.token",
		internalAuthToken: "internal-test",
		serviceApiKey: "ec_pat_unused",
		cmsDispatch: { fetch } as CmsProxyContext["cmsDispatch"],
	});
	return handlers;
}

describe("native sections and typed page blocks", () => {
	it("uses native section bodies, filters, renamed slugs and response envelopes", () => {
		expect(
			REST_ROUTES.list_sections!.query!({
				source: "user",
				search: "links",
				limit: 2,
				cursor: "next",
			}),
		).toEqual({ source: "user", search: "links", limit: "2", cursor: "next" });
		expect(REST_ROUTES.update_section!.path({ slug: "old/name" })).toBe(
			"/sections/old%2Fname",
		);
		expect(
			REST_ROUTES.update_section!.body!({
				slug: "old-name",
				changes: { slug: "new-name", title: "New" },
			}),
		).toEqual({ slug: "new-name", title: "New" });
		for (const name of [
			"get_section",
			"create_section",
			"update_section",
		] as const) {
			expect(
				CMS_PROXY_TOOL_SCHEMAS[name].output.safeParse({
					success: true,
					data: section,
				}).success,
			).toBe(true);
		}
		expect(
			CMS_PROXY_TOOL_SCHEMAS.list_sections.output.safeParse({
				success: true,
				data: { items: [section], nextCursor: "next" },
			}).success,
		).toBe(true);
		expect(
			CMS_PROXY_TOOL_SCHEMAS.create_section.input.safeParse({
				slug: "example",
				title: "Example",
				content: "invalid",
			}).success,
		).toBe(false);
	});

	it("requires block types, retained versions and an entry revision", () => {
		const input = {
			collection: "pages",
			id: "home",
			field: "content",
			_rev: "rev",
			blocks: [{ _type: "marketing_hero", _version: 2, headline: "Hello" }],
		};
		expect(
			CMS_PROXY_TOOL_SCHEMAS.set_content_blocks.input.parse(input),
		).toEqual(input);
		expect(
			CMS_PROXY_TOOL_SCHEMAS.set_content_blocks.input.safeParse({
				...input,
				_rev: undefined,
			}).success,
		).toBe(false);
		for (const block of [
			{ _type: "marketing_hero" },
			{ _type: "marketing_hero", _version: 0 },
			{ _version: 1 },
		]) {
			expect(
				CMS_PROXY_TOOL_SCHEMAS.set_content_blocks.input.safeParse({
					...input,
					blocks: [block],
				}).success,
			).toBe(false);
		}
	});

	it("saves only the requested blocks field without publishing, overriding locks or retrying a stale revision", async () => {
		const requests: Request[] = [];
		const bodies: unknown[] = [];
		const fetch = vi.fn(async (request: Request) => {
			requests.push(request);
			bodies.push(await request.json());
			return Response.json(
				{ success: false, error: { code: "REVISION_CONFLICT" } },
				{ status: 409 },
			);
		});
		const handler = toolsFor(fetch).get("set_content_blocks")!;
		const blocks = [
			{
				_type: "marketing_hero",
				_version: 2,
				_key: "hero",
				headline: "Updated",
			},
		];
		const result = await handler({
			collection: "pages",
			id: "home",
			field: "content",
			_rev: "stale",
			blocks,
		});
		expect(result.isError).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(requests[0]!.method).toBe("PUT");
		expect(new URL(requests[0]!.url).pathname).toBe(
			"/_emdash/api/content/pages/home",
		);
		expect(requests[0]!.headers.get("Cookie")).toBe("DS=human.jwt.token");
		expect(requests[0]!.headers.has("Authorization")).toBe(false);
		expect(bodies).toEqual([{ data: { content: blocks }, _rev: "stale" }]);
	});

	it("keeps section authorization denials on the original human identity", async () => {
		const fetch = vi.fn(async (request: Request) => {
			expect(request.method).toBe("POST");
			expect(new URL(request.url).pathname).toBe("/_emdash/api/sections");
			expect(request.headers.get("Cookie")).toBe("DS=human.jwt.token");
			return Response.json(
				{ success: false, error: { code: "FORBIDDEN" } },
				{ status: 403 },
			);
		});
		const result = await toolsFor(fetch).get("create_section")!({
			slug: "link-directory",
			title: "Link directory",
			content: [],
		});
		expect(result.isError).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
