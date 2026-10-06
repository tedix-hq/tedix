import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createDescopeResource,
	deleteDescopeResource,
	loadAllDescopeResources,
	loadDescopeResource,
	loadDescopeResourceByUri,
	updateDescopeResource,
} from "./descope-resource";

const env = {
	DESCOPE_PROJECT_ID: "P123",
	DESCOPE_MANAGEMENT_KEY: "management-key",
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Descope Resource management", () => {
	it("uses the Resource API instead of the legacy MCP server API", async () => {
		const resource = {
			id: "RS123",
			name: "Tedix Unified",
			uri: "https://tedix-unified.mcp.tedix.dev/mcp",
			type: "mcp",
		};
		const fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(JSON.stringify({ resource }), { status: 200 }),
			);
		vi.stubGlobal("fetch", fetch);

		await expect(
			createDescopeResource(env, {
				name: resource.name,
				uri: resource.uri,
				type: "mcp",
			}),
		).resolves.toEqual(resource);

		expect(fetch).toHaveBeenCalledWith(
			"https://api.descope.com/v1/mgmt/resource/create",
			expect.objectContaining({ method: "POST" }),
		);
		expect(fetch.mock.calls[0]?.[0]).not.toContain("/mcp/server/");
	});

	it("loads resources by ID, URI, and inventory", async () => {
		const resource = {
			id: "RS123",
			name: "Tedix Unified",
			uri: "https://tedix-unified.mcp.tedix.dev/mcp",
			type: "mcp",
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ resource }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ resource }), { status: 200 }),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ resources: [resource], total: 1 }), {
					status: 200,
				}),
			);
		vi.stubGlobal("fetch", fetch);

		await expect(loadDescopeResource(env, "RS 123")).resolves.toEqual(resource);
		await expect(loadDescopeResourceByUri(env, resource.uri)).resolves.toEqual(
			resource,
		);
		await expect(loadAllDescopeResources(env)).resolves.toEqual([resource]);

		expect(fetch.mock.calls.map(([url]) => url)).toEqual([
			"https://api.descope.com/v1/mgmt/resource/load?id=RS%20123",
			"https://api.descope.com/v1/mgmt/resource/load/uri?uri=https%3A%2F%2Ftedix-unified.mcp.tedix.dev%2Fmcp",
			"https://api.descope.com/v1/mgmt/resources/load",
		]);
	});

	it("wraps updates and exact-ID deletes", async () => {
		const resource = {
			id: "RS123",
			name: "Tedix Unified",
			uri: "https://tedix-unified.mcp.tedix.dev/mcp",
			type: "mcp",
		};
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ resource }), { status: 200 }),
			)
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetch);

		await expect(updateDescopeResource(env, resource)).resolves.toEqual(
			resource,
		);
		await deleteDescopeResource(env, resource.id);

		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
			resource,
		});
		expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
			id: "RS123",
		});
	});
});
