import { it, expect } from "vite-plus/test";
import {
	buildNamespaceGroups,
	buildLazyNamespaceGroups,
	buildProviders,
	legacyNamespaceAliases,
	withLegacyNamespaceAliases,
	type CodeModeExecutionRefs,
} from "./codemode-execution";
import type { AppTool, ServerContext } from "./server-context";

// NODE_OPTIONS=--expose-gc TEDIX_CATALOG_BENCH=1 makes the retained-heap
// comparison reproducible; without forced GC the values are diagnostic only.
it.skipIf(!process.env.TEDIX_CATALOG_BENCH)(
	"measures retained execution-binding allocation",
	() => {
		const tools = Array.from(
			{ length: 16_000 },
			(_, i) =>
				({
					id: `row-${i}`,
					toolId: `org_${i % 100}__read_${i}`,
					title: `Read ${i}`,
					description: "A provider read",
					enabled: true,
					annotations: { readOnlyHint: true },
					inputSchema: {
						type: "object",
						properties: { id: { type: "string" } },
					},
					config: {
						transport: "rpc",
						endpoint: "apps/get",
						_aggregateNamespace: `org_${i % 100}`,
						_aggregateLegacyNamespace: `legacy_${i % 10}`,
					},
				}) as unknown as AppTool,
		);
		const ctx = {
			loadedTools: new Map(tools.map((t) => [t.toolId, t])),
			appSlug: "connect",
		} as ServerContext;
		const gc = (globalThis as { gc?: () => void }).gc;
		const measure = (lazy: boolean) => {
			gc?.();
			const heap = process.memoryUsage().heapUsed;
			const cpu = process.cpuUsage();
			const groups = (lazy ? buildLazyNamespaceGroups : buildNamespaceGroups)(
				ctx,
				undefined,
				{} as CodeModeExecutionRefs,
				new Set(),
			);
			const providers = withLegacyNamespaceAliases(
				buildProviders(groups),
				legacyNamespaceAliases(ctx, undefined, groups, new Set()),
			);
			gc?.();
			const retainedBytes = process.memoryUsage().heapUsed - heap;
			const cost = process.cpuUsage(cpu);
			expect(providers.reduce((n, p) => n + Object.keys(p.fns).length, 0)).toBe(
				32_000,
			);
			return { retainedBytes, cpuMs: (cost.user + cost.system) / 1000 };
		};
		console.log(
			"LAZY_BINDINGS_MEASURE",
			JSON.stringify({
				forcedGc: !!gc,
				lazy: measure(true),
				eager: measure(false),
			}),
		);
	},
);
