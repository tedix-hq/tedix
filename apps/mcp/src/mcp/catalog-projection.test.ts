import { describe, expect, it, vi } from "vite-plus/test";
import { resolveProvider } from "@cloudflare/codemode";
import { cachedCatalogProjection, copyCatalogTool } from "./catalog-projection";
import {
	buildCatalogProvider,
	resolveLazyCatalogProvider,
} from "./codemode-catalog";
import type { AppTool, ServerContext } from "./server-context";
import type { CatalogToolEntry } from "./codemode-catalog-entries";
import * as scopeAuthorization from "./codemode-auth";
import {
	buildNamespaceGroups,
	buildLazyNamespaceGroups,
	buildProviders,
	legacyNamespaceAliases,
	withLegacyNamespaceAliases,
	type CodeModeExecutionRefs,
} from "./codemode-execution";
import { McpNativeDescriptorSchema } from "@tedix/api-contract/schemas/mcp-native-transport";

function row(): AppTool {
	return {
		id: "row-one",
		toolId: "apps__read_item",
		title: "Read item",
		description: "Read an item",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		config: {
			transport: "rpc",
			endpoint: "apps/get",
			_aggregateNamespace: "apps",
		},
		enabled: true,
	} as unknown as AppTool;
}
function context(tool: AppTool, scopes: string[] = []): ServerContext {
	return {
		loadedTools: new Map([[tool.toolId, tool]]),
		appSlug: "connect",
		callerIdentity: { authType: "oauth", scopes },
		appMetadata: {
			mcpConfig: { toolScopes: { [tool.toolId]: ["mcp:apps.read"] } },
		},
	} as unknown as ServerContext;
}

describe("catalog projection reuse", () => {
	it("reuses only the same source revision, namespace and enriched description", () => {
		const source = row();
		const build = vi.fn(
			() =>
				({
					callable: "apps.read_item",
					namespace: "apps",
					tool: "read_item",
					name: "Read",
					displayName: "Read",
					description: "Read",
					parameters: source.inputSchema,
				}) satisfies CatalogToolEntry,
		);
		const first = cachedCatalogProjection(
			copyCatalogTool(source),
			"apps",
			"read_item",
			build,
		);
		expect(
			cachedCatalogProjection(
				copyCatalogTool(source),
				"apps",
				"read_item",
				build,
			),
		).toBe(first);
		expect(build).toHaveBeenCalledTimes(1);
		cachedCatalogProjection(
			copyCatalogTool({
				...source,
				inputSchema: {
					type: "object",
					properties: { newField: { type: "string" } },
				},
			}),
			"apps",
			"read_item",
			build,
		);
		cachedCatalogProjection(
			copyCatalogTool(source),
			"other_org",
			"read_item",
			build,
		);
		cachedCatalogProjection(
			Object.assign(copyCatalogTool(source), { description: "Changed skill" }),
			"apps",
			"read_item",
			build,
		);
		expect(build).toHaveBeenCalledTimes(4);
	});
	it("does not cache failed builds", () => {
		const source = row();
		const build = vi
			.fn()
			.mockImplementationOnce(() => {
				throw new Error("failed");
			})
			.mockReturnValue({});
		expect(() =>
			cachedCatalogProjection(
				copyCatalogTool(source),
				"apps",
				"read_item",
				build,
			),
		).toThrow("failed");
		cachedCatalogProjection(
			copyCatalogTool(source),
			"apps",
			"read_item",
			build,
		);
		expect(build).toHaveBeenCalledTimes(2);
	});
	it("keeps authorization and native eligibility request-local on a warm projection", async () => {
		const source = row();
		const describeTool = async (scopes: string[]) =>
			resolveProvider(
				buildCatalogProvider(
					context(copyCatalogTool(source), scopes),
					undefined,
				),
			).fns.describe!({ callable: "apps.read_item" });
		const [granted, denied] = await Promise.all([
			describeTool(["mcp:apps.read"]),
			describeTool([]),
		]);
		expect(granted).toMatchObject({
			authorized: true,
			native: { authorized: true },
		});
		expect(denied).toMatchObject({
			authorized: false,
			missingScopes: ["mcp:apps.read"],
			native: { authorized: false },
		});
	});
	it("shares own enumerable getter functions while retaining private lazy caller decisions", () => {
		const source = row();
		const properties = vi.spyOn(Object, "defineProperties");
		const authorize = vi.spyOn(
			scopeAuthorization,
			"evaluateMcpToolScopeAuthorization",
		);
		try {
			buildCatalogProvider(
				context(copyCatalogTool(source), ["mcp:apps.read"]),
				undefined,
			);
			buildCatalogProvider(context(copyCatalogTool(source), []), undefined);
			const entries = properties.mock.calls
				.filter(
					([, descriptors]) =>
						descriptors.authorized?.get && descriptors.native?.get,
				)
				.map(([entry]) => entry as CatalogToolEntry);
			expect(entries).toHaveLength(2);
			expect(authorize).not.toHaveBeenCalled();
			const [granted, denied] = entries;
			for (const key of [
				"native",
				"authorized",
				"requiredScopes",
				"missingScopes",
				"scopeMappingMissing",
			]) {
				const first = Object.getOwnPropertyDescriptor(granted, key)!;
				const second = Object.getOwnPropertyDescriptor(denied, key)!;
				expect(first.enumerable).toBe(true);
				expect(first.configurable).toBe(true);
				expect(first.get).toBe(second.get);
			}
			const deniedWire = JSON.parse(JSON.stringify(denied));
			const grantedWire = JSON.parse(JSON.stringify(granted));
			expect(deniedWire).toMatchObject({
				authorized: false,
				missingScopes: ["mcp:apps.read"],
				native: { authorized: false },
			});
			expect(grantedWire).toMatchObject({
				authorized: true,
				native: { authorized: true },
			});
			expect(JSON.parse(JSON.stringify(denied))).toEqual(deniedWire);
			expect(
				Object.getOwnPropertySymbols(granted).every(
					(symbol) =>
						!Object.getOwnPropertyDescriptor(granted, symbol)?.enumerable,
				),
			).toBe(true);
			expect(grantedWire).not.toHaveProperty("serverCtx");
		} finally {
			properties.mockRestore();
			authorize.mockRestore();
		}
	});

	it("defers catalog construction until discovery and matches every discovery method", async () => {
		const ctx = context(copyCatalogTool(row()), ["mcp:apps.read"]);
		const values = vi.spyOn(ctx.loadedTools, "values");
		const refs = {
			discoverCalls: 0,
			discoverParameterRequests: 0,
		} as CodeModeExecutionRefs;
		const lazy = resolveLazyCatalogProvider(ctx, undefined, refs, new Set());
		expect(values).not.toHaveBeenCalled();
		const eager = resolveProvider(
			buildCatalogProvider(ctx, undefined, refs, new Set()),
		);
		expect(Object.keys(lazy.fns)).toEqual(Object.keys(eager.fns));
		expect(await lazy.fns.describe!({ callable: "apps.read_item" })).toEqual(
			await eager.fns.describe!({ callable: "apps.read_item" }),
		);
		expect(await lazy.fns.list_namespaces!({})).toEqual(
			await eager.fns.list_namespaces!({}),
		);
	});
	it("materializes native descriptors only for the ranked page", async () => {
		const tools = Array.from({ length: 100 }, (_, i) =>
			copyCatalogTool({
				...row(),
				id: `row-${i}`,
				toolId: `apps__read_item_${i}`,
			}),
		);
		const ctx = context(tools[0]!, ["mcp:apps.read"]);
		for (const tool of tools) ctx.loadedTools.set(tool.toolId, tool);
		const parse = vi.spyOn(McpNativeDescriptorSchema, "safeParse");
		try {
			const provider = resolveProvider(buildCatalogProvider(ctx, undefined));
			expect(parse).not.toHaveBeenCalled();
			const result = await provider.fns.search!({
				query: "read item",
				limit: 3,
				includeMetadata: true,
			});
			expect(result).toMatchObject({
				results: expect.arrayContaining([
					expect.objectContaining({ native: expect.any(Object) }),
				]),
			});
			expect(parse).toHaveBeenCalledTimes(3);
		} finally {
			parse.mockRestore();
		}
	});
	it("keeps namespace schemas lazy and available to flow validation", () => {
		const source = row();
		const schema = source.inputSchema;
		const read = vi.fn(() => schema);
		Object.defineProperty(source, "inputSchema", { get: read });
		const groups = buildNamespaceGroups(
			context(source),
			undefined,
			{} as CodeModeExecutionRefs,
			new Set(),
		);
		expect(read).not.toHaveBeenCalled();
		expect(
			groups.get("apps")!.schemas.read_item?.inputSchema.properties,
		).toEqual(schema.properties);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("enumerates 16k bindings and legacy aliases without building executable namespaces", () => {
		const policyReads = new Map<string, number>();
		const tools = Array.from({ length: 16_000 }, (_, i) => {
			const namespace = `org_${i % 100}`;
			const tool = {
				...row(),
				toolId: `${namespace}__read_${i}`,
				config: {
					transport: "rpc",
					endpoint: "apps/get",
					_aggregateNamespace: namespace,
					_aggregateLegacyNamespace: `legacy_${i % 10}`,
				},
			} as AppTool;
			Object.defineProperty(tool, "meta", {
				get: () => {
					policyReads.set(namespace, (policyReads.get(namespace) ?? 0) + 1);
					return null;
				},
			});
			return tool;
		});
		const ctx = context(tools[0]!);
		ctx.loadedTools.clear();
		for (const tool of tools) ctx.loadedTools.set(tool.toolId, tool);
		const groups = buildLazyNamespaceGroups(
			ctx,
			undefined,
			{} as CodeModeExecutionRefs,
			new Set(),
		);
		const providers = withLegacyNamespaceAliases(
			buildProviders(groups),
			legacyNamespaceAliases(ctx, undefined, groups, new Set()),
		);
		expect(
			providers.reduce(
				(n, provider) => n + Object.keys(provider.fns).length,
				0,
			),
		).toBe(32_000);
		expect(policyReads.size).toBe(0);
		const selected = providers.find((provider) => provider.name === "org_2")!;
		expect(Object.entries(selected.fns)).toHaveLength(160);
		// The error transport remains lazy too: SDK registration wraps only the
		// selected provider, and the original namespace is built on first dispatch.
		expect(policyReads.size).toBe(0);
		const original = groups.get("org_2")!.fns.read_2;
		expect(typeof original).toBe("function");
		expect([...policyReads.keys()]).toEqual(["org_2"]);
		expect(policyReads.get("org_2")).toBe(160);
	});
	it("defers error preludes and preserves ambiguous and shadowed legacy aliases", () => {
		const make = (namespace: string, name: string) =>
			({
				...row(),
				toolId: `${namespace}__${name}`,
				config: {
					transport: "rpc",
					endpoint: "apps/get",
					_aggregateNamespace: namespace,
					_aggregateLegacyNamespace: "legacy",
				},
			}) as AppTool;
		const tools = [
			make("a", "ambiguous"),
			make("b", "ambiguous"),
			make("a", "shadowed"),
			make("legacy", "shadowed"),
			make("a", "unique"),
		];
		const ctx = context(tools[0]!);
		ctx.loadedTools.clear();
		for (const tool of tools) ctx.loadedTools.set(tool.toolId, tool);
		const groups = buildLazyNamespaceGroups(
			ctx,
			undefined,
			{} as CodeModeExecutionRefs,
			new Set(),
		);
		const stringify = vi.spyOn(JSON, "stringify");
		try {
			const providers = withLegacyNamespaceAliases(
				buildProviders(groups),
				legacyNamespaceAliases(ctx, undefined, groups, new Set()),
			);
			expect(stringify).not.toHaveBeenCalled();
			const legacy = providers.find((provider) => provider.name === "legacy")!;
			expect(Object.keys(legacy.fns).sort()).toEqual(["shadowed", "unique"]);
			expect(legacy.prelude).toContain('"shadowed"');
			expect(stringify).toHaveBeenCalled();
			expect(
				legacyNamespaceAliases(ctx, undefined, groups, new Set()).get("legacy")
					?.unique,
			).toBe(groups.get("a")!.fns.unique);
		} finally {
			stringify.mockRestore();
		}
	});
});
