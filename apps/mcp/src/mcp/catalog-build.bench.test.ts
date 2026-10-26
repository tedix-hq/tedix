import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { it, expect, vi } from "vite-plus/test";
import { buildMcpServer, type CachedAppData } from "./server-factory";
import type { AppTool } from "./server-context";

vi.mock("../lib/api-client", () => ({ getApiClient: () => ({}) }));

it.skipIf(!process.env.TEDIX_CATALOG_BENCH)(
	"measures 15,922-tool request builds",
	async () => {
		const tools = Array.from(
			{ length: 15_922 },
			(_, i) =>
				({
					id: `row-${i}`,
					toolId: `app_${i % 100}__read_item_${i}`,
					title: `Read item ${i}`,
					description: `Read item ${i} with its configured provider.`,
					toolTypeId: "rpc",
					enabled: true,
					config: {
						transport: "rpc",
						endpoint: "apps/get",
						_aggregateNamespace: `app_${i % 100}`,
					},
					inputSchema: {
						type: "object",
						properties: { id: { type: "string" } },
					},
					annotations: { readOnlyHint: true },
				}) as unknown as AppTool,
		);
		const data = {
			app: { id: "bench", slug: "connect", name: "Bench" },
			tools,
			metadata: { mcpConfig: { codeMode: true } },
			capabilities: {},
			expiresAt: Date.now() + 60_000,
		} as CachedAppData;
		// Replace only the sandbox startup. The real MCP code handler and discover
		// provider still run; no model or provider request is made.
		const execute = vi
			.spyOn(DynamicWorkerExecutor.prototype, "execute")
			.mockImplementation(async (_code, providers) => {
				if (!Array.isArray(providers)) throw new Error("Expected providers");
				const discover = providers.find(
					(provider) => provider.name === "discover",
				)!;
				return {
					result: await discover.fns.search!({
						query: "read_item_500",
						limit: 3,
					}),
					logs: [],
				};
			});
		const samples = [];
		for (let i = 0; i < 6; i++) {
			const start = process.cpuUsage();
			const wall = performance.now();
			const server = await buildMcpServer(
				data,
				{ authType: "oauth", scopes: ["mcp:apps.read"] },
				{ LOADER: {}, ENVIRONMENT: "test" } as CloudflareEnv,
				{ waitUntil: () => {} } as unknown as ExecutionContext,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				"code",
			);
			const buildCpu = process.cpuUsage(start);
			const [client, transport] = InMemoryTransport.createLinkedPair();
			let id = 0;
			const request = async (
				method: string,
				params: Record<string, unknown>,
			) => {
				const response = new Promise<{
					error?: unknown;
					result?: { isError?: boolean };
				}>((resolve) => {
					client.onmessage = (message) => resolve(message as never);
				});
				await client.send({
					jsonrpc: "2.0",
					id: ++id,
					method,
					params,
				} as never);
				return response;
			};
			try {
				await server.connect(transport);
				expect(
					(
						await request("initialize", {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "bench", version: "1" },
						})
					).error,
				).toBeUndefined();
				await client.send({
					jsonrpc: "2.0",
					method: "notifications/initialized",
				} as never);
				const called = await request("tools/call", {
					name: "code",
					arguments: {
						code: 'async () => await discover.search({query:"read_item_500",limit:3})',
					},
				});
				expect(called.error).toBeUndefined();
				expect(called.result?.isError).not.toBe(true);
				const cpu = process.cpuUsage(start);
				samples.push({
					buildCpuMs: (buildCpu.user + buildCpu.system) / 1000,
					requestCpuMs: (cpu.user + cpu.system) / 1000,
					wallMs: performance.now() - wall,
				});
			} finally {
				await server.close();
				await client.close();
			}
		}
		console.log(
			"CATALOG_BENCH",
			JSON.stringify({ toolCount: tools.length, samples }),
		);
		execute.mockRestore();
		expect(samples).toHaveLength(6);
	},
	60_000,
);
