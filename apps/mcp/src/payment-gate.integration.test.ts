import { mountMcp } from "@tedix/mcp-shared/transport";
import { describe, expect, it, vi } from "vite-plus/test";
import { buildMcpServer, type CachedAppData } from "./mcp/server-factory";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {},
	DurableObject: class {},
	RpcTarget: class {},
	env: {},
	tracing: {
		enterSpan: (_name: string, callback: (span: unknown) => unknown) =>
			callback({ setAttribute: vi.fn() }),
	},
}));

const APP_ID = "07ed3daf-ce65-480d-846a-9e93e5843461";
const ORG_ID = "0f0f0f0f-0000-4000-8000-000000000001";
const TOOL_ROW_ID = "a0e5cef4-ae8d-4451-9ef8-056241c57aea";
const ACCEPT_BOTH = "application/json, text/event-stream";

function createAppWithToolsResponse() {
	const now = new Date("2026-05-10T00:00:00.000Z").toISOString();
	return {
		app: {
			id: APP_ID,
			organizationId: ORG_ID,
			name: "PayMesh Demo",
			slug: "paymesh-demo",
			description: "x402 payment-gated MCP app",
			primaryDomain: null,
			domain: null,
			logoUrl: null,
			visibility: "public",
			discoveryStatus: "scraped",
			customMcpDomain: null,
			openaiChallengeToken: null,
			openaiAppId: null,
			appStoreStatus: "draft",
			activeConfigVersionId: null,
			latestConfigVersion: null,
			vertical: "platform",
			metadata: {
				mcpConfig: {
					authMode: "public",
					capabilities: [],
					enforcePolicies: false,
					codeMode: false,
					connectionLabel: "paymesh-demo",
					autoAppendSkillInstructions: false,
				},
			},
			extractedAt: null,
			aiSearchSyncedAt: null,
			createdAt: now,
			updatedAt: now,
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
					properties: {
						topic: { type: "string" },
					},
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
		],
	};
}

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

			return Response.json(
				{ code: "NOT_FOUND", message: `Unexpected API path: ${url.pathname}` },
				{ status: 404 },
			);
		}),
	};
}

function createCachedData(): CachedAppData {
	const response = createAppWithToolsResponse();
	return {
		app: {
			id: response.app.id,
			organizationId: response.app.organizationId,
			name: response.app.name,
			slug: response.app.slug,
			domain: response.app.domain,
			description: response.app.description,
			logoUrl: response.app.logoUrl,
			customMcpDomain: response.app.customMcpDomain,
			openaiChallengeToken: response.app.openaiChallengeToken,
			openaiAppId: response.app.openaiAppId,
			appStoreStatus: response.app.appStoreStatus,
			visibility: response.app.visibility,
			discoveryStatus: response.app.discoveryStatus,
		},
		tools: response.tools as unknown as CachedAppData["tools"],
		metadata: response.app.metadata as CachedAppData["metadata"],
		capabilities: {
			checkout: { enabled: false },
			cart: { enabled: false },
			wishlist: { enabled: false },
			compare: { enabled: false },
			map: { enabled: false },
			externalCta: { enabled: true },
		},
		organizationId: response.app.organizationId,
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
	const server = await buildMcpServer(
		createCachedData(),
		undefined,
		env,
		ctx,
		"paymesh-demo",
		"payment-gate-test-trace",
	);
	return mountMcp(
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

describe("payment-gated MCP tools", () => {
	it("advertises paid tools, returns an x402 v2 challenge, and accepts a payment proof retry", async () => {
		const apiService = createApiService();
		const env = createEnv(apiService);
		const ctx = createExecutionContext();

		const listResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});
		expect(listResponse.status).toBe(200);
		const listBody = await readJsonRpcResponse<{
			result: {
				tools: Array<{
					name: string;
					_meta?: Record<string, unknown>;
				}>;
			};
		}>(listResponse);
		const paidTool = listBody.result.tools.find(
			(tool) => tool.name === "premium_research_brief",
		);
		expect(paidTool).toMatchObject({
			name: "premium_research_brief",
			_meta: {
				"x-tedix/paymentRequired": true,
				// agents-x402 discovery extension read by Cloudflare buyer agents
				"agents-x402/paymentRequired": true,
				"agents-x402/priceUSD": 0.01,
			},
		});

		const unpaidResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "premium_research_brief",
				arguments: { topic: "Solana agent payments" },
			},
		});
		expect(unpaidResponse.status).toBe(200);
		const unpaidBody = await readJsonRpcResponse<{
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
								payTo: string;
								extra: {
									requirementId: string;
									toolId: string;
									mode: string;
									paymentRequestId: string;
								};
							}>;
						};
					};
				};
			};
		}>(unpaidResponse);
		expect(unpaidBody.result.isError).toBe(true);
		const requirements =
			unpaidBody.result._meta["x-tedix/payment-required"].requirements;
		expect(requirements.x402Version).toBe(2);
		expect(requirements.resource).toMatchObject({
			url: expect.stringContaining(
				"mcp://paymesh-demo/tools/premium_research_brief",
			),
			mimeType: "application/json",
		});
		expect(unpaidBody.result._meta["x402/error"]).toEqual(requirements);
		expect(requirements.accepts[0]).toMatchObject({
			network: "solana:devnet",
			amount: "10000",
			payTo: "TedixPayMeshDemo111111111111111111111111111",
			extra: {
				toolId: "premium_research_brief",
				mode: "mock",
			},
		});

		const requirementId = requirements.accepts[0]?.extra.requirementId;
		expect(requirementId).toMatch(/^tedix-x402-/);
		expect(requirements.accepts[0]?.extra.paymentRequestId).toMatch(
			/^[0-9a-f-]{36}$/,
		);

		const paidResponse = await postRpc(env, ctx, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "premium_research_brief",
				arguments: { topic: "Solana agent payments" },
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
		expect(paidResponse.status).toBe(200);
		const paidBody = await readJsonRpcResponse<{
			result: {
				content: Array<{ text: string }>;
				structuredContent: Record<string, unknown>;
				_meta: Record<string, unknown>;
			};
		}>(paidResponse);
		expect(paidBody.result.structuredContent).toMatchObject({
			message: "Tedix PayMesh paid tool executed",
			topic: "Solana agent payments",
			paid: true,
		});
		expect(paidBody.result.content[0]?.text).toContain(
			"Tedix PayMesh paid tool executed",
		);
		expect(paidBody.result._meta["x402/payment-response"]).toMatchObject({
			protocol: "x402",
			settled: true,
			mode: "mock",
			requirementId,
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
	});
});
