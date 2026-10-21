import { afterEach, assert, describe, expect, it, vi } from "vite-plus/test";
import { DynamicWorkerExecutor, resolveProvider } from "@cloudflare/codemode";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildUiProvider } from "./codemode-ui";
import type { ServerContext } from "./server-context";
import { buildMcpServer, type CachedAppData } from "./server-factory";
import { clientSupportsMcpApps } from "./client-apps-capability";

vi.mock("../lib/api-client", () => ({
	getApiClient: () => ({
		skills: { listByApp: async () => ({ skills: [] }) },
	}),
}));

afterEach(() => vi.restoreAllMocks());

const context = {
	appId: "app-example",
	appSlug: "example",
	app: { name: "Example", logoUrl: "https://example.com/logo.png" },
} as ServerContext;

const tools = resolveProvider(buildUiProvider(context)).fns;

describe.each([true, false])(
	"Code Mode UI wire conformance (Apps=%s)",
	(apps) => {
		it.each([
			["create_view", '{ title: "Counts", data: [{ count: 2 }] }', "counts"],
			[
				"create_mcp_app",
				'{ title: "Counts", summary: "Two records", html: "<p>Two records</p>" }',
				"generated-app",
			],
		])(
			"returns both UI metadata forms for %s and serves HTML",
			async (method, input, layout) => {
				// Replace only the WorkerLoader boundary; run the program against real providers.
				vi.spyOn(DynamicWorkerExecutor.prototype, "execute").mockImplementation(
					async (code, providers) => {
						assert(Array.isArray(providers));
						return {
							result: await new Function(
								...providers.map((provider) => provider.name),
								`return (${code})()`,
							)(...providers.map((provider) => provider.fns)),
							logs: [],
						};
					},
				);
				vi.spyOn(globalThis, "fetch").mockResolvedValue(
					new Response("<!DOCTYPE html><title>Fixture shell</title>"),
				);
				const capabilities = apps
					? {
							extensions: {
								"io.modelcontextprotocol/ui": {
									mimeTypes: ["text/html;profile=mcp-app"],
								},
							},
						}
					: {};
				const initialize = {
					protocolVersion: "2025-11-25",
					capabilities,
					clientInfo: { name: "fixture-client", version: "1.0.0" },
				};
				const server = await buildMcpServer(
					{
						app: { id: "app-example", slug: "example", name: "Example" },
						tools: [
							{
								id: "fixture-tool",
								toolId: "show_fixture",
								title: "Show fixture",
								toolTypeId: "rpc",
								enabled: true,
								inputSchema: { type: "object", properties: {} },
								widgetKey: "render",
								config: {
									transport: "rpc",
									endpoint: "fixture/show",
									nativeDirect: true,
									layoutId: "fixture-view",
								},
							},
						],
						metadata: {
							mcpConfig: {
								codeMode: true,
								codeModeNativeTools: ["show_fixture"],
							},
						},
						capabilities: {},
						catalogResources: [],
						catalogResourceTemplates: [],
						catalogPrompts: [],
						expiresAt: Date.now() + 60_000,
					} as unknown as CachedAppData,
					undefined,
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
					clientSupportsMcpApps({ method: "initialize", params: initialize }),
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
				const request = async (
					method: string,
					params?: Record<string, unknown>,
				) => {
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
				try {
					await server.connect(transport);
					expect(
						(await request("initialize", initialize)).error,
					).toBeUndefined();
					await client.send({
						jsonrpc: "2.0",
						method: "notifications/initialized",
					} as never);
					const listed = await request("tools/list");
					const names = (listed.result!.tools as Array<{ name: string }>).map(
						(tool) => tool.name,
					);
					expect(names).toContain("code");
					expect(names.includes("show_fixture")).toBe(apps);
					const called = await request("tools/call", {
						name: "code",
						arguments: { code: `async () => await ui.${method}(${input})` },
					});
					expect(called.error).toBeUndefined();
					expect(called.result?.isError).not.toBe(true);
					const uri = `ui://widgets/mcp-app/example/r/${layout}.html`;
					expect(called.result?._meta).toMatchObject({
						ui: { resourceUri: uri },
						"openai/outputTemplate": uri,
					});
					const read = await request("resources/read", { uri });
					expect(read.error).toBeUndefined();
					expect(read.result?.contents).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								uri,
								mimeType: "text/html;profile=mcp-app",
								text: expect.stringContaining("Fixture shell"),
							}),
						]),
					);
				} finally {
					await server.close();
					await client.close();
				}
			},
		);
	},
);

describe("Code Mode UI provider", () => {
	it("keeps catalog selection ordered, deduplicated and limited to known components", async () => {
		const catalog = (await tools.get_catalog!({
			components: ["Text", "Text", "Unknown", "Stack"],
		})) as {
			componentDefinitions: string[];
			components: string[];
			actions: string[];
		};
		expect(
			catalog.componentDefinitions.map((line) => line.split(":")[0]),
		).toEqual(["- Text", "- Stack"]);
		expect(catalog.components).toContain("DataTable");
		expect(catalog.actions.length).toBeGreaterThan(0);
	});

	it("preserves rows, metadata and caller app identity in an inferred view", async () => {
		const rows = [
			{ name: "First", count: 2 },
			{ name: "Second", count: 4 },
		];
		const view = (await tools.create_view!({
			title: "Counts",
			visualKind: "table",
			data: { rows, _meta: { receipt: "kept" } },
		})) as Record<string, unknown>;
		expect(view.rows).toEqual(rows);
		expect(view.app).toEqual({
			id: "app-example",
			slug: "example",
			name: "Example",
			logoUrl: "https://example.com/logo.png",
		});
		expect(view._meta).toMatchObject({
			receipt: "kept",
			ui: { resourceUri: "ui://widgets/mcp-app/example/r/counts.html" },
		});
		expect(view.layoutSpec).toMatchSnapshot();
	});

	it.each([
		"auto",
		"table",
		"summary",
		"comparison",
		"timeline",
		"stats",
		"details",
		"chart",
		"timeSeries",
		"categoricalCounts",
		"rankedMetrics",
	])("produces a valid %s layout for record arrays", async (visualKind) => {
		const rows = [
			{
				name: "First",
				date: "2026-01-01",
				count: 2,
				status: "ok",
				price: 10,
				currency: "EUR",
			},
			{
				name: "Second",
				date: "2026-01-02",
				count: 4,
				status: "warning",
				price: 20,
				currency: "EUR",
			},
		];
		const view = (await tools.create_view!({
			title: "Records",
			visualKind,
			data: rows,
		})) as Record<string, unknown>;
		expect(view.rows).toEqual(rows);
		expect(
			await tools.validate_layout!({ layoutSpec: view.layoutSpec }),
		).toMatchObject({ valid: true, issues: [] });
	});

	it("preserves explicit layouts and falls back from invalid layouts", async () => {
		const layoutSpec = {
			root: "text",
			elements: {
				text: { type: "Text", props: { text: "Explicit" }, children: [] },
			},
		};
		const explicit = (await tools.create_view!({
			data: { value: 1 },
			layoutSpec,
		})) as Record<string, unknown>;
		expect(explicit.layoutSpec).toEqual(layoutSpec);
		const fallback = (await tools.create_view!({
			data: { value: 1 },
			layoutSpec: {},
		})) as Record<string, unknown>;
		expect(
			await tools.validate_layout!({ layoutSpec: fallback.layoutSpec }),
		).toMatchObject({ valid: true });
		expect(await tools.validate_layout!({ layoutSpec: null })).toEqual({
			valid: false,
			issues: ["layoutSpec must be a non-empty json-render object."],
		});
	});

	it("normalizes health statuses, latency and summary counts", async () => {
		const view = (await tools.create_health_sweep!({
			checks: [
				{ provider: "one", status: "healthy", latencyMs: 2.9 },
				{ namespace: "two", status: "forbidden", latencyMs: -1 },
				{ app: "three", status: "partial" },
			],
		})) as Record<string, unknown>;
		expect(view.summary).toBe("3 checks: 1 OK, 2 need attention.");
		expect(view.checks).toEqual([
			{
				namespace: "one",
				label: "one",
				status: "ok",
				latencyMs: 2,
				tone: "success",
			},
			{
				namespace: "two",
				label: "two",
				status: "blocked",
				latencyMs: 0,
				tone: "danger",
			},
			{
				namespace: "three",
				label: "three",
				status: "warning",
				tone: "warning",
			},
		]);
		expect(
			await tools.validate_layout!({ layoutSpec: view.layoutSpec }),
		).toMatchObject({ valid: true });
	});

	it("keeps transient HTML, summary fallback and widget routing", async () => {
		expect(
			await tools.create_mcp_app!({
				title: " Custom ",
				summary: " Summary ",
				html: " <p>Hi</p> ",
				data: { value: 1 },
			}),
		).toMatchObject({
			title: "Custom",
			summary: "Summary",
			value: 1,
			generatedMcpApp: { html: "<p>Hi</p>", renderMode: "sandboxed-html-css" },
			_meta: {
				ui: {
					resourceUri: "ui://widgets/mcp-app/example/r/generated-app.html",
				},
			},
		});
		await expect(
			tools.create_mcp_app!({
				title: "Custom",
				summary: "Summary",
				html: "x".repeat(4001),
			}),
		).rejects.toThrow("transient limit");
		await expect(
			tools.create_mcp_app!({ title: "Custom", html: "<p>Hi</p>" }),
		).rejects.toThrow("summary fallback");
	});

	it("rejects scalar view data and empty health sweeps", async () => {
		await expect(tools.create_view!({ data: 1 })).rejects.toThrow(
			"JSON object or an array of records",
		);
		await expect(tools.create_health_sweep!({ checks: [] })).rejects.toThrow(
			"at least one check row",
		);
	});
});
