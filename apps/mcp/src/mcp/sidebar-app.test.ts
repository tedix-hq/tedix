import { describe, expect, it } from "vite-plus/test";
import { compactCodeModeTools } from "../codemode-fast-paths";
import {
	buildBootstrapInfo,
	registerGetInfoTool,
	registerBootstrapResources,
} from "./registration/bootstrap";
import { sidebarAppConfig, sidebarAppToolMeta } from "./sidebar-app";
import type { ServerContext } from "./server-context";
import { vi } from "vite-plus/test";

const sidebarApp = {
	title: "Tedix",
	tabs: [
		{
			id: "deck",
			label: "Deck",
			tool: "show_deck",
		},
		{
			id: "feed",
			label: "Feed",
			tool: "show_feed",
		},
	],
};
const mcpConfig = {
	codeMode: true,
	codeModeNativeTools: ["get_info"],
	sidebarApp,
};

describe("configured sidebar entrypoint", () => {
	it("advertises exactly one global entry with the same resource in compact and registered discovery", () => {
		const server = { registerTool: vi.fn(), registerResource: vi.fn() };
		const agent = {
			appSlug: "connect",
			app: { name: "Tedix" },
			appMetadata: { mcpConfig },
			server,
			registeredTools: new Map(),
			registeredResources: new Map(),
		} as unknown as ServerContext;
		registerGetInfoTool(agent);
		registerBootstrapResources(agent);
		const tools = compactCodeModeTools(
			{
				app: { slug: "connect", name: "Tedix" },
				metadata: { mcpConfig },
			} as never,
			new Headers(),
		);
		expect(
			tools.filter(
				(tool) => (tool._meta as Record<string, unknown>)?.["openai/ui"],
			),
		).toHaveLength(1);
		const entry = tools.find((tool) => tool.name === "get_info")!;
		expect(entry.title).toBe("Tedix");
		expect(entry.inputSchema).toMatchObject({ type: "object", properties: {} });
		expect(entry._meta).toEqual(server.registerTool.mock.calls[0]![1]._meta);
		expect(entry._meta).toMatchObject({
			"openai/ui": { entrypoints: [{ type: "global" }] },
			ui: { resourceUri: "ui://widgets/mcp-app/connect/r/sidebar-app.html" },
		});
		expect(server.registerResource.mock.calls[0]![1]).toBe(
			"ui://widgets/mcp-app/connect/r/sidebar-app.html",
		);
		expect(tools.find((tool) => tool.name === "code")?._meta).toMatchObject({
			ui: { visibility: ["model", "app"] },
		});
	});

	it("has no sidebar without a valid opt-in and rejects duplicate tab IDs", () => {
		expect(sidebarAppToolMeta("example", {})).toEqual({});
		expect(sidebarAppConfig({ sidebarApp })).toBeNull();
		expect(
			sidebarAppConfig({
				...mcpConfig,
				sidebarApp: {
					...sidebarApp,
					tabs: [sidebarApp.tabs[0], sidebarApp.tabs[0]],
				},
			}),
		).toBeNull();
	});

	it("returns only the request's live verified organization choices and no member cards", () => {
		const agent = {
			appSlug: "connect",
			app: { name: "Tedix", organizationId: "hosting-org" },
			appMetadata: { mcpConfig },
			getServerVersion: () => "1",
			loadedTools: new Map(),
			registeredTools: new Map(),
			callerIdentity: {
				authType: "oauth",
				userId: "member-one",
				verifiedMultiOrgOrganizations: [
					{
						organizationId: "maple",
						descopeTenantId: "tenant-maple",
						gatewaySlug: "maple-unified",
					},
				],
			},
		} as unknown as ServerContext;
		const info = buildBootstrapInfo(agent);
		expect(info.sidebarApp).toMatchObject({
			organizations: [{ id: "maple", label: "maple" }],
			accountId: "member-one",
		});
		expect(info.sidebarApp).not.toHaveProperty("cards");
		expect(
			buildBootstrapInfo({ ...agent, callerIdentity: undefined }).sidebarApp,
		).toMatchObject({
			organizations: [],
			accountId: null,
		});
	});
});
