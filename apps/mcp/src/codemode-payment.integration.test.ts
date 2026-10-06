import { mountMcp } from "@tedix/mcp-shared/transport";
import { describe, expect, it, vi } from "vite-plus/test";
import type { CallerIdentity } from "./mcp/caller-identity";
import { buildMcpServer, type CachedAppData } from "./mcp/server-factory";

vi.mock("cloudflare:workers", () => ({
	tracing: {
		enterSpan: (_name: string, callback: (span: unknown) => unknown) =>
			callback({ setAttribute: vi.fn() }),
	},
}));

vi.mock("@cloudflare/codemode", () => {
	const sanitizeToolName = (name: string) =>
		name.replace(/[^a-zA-Z0-9_]/g, "_");
	return {
		DynamicWorkerExecutor: class DynamicWorkerExecutor {
			async execute(
				code: string,
				providers: Array<{
					name: string;
					fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
				}>,
			) {
				const byName = new Map(
					providers.map((provider) => [provider.name, provider]),
				);
				if (code.includes("premium_research_brief")) {
					const payments = byName.get("payments");
					const tool = payments?.fns.premium_research_brief;
					if (!tool) throw new Error("payments.premium_research_brief missing");
					const result = await tool({ topic: "Solana agent payments" });
					return { result, logs: [] };
				}
				if (code.includes("nosana.get_deployments")) {
					const nosana = byName.get("nosana");
					const tool = nosana?.fns.get_deployments;
					if (!tool) throw new Error("nosana.get_deployments missing");
					const result = await tool({ limit: 10 });
					return { result, logs: [] };
				}
				if (code.includes("ui.create_health_sweep")) {
					const ui = byName.get("ui");
					const createHealthSweep = ui?.fns.create_health_sweep;
					if (!createHealthSweep)
						throw new Error("ui.create_health_sweep missing");
					const result = await createHealthSweep({
						checks: [
							{
								namespace: "notion",
								status: "ok",
								summary: "Latest edits read successfully",
							},
							{
								namespace: "gmail",
								status: "blocked",
								summary: "Connection needs re-auth",
							},
							{
								namespace: "nosana",
								status: "warning",
								summary: "Deployments returned but included error states",
							},
						],
						title: "Provider health sweep",
					});
					return { result, logs: [] };
				}
				if (code.includes("ui.get_catalog")) {
					const ui = byName.get("ui");
					const getCatalog = ui?.fns.get_catalog;
					if (!getCatalog) throw new Error("ui.get_catalog missing");
					return { result: await getCatalog({}), logs: [] };
				}
				if (code.includes("ui.create_mcp_app")) {
					const ui = byName.get("ui");
					const createMcpApp = ui?.fns.create_mcp_app;
					if (!createMcpApp) throw new Error("ui.create_mcp_app missing");
					const result = await createMcpApp({
						appName: "Tedix",
						appSlug: "tedix-unified",
						data: { score: 92 },
						html: '<style>.score{font-size:3rem}</style><main><p>Health</p><strong class="score">92</strong></main>',
						summary: "Health score is 92.",
						title: "Generated health card",
					});
					return { result, logs: [] };
				}
				if (code.includes("ui.create_view")) {
					const ui = byName.get("ui");
					const createView = ui?.fns.create_view;
					if (!createView) throw new Error("ui.create_view missing");

					if (code.includes("visual_kind_matrix")) {
						const result = {
							table: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									products: [
										{ name: "MacBook Pro", price: "$1,999", score: 91 },
									],
								},
								title: "Forced product table",
								visualKind: "table",
							}),
							comparison: await createView({
								appSlug: "acme",
								appName: "Acme",
								data: {
									rows: [
										{
											name: "MacBook Air",
											merchant: "Example Store",
											price: "$999",
										},
									],
								},
								title: "Forced comparison",
								visualKind: "comparison",
							}),
							timeline: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									rows: [
										{
											step: "render",
											status: "running",
											message: "Rendering widget",
										},
									],
								},
								title: "Forced timeline",
								visualKind: "timeline",
							}),
							stats: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									totalTools: 447,
									publishedWidgets: 39,
									failedChecks: 2,
								},
								title: "Forced stats",
								visualKind: "stats",
							}),
							chart: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									usage: [
										{ date: "2026-05-15", tokens: 1200, cost: 0.42 },
										{ date: "2026-05-16", tokens: 1825, cost: 0.61 },
										{ date: "2026-05-17", tokens: 2440, cost: 0.77 },
									],
								},
								title: "Forced chart",
								visualKind: "chart",
							}),
							timeSeries: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									usage: [
										{ date: "2026-05-15", calls: 12 },
										{ date: "2026-05-16", calls: 18 },
										{ date: "2026-05-17", calls: 22 },
									],
								},
								title: "Forced time series",
								visualKind: "timeSeries",
							}),
							categoricalCounts: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									rows: [
										{ status: "OK" },
										{ status: "OK" },
										{ status: "Blocked" },
									],
								},
								title: "Forced category counts",
								visualKind: "categoricalCounts",
							}),
							rankedMetrics: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									rows: [
										{ name: "Notion", calls: 42 },
										{ name: "Gmail", calls: 18 },
										{ name: "Nosana", calls: 9 },
									],
								},
								title: "Forced ranked metrics",
								visualKind: "rankedMetrics",
							}),
							summary: await createView({
								appSlug: "tedix",
								appName: "Tedix",
								data: {
									products: [
										{ name: "MacBook Pro", price: "$1,999", score: 91 },
									],
									status: "healthy",
									owner: "Tedix OS",
								},
								summary: "Scalar summary beats table inference when requested.",
								title: "Forced summary",
								visualKind: "summary",
							}),
						};
						return { result, logs: [] };
					}

					if (code.includes("bare_array_data")) {
						// Models frequently pass `data` as a bare array. The view
						// builder auto-wraps it under `rows` instead of throwing.
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: [
								{ name: "CTO", role: "engineering" },
								{ name: "CEO", role: "leadership" },
								{ name: "CPO", role: "product" },
							] as unknown as Record<string, unknown>,
							title: "bare_array_data",
							visualKind: "table",
						});
						return { result, logs: [] };
					}

					if (code.includes("preferred_items")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: { items: [{ name: "Alpha", value: 42 }] },
							title: "preferred_items",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_comparison")) {
						const result = await createView({
							appSlug: "acme",
							appName: "Acme",
							data: {
								listings: [
									{
										chip: "M5",
										color: "Space Black",
										keyboard: "Unspecified",
										memory: "16GB",
										model: "MacBook Pro 14",
										priceDisplay: "EUR 1,445.99",
										priceEUR: 1445.99,
										productName: "MacBook Pro 14 M5 16GB/512GB",
										rating: 4.8,
										url: "https://example.com/macbook-pro-m5",
									},
								],
								query: "macbook m5",
							},
							title: "MacBook M5 prices",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_timeline")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								events: [
									{
										id: "qa-run-1",
										status: "running",
										message: "Browser QA is capturing the widget",
										createdAt: "2026-05-16T10:00:00.000Z",
									},
								],
							},
							title: "Widget QA run",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_stats")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								totalTools: 447,
								publishedWidgets: 39,
								failedChecks: 2,
							},
							title: "MCP Gateway health",
							visualKind: "stats",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_time_series_chart")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								usage: [
									{ date: "2026-05-15", tokens: 1200, cost: 0.42 },
									{ date: "2026-05-16", tokens: 1825, cost: 0.61 },
									{ date: "2026-05-17", tokens: 2440, cost: 0.77 },
								],
							},
							title: "Token usage trend",
						});
						return { result, logs: [] };
					}

					if (code.includes("forced_generated_bar_chart")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								providers: [
									{ name: "Notion", calls: 42 },
									{ name: "Gmail", calls: 18 },
									{ name: "Nosana", calls: 9 },
								],
							},
							title: "Provider calls",
							visualKind: "chart",
						});
						return { result, logs: [] };
					}

					if (code.includes("empty_layoutspec_fallback")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								providers: [
									{ name: "Notion", calls: 42 },
									{ name: "Gmail", calls: 18 },
									{ name: "Nosana", calls: 9 },
								],
							},
							layoutSpec: {},
							title: "Fallback visual",
							visualKind: "chart",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_dashboard")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								providers: [
									{
										name: "Notion",
										status: "OK",
										result: "Workspace edits found",
										updatedAt: "2026-05-17T09:00:00.000Z",
									},
									{
										name: "Gmail",
										status: "BLOCKED_AUTH",
										result: "Connection credential not found",
										updatedAt: "2026-05-17T09:01:00.000Z",
									},
									{
										name: "PromptWatch",
										status: "OK",
										result: "Projects listed",
										updatedAt: "2026-05-17T09:02:00.000Z",
									},
								],
								evidence: [
									{
										title: "Notion search",
										status: "completed",
										message: "notion_tedix.notion_search returned results",
										timestamp: "2026-05-17T09:00:00.000Z",
									},
									{
										title: "Gmail probe",
										status: "blocked",
										message: "Credential missing",
										timestamp: "2026-05-17T09:01:00.000Z",
									},
								],
							},
							summary: "Cross-provider health check with one blocked provider.",
							title: "Tedi provider validation",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_summary")) {
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								status: "healthy",
								owner: "Tedix OS",
								activeWidgets: 12,
							},
							summary: "MCP generative UI surface is healthy.",
							title: "Gateway summary",
						});
						return { result, logs: [] };
					}

					if (code.includes("auto_generated_table")) {
						const result = await createView({
							appSlug: "nosana",
							appName: "Nosana",
							data: {
								deployments: [
									{
										id: "deployment-1",
										status: "RUNNING",
										market: "nvidia-4090",
									},
								],
								stats: [
									{ label: "Total", value: 1 },
									{ label: "Running", value: 1 },
								],
							},
							title: "Nosana deployments",
						});
						return { result, logs: [] };
					}

					if (code.includes("custom_validated_layout")) {
						const validateLayout = ui?.fns.validate_layout;
						if (!validateLayout) throw new Error("ui.validate_layout missing");
						const layoutSpec = {
							root: "root",
							elements: {
								root: {
									type: "Stack",
									props: { gap: 2 },
									children: ["title", "facts"],
								},
								title: {
									type: "Text",
									props: { text: "Validated custom layout" },
								},
								facts: {
									type: "KeyValuePanel",
									props: {
										items: [
											{ label: "Status", value: "published" },
											{ label: "Kind", value: "custom" },
										],
									},
								},
							},
						};
						const validation = (await validateLayout({ layoutSpec })) as {
							valid?: boolean;
							layoutSpec?: Record<string, unknown>;
						};
						if (!validation.valid || !validation.layoutSpec) {
							throw new Error("custom layoutSpec did not validate");
						}
						const result = await createView({
							appSlug: "tedix",
							appName: "Tedix",
							data: {
								status: "published",
								kind: "custom",
							},
							layoutId: "validated-custom-layout",
							layoutSpec: validation.layoutSpec,
							title: "Validated custom layout",
							visualKind: "stats",
						});
						return { result, logs: [] };
					}

					if (code.includes("nested_compact_view")) {
						const view = await createView({
							appSlug: "acme",
							appName: "Acme",
							data: { items: [{ name: "Alpha", value: 42 }] },
							layoutId: "nested-view",
							title: "Nested view",
						});
						return { result: { sourceCount: 1, view }, logs: [] };
					}

					const result = await createView({
						appSlug: "acme",
						appName: "Acme",
						data: {
							products: [{ name: "MacBook Pro", price: "$1,999", score: 91 }],
						},
						layoutId: "macbook-prices",
						layoutSpec: {
							root: "root",
							elements: {
								root: {
									type: "Text",
									props: { text: "MacBook prices" },
									children: [],
								},
							},
						},
						title: "MacBook price comparison",
					});
					return { result, logs: [] };
				}
				if (code.includes("discover.search")) {
					const discover = byName.get("discover");
					const search = discover?.fns.search;
					if (!search) throw new Error("discover.search missing");
					const query = code.includes("discover_empty_catalog")
						? ""
						: code.includes("health sweep")
							? "multiple provider health sweep"
							: "visual view ui create_view json-render";
					const result = await search(
						code.includes("includeParameters")
							? { query, includeParameters: true, limit: 5 }
							: query,
					);
					return { result, logs: [] };
				}
				if (code.includes("discover.list_namespaces")) {
					const discover = byName.get("discover");
					const listNamespaces = discover?.fns.list_namespaces;
					if (!listNamespaces)
						throw new Error("discover.list_namespaces missing");
					const result = await listNamespaces(
						code.includes("includeTools") ? { includeTools: true } : {},
					);
					return { result, logs: [] };
				}
				return { result: null, logs: [] };
			}
		},
		resolveProvider: (provider: {
			name?: string;
			tools: Record<
				string,
				{ execute: (...args: unknown[]) => Promise<unknown> }
			>;
		}) => ({
			name: provider.name ?? "codemode",
			fns: Object.fromEntries(
				Object.entries(provider.tools).map(([name, tool]) => [
					name,
					tool.execute,
				]),
			),
		}),
		sanitizeToolName,
		truncateResult: (value: unknown) => value,
	};
});

vi.mock("@tedix/tedi-codemode-core/run-stateless-code", () => ({
	runStatelessCodeMode: async ({
		code,
		executor,
		providers,
	}: {
		code: string;
		executor: {
			execute: (
				code: string,
				providers: Array<unknown>,
			) => Promise<{ logs?: string[]; result: unknown }>;
		};
		providers: Array<unknown>;
	}) => executor.execute(code, providers),
}));

const APP_ID = "07ed3daf-ce65-480d-846a-9e93e5843461";
const ORG_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const TOOL_ROW_ID = "a0e5cef4-ae8d-4451-9ef8-056241c57aea";
const ACCEPT_BOTH = "application/json, text/event-stream";
const CODE =
	'async () => await payments.premium_research_brief({ topic: "Solana agent payments" })';

function createApiService() {
	return {
		fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request =
				input instanceof Request ? input : new Request(input, init);
			const url = new URL(request.url);

			if (url.pathname === "/rpc/skills/listByApp") {
				return Response.json({ json: { skills: [], summaries: [] } });
			}

			if (url.pathname === "/rpc/payments/demoPaidTool") {
				const body = (await request.json()) as { json?: { topic?: string } };
				return Response.json({
					json: {
						message: "Tedix PayMesh paid tool executed",
						topic: body.json?.topic ?? "unknown",
						paid: true,
					},
				});
			}

			if (url.pathname === "/rpc/nosana/listDeployments") {
				return Response.json({
					json: {
						deployments: [
							{
								id: "deployment-1",
								name: "tedix-private-service",
								status: "RUNNING",
							},
						],
						pagination: { limit: 10, total_items: 1 },
					},
				});
			}

			return Response.json(
				{ code: "NOT_FOUND", message: `Unexpected API path: ${url.pathname}` },
				{ status: 404 },
			);
		}),
	};
}

function createCachedData(): CachedAppData {
	const now = new Date("2026-05-10T00:00:00.000Z").toISOString();
	return {
		app: {
			id: APP_ID,
			organizationId: ORG_ID,
			name: "PayMesh Demo",
			slug: "paymesh-demo",
			domain: null,
			description: "x402 payment-gated MCP app",
			logoUrl: null,
			customMcpDomain: null,
			openaiChallengeToken: null,
			openaiAppId: null,
			appStoreStatus: "draft",
			visibility: "public",
			discoveryStatus: "scraped",
		},
		tools: [
			{
				id: TOOL_ROW_ID,
				toolId: "premium_research_brief",
				toolTypeId: "rpc",
				title: "Premium Research Brief",
				description: "Generate a payment-gated research brief.",
				inputSchema: {
					type: "object",
					properties: { topic: { type: "string" } },
					required: ["topic"],
				},
				outputSchema: null,
				adapterScope: null,
				resultStrategy: null,
				outputTemplate: null,
				widgetKey: null,
				widgetRoute: null,
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
				widgetPrefersBorder: null,
				widgetDomain: null,
				config: {
					transport: "rpc",
					endpoint: "payments/demoPaidTool",
					"x-tedix/payment": {
						enabled: true,
						protocol: "x402",
						mode: "mock",
						amount: "0.01",
						currency: "USDC",
						asset: "USDC",
						network: "solana-devnet",
						recipient: "TedixPayMeshDemo111111111111111111111111111",
						description:
							"Pay 0.01 USDC on Solana devnet to call the Tedix PayMesh demo tool",
						ttlSeconds: 300,
					},
				},
				schemaDialect: "json-schema-2020-12",
				schemaSource: "manual",
				schemaSourceRef: null,
				schemaSourceHash: null,
				schemaSyncedAt: null,
				sortOrder: 0,
				enabled: true,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "d5f65150-8ae9-462f-a557-3ecfedb65675",
				toolId: "nosana__get_deployments",
				toolTypeId: "rpc",
				title: "nosana__Get Deployments",
				description: "List Nosana deployments.",
				inputSchema: {
					type: "object",
					properties: { limit: { type: "number" } },
				},
				outputSchema: null,
				adapterScope: null,
				resultStrategy: "text",
				outputTemplate: null,
				widgetKey: "render",
				widgetRoute: null,
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
				widgetPrefersBorder: null,
				widgetDomain: null,
				config: {
					transport: "rpc",
					endpoint: "nosana/listDeployments",
					layoutId: "deployments",
					_sourceAppId: "b1b7e0f4-06b1-4702-b6d9-181500a1c4aa",
					_aggregateNamespace: "nosana",
					layoutSpec: {
						version: "1",
						kind: "table",
						itemsPath: "deployments",
					},
				},
				schemaDialect: "json-schema-2020-12",
				schemaSource: "manual",
				schemaSourceRef: null,
				schemaSourceHash: null,
				schemaSyncedAt: null,
				sortOrder: 1,
				enabled: true,
				createdAt: now,
				updatedAt: now,
			},
		] as unknown as CachedAppData["tools"],
		metadata: {
			mcpConfig: {
				authMode: "public",
				capabilities: [],
				enforcePolicies: false,
				codeMode: true,
				connectionLabel: "paymesh-demo",
				autoAppendSkillInstructions: false,
				toolScopes: { get_deployments: [], premium_research_brief: [] },
			},
		} as CachedAppData["metadata"],
		capabilities: {
			checkout: { enabled: false },
			cart: { enabled: false },
			wishlist: { enabled: false },
			compare: { enabled: false },
			map: { enabled: false },
			externalCta: { enabled: true },
		},
		organizationId: ORG_ID,
		expiresAt: Date.now() + 60_000,
	};
}

function createEnv(apiService: ReturnType<typeof createApiService>) {
	return {
		ENVIRONMENT: "test",
		MCP_URL: "https://mcp.tedi.club",
		API_URL: "https://api.tedi.club",
		MCP_UI_URL: "https://widget.tedi.club",
		GIT_SHA: "test",
		DESCOPE_AIH_BASE_URL: "https://api.descope.com",
		DEFAULT_APP_SLUG: "",
		DO_NOT_TRACK: "1",
		API_SERVICE: apiService,
		LOADER: {},
	} as unknown as CloudflareEnv;
}

function createExecutionContext() {
	return {
		waitUntil: vi.fn((promise: Promise<unknown>) => {
			promise.catch(() => {});
		}),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;
}

async function postRpc(
	env: CloudflareEnv,
	ctx: ExecutionContext,
	body: unknown,
) {
	return postRpcWithData(env, ctx, createCachedData(), body);
}

async function postRpcWithData(
	env: CloudflareEnv,
	ctx: ExecutionContext,
	cachedData: CachedAppData,
	body: unknown,
	callerIdentity?: CallerIdentity,
) {
	const requestedToolName =
		!Array.isArray(body) &&
		body &&
		typeof body === "object" &&
		(body as { method?: unknown }).method === "tools/call"
			? ((body as { params?: { name?: string } }).params?.name ?? undefined)
			: undefined;
	const server = await buildMcpServer(
		cachedData,
		callerIdentity,
		env,
		ctx,
		"paymesh-demo",
		"codemode-payment-test-trace",
		undefined,
		undefined,
		undefined,
		requestedToolName,
	);
	const response = await mountMcp(
		server,
		new Request("https://paymesh-demo.mcp.tedi.club/mcp", {
			method: "POST",
			headers: {
				Accept: ACCEPT_BOTH,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		}),
		{
			route: "/mcp",
			cors: { origin: "https://paymesh-demo.mcp.tedi.club" },
		},
	);
	if (
		!(response.headers.get("Content-Type") ?? "").includes("text/event-stream")
	) {
		return response;
	}

	const message = await readJsonRpcResponse<unknown>(response);
	return Response.json(message, { status: response.status });
}

async function readJsonRpcResponse<T>(response: Response): Promise<T> {
	if (
		!(response.headers.get("Content-Type") ?? "").includes("text/event-stream")
	) {
		return (await response.json()) as T;
	}

	const messages = (await response.text())
		.split("\n")
		.filter((line) => line.startsWith("data:"))
		.map((line) => JSON.parse(line.slice(5).trim()) as unknown);
	const responseMessage = messages
		.toReversed()
		.find(
			(message) =>
				message !== null && typeof message === "object" && "id" in message,
		);
	if (!responseMessage) {
		throw new Error(
			"MCP SSE response did not contain a JSON-RPC response message",
		);
	}

	return responseMessage as T;
}

async function listToolNames(
	cachedData: CachedAppData,
	callerIdentity?: CallerIdentity,
) {
	const apiService = createApiService();
	const env = createEnv(apiService);
	const ctx = createExecutionContext();
	const response = await postRpcWithData(
		env,
		ctx,
		cachedData,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		},
		callerIdentity,
	);
	const body = await readJsonRpcResponse<{
		result: { tools: Array<{ name: string }> };
	}>(response);
	return body.result.tools.map((tool) => tool.name);
}

async function listCodeToolDescription(cachedData: CachedAppData) {
	const apiService = createApiService();
	const env = createEnv(apiService);
	const ctx = createExecutionContext();
	const response = await postRpcWithData(env, ctx, cachedData, {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/list",
	});
	const body = await readJsonRpcResponse<{
		result: { tools: Array<{ name: string; description?: string }> };
	}>(response);
	const codeTool = body.result.tools.find((tool) => tool.name === "code");
	if (!codeTool?.description) {
		throw new Error("code tool description missing");
	}
	return codeTool.description;
}

describe("Code Mode payment-gated tools", () => {
	it("keeps chat clients collapsed to Code Mode", async () => {
		const toolNames = await listToolNames(createCachedData());

		expect(toolNames).toContain("code");
		expect(toolNames).not.toContain("premium_research_brief");
	});

	it("keeps AIH M2M discovery collapsed to Code Mode", async () => {
		const toolNames = await listToolNames(createCachedData(), {
			authType: "tedi",
			credentialMode: "aih-m2m",
			scopes: ["platform:admin"],
		});

		expect(toolNames).toContain("code");
		expect(toolNames).not.toContain("premium_research_brief");
		expect(toolNames).not.toContain("nosana__get_deployments");
	});

	it("exposes only the requested typed tool to direct AIH M2M automation calls", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();
		const response = await postRpcWithData(
			env,
			ctx,
			createCachedData(),
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "nosana__get_deployments",
					arguments: { limit: 1 },
				},
			},
			{
				authType: "tedi",
				credentialMode: "aih-m2m",
				scopes: ["platform:admin"],
			},
		);
		const body = (await response.json()) as {
			result: { structuredContent?: unknown };
		};

		expect(response.status).toBe(200);
		expect(body.result.structuredContent).toMatchObject({
			deployments: [{ id: "deployment-1" }],
		});
	});

	it("advertises MCP Apps extension support during initialize", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {
					extensions: {
						"io.modelcontextprotocol/apps": {
							mimeTypes: ["text/html;profile=mcp-app"],
						},
						"io.modelcontextprotocol/ui": {
							mimeTypes: ["text/html;profile=mcp-app"],
						},
					},
				},
				clientInfo: { name: "mcp-apps-host-test", version: "0.0.1" },
			},
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { capabilities: { extensions?: Record<string, unknown> } };
		};
		expect(body.result.capabilities.extensions).toMatchObject({
			"io.modelcontextprotocol/apps": {},
			"io.modelcontextprotocol/ui": {},
			"io.modelcontextprotocol/skills": { directoryRead: true },
		});
	});

	it("preserves source-app widget metadata from aggregate inner tool results", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await nosana.get_deployments({ limit: 10 })",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				content: Array<{ text: string }>;
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						_meta: { ui: { resourceUri: string } };
						layoutSpec: Record<string, unknown>;
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/nosana/r/deployments.html",
		);
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/nosana/r/deployments.html",
		);
		expect(result.layoutSpec).toMatchObject({
			kind: "table",
			itemsPath: "deployments",
		});
		expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
			result: {
				_meta: {
					ui: {
						resourceUri: "ui://widgets/mcp-app/nosana/r/deployments.html",
					},
				},
			},
		});
	});

	it("exposes explicit generative UI views from the Code Mode ui namespace", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({})",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				content: Array<{ text: string }>;
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						_meta: { ui: { resourceUri: string } };
						app: { slug: string };
						layoutSpec: Record<string, unknown>;
						products: Array<Record<string, unknown>>;
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/acme/r/macbook-prices.html",
		);
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/acme/r/macbook-prices.html",
		);
		expect(result.app.slug).toBe("acme");
		expect(result.layoutSpec).toMatchObject({
			root: "root",
			elements: { root: { type: "Text" } },
		});
		expect(result.products).toHaveLength(1);
		expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
			result: {
				_meta: {
					ui: {
						resourceUri: "ui://widgets/mcp-app/acme/r/macbook-prices.html",
					},
				},
			},
		});
	});

	it("exposes the current json-render catalog to model-authored layouts", async () => {
		const response = await postRpc(
			createEnv(createApiService()),
			createExecutionContext(),
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "code",
					arguments: { code: "async () => await ui.get_catalog()" },
				},
			},
		);
		const body = await readJsonRpcResponse<{
			result: { structuredContent: { result: Record<string, unknown> } };
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result.components).toContain("DataChart");
		expect(result.componentDefinitions).toContainEqual(
			expect.stringContaining("- DataChart:"),
		);
		expect(result.actions).toContain("follow_up");
		expect(result.schema).toMatchObject({ required: ["root", "elements"] });
	});

	it("returns a transient free-form HTML/CSS MCP App with structured fallback", async () => {
		const response = await postRpc(
			createEnv(createApiService()),
			createExecutionContext(),
			{
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "code",
					arguments: { code: "async () => await ui.create_mcp_app({})" },
				},
			},
		);
		const body = await readJsonRpcResponse<{
			result: {
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						generatedMcpApp: { html: string; renderMode: string };
						score: number;
						summary: string;
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix-unified/r/generated-app.html",
		);
		expect(result.generatedMcpApp.renderMode).toBe("sandboxed-html-css");
		expect(result.generatedMcpApp.html).toContain('class="score"');
		expect(result).toMatchObject({ score: 92, summary: "Health score is 92." });
	});

	it("serves the generated-app shell through the portable MCP Apps resource", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response("<html><body>Generated MCP App shell</body></html>", {
					headers: { "content-type": "text/html" },
				}),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const resourceUri =
				"ui://widgets/mcp-app/tedix-unified/r/generated-app.html";
			const response = await postRpc(
				createEnv(createApiService()),
				createExecutionContext(),
				{
					jsonrpc: "2.0",
					id: 1,
					method: "resources/read",
					params: { uri: resourceUri },
				},
			);
			const body = await readJsonRpcResponse<{
				result: {
					contents: Array<{
						_meta: { ui: { csp: Record<string, unknown> } };
						mimeType: string;
						text: string;
						uri: string;
					}>;
				};
			}>(response);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://widget.tedi.club/tedix-unified/r/generated-app",
				expect.objectContaining({ headers: expect.anything() }),
			);
			expect(body.result.contents[0]).toMatchObject({
				mimeType: "text/html;profile=mcp-app",
				text: expect.stringContaining("Generated MCP App shell"),
				uri: resourceUri,
				_meta: { ui: { csp: expect.any(Object) } },
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("projects a generative UI view nested in a compact Code Mode result", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => { /* nested_compact_view */ const view = await ui.create_view({ data: { items: [{ name: 'Alpha', value: 42 }] }, title: 'Nested view', appSlug: 'acme', layoutId: 'nested-view' }); return { sourceCount: 1, view }; }",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					resultProjection?: {
						_meta?: { ui?: { resourceUri?: string } };
						items?: Array<Record<string, unknown>>;
					};
				};
			};
		}>(response);

		expect(body.result.structuredContent.resultProjection).toMatchObject({
			items: [{ name: "Alpha", value: 42 }],
			_meta: {
				ui: {
					resourceUri: "ui://widgets/mcp-app/acme/r/nested-view.html",
				},
			},
		});
	});

	it("serves stored Code Mode layouts as MCP-App resources", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();
		const sourceTool = createCachedData().tools[1];
		if (!sourceTool) throw new Error("Expected a widget tool fixture");
		const { _aggregateNamespace, _sourceAppId, ...firstPartyConfig } =
			sourceTool.config ?? {};
		void _aggregateNamespace;
		void _sourceAppId;
		const layoutSpec = {
			root: "stats",
			elements: {
				stats: {
					type: "Text",
					props: { text: "Catalog health" },
				},
			},
		};
		const cachedData = createCachedData();
		cachedData.tools = [
			{
				...sourceTool,
				toolId: "get_catalog_health_summary",
				title: "Get Catalog Health Summary",
				config: {
					...firstPartyConfig,
					layoutId: "catalog-health-summary",
					layoutSpec,
				},
			},
		];
		const fetchMock = vi.fn(
			async () =>
				new Response(
					"<html><head></head><body>Generated visual</body></html>",
					{
						headers: { "content-type": "text/html" },
					},
				),
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const response = await postRpcWithData(env, ctx, cachedData, {
				jsonrpc: "2.0",
				id: 1,
				method: "resources/read",
				params: {
					uri: "ui://widgets/mcp-app/paymesh-demo/r/catalog-health-summary.html",
				},
			});
			const body = await readJsonRpcResponse<{
				result: {
					contents: Array<{
						mimeType: string;
						text: string;
						uri: string;
						_meta: {
							ui: {
								domain: string;
								prefersBorder: boolean;
								csp: {
									baseUriDomains: string[];
									connectDomains: string[];
									resourceDomains: string[];
								};
							};
						};
					}>;
				};
			}>(response);
			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://widget.tedi.club/paymesh-demo/r/catalog-health-summary",
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Tedix-Layout-Spec": JSON.stringify(layoutSpec),
					}),
				}),
			);
			expect(body.result.contents[0]).toMatchObject({
				mimeType: "text/html;profile=mcp-app",
				text: expect.stringContaining("Generated visual"),
				uri: "ui://widgets/mcp-app/paymesh-demo/r/catalog-health-summary.html",
				_meta: {
					ui: {
						domain: "https://widget.tedi.club",
						prefersBorder: false,
						csp: {
							baseUriDomains: ["https://widget.tedi.club"],
							connectDomains: expect.arrayContaining([
								"https://widget.tedi.club",
								"https://mcp.tedi.club",
								"https://api.tedi.club",
							]),
							resourceDomains: expect.arrayContaining([
								"https://widget.tedi.club",
							]),
						},
					},
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("fails missing Code Mode generated UI resources with InvalidParams", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();
		const resourceUri = "ui://widgets/mcp-app/acme/r/missing-view.html";
		const fetchMock = vi.fn(
			async () =>
				new Response("<html><head></head><body>missing</body></html>", {
					status: 404,
					statusText: "Not Found",
					headers: { "content-type": "text/html" },
				}),
		);
		const originalFetch = globalThis.fetch;
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const response = await postRpc(env, ctx, {
				jsonrpc: "2.0",
				id: 1,
				method: "resources/read",
				params: { uri: resourceUri },
			});
			const body = (await response.json()) as {
				error?: {
					code: number;
					message: string;
					data?: Record<string, unknown>;
				};
				result?: unknown;
			};
			expect(response.status).toBe(200);
			expect(fetchMock).toHaveBeenCalledWith(
				"https://widget.tedi.club/acme/r/missing-view",
				expect.any(Object),
			);
			expect(body.result).toBeUndefined();
			expect(body.error?.code).toBe(-32602);
			expect(body.error?.message).toBe("Resource not found");
			expect(body.error?.data).toMatchObject({
				reason: "resource_not_found",
				uri: resourceUri,
				resourceUri,
				resourceType: "mcp-app",
				sourceAppSlug: "acme",
				widgetRoute: "/r/missing-view",
			});
		} finally {
			globalThis.fetch = originalFetch;
			consoleError.mockRestore();
		}
	});

	it("auto-wraps a bare-array ui.create_view data under rows", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: [], title: 'bare_array_data', visualKind: 'table' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				isError?: boolean;
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						rows: Array<Record<string, unknown>>;
						layoutSpec: {
							elements: Record<string, { type: string }>;
						};
						_meta: { ui: { resourceUri: string } };
					};
				};
			};
		};
		// The bare array no longer throws — it renders a real view.
		expect(body.result.isError ?? false).toBe(false);
		const result = body.result.structuredContent.result;
		// The array landed under `rows` (the canonical key) with all 3 entries.
		expect(result.rows).toHaveLength(3);
		expect(result.rows[0]).toMatchObject({ name: "CTO", role: "engineering" });
		// A real table layout + bubbled resource URI are produced.
		expect(result.layoutSpec.elements.table).toMatchObject({
			type: "DataTable",
		});
		expect(result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix/r/bare-array-data.html",
		);
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix/r/bare-array-data.html",
		);
	});

	it("infers a DataTable from the preferred ui.create_view items shape", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: { items: [{ name: 'Alpha', value: 42 }] }, title: 'preferred_items' })",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					result: {
						items: Array<Record<string, unknown>>;
						layoutSpec: {
							elements: Record<
								string,
								{ type: string; props?: Record<string, unknown> }
							>;
						};
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result.items).toEqual([{ name: "Alpha", value: 42 }]);
		expect(result.layoutSpec.elements.table).toMatchObject({
			type: "DataTable",
			props: { data: { $state: "/items" } },
		});
	});

	it("infers a native table layout when ui.create_view omits layoutSpec", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_table' })",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						_view: {
							dashboardStats: Array<Record<string, unknown>>;
						};
						_meta: { ui: { resourceUri: string } };
						layoutSpec: {
							elements: {
								stats: {
									type: string;
									props: {
										stats: { $state: string };
									};
								};
								table: {
									type: string;
									props: {
										data: { $state: string };
										columns: Array<{ field: string; format: string }>;
									};
								};
							};
						};
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/nosana/r/nosana-deployments.html",
		);
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/nosana/r/nosana-deployments.html",
		);
		expect(result.layoutSpec.elements.table).toMatchObject({
			type: "DataTable",
			props: {
				data: { $state: "/deployments" },
			},
		});
		expect(result.layoutSpec.elements.stats).toMatchObject({
			type: "StatGrid",
			props: {
				stats: { $state: "/_view/dashboardStats" },
			},
		});
		expect(result._view.dashboardStats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Total", value: 1 }),
				expect.objectContaining({ label: "Running", value: 1 }),
			]),
		);
		expect(result.layoutSpec.elements.table.props.columns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ field: "id", format: "text" }),
				expect.objectContaining({ field: "status", format: "badge" }),
			]),
		);
	});

	it("infers a reusable dashboard layout for cross-provider status data", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_dashboard' })",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					result: {
						_view: {
							dashboardStats: Array<Record<string, unknown>>;
							timelineItems: Array<Record<string, unknown>>;
						};
						layoutSpec: {
							elements: Record<
								string,
								{ type: string; props?: Record<string, unknown> }
							>;
						};
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.stats).toMatchObject({
			type: "StatGrid",
			props: { stats: { $state: "/_view/dashboardStats" } },
		});
		expect(result.layoutSpec.elements.table).toMatchObject({
			type: "DataTable",
			props: { data: { $state: "/providers" } },
		});
		expect(result.layoutSpec.elements.timeline).toMatchObject({
			type: "StatusTimeline",
			props: { items: { $state: "/_view/timelineItems" } },
		});
		expect(result._view.dashboardStats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Total", value: 3 }),
				expect.objectContaining({ label: "OK", value: 2, tone: "success" }),
				expect.objectContaining({
					label: "BLOCKED AUTH",
					value: 1,
					tone: "danger",
				}),
			]),
		);
	});

	it("infers a native comparison layout for product-like generated views", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_comparison' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						_view: {
							comparisonItems: Array<Record<string, unknown>>;
						};
						layoutSpec: {
							elements: {
								comparison: {
									type: string;
									props: {
										results: { $state: string };
										sortBy: string;
									};
								};
							};
						};
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.comparison).toMatchObject({
			type: "ComparisonLayout",
			props: {
				results: { $state: "/_view/comparisonItems" },
				sortBy: "price",
			},
		});
		expect(result._view.comparisonItems[0]).toMatchObject({
			id: "item-1",
			title: "MacBook Pro 14 M5 16GB/512GB",
			price: { amount: 1445.99, currency: "EUR", formatted: "EUR 1,445.99" },
			subtitle: "M5 · 16GB · Space Black · Unspecified",
		});
	});

	it("infers a native timeline layout for status/event generated views", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_timeline' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						_view: {
							timelineItems: Array<Record<string, unknown>>;
						};
						layoutSpec: {
							elements: {
								timeline: {
									type: string;
									props: {
										items: { $state: string };
									};
								};
							};
						};
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.timeline).toMatchObject({
			type: "StatusTimeline",
			props: {
				items: { $state: "/_view/timelineItems" },
			},
		});
		expect(result._view.timelineItems[0]).toMatchObject({
			title: "qa-run-1",
			status: "current",
			description: "Browser QA is capturing the widget",
		});
	});

	it("infers a native chart layout for time-series generated views", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_time_series_chart' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						_view: { chartData: Array<Record<string, unknown>> };
						layoutSpec: {
							elements: {
								chart: {
									type: string;
									props: {
										data: { $state: string };
										xKey: string;
										yKeys: string[];
										series: Array<{ key: string; label: string }>;
										variant: string;
									};
								};
								table: { type: string };
							};
						};
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.chart).toMatchObject({
			type: "DataChart",
			props: {
				data: { $state: "/_view/chartData" },
				variant: "line",
				xKey: "date",
				yKeys: ["tokens", "cost"],
			},
		});
		expect(result.layoutSpec.elements.chart.props.series).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "tokens", label: "Tokens" }),
				expect.objectContaining({ key: "cost", label: "Cost" }),
			]),
		);
		expect(result.layoutSpec.elements.table).toMatchObject({
			type: "DataTable",
		});
		expect(result._view.chartData[0]).toMatchObject({
			date: "2026-05-15",
			tokens: 1200,
			cost: 0.42,
		});
	});

	it("honors visualKind chart for categorical generated views", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'forced_generated_bar_chart' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						_view: { chartData: Array<Record<string, unknown>> };
						layoutSpec: {
							elements: {
								chart: {
									type: string;
									props: {
										variant: string;
										xKey: string;
										yKeys: string[];
										data: { $state: string };
									};
								};
							};
						};
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.chart).toMatchObject({
			type: "DataChart",
			props: {
				data: { $state: "/_view/chartData" },
				variant: "bar",
				xKey: "label",
				yKeys: ["value"],
			},
		});
		expect(result._view.chartData).toEqual([
			{ label: "Notion", value: 42 },
			{ label: "Gmail", value: 18 },
			{ label: "Nosana", value: 9 },
		]);
	});

	it("falls back to inferred layouts when ui.create_view receives an empty layoutSpec", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'empty_layoutspec_fallback' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						layoutSpec: {
							elements: {
								chart: { type: string };
							};
						};
					};
				};
			};
		};
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix/r/fallback-visual.html",
		);
		expect(
			body.result.structuredContent.result.layoutSpec.elements.chart,
		).toMatchObject({
			type: "DataChart",
		});
	});

	it("infers a native stats layout when visualKind is stats", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_stats' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						_view: {
							stats: Array<Record<string, unknown>>;
						};
						layoutSpec: {
							elements: {
								stats: {
									type: string;
									props: {
										stats: { $state: string };
									};
								};
							};
						};
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.stats).toMatchObject({
			type: "StatGrid",
			props: {
				stats: { $state: "/_view/stats" },
			},
		});
		expect(result._view.stats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Total Tools", value: 447 }),
				expect.objectContaining({ label: "Failed Checks", tone: "danger" }),
			]),
		);
	});

	it("honors every explicit ui.create_view visualKind", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'visual_kind_matrix' })",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					result: Record<
						| "categoricalCounts"
						| "chart"
						| "comparison"
						| "rankedMetrics"
						| "stats"
						| "summary"
						| "table"
						| "timeSeries"
						| "timeline",
						{
							_view?: Record<string, unknown>;
							layoutSpec: {
								elements: Record<
									string,
									{ type: string; props?: Record<string, unknown> }
								>;
							};
						}
					>;
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;

		expect(result.table.layoutSpec.elements.table).toMatchObject({
			type: "DataTable",
			props: { data: { $state: "/products" } },
		});
		expect(result.table.layoutSpec.elements.comparison).toBeUndefined();

		expect(result.comparison.layoutSpec.elements.comparison).toMatchObject({
			type: "ComparisonLayout",
			props: { results: { $state: "/_view/comparisonItems" } },
		});
		expect(result.comparison._view?.comparisonItems).toEqual([
			expect.objectContaining({ title: "MacBook Air" }),
		]);

		expect(result.timeline.layoutSpec.elements.timeline).toMatchObject({
			type: "StatusTimeline",
			props: { items: { $state: "/_view/timelineItems" } },
		});
		expect(result.timeline._view?.timelineItems).toEqual([
			expect.objectContaining({
				description: "Rendering widget",
				status: "current",
			}),
		]);

		expect(result.stats.layoutSpec.elements.stats).toMatchObject({
			type: "StatGrid",
			props: { stats: { $state: "/_view/stats" } },
		});
		expect(result.stats._view?.stats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Total Tools", value: 447 }),
			]),
		);

		for (const key of [
			"chart",
			"timeSeries",
			"categoricalCounts",
			"rankedMetrics",
		] as const) {
			expect(result[key].layoutSpec.elements.chart).toMatchObject({
				type: "DataChart",
				props: { data: { $state: "/_view/chartData" } },
			});
			expect(result[key]._view?.chartData).toEqual(expect.any(Array));
		}

		expect(result.summary.layoutSpec.elements.facts).toMatchObject({
			type: "KeyValuePanel",
			props: {
				items: expect.arrayContaining([
					expect.objectContaining({ label: "Status", value: "healthy" }),
					expect.objectContaining({ label: "Owner", value: "Tedix OS" }),
				]),
			},
		});
		expect(result.summary.layoutSpec.elements.table).toBeUndefined();
		expect(result.summary.layoutSpec.elements.stats).toBeUndefined();
		expect(result.summary._view).toBeUndefined();
	});

	it("infers a native summary layout for scalar generated views", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'auto_generated_summary' })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						layoutSpec: {
							elements: {
								facts: {
									type: string;
									props: { items: Array<Record<string, unknown>> };
								};
								summary: { type: string; props: { text: string } };
								table?: unknown;
							};
						};
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result.layoutSpec.elements.summary).toMatchObject({
			type: "Text",
			props: { text: "MCP generative UI surface is healthy." },
		});
		expect(result.layoutSpec.elements.facts).toMatchObject({
			type: "KeyValuePanel",
			props: {
				items: expect.arrayContaining([
					expect.objectContaining({ label: "Status", value: "healthy" }),
					expect.objectContaining({ label: "Active Widgets", value: "12" }),
				]),
			},
		});
		expect(result.layoutSpec.elements.table).toBeUndefined();
	});

	it("returns custom layoutSpec only after json-render validation", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_view({ data: {}, title: 'custom_validated_layout' })",
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						_meta: { ui: { resourceUri: string } };
						layoutSpec: {
							root: string;
							elements: Record<string, { type: string }>;
						};
					};
				};
			};
		}>(response);
		const result = body.result.structuredContent.result;
		expect(result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix/r/validated-custom-layout.html",
		);
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix/r/validated-custom-layout.html",
		);
		expect(result.layoutSpec).toMatchObject({
			root: "root",
			elements: {
				root: { type: "Stack" },
				title: { type: "Text" },
				facts: { type: "KeyValuePanel" },
			},
		});
		expect(
			Object.values(result.layoutSpec.elements).map((element) => element.type),
		).not.toContain("StatGrid");
	});

	it("finds ui.create_view with normal multi-word discovery search", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => await discover.search("visual view ui create_view json-render")',
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						results: Array<{
							callable: string;
							namespace: string;
							tool: string;
							name: string;
							description: string;
						}>;
					};
				};
			};
		};
		const createView = body.result.structuredContent.result.results.find(
			(tool) => tool.callable === "ui.create_view",
		);
		expect(createView).toBeDefined();
		expect(createView).toMatchObject({
			callable: "ui.create_view",
			namespace: "ui",
			tool: "create_view",
			name: "Create Visual View",
		});
		expect(createView?.description).toContain("json-render");
	});

	it("finds the dedicated ui.create_health_sweep helper", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => await discover.search("multiple provider health sweep")',
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: {
						results: Array<{
							callable: string;
							namespace: string;
							tool: string;
							name: string;
							description: string;
						}>;
					};
				};
			};
		};
		const createHealthSweep = body.result.structuredContent.result.results.find(
			(tool) => tool.callable === "ui.create_health_sweep",
		);
		expect(createHealthSweep).toMatchObject({
			callable: "ui.create_health_sweep",
			namespace: "ui",
			tool: "create_health_sweep",
			name: "Create Health Sweep",
		});
	});

	it("renders multi-provider health sweeps as a single json-render view", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await ui.create_health_sweep({})",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				_meta: { ui: { resourceUri: string } };
				structuredContent: {
					result: {
						_meta: { ui: { resourceUri: string } };
						checks: Array<Record<string, unknown>>;
						layoutSpec: {
							root: string;
							elements: Record<string, { type: string }>;
						};
						stats: Array<Record<string, unknown>>;
					};
				};
			};
		};
		const result = body.result.structuredContent.result;
		expect(result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix-unified/r/mcp-health-sweep.html",
		);
		expect(body.result._meta.ui.resourceUri).toBe(
			"ui://widgets/mcp-app/tedix-unified/r/mcp-health-sweep.html",
		);
		expect(result.checks).toHaveLength(3);
		expect(result.stats).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "OK", value: 1 }),
				expect.objectContaining({ label: "Attention", value: 2 }),
			]),
		);
		expect(result.layoutSpec.elements.stats).toMatchObject({
			type: "StatGrid",
		});
		expect(result.layoutSpec.elements.checks).toMatchObject({
			type: "DataTable",
		});
	});

	it("bounds empty discovery catalog searches with default pagination", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const response = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => await discover.search("discover_empty_catalog")',
				},
			},
		});
		const body = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					result: {
						meta: {
							pagination: { limit: number; offset: number; total: number };
						};
					};
				};
			};
		}>(response);
		const pagination = body.result.structuredContent.result.meta.pagination;
		expect(pagination).toMatchObject({ limit: 25, offset: 0 });
		expect(pagination.total).toBeGreaterThan(0);
	});

	it("keeps namespace discovery count-only unless tool names are requested", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const countOnlyResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await discover.list_namespaces()",
				},
			},
		});
		const countOnlyBody = (await countOnlyResponse.json()) as {
			result: { structuredContent: { result: Record<string, unknown> } };
		};
		expect(
			countOnlyBody.result.structuredContent.result.payments,
		).toMatchObject({
			tools: 1,
		});

		const fullResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await discover.list_namespaces({ includeTools: true })",
				},
			},
		});
		const fullBody = (await fullResponse.json()) as {
			result: {
				structuredContent: {
					result: Record<string, { tools: number; toolNames?: string[] }>;
				};
			};
		};
		expect(
			fullBody.result.structuredContent.result.payments?.toolNames,
		).toEqual(["premium_research_brief"]);
	});

	it("keeps discovery search schema-light unless parameters are requested", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const defaultResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => await discover.search("visual view ui create_view json-render")',
				},
			},
		});
		const defaultBody = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					result: {
						results: Array<{ callable: string; parameters?: unknown }>;
					};
				};
			};
		}>(defaultResponse);
		const defaultCreateView =
			defaultBody.result.structuredContent.result.results.find(
				(tool) => tool.callable === "ui.create_view",
			);
		expect(defaultCreateView).toBeDefined();
		expect(defaultCreateView?.parameters).toBeUndefined();

		const detailedResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => await discover.search({ query: "visual view ui create_view json-render", includeParameters: true })',
				},
			},
		});
		const detailedBody = await readJsonRpcResponse<{
			result: {
				structuredContent: {
					result: {
						results: Array<{ callable: string; parameters?: unknown }>;
					};
				};
			};
		}>(detailedResponse);
		const detailedCreateView =
			detailedBody.result.structuredContent.result.results.find(
				(tool) => tool.callable === "ui.create_view",
			);
		expect(detailedCreateView?.parameters).toBeDefined();
		expect(detailedCreateView?.parameters).toMatchObject({
			properties: {
				data: {
					anyOf: [
						{ type: "object" },
						{ type: "array", items: { type: "object" } },
					],
					examples: [
						{ items: [{ name: "Alpha", value: 42 }] },
						[{ name: "Alpha", value: 42 }],
					],
				},
			},
		});
	});

	it("quarantines ambiguous projected tools without taking Code Mode offline", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const cachedData = createCachedData();
		const sourceTool = cachedData.tools.find(
			(tool) => tool.toolId === "nosana__get_deployments",
		);
		if (!sourceTool) throw new Error("source test tool missing");
		cachedData.tools = [
			...cachedData.tools,
			{
				...sourceTool,
				id: "e34778ce-4241-4f70-b066-0930f10aafeb",
				toolId: "nosana__get-deployments",
			},
		];

		const response = await postRpcWithData(env, ctx, cachedData, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: "async () => await discover.list_namespaces({ includeTools: true })",
				},
			},
		});
		const body = (await response.json()) as {
			result: {
				structuredContent: {
					result: Record<string, { toolNames?: string[] }>;
				};
			};
		};

		expect(response.status).toBe(200);
		expect(body.result.structuredContent.result.nosana).toBeUndefined();
		expect(body.result.structuredContent.result.payments?.toolNames).toEqual([
			"premium_research_brief",
		]);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				'"event":"tool_collision_quarantined","ownerKey":"nosana.get_deployments"',
			),
		);
		warn.mockRestore();
	});

	it("rebuilds the code tool description from the per-request tool catalog", async () => {
		const firstDescription = await listCodeToolDescription(createCachedData());
		expect(firstDescription).toContain("13 tools across 5 namespaces");
		expect(firstDescription).toContain("payments (1)");
		expect(firstDescription).toContain("nosana (1)");
		expect(firstDescription).toContain("codemode (1)");
		expect(firstDescription).not.toContain("catalog (1)");
		expect(firstDescription).not.toContain("catalog.reconcile_app");

		const cachedData = createCachedData();
		const baseTool = cachedData.tools[0];
		if (!baseTool) throw new Error("base test tool missing");
		cachedData.tools = [
			...cachedData.tools,
			{
				...baseTool,
				id: "55e63671-972f-4c0c-9e8c-4c0688f67094",
				toolId: "catalog__reconcile_app",
				title: "Reconcile catalog app",
				description: "Reconcile a catalog app projection.",
				config: {
					transport: "rpc",
					endpoint: "catalog/reconcileApp",
				},
				sortOrder: 2,
			},
		];

		const secondDescription = await listCodeToolDescription(cachedData);
		expect(secondDescription).toContain("14 tools across 6 namespaces");
		expect(secondDescription).toContain("catalog (1)");
		expect(secondDescription).toContain("declare namespace catalog");
		expect(secondDescription).toContain("function reconcile_app");
	});

	it("surfaces inner paid tool requirements and accepts outer code-tool payment proof", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const listResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});
		const listBody = (await listResponse.json()) as {
			result: { tools: Array<{ name: string }> };
		};
		expect(listBody.result.tools.map((tool) => tool.name)).toContain("code");

		const unpaidResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "code",
				arguments: { code: CODE },
			},
		});
		const unpaidBody = (await unpaidResponse.json()) as {
			result: {
				isError: boolean;
				_meta: {
					[key: string]: unknown;
					"x-tedix/payment-required": {
						requirements: {
							x402Version: number;
							resource: {
								url: string;
								description?: string;
								mimeType?: string;
							};
							accepts: Array<{
								network: string;
								amount: string;
								extra: { requirementId: string; paymentRequestId: string };
							}>;
						};
					};
				};
			};
		};
		expect(unpaidBody.result.isError).toBe(true);
		const requirements =
			unpaidBody.result._meta["x-tedix/payment-required"].requirements;
		expect(requirements.x402Version).toBe(2);
		expect(requirements.resource.url).toContain(
			"mcp://paymesh-demo/tools/premium_research_brief",
		);
		expect(unpaidBody.result._meta["x402/error"]).toEqual(requirements);
		expect(requirements.accepts[0]).toMatchObject({
			network: "solana:devnet",
			amount: "10000",
		});

		const requirementId = requirements.accepts[0]?.extra.requirementId;
		expect(requirements.accepts[0]?.extra.paymentRequestId).toMatch(
			/^[0-9a-f-]{36}$/,
		);
		const paidResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "code",
				arguments: { code: CODE },
				_meta: {
					"x402/payment": {
						mockPaid: true,
						requirementId,
						toolId: "premium_research_brief",
						amount: "0.01",
						network: "solana-devnet",
					},
				},
			},
		});
		const paidBody = (await paidResponse.json()) as {
			result: {
				content: Array<{ text: string }>;
				_meta: Record<string, unknown>;
			};
		};
		expect(paidBody.result.content[0]?.text).toContain(
			"Tedix PayMesh paid tool executed",
		);
		expect(paidBody.result._meta["x402/payment-response"]).toMatchObject({
			protocol: "x402",
			mode: "mock",
			requirementId,
			settled: true,
			ledger: {
				table: "mcp_payment_events",
			},
		});
		expect(
			(
				paidBody.result._meta["x402/payment-response"] as Record<
					string,
					unknown
				>
			).receiptId,
		).toMatch(/^[0-9a-f-]{36}$/);

		const paidViaArgumentResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: CODE,
					payment: {
						mockPaid: true,
						requirementId,
						toolId: "premium_research_brief",
						amount: "0.01",
						network: "solana-devnet",
					},
				},
				_meta: { host: "codex" },
			},
		});
		const paidViaArgumentBody = (await paidViaArgumentResponse.json()) as {
			result: {
				content: Array<{ text: string }>;
				_meta: Record<string, unknown>;
			};
		};
		expect(paidViaArgumentBody.result.content[0]?.text).toContain(
			"Tedix PayMesh paid tool executed",
		);
		expect(
			paidViaArgumentBody.result._meta["x402/payment-response"],
		).toMatchObject({
			protocol: "x402",
			mode: "mock",
			requirementId,
			settled: true,
			ledger: {
				table: "mcp_payment_events",
			},
		});
	});
});
