/**
 * Routing + spec parity for the graph/governance routers.
 *
 * Replaces `lazy-governance-routers.test.ts`. That file guarded a bespoke
 * mechanism that no longer exists: these four routers were wrapped in a
 * `lazyContractImplementationRouter()` whose root-key `Proxy` kept contract-first
 * matching working through oRPC v1's `lazy()`. The wrapper and its Proxy are
 * gone — laziness is no longer four routers' special case but every namespace's
 * default, built on oRPC v2's own `Lazy` in `./index` and guarded by
 * `lazy-namespace-isolation.test.ts`. (The dismissal that retired the old file —
 * that `lazy()` "only ever deferred first-request CPU, not the startup budget
 * that error 10021 measures" — had the fact right and the conclusion backwards:
 * first-request CPU is per isolate, and it was costing seconds.)
 *
 * Full RPC-path resolution is covered once for every namespace by
 * `lazy-namespace-isolation.test.ts`. This file keeps the governance-specific
 * OpenAPI parity guarantee without repeating that expensive exhaustive matcher
 * walk. The REST side is asserted through the generated spec since the effective
 * REST path is the router prefix joined with the procedure path and the spec is
 * what actually publishes it.
 */

import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { describe, expect, it } from "vite-plus/test";
import { apiRouter } from "./index";

describe("graph/governance router routing", () => {
	it("generates the same REST paths from the routers as from the contracts", async () => {
		const [
			{ graphRetrievalBenchmarksContract },
			{ memoryEntitiesContract },
			{ memoryGraphContract },
			{ workItemsContract },
		] = await Promise.all([
			import("@tedix/api-contract/contracts/graph-retrieval-benchmarks"),
			import("@tedix/api-contract/contracts/memory-entities"),
			import("@tedix/api-contract/contracts/memory-graph"),
			import("@tedix/api-contract/contracts/work-items"),
		]);

		const generator = new OpenAPIGenerator({
			converters: [new ZodToJsonSchemaConverter()],
		});
		const base = { info: { title: "Governance router test", version: "1" } };

		const fromRouters = await generator.generate(
			{
				memoryGraph: apiRouter.memoryGraph,
				memoryEntities: apiRouter.memoryEntities,
				graphRetrievalBenchmarks: apiRouter.graphRetrievalBenchmarks,
				workItems: apiRouter.workItems,
			},
			{ base },
		);
		const fromContracts = await generator.generate(
			{
				memoryGraph: memoryGraphContract,
				memoryEntities: memoryEntitiesContract,
				graphRetrievalBenchmarks: graphRetrievalBenchmarksContract,
				workItems: workItemsContract,
			},
			{ base },
		);

		expect(fromRouters).toEqual(fromContracts);
		expect(fromRouters.paths?.["/memory/search"]).toEqual(
			fromContracts.paths?.["/memory/search"],
		);
		expect(fromRouters.paths).toHaveProperty("/memory/health");
		expect(fromRouters.paths).toHaveProperty("/memory/entities");
		expect(fromRouters.paths).not.toHaveProperty("/memory/entities/");
		expect(fromRouters.paths).toHaveProperty(
			"/graph-retrieval-benchmarks/paired-runs/{pairedRunKey}/graduation",
		);
	});
});
