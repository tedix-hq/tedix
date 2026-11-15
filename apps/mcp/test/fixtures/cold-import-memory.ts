import {
	aggregateSurfaceCache,
	aggregateSurfaceRetainedRows,
} from "../../src/aggregate-surface-cache";
import { internalToolCache } from "../../src/aggregate-internal-tools";
import {
	buildMcpServer,
	type CachedAppData,
} from "../../src/mcp/server-factory";

export default {
	async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
		if (new URL(request.url).pathname === "/seed") {
			const tools = Array.from({ length: 5791 }, (_, i) => ({
				toolId: `retained_${i}`,
				inputSchema: {
					type: "object",
					properties: Object.fromEntries(
						Array.from({ length: 80 }, (_, j) => [
							`field_${j}`,
							{
								type: "string",
								description: `Fictional schema ${i}/${j} `.padEnd(90, "x"),
							},
						]),
					),
				},
			}));
			aggregateSurfaceCache.set("memory-fixture", {
				result: {
					tools,
					resources: [],
					resourceTemplates: [],
					prompts: [],
				} as never,
				expiresAt: Date.now() + 120_000,
			});
			return Response.json({ retainedSchemas: aggregateSurfaceRetainedRows() });
		}
		const tools = Array.from({ length: 20422 }, (_, i) => ({
			id: `compact_${i}`,
			toolId: `fixture__read_item_${i}`,
			title: `Read item ${i}`,
			description: `Fictional compact descriptor ${i} `.padEnd(280, "x"),
			enabled: true,
			inputSchema: { type: "object", properties: {} },
			config: { transport: "rpc", endpoint: "apps/getBySlugWithTools" },
			annotations: { readOnlyHint: true },
			writeCapability: "read",
		}));
		const cached = {
			app: { id: "fixture-app", slug: "connect", name: "Memory fixture" },
			tools,
			metadata: { mcpConfig: { codeMode: true } },
			capabilities: {},
			catalogResources: [],
			catalogResourceTemplates: [],
			catalogPrompts: [],
			expiresAt: Date.now() + 60_000,
		} as unknown as CachedAppData;
		const server = await buildMcpServer(
			cached,
			{
				authType: "service",
				organizationId: "fixture-org",
				scopes: ["mcp:apps.read"],
			},
			env,
			ctx,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"code",
			undefined,
			undefined,
			undefined,
			false,
			async (tool) => tool,
		);
		await server.close();
		return Response.json({
			compactTools: tools.length,
			retainedSchemas: aggregateSurfaceRetainedRows(),
			retainedSources: internalToolCache.size,
		});
	},
};
