import { afterEach, describe, expect, it } from "vite-plus/test";
import {
	aggregateSurfaceCache,
	aggregateSurfaceRetainedRows,
} from "../aggregate-surface-cache";
import { internalToolCache } from "../aggregate-internal-tools";
import { buildMcpServer, type CachedAppData } from "./server-factory";

afterEach(() => {
	aggregateSurfaceCache.clear();
	internalToolCache.clear();
});

describe("server catalog retention", () => {
	it.each([false, true])(
		"releases unrelated full schemas only with an individual definition loader: %s",
		async (sharded) => {
			aggregateSurfaceCache.set("prior-gateway", {
				result: {
					tools: [{ toolId: "prior_tool" }],
					resources: [],
					resourceTemplates: [],
					prompts: [],
				} as never,
				expiresAt: Date.now() + 120_000,
			});
			internalToolCache.set("prior-source", {
				result: { tools: [{ toolId: "prior_tool" }] } as never,
				expiresAt: Date.now() + 120_000,
			});
			const cached = {
				app: { id: "fixture", slug: "fixture", name: "Fixture" },
				tools: [],
				metadata: null,
				capabilities: {},
				catalogResources: [],
				catalogResourceTemplates: [],
				catalogPrompts: [],
				expiresAt: Date.now() + 60_000,
			} as unknown as CachedAppData;
			const server = await buildMcpServer(
				cached,
				undefined,
				{
					API_SERVICE: {
						fetch: async () => {
							throw new Error("Unexpected fixture API call");
						},
					},
				} as unknown as CloudflareEnv,
				{} as ExecutionContext,
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
				sharded ? async (tool) => tool : undefined,
			);
			await server.close();
			expect(aggregateSurfaceRetainedRows()).toBe(sharded ? 0 : 1);
			expect(internalToolCache.size).toBe(sharded ? 0 : 1);
		},
	);
});
