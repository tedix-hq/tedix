import { describe, expect, it } from "vite-plus/test";
import { MCP_NATIVE_CATALOG_META_KEY } from "@tedix/api-contract/schemas/mcp-native-transport";
import { TedixMcpRuntime } from "./runtime";
import type { McpToolInfo } from "./types";

function searchTool(
	name = "search_native_tools",
): Pick<McpToolInfo, "name" | "meta"> {
	return {
		name,
		meta: {
			[MCP_NATIVE_CATALOG_META_KEY]: {
				version: 1,
				bootstrapTool: "get_info",
				endpoint: "catalog/search",
			},
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
		searchTool(),
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
	it("matches the legacy array using the actual native envelope, preserving denied and skill rows", async () => {
		const rows = [
			{
				callable: "docs.read",
				authorized: true,
			},
			{
				callable: "docs.write",
				authorized: false,
				missingScopes: ["docs:write"],
			},
			{
				kind: "skill",
				uri: "skill://example/SKILL.md",
				load: 'skills.get({ slug: "example" })',
			},
		];
		const native = fixture(() => ({
			structuredContent: {
				results: rows.map((row) => ({
					...row,
					schemaFreshness: {},
					wire: {},
					native: {},
					_match: {},
				})),
				namespaces: { docs: {} },
				meta: { pagination: { total: 3 } },
				appCapabilities: {},
				_detailTemplate: "catalog detail",
			},
			content: [{ type: "text", text: "Structured content takes precedence" }],
		}));
		const legacy = fixture(
			() => ({
				structuredContent: { executionId: "exec", result: rows },
				content: [],
			}),
			[{ name: "code" }],
		);
		expect(
			await native.search({
				query: " read records ",
				limit: 99,
				includeParameters: true,
			}),
		).toEqual(await legacy.search());
		expect(await native.search()).toEqual(rows);
		expect(native.calls.map(({ name }) => name)).toEqual([
			"search_native_tools",
			"search_native_tools",
		]);
		expect(
			native.calls.every(({ server }) => server === "fictional-unified"),
		).toBe(true);
		expect(native.calls[0]?.args).toEqual({
			query: "read records",
			limit: 25,
			includeParameters: true,
			includeMetadata: false,
		});
		expect(native.calls[0]?.options.signal).toBeInstanceOf(AbortSignal);
		expect(native.calls[0]?.options.onTaskInputRequired).toBeTypeOf("function");
		expect(native.events.map(({ kind }) => kind)).toEqual([
			"tool.started",
			"tool.completed",
			"tool.started",
			"tool.completed",
		]);
		expect(
			native.events.every(
				({ payload }) => payload.name === "tedix_mcp_search_tools",
			),
		).toBe(true);
	});

	it("uses current inventory names on the same server without a bootstrap request", async () => {
		const tools = [{ name: "code" }, searchTool("find_1")];
		const f = fixture(
			() => ({ structuredContent: { results: [] }, content: [] }),
			tools,
		);
		await f.search();
		tools[1] = searchTool("find_2");
		await f.search();
		expect(f.calls.map(({ name }) => name)).toEqual(["find_1", "find_2"]);
	});

	it("applies compact descriptions and explicit schema selection to verbose native rows", async () => {
		const f = fixture(() => ({
			structuredContent: {
				results: [
					{
						callable: "docs.read",
						description: `${"word ".repeat(100)}\n\nPaid tool: use credits`,
						parameters: { type: "object" },
						outputSchema: { type: "string" },
						annotations: { readOnlyHint: true },
						_meta: { source: "docs" },
					},
				],
			},
			content: [],
		}));
		const compact = (await f.search()) as Record<string, unknown>[];
		expect(compact[0]).toMatchObject({
			descriptionTruncated: true,
			annotations: { readOnlyHint: true },
			_meta: { source: "docs" },
		});
		expect(compact[0]?.description).toContain("Paid tool: use credits");
		expect(compact[0]?.parameters).toBeUndefined();
		expect(compact[0]?.outputSchema).toBeUndefined();
		const withParameters = (await f.search({
			query: "read",
			includeParameters: true,
		})) as Record<string, unknown>[];
		expect(withParameters[0]?.parameters).toEqual({ type: "object" });
		expect(withParameters[0]?.outputSchema).toBeUndefined();
	});

	it("keeps unmarked providers on Code Mode even if they advertise get_info", async () => {
		const f = fixture(
			({ name }) => {
				if (name !== "code") throw new Error("Unsupported tool");
				return {
					structuredContent: { executionId: "exec", result: [] },
					content: [],
				};
			},
			[{ name: "code" }, { name: "get_info" }],
		);
		expect(await f.search()).toEqual([]);
		expect(f.calls.map(({ name }) => name)).toEqual(["code"]);
	});

	it.each([
		{ version: 2, bootstrapTool: "get_info", endpoint: "catalog/search" },
		{ version: 1, bootstrapTool: "run_code", endpoint: "catalog/search" },
		{ version: 1, bootstrapTool: "get_info", endpoint: "workItems/create" },
	])(
		"refuses an unsupported marker %j without dispatch or Code Mode fallback",
		async (marker) => {
			const f = fixture(() => {
				throw new Error("Unexpected dispatch");
			}, [
				{ name: "code" },
				{ name: "find", meta: { [MCP_NATIVE_CATALOG_META_KEY]: marker } },
			]);
			await expect(f.search()).rejects.toThrow();
			expect(f.calls).toEqual([]);
		},
	);

	it.each([
		{ tools: [searchTool("find_1"), searchTool("find_2")] },
		{ tools: [searchTool("find"), { name: "find" }] },
	])(
		"refuses ambiguous advertised routes without dispatch",
		async ({ tools }) => {
			const f = fixture(() => {
				throw new Error("Unexpected dispatch");
			}, [{ name: "code" }, ...tools]);
			await expect(f.search()).rejects.toThrow("ambiguous");
			expect(f.calls).toEqual([]);
		},
	);

	it("rechecks authorization at dispatch after a previously permitted search", async () => {
		let authorized = true;
		const f = fixture(() =>
			authorized
				? { structuredContent: { results: [] }, content: [] }
				: {
						isError: true,
						content: [{ type: "text", text: "Permission revoked" }],
					},
		);
		await f.search();
		authorized = false;
		await expect(f.search()).rejects.toThrow("Permission revoked");
		expect(f.calls.map(({ name }) => name)).toEqual([
			"search_native_tools",
			"search_native_tools",
		]);
		expect(f.events.at(-1)?.kind).toBe("tool.failed");
	});

	it.each([{}, { results: "invalid" }, { results: ["invalid"] }])(
		"refuses malformed native output %j without Code Mode fallback",
		async (value) => {
			const f = fixture(() => ({ structuredContent: value, content: [] }));
			await expect(f.search()).rejects.toThrow();
			expect(f.calls.map(({ name }) => name)).toEqual(["search_native_tools"]);
		},
	);

	it("propagates cancellation without a Code Mode fallback", async () => {
		const abort = new AbortController();
		const f = fixture(({ options }) => {
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
		expect(f.calls.map(({ name }) => name)).toEqual(["search_native_tools"]);
	});

	it("keeps authored JavaScript results and isolated dispatch unchanged", async () => {
		const result = {
			results: [{ arbitrary: true }],
			namespaces: { keep: true },
		};
		const f = fixture(() => ({
			structuredContent: { executionId: "exec", result },
			content: [],
		}));
		const code =
			"async () => { globalThis.privateState = true; return { results: [] }; }";
		expect(await f.runtime.executeTool("tedix_mcp_code", { code })).toEqual(
			result,
		);
		expect(f.calls.map(({ name, args }) => ({ name, args }))).toEqual([
			{ name: "code", args: { code } },
		]);
	});
});
