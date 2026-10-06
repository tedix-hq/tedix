import { beforeEach, expect, it, vi } from "vite-plus/test";
import { getCmsSiteOverview } from "./cms-proxy-inspection";
import { callCmsRest, listTenantMcpTools } from "./cms-proxy-runtime";

vi.mock("./cms-proxy-runtime", () => ({
	apiData: (value: { data?: unknown }) => value.data ?? value,
	buildCmsAuthHeaderCandidates: () => [],
	cmsApiBaseUrl: () => "https://sample.cms.tedix.dev/_emdash/api",
	callCmsRest: vi.fn(),
	listTenantMcpTools: vi.fn(),
}));
const result = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
beforeEach(() => {
	vi.mocked(callCmsRest).mockImplementation(async (_ctx, tool) => {
		if (tool === "schema_list_collections")
			return result({ success: true, data: { items: [{ slug: "pages" }] } });
		if (tool === "schema_get_collection")
			return result({
				success: true,
				data: {
					item: {
						slug: "pages",
						fields: [{ slug: "content", type: "richtext" }],
					},
				},
			});
		if (tool === "schema_list_block_types")
			return result({
				success: true,
				data: { items: [{ slug: "hero", versions: [{ version: 2 }] }] },
			});
		if (tool === "taxonomy_list")
			return result({
				success: true,
				data: { taxonomies: [{ name: "category", hierarchical: true }] },
			});
		if (tool === "content_list")
			return result({
				success: true,
				data: {
					items: [
						{
							id: "entry",
							locale: "de",
							version: 7,
							draftRevisionId: "draft",
							liveRevisionId: "live",
							data: { title: "Titel" },
						},
					],
				},
			});
		return result({ success: true, data: { items: [] } });
	});
	vi.mocked(listTenantMcpTools).mockResolvedValue(
		result({
			tools: [
				{
					name: "content_update",
					inputSchema: {
						type: "object",
						properties: { _rev: { type: "string" } },
					},
					annotations: { readOnlyHint: false },
				},
			],
		}),
	);
});
it("reads native envelopes and exposes observed capabilities with distinct revision and URL surfaces", async () => {
	const output = await getCmsSiteOverview(
		{
			orgSlug: "sample",
			environment: "production",
			forwardedAuth: undefined,
			serviceApiKey: undefined,
			internalAuthToken: undefined,
		},
		{ includePlugins: false, includeRecentContent: true, locale: "de" },
	);
	const value = JSON.parse(output.content[0]?.text ?? "{}");
	expect(value.collections[0].fields).toEqual([
		{ slug: "content", type: "richtext" },
	]);
	expect(value.taxonomies[0].name).toBe("category");
	expect(value.capabilities.blockSchema).toEqual({
		status: "observed",
		types: [{ slug: "hero", versions: [{ version: 2 }] }],
	});
	expect(
		value.capabilities.nativeTools.tools[0].inputSchema.properties._rev,
	).toEqual({ type: "string" });
	expect(value.urls).toMatchObject({
		tenant: "https://sample.cms.tedix.dev",
		admin: "https://sample.cms.tedix.dev/_emdash/admin",
		nativeMcp: "https://sample.cms.tedix.dev/_emdash/api/mcp",
		canonicalPublic: null,
	});
	expect(value.recentContent.pages[0]).toMatchObject({
		locale: "de",
		version: 7,
		liveRevisionId: "live",
		draftRevisionId: "draft",
	});
	expect(value.databaseRuntime.durableObjectsStatus).toBe("not_inspected");
	expect(value.capabilities.activeBundleFeatures).toBe("not_inspected");
});
it("rejects legacy aliases and avoids capability claims after access denial", async () => {
	vi.mocked(callCmsRest).mockResolvedValue(
		result({ items: [{ slug: "obsolete" }] }),
	);
	vi.mocked(listTenantMcpTools).mockResolvedValue({
		...result({ error: "Human native MCP credential unavailable" }),
		isError: true,
	});
	const output = await getCmsSiteOverview(
		{
			orgSlug: "sample",
			environment: "production",
			forwardedAuth: undefined,
			serviceApiKey: undefined,
			internalAuthToken: undefined,
		},
		{ includePlugins: false },
	);
	const value = JSON.parse(output.content[0]?.text ?? "{}");
	expect(value.collections).toEqual([]);
	expect(value.capabilities.nativeTools.status).toBe("not_inspected");
});
