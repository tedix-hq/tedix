import { describe, expect, it, vi } from "vite-plus/test";
import type { AppTool, ServerContext } from "./mcp/server-context";
import { executeTool } from "./mcp/tool-execution";
import {
	mcpInventoryListChangedKinds,
	publishMcpInventoryListChanged,
	publishMcpListChanged,
} from "./subscription-publisher";

type PublishedEvent = { appId: string; body: Record<string, unknown> };

function makeSubscriptionBinding(published: PublishedEvent[]) {
	return {
		idFromName: (name: string) => ({ name }),
		get: (id: { name: string }) => ({
			fetch: async (_url: string, init?: RequestInit) => {
				published.push({
					appId: id.name,
					body: JSON.parse(String(init?.body ?? "{}")) as Record<
						string,
						unknown
					>,
				});
				return new Response(JSON.stringify({ ok: true, delivered: 1 }), {
					headers: { "Content-Type": "application/json" },
				});
			},
		}),
	} as unknown as DurableObjectNamespace;
}

function makeOperatorTool(endpoint: string): AppTool {
	return {
		id: "tool-row-id",
		toolId: "update_app_tool",
		title: "Update App Tool",
		description: "Update an app tool",
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: { transport: "rpc", endpoint },
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
	} as unknown as AppTool;
}

function makeAgent(
	env: Record<string, unknown>,
	result: {
		status: number;
		data: Record<string, unknown>;
	},
): ServerContext {
	const toolHandler = {
		execute: vi.fn(async () => result),
		buildStructuredContent: vi.fn(() => result.data),
		buildTextContent: vi.fn(() =>
			result.status >= 400 ? "Error: failed" : "ok",
		),
	};
	return {
		env: { ENVIRONMENT: "test", GIT_SHA: "1234567890abcdef", ...env },
		ctx: { waitUntil: vi.fn() },
		appId: "serving-app-uuid",
		appSlug: "tedix-unified",
		app: {
			id: "serving-app-uuid",
			slug: "tedix-unified",
			name: "Tedix Unified",
			organizationId: "org-uuid",
		},
		appMetadata: null,
		appCapabilities: {},
		apiClient: {},
		toolHandler,
		callerIdentity: {
			authType: "oauth",
			userId: "user-uuid",
			scopes: ["platform:admin"],
		},
		traceId: "trace-uuid",
		connectionLabel: undefined,
		bearerToken: undefined,
		upstreamAppId: undefined,
		registeredTools: new Map(),
		registeredResources: new Map(),
		registeredResourceTemplates: new Map(),
		registeredPrompts: new Map(),
		registeredWidgetResourceUris: new Set(),
		toolOutputTemplates: new Map(),
	} as unknown as ServerContext;
}

async function flushWaitUntil(agent: ServerContext): Promise<unknown[]> {
	const waitUntil = agent.ctx.waitUntil as unknown as ReturnType<typeof vi.fn>;
	return Promise.all(
		waitUntil.mock.calls.map((call) => call[0] as Promise<unknown>),
	);
}

describe("inventory list_changed publish seam (tool-execution dispatch)", () => {
	it("a successful appTools mutation publishes resources/prompts list_changed to target and serving apps", async () => {
		const published: PublishedEvent[] = [];
		const agent = makeAgent(
			{ MCP_SUBSCRIPTIONS: makeSubscriptionBinding(published) },
			{ status: 200, data: { id: "tool-1" } },
		);
		const result = await executeTool(
			agent,
			makeOperatorTool("appTools/update"),
			{ appId: "target-app-uuid", toolId: "tool-1" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result.isError).toBeUndefined();
		await flushWaitUntil(agent);

		const methods = published.map(
			(event) => `${event.appId}:${String(event.body.method)}`,
		);
		expect(methods).toContain(
			"target-app-uuid:notifications/resources/list_changed",
		);
		expect(methods).toContain(
			"target-app-uuid:notifications/prompts/list_changed",
		);
		// Serving/aggregate surface gets the same nudges (re-exported inventory).
		expect(methods).toContain(
			"serving-app-uuid:notifications/resources/list_changed",
		);
		// tools/list_changed for appTools CRUD stays owned by apps/api's router —
		// no duplicate emission from this seam.
		expect(methods.join("\n")).not.toContain(
			"notifications/tools/list_changed",
		);
	});

	it("catalog tool sync publishes tools+prompts+resources list_changed (no apps/api publish exists)", async () => {
		const published: PublishedEvent[] = [];
		const agent = makeAgent(
			{ MCP_SUBSCRIPTIONS: makeSubscriptionBinding(published) },
			{ status: 200, data: { added: 3 } },
		);
		await executeTool(
			agent,
			makeOperatorTool("catalog/syncCatalogToolsToApp"),
			{ catalogAppId: "catalog-uuid", appId: "target-app-uuid" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		await flushWaitUntil(agent);

		const targetMethods = published
			.filter((event) => event.appId === "target-app-uuid")
			.map((event) => event.body.method);
		expect(targetMethods).toEqual(
			expect.arrayContaining([
				"notifications/tools/list_changed",
				"notifications/prompts/list_changed",
				"notifications/resources/list_changed",
			]),
		);
	});

	it("does not publish for non-mutating endpoints", async () => {
		const published: PublishedEvent[] = [];
		const agent = makeAgent(
			{ MCP_SUBSCRIPTIONS: makeSubscriptionBinding(published) },
			{ status: 200, data: { items: [] } },
		);
		await executeTool(
			agent,
			makeOperatorTool("appTools/list"),
			{ appId: "target-app-uuid" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		await flushWaitUntil(agent);
		expect(published).toEqual([]);
	});

	it("does not publish when the mutation dispatch failed (status >= 400)", async () => {
		const published: PublishedEvent[] = [];
		const agent = makeAgent(
			{ MCP_SUBSCRIPTIONS: makeSubscriptionBinding(published) },
			{ status: 500, data: { error: "boom" } },
		);
		const result = await executeTool(
			agent,
			makeOperatorTool("appTools/update"),
			{ appId: "target-app-uuid" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result.isError).toBe(true);
		await flushWaitUntil(agent);
		expect(published).toEqual([]);
	});

	it("is a delivered-0 no-op without the MCP_SUBSCRIPTIONS binding", async () => {
		const agent = makeAgent({}, { status: 200, data: { id: "tool-1" } });
		const result = await executeTool(
			agent,
			makeOperatorTool("appTools/update"),
			{ appId: "target-app-uuid" },
			{ adapterScope: "primary", resultStrategy: "merge" },
		);
		expect(result.isError).toBeUndefined();
		const settled = await flushWaitUntil(agent);
		// The publish promise resolves 0 delivered and never throws.
		expect(settled).toEqual([0]);
	});
});

describe("publishMcpInventoryListChanged", () => {
	it("returns 0 without touching the binding for unmapped endpoints", async () => {
		const published: PublishedEvent[] = [];
		const delivered = await publishMcpInventoryListChanged({
			env: {
				MCP_SUBSCRIPTIONS: makeSubscriptionBinding(published),
			} as unknown as CloudflareEnv,
			endpoint: "reports/fetch",
			appIds: ["app-a"],
		});
		expect(delivered).toBe(0);
		expect(published).toEqual([]);
	});

	it("dedupes app ids and drops empty ones", async () => {
		const published: PublishedEvent[] = [];
		await publishMcpInventoryListChanged({
			env: {
				MCP_SUBSCRIPTIONS: makeSubscriptionBinding(published),
			} as unknown as CloudflareEnv,
			endpoint: "catalog/runOpenApiImport",
			appIds: ["app-a", "app-a", undefined, null, ""],
		});
		expect(new Set(published.map((event) => event.appId))).toEqual(
			new Set(["app-a"]),
		);
		// runOpenApiImport writes external tool rows: tools + widget resources.
		expect(published.map((event) => event.body.method).sort()).toEqual([
			"notifications/resources/list_changed",
			"notifications/tools/list_changed",
		]);
	});

	it("maps only inventory-mutating endpoints", () => {
		expect(mcpInventoryListChangedKinds("appTools/delete")).toEqual([
			"prompts",
			"resources",
		]);
		expect(mcpInventoryListChangedKinds("appTools/preflight")).toEqual([]);
		expect(mcpInventoryListChangedKinds(undefined)).toEqual([]);
	});
});

describe("subscription publish failures", () => {
	it("logs a content-free cause chain and keeps delivery best-effort", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const failure = new Error("outer bearer secret", {
				cause: new TypeError("inner bearer secret"),
			});
			const binding = {
				idFromName: (name: string) => name,
				get: () => ({ fetch: async () => Promise.reject(failure) }),
			} as unknown as DurableObjectNamespace;
			const delivered = await publishMcpListChanged({
				env: { MCP_SUBSCRIPTIONS: binding } as unknown as CloudflareEnv,
				appId: "app-a",
				kind: "tools",
			});

			expect(delivered).toBe(0);
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toMatchObject({
				component: "mcp.subscription.publisher",
				event: "mcp.subscription.publish_failed",
				appId: "app-a",
				step: "notifications/tools/list_changed",
				outcome: "unavailable",
				exception: {
					type: "Error",
					message: "Content omitted",
					cause: { type: "TypeError", message: "Content omitted" },
				},
			});
			expect(JSON.stringify(warn.mock.calls)).not.toContain("bearer secret");
		} finally {
			warn.mockRestore();
		}
	});

	it("records a rejected Durable Object response without logging its body", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const binding = {
				idFromName: (name: string) => name,
				get: () => ({
					fetch: async () => new Response("secret response", { status: 503 }),
				}),
			} as unknown as DurableObjectNamespace;
			const delivered = await publishMcpListChanged({
				env: { MCP_SUBSCRIPTIONS: binding } as unknown as CloudflareEnv,
				appId: "app-a",
				kind: "tools",
			});

			expect(delivered).toBe(0);
			expect(warn.mock.calls[0]?.[0]).toMatchObject({
				event: "mcp.subscription.publish_rejected",
				appId: "app-a",
				status: 503,
				outcome: "unavailable",
			});
			expect(JSON.stringify(warn.mock.calls)).not.toContain("secret response");
		} finally {
			warn.mockRestore();
		}
	});
});
