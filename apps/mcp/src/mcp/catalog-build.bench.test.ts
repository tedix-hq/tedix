import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { it, expect, vi } from "vite-plus/test";
import { buildMcpServer, type CachedAppData } from "./server-factory";
import type { AppTool } from "./server-context";
import * as executionBindings from "./codemode-execution";

vi.mock("../lib/api-client", () => ({ getApiClient: () => ({}) }));

it("keeps discovery SDK bindings bounded on a 15,922-tool aggregate", async () => {
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
					properties: Object.fromEntries(
						Array.from({ length: 16 }, (_, field) => [
							`field_${field}`,
							{
								type: "string",
								description:
									"A field from the provider's complete input contract.",
								enum: ["one", "two", "three"],
							},
						]),
					),
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
			expect(providers.map((provider) => provider.name).sort()).toEqual([
				"codemode",
				"discover",
				"flow",
				"ui",
			]);
			// The SDK enumerates every function and allocates a gated RPC wrapper
			// per binding. Discovery must not send the 15k app functions (or aliases).
			expect(
				providers.reduce(
					(n, provider) => n + Object.keys(provider.fns).length,
					0,
				),
			).toBeLessThan(30);
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
	const aliases = vi.spyOn(executionBindings, "legacyNamespaceAliases");
	const samples: Array<{
		wave: number;
		buildCpuMs: number;
		requestCpuMs: number;
		wallMs: number;
		heapAfterBuild: number;
		heapAfterDiscovery: number;
	}> = [];
	const waves: Array<{
		wave: number;
		cpuMs: number;
		wallMs: number;
		heapBefore: number;
		heapAfter: number;
	}> = [];
	const sampleCount = process.env.TEDIX_CATALOG_BENCH ? 6 : 2;
	for (let wave = 0; wave < sampleCount; wave++) {
		const gc = (globalThis as { gc?: () => void }).gc;
		gc?.();
		const waveCpu = process.cpuUsage();
		const waveStart = performance.now();
		const heapBefore = process.memoryUsage().heapUsed;
		await Promise.all(
			Array.from({ length: 9 }, async () => {
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
				const heapAfterBuild = process.memoryUsage().heapUsed;
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
						wave,
						heapAfterBuild,
						heapAfterDiscovery: process.memoryUsage().heapUsed,
						buildCpuMs: (buildCpu.user + buildCpu.system) / 1000,
						requestCpuMs: (cpu.user + cpu.system) / 1000,
						wallMs: performance.now() - wall,
					});
				} finally {
					await server.close();
					await client.close();
				}
			}),
		);
		const usedCpu = process.cpuUsage(waveCpu);
		execute.mockClear();
		gc?.();
		waves.push({
			wave,
			cpuMs: (usedCpu.user + usedCpu.system) / 1000,
			wallMs: performance.now() - waveStart,
			heapBefore,
			heapAfter: process.memoryUsage().heapUsed,
		});
	}
	expect(aliases).not.toHaveBeenCalled();
	aliases.mockRestore();
	console.log(
		"CATALOG_BENCH",
		JSON.stringify({ toolCount: tools.length, concurrency: 9, waves, samples }),
	);
	if (process.env.TEDIX_CATALOG_BENCH)
		process.stdout.write(
			`CATALOG_BENCH ${JSON.stringify({ toolCount: tools.length, concurrency: 9, forcedGc: typeof (globalThis as { gc?: unknown }).gc === "function", waves, samples })}\n`,
		);
	execute.mockRestore();
	expect(samples).toHaveLength(sampleCount * 9);
}, 60_000);
