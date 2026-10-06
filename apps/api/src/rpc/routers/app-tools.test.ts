/**
 * App-tools router MCP subscription publishes.
 *
 * Every app_tools mutation must nudge live MCP subscribers: tools/list_changed
 * plus resources/list_changed (each row derives a ui:// widget resource), and
 * prompts/list_changed when a prompt-type row is touched.
 */

import { createRouterClient } from "@orpc/server";
import {
	resolveMcpToolNamespace,
	resolveMcpToolRequiredScopes,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getAppById: vi.fn(),
	getAdaptersByAppId: vi.fn(),
	getToolByAppAndToolId: vi.fn(),
	getToolById: vi.fn(),
	listToolsPage: vi.fn(),
	upsertTool: vi.fn(),
	deleteTool: vi.fn(),
	toggleToolEnabled: vi.fn(),
	bulkUpdateToolSortOrders: vi.fn(),
}));

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getAppById: mocks.getAppById };
});

vi.mock("@tedix/db/queries/adapters", () => ({
	getAdaptersByAppId: mocks.getAdaptersByAppId,
}));

vi.mock("@tedix/db/queries/tools", () => ({
	getToolByAppAndToolId: mocks.getToolByAppAndToolId,
	getToolById: mocks.getToolById,
	listToolsPage: mocks.listToolsPage,
	upsertTool: mocks.upsertTool,
	deleteTool: mocks.deleteTool,
	toggleToolEnabled: mocks.toggleToolEnabled,
	bulkUpdateToolSortOrders: mocks.bulkUpdateToolSortOrders,
}));

import { appToolsContractRouter } from "./app-tools";

const ORG_ID = "org-1";
const APP_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";
const TOOL_UUID = "6f0a49a2-8c5f-4d0b-a2e6-1f2d3c4b5a69";

function makeToolRow(overrides: Record<string, unknown> = {}) {
	return {
		id: TOOL_UUID,
		appId: APP_ID,
		toolId: "list_things",
		toolTypeId: "rpc",
		title: "List things",
		description: null,
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		adapterScope: "primary",
		resultStrategy: "merge",
		outputTemplate: null,
		widgetRoute: null,
		widgetKey: null,
		widgetAccessible: true,
		authRequired: false,
		visibility: "public",
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		widgetDescription: null,
		widgetPrefersBorder: true,
		widgetDomain: null,
		config: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: 0,
		enabled: true,
		createdAt: "2026-07-01T00:00:00.000Z",
		updatedAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function makeHarness() {
	const published: Array<{ appId?: string; method: string }> = [];
	const invalidations: Array<{ url: string; body: unknown }> = [];
	const pending: Promise<unknown>[] = [];
	const env = {
		ENVIRONMENT: "test",
		MCP_SERVICE: {
			fetch: async (req: Request) => {
				const body = await req.json();
				if (req.url.endsWith("/subscriptions/publish")) {
					published.push(body as { appId?: string; method: string });
				} else {
					invalidations.push({ url: req.url, body });
				}
				return Response.json({ ok: true });
			},
		},
	} as unknown as CloudflareEnv;

	const context: BaseContext = {
		authType: "user",
		db: {} as BaseContext["db"],
		env,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/app-tools"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions: ["apps:read", "apps:update"],
			roles: [],
		},
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
	} as BaseContext;

	const client = createRouterClient(appToolsContractRouter, { context });
	const flush = () => Promise.all(pending);
	return { client, flush, published, invalidations };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAppById.mockResolvedValue({
		id: APP_ID,
		organizationId: ORG_ID,
		slug: "inventory-app",
		customMcpDomain: "tools.example.com",
	});
	mocks.getAdaptersByAppId.mockResolvedValue([]);
	mocks.getToolByAppAndToolId.mockResolvedValue(undefined);
});

describe("app-tools list", () => {
	it("returns one server-owned page with filtered and inventory counts", async () => {
		const { client } = makeHarness();
		mocks.listToolsPage.mockResolvedValue({
			rows: [makeToolRow({ toolId: "list_matching" })],
			total: 1,
			inventoryTotal: 908,
		});

		const result = await client.list({
			appId: APP_ID,
			limit: 25,
			offset: 25,
			query: "matching",
		});

		expect(mocks.listToolsPage).toHaveBeenCalledWith(
			expect.anything(),
			APP_ID,
			{
				limit: 25,
				offset: 25,
				query: "matching",
			},
		);
		expect(result.data.map((tool) => tool.toolId)).toEqual(["list_matching"]);
		expect(result.pagination).toEqual({
			limit: 25,
			offset: 25,
			total: 1,
			hasMore: false,
		});
		expect(result.inventoryTotal).toBe(908);
	});

	it("marks an unmapped tool without turning unknown scope into an empty grant", async () => {
		const { client } = makeHarness();
		const unmapped = makeToolRow({
			toolId: "resolve_mcp_credentials",
			config: { endpoint: "mcpCredentials/resolve" },
			annotations: { readOnlyHint: true },
			writeCapability: "read",
		});
		const mapped = makeToolRow({
			id: "5fc8ae7c-2f1d-4a6d-bf73-812db4a02894",
			toolId: "list_app_tools",
			config: { endpoint: "appTools/list" },
			annotations: { readOnlyHint: true },
			writeCapability: "read",
		});
		mocks.listToolsPage.mockResolvedValue({
			rows: [unmapped, mapped],
			total: 2,
			inventoryTotal: 2,
		});

		const result = await client.list({ appId: APP_ID, limit: 25, offset: 0 });

		expect(result.data[0]).toMatchObject({
			toolId: "resolve_mcp_credentials",
			scopeMappingMissing: true,
		});
		expect(result.data[0]).not.toHaveProperty("requiredScopes");
		expect(result.data[1]).toMatchObject({
			toolId: "list_app_tools",
			requiredScopes: [],
		});
		expect(result.data[1]).not.toHaveProperty("scopeMappingMissing");
	});

	it("marks the same unmapped state on exact tool reads", async () => {
		const { client } = makeHarness();
		mocks.getToolById.mockResolvedValue(
			makeToolRow({
				toolId: "resolve_mcp_credentials",
				config: { endpoint: "mcpCredentials/resolve" },
				annotations: { readOnlyHint: true },
				writeCapability: "read",
			}),
		);

		const result = await client.get({ appId: APP_ID, toolId: TOOL_UUID });

		expect(result.scopeMappingMissing).toBe(true);
		expect(result).not.toHaveProperty("requiredScopes");
	});

	it("does not catch unrelated scope resolver failures", async () => {
		const { client } = makeHarness();
		mocks.getAppById.mockResolvedValue({
			id: APP_ID,
			organizationId: ORG_ID,
			slug: "inventory-app",
			customMcpDomain: null,
			metadata: {
				mcpConfig: { toolScopes: { list_app_tools: "not-an-array" } },
			},
		});
		mocks.listToolsPage.mockResolvedValue({
			rows: [
				makeToolRow({
					toolId: "list_app_tools",
					config: { endpoint: "appTools/list" },
				}),
			],
			total: 1,
			inventoryTotal: 1,
		});

		await expect(
			client.list({ appId: APP_ID, limit: 25, offset: 0 }),
		).rejects.toThrow();
	});

	it("keeps actual MCP dispatch scope resolution fail-closed", () => {
		const tool = {
			toolId: "resolve_mcp_credentials",
			toolTypeId: "rpc",
			config: { endpoint: "mcpCredentials/resolve" },
			authRequired: false,
			visibility: "public",
			annotations: { readOnlyHint: true },
			writeCapability: "read" as const,
		};
		expect(() =>
			resolveMcpToolRequiredScopes(
				tool,
				resolveMcpToolNamespace(tool),
				undefined,
			),
		).toThrow(
			"Missing MCP capability mapping for tool: resolve_mcp_credentials",
		);
	});
});

describe("app-tools mutation subscription publishes", () => {
	it("delete publishes tools + resources list_changed for a non-prompt tool", async () => {
		const { client, flush, published, invalidations } = makeHarness();
		mocks.getToolById.mockResolvedValue(makeToolRow());
		mocks.deleteTool.mockResolvedValue(undefined);

		await client.delete({ appId: APP_ID, toolId: TOOL_UUID });
		await flush();

		expect(mocks.deleteTool).toHaveBeenCalledWith(expect.anything(), TOOL_UUID);
		expect(published.map((p) => p.method)).toEqual([
			"notifications/tools/list_changed",
			"notifications/resources/list_changed",
		]);
		for (const event of published) {
			expect(event.appId).toBe(APP_ID);
		}
		expect(invalidations).toEqual([
			{
				url: "https://mcp/__internal/purge-discovery-cache",
				body: {
					appId: APP_ID,
					appResolutionKeys: [
						"mcp-subdomain:inventory-app",
						"custom:tools.example.com",
					],
				},
			},
			{
				url: "https://mcp/__internal/purge-aggregate-cache",
				body: { reason: "inventory-list-changed" },
			},
		]);
	});

	it("create of a prompt-type tool also publishes prompts/list_changed", async () => {
		const { client, flush, published } = makeHarness();
		mocks.upsertTool.mockResolvedValue(
			makeToolRow({ toolId: "summarize_report", toolTypeId: "prompt" }),
		);

		await client.create({
			appId: APP_ID,
			toolId: "summarize_report",
			toolTypeId: "prompt",
			title: "Summarize report",
		});
		await flush();

		expect(published.map((p) => p.method)).toEqual([
			"notifications/tools/list_changed",
			"notifications/resources/list_changed",
			"notifications/prompts/list_changed",
		]);
	});

	it("rejects a new non-conforming logical id", async () => {
		const { client } = makeHarness();

		await expect(
			client.create({
				appId: APP_ID,
				toolId: "skills_list",
				toolTypeId: "rpc",
				title: "Skills list",
			}),
		).rejects.toThrow(/not verb-first/);

		expect(mocks.getToolByAppAndToolId).toHaveBeenCalledWith(
			expect.anything(),
			APP_ID,
			"skills_list",
		);
		expect(mocks.upsertTool).not.toHaveBeenCalled();
	});

	it("allows an existing non-conforming logical id to be re-submitted", async () => {
		const { client } = makeHarness();
		const existing = makeToolRow({ toolId: "skills_list" });
		mocks.getToolByAppAndToolId.mockResolvedValue(existing);
		mocks.upsertTool.mockResolvedValue(existing);

		await expect(
			client.create({
				appId: APP_ID,
				toolId: "skills_list",
				toolTypeId: "rpc",
				title: "Skills list",
			}),
		).resolves.toMatchObject({ toolId: "skills_list" });

		expect(mocks.upsertTool).toHaveBeenCalledOnce();
	});

	it("enable of a non-prompt tool publishes tools + resources only", async () => {
		const { client, flush, published } = makeHarness();
		mocks.getToolById.mockResolvedValue(makeToolRow());
		mocks.toggleToolEnabled.mockResolvedValue(undefined);

		await client.enable({ appId: APP_ID, toolId: TOOL_UUID });
		await flush();

		expect(published.map((p) => p.method)).toEqual([
			"notifications/tools/list_changed",
			"notifications/resources/list_changed",
		]);
	});
});
