import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { CallerIdentity } from "../server-context";
import { buildMcpServer, type CachedAppData } from "../server-factory";

vi.mock("../../lib/api-client", () => ({
	getApiClient: () => ({
		skills: {
			listByApp: async () => ({ skills: [] }),
			listByOrg: async () => ({ skills: [] }),
		},
	}),
}));

afterEach(() => vi.restoreAllMocks());

async function configuredViews(
	options: {
		apps?: boolean;
		nativeDirect?: boolean;
		optedIn?: boolean;
		empty?: boolean;
		gated?: boolean;
		sourceSlug?: string;
		unmapped?: boolean;
	} = {},
) {
	vi.spyOn(globalThis, "fetch").mockImplementation(
		async () => new Response("<!DOCTYPE html><title>Fixture view</title>"),
	);
	const names = ["show_fixture", "show_shared", "show_generated"];
	const server = await buildMcpServer(
		{
			app: { id: "app-example", slug: "example", name: "Example" },
			tools: options.empty
				? []
				: names.map((toolId, index) => ({
						id: `fixture-${index}`,
						toolId,
						title: toolId,
						toolTypeId: "rpc",
						enabled: true,
						inputSchema: { type: "object", properties: {} },
						widgetKey: "render",
						config: {
							transport: "rpc",
							endpoint: "fixture/show",
							...(options.sourceSlug
								? { _sourceAppSlug: options.sourceSlug }
								: {}),
							nativeDirect: options.nativeDirect ?? true,
							layoutId: index === 2 ? "generated-app" : "fixture-view",
							layoutSpec: {
								root: "title",
								elements: {
									title: { type: "Text", props: { text: "Fixture" } },
								},
							},
						},
					})),
			metadata: {
				mcpConfig: {
					codeMode: true,
					codeModeNativeTools: options.optedIn === false ? [] : names,
					toolScopes: options.unmapped
						? undefined
						: Object.fromEntries(
								names.map((name) => [name, ["mcp:apps.read"]]),
							),
				},
			},
			capabilities: {},
			catalogResources: [],
			catalogResourceTemplates: [],
			catalogPrompts: [],
			expiresAt: Date.now() + 60_000,
		} as unknown as CachedAppData,
		{
			authType: "oauth",
			scopes: options.gated ? [] : ["mcp:apps.read"],
		} as CallerIdentity,
		{
			ENVIRONMENT: "test",
			LOADER: {},
			API_URL: "https://api.test",
			MCP_UI_URL: "https://widget.test",
		} as unknown as CloudflareEnv,
		{
			waitUntil: (promise: Promise<unknown>) => {
				void promise.catch(() => {});
			},
		} as ExecutionContext,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		options.apps ?? true,
	);
	const [client, transport] = InMemoryTransport.createLinkedPair();
	type ResponseMessage = {
		id?: number;
		result?: Record<string, unknown>;
		error?: unknown;
	};
	const pending = new Map<number, (message: ResponseMessage) => void>();
	let nextId = 1;
	client.onmessage = (message) => {
		const response = message as ResponseMessage;
		if (typeof response.id === "number") {
			pending.get(response.id)?.(response);
			pending.delete(response.id);
		}
	};
	const request = async (method: string, params?: Record<string, unknown>) => {
		const id = nextId++;
		const response = new Promise<ResponseMessage>((resolve) =>
			pending.set(id, resolve),
		);
		await client.send({
			jsonrpc: "2.0",
			id,
			method,
			...(params ? { params } : {}),
		} as never);
		return response;
	};
	await server.connect(transport);
	expect(
		(
			await request("initialize", {
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "fixture", version: "1" },
			})
		).error,
	).toBeUndefined();
	await client.send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	} as never);
	return { server, request };
}

describe("configured generated view listing", () => {
	it.each(["example", "fixture-source"])(
		"lists and reads each configured URI once using source %s",
		async (sourceSlug) => {
			const { server, request } = await configuredViews({ sourceSlug });
			try {
				const listed = await request("resources/list");
				expect(listed.error).toBeUndefined();
				const views = (
					listed.result!.resources as Array<{
						uri: string;
						mimeType?: string;
						_meta?: unknown;
					}>
				).filter((resource) =>
					resource.uri.startsWith("ui://widgets/mcp-app/"),
				);
				expect(views.map((view) => view.uri).sort()).toEqual([
					`ui://widgets/mcp-app/${sourceSlug}/r/fixture-view.html`,
					`ui://widgets/mcp-app/${sourceSlug}/r/generated-app.html`,
				]);
				const tools = await request("tools/list");
				expect(tools.error).toBeUndefined();
				const nativeTools = (
					tools.result!.tools as Array<{
						name: string;
						_meta?: { ui?: { resourceUri?: string } };
					}>
				).filter((tool) => tool.name.startsWith("show_"));
				expect(nativeTools.map((tool) => tool.name).sort()).toEqual([
					"show_fixture",
					"show_generated",
					"show_shared",
				]);
				expect(
					new Set(nativeTools.map((tool) => tool._meta?.ui?.resourceUri)),
				).toEqual(new Set(views.map((view) => view.uri)));
				for (const view of views) {
					const read = await request("resources/read", { uri: view.uri });
					expect(read.error).toBeUndefined();
					expect(view.mimeType).toBe("text/html;profile=mcp-app");
					expect(view._meta).toMatchObject({
						ui: { csp: expect.any(Object), prefersBorder: false },
					});
					expect(read.result!.contents).toEqual([
						expect.objectContaining({
							uri: view.uri,
							mimeType: view.mimeType,
							_meta: view._meta,
							text: expect.stringContaining("Fixture view"),
						}),
					]);
				}
			} finally {
				await server.close();
			}
		},
	);

	it.each([true, false])(
		"retains runtime view reads without inventing listed URIs (Apps %s)",
		async (apps) => {
			const { server, request } = await configuredViews({ apps, empty: true });
			try {
				const listed = await request("resources/list");
				expect(listed.error).toBeUndefined();
				expect(
					(listed.result!.resources as Array<{ uri: string }>).filter(
						(resource) => resource.uri.startsWith("ui://widgets/mcp-app/"),
					),
				).toEqual([]);
				const uri = "ui://widgets/mcp-app/example/r/runtime-title.html";
				const read = await request("resources/read", { uri });
				expect(read.error).toBeUndefined();
				expect(read.result!.contents).toEqual([
					expect.objectContaining({
						uri,
						mimeType: "text/html;profile=mcp-app",
						text: expect.stringContaining("Fixture view"),
					}),
				]);
			} finally {
				await server.close();
			}
		},
	);

	it.each([
		{ empty: true },
		{ apps: false },
		{ nativeDirect: false },
		{ optedIn: false },
		{ gated: true },
		{ unmapped: true },
	])(
		"lists no views when configuration or discovery denies them: %j",
		async (options) => {
			const { server, request } = await configuredViews(options);
			try {
				const listed = await request("resources/list");
				expect(listed.error).toBeUndefined();
				expect(
					(listed.result!.resources as Array<{ uri: string }>).filter(
						(resource) => resource.uri.startsWith("ui://widgets/mcp-app/"),
					),
				).toEqual([]);
			} finally {
				await server.close();
			}
		},
	);
});
