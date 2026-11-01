import { describe, expect, it } from "vite-plus/test";
import { MCP_NATIVE_CATALOG_META_KEY } from "@tedix/api-contract/schemas/mcp-native-transport";
import { TedixMcpRuntime } from "./runtime";
import type { McpToolInfo } from "./types";

function bootstrap(name = "find_tools") {
	const descriptor = (name: string, endpoint: string) => ({
		name,
		toolRowId: `row-${name}`,
		endpoint,
		eligible: true,
		authorized: true,
		schemaFreshness: {
			source: null,
			sourceRef: null,
			sourceHash: null,
			syncedAt: null,
		},
	});
	return {
		nativeContext: {
			version: 1,
			surface: "mcp-gateway",
			appId: "fictional-app",
			appSlug: "fictional",
			organizationId: "fictional-org",
			actor: { authType: "tedi" },
			nativeTransportAvailable: true,
		},
		nativeCatalog: {
			status: "usable",
			search: descriptor(name, "catalog/search"),
			describe: descriptor("describe_tool", "catalog/describe"),
		},
	};
}

type Call = {
	server: string;
	name: string;
	args: Record<string, unknown>;
	options: { signal?: AbortSignal; onTaskInputRequired?: unknown };
};

function fixture(
	reply: (call: Call) => unknown | Promise<unknown>,
	tools: Pick<McpToolInfo, "name" | "meta">[] = [
		{ name: "code" },
		{ name: "get_info" },
	],
) {
	const calls: Call[] = [];
	const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
	const runtime = new TedixMcpRuntime({
		manager: {
			listConnections: () => [
				{ serverId: "tedix-unified" },
				{ serverId: "fictional-unified" },
			],
			listTools: () => tools,
			callTool: async (
				server: string,
				name: string,
				args: Record<string, unknown>,
				options: Call["options"],
			) => {
				const call = { server, name, args, options };
				calls.push(call);
				return reply(call);
			},
		} as never,
		platform: {
			listServers: async () => [],
			resolveCredentials: async () => ({ headers: {} }),
			recordToolEvent: async (event) => {
				events.push(event);
			},
		},
	});
	runtime.ensureSynced = async () => {};
	const search = (args: Record<string, unknown> = { query: "read records" }) =>
		runtime.executeTool("tedix_mcp_search_tools", args, {
			binding: { conversationId: "conversation", runId: "run" },
			resultAudience: "machine",
		});
	return { runtime, calls, events, search };
}

describe("native runtime tool search", () => {
	it("discovers the bootstrap from a marked catalog tool when get_info is unlisted", async () => {
		const f = fixture(
			({ name }) => ({
				structuredContent:
					name === "get_info"
						? bootstrap("search_native_tools")
						: { results: [] },
				content: [],
			}),
			[
				{ name: "code" },
				{
					name: "search_native_tools",
					meta: {
						[MCP_NATIVE_CATALOG_META_KEY]: {
							version: 1,
							bootstrapTool: "get_info",
							endpoint: "catalog/search",
						},
					},
				},
			],
		);
		expect(await f.search()).toEqual({ results: [] });
		expect(f.calls.map(({ name }) => name)).toEqual([
			"get_info",
			"search_native_tools",
		]);
	});

	it.each([
		{ version: 2, bootstrapTool: "get_info", endpoint: "catalog/search" },
		{ version: 1, bootstrapTool: "run_code", endpoint: "catalog/search" },
		{ version: 1, bootstrapTool: "get_info", endpoint: "workItems/create" },
	])(
		"does not probe a bootstrap advertised by an unsupported marker %j",
		async (marker) => {
			const f = fixture(
				() => ({
					structuredContent: { executionId: "exec", result: { results: [] } },
					content: [],
				}),
				[
					{ name: "code" },
					{
						name: "search_native_tools",
						meta: { [MCP_NATIVE_CATALOG_META_KEY]: marker },
					},
				],
			);
			expect(await f.search()).toEqual({ results: [] });
			expect(f.calls.map(({ name }) => name)).toEqual(["code"]);
		},
	);

	it("keeps code-only providers working without probing an unsupported bootstrap", async () => {
		const f = fixture(
			({ name }) => {
				if (name !== "code") throw new Error("Unsupported tool");
				return {
					structuredContent: { executionId: "exec", result: { results: [] } },
					content: [],
				};
			},
			[{ name: "code" }],
		);
		expect(await f.search()).toEqual({ results: [] });
		expect(f.calls.map(({ name }) => name)).toEqual(["code"]);
	});

	it("uses fresh same-server descriptors and keeps search results and ledger events", async () => {
		let revision = 0;
		const result = {
			results: [{ callable: "docs.read", authorized: true }],
			meta: {},
		};
		const f = fixture(({ name }) => ({
			structuredContent:
				name === "get_info" ? bootstrap(`find_${++revision}`) : result,
			content: [],
		}));
		for (let i = 0; i < 2; i++)
			expect(
				await f.search({
					query: " read records ",
					limit: 99,
					includeParameters: true,
				}),
			).toEqual(result);
		expect(f.calls.map(({ name }) => name)).toEqual([
			"get_info",
			"find_1",
			"get_info",
			"find_2",
		]);
		expect(f.calls.every(({ server }) => server === "fictional-unified")).toBe(
			true,
		);
		expect(f.calls[1]?.args).toEqual({
			query: "read records",
			limit: 25,
			includeParameters: true,
			includeMetadata: false,
		});
		expect(f.calls[0]?.options.signal).toBe(f.calls[1]?.options.signal);
		expect(f.calls[0]?.options.onTaskInputRequired).toBe(
			f.calls[1]?.options.onTaskInputRequired,
		);
		expect(f.events.map(({ kind }) => kind)).toEqual([
			"tool.started",
			"tool.completed",
			"tool.started",
			"tool.completed",
		]);
		expect(
			f.events.every(
				({ payload }) => payload.name === "tedix_mcp_search_tools",
			),
		).toBe(true);
	});

	it("uses Code Mode on the same server only for an explicitly unavailable catalog", async () => {
		const f = fixture(({ name }) => ({
			structuredContent:
				name === "get_info"
					? {
							nativeContext: null,
							nativeCatalog: {
								status: "unavailable",
								search: null,
								describe: null,
							},
						}
					: { executionId: "exec", result: { results: [] } },
			content: [],
		}));
		expect(await f.search()).toEqual({ results: [] });
		expect(f.calls.map(({ name }) => name)).toEqual(["get_info", "code"]);
		expect(f.calls.every(({ server }) => server === "fictional-unified")).toBe(
			true,
		);
	});

	it.each(["get_info", "find_tools"])(
		"does not retry %s authorization refusal through Code Mode",
		async (denied) => {
			const f = fixture(({ name }) =>
				name === denied
					? {
							isError: true,
							content: [{ type: "text", text: "Permission denied" }],
						}
					: { structuredContent: bootstrap(), content: [] },
			);
			await expect(f.search()).rejects.toThrow("Permission denied");
			expect(f.calls.some(({ name }) => name === "code")).toBe(false);
			expect(f.events.at(-1)?.kind).toBe("tool.failed");
		},
	);

	it.each(["malformed", "endpoint", "unauthorized"])(
		"rejects a %s native bootstrap without execution",
		async (kind) => {
			const info = bootstrap();
			if (kind === "endpoint")
				info.nativeCatalog.search.endpoint = "workItems/create";
			if (kind === "unauthorized") info.nativeCatalog.search.authorized = false;
			const f = fixture(() => ({
				structuredContent: kind === "malformed" ? {} : info,
				content: [],
			}));
			await expect(f.search()).rejects.toThrow();
			expect(f.calls.map(({ name }) => name)).toEqual(["get_info"]);
		},
	);

	it("propagates cancellation without a Code Mode fallback", async () => {
		const abort = new AbortController();
		const f = fixture(({ name, options }) => {
			if (name === "get_info")
				return { structuredContent: bootstrap(), content: [] };
			abort.abort(new Error("Search canceled"));
			options.signal?.throwIfAborted();
		});
		await expect(
			f.runtime.executeTool(
				"tedix_mcp_search_tools",
				{ query: "records" },
				{ signal: abort.signal },
			),
		).rejects.toThrow("Search canceled");
		expect(f.calls.map(({ name }) => name)).toEqual(["get_info", "find_tools"]);
	});

	it("keeps authored JavaScript on the isolated Code Mode path", async () => {
		const f = fixture(() => ({
			structuredContent: { executionId: "exec", result: 7 },
			content: [],
		}));
		const code = "async () => { globalThis.privateState = true; return 7; }";
		expect(await f.runtime.executeTool("tedix_mcp_code", { code })).toBe(7);
		expect(f.calls.map(({ name, args }) => ({ name, args }))).toEqual([
			{ name: "code", args: { code } },
		]);
	});
});
