/**
 * Completions (2026-07-28 `completion/complete`) exposed to the MODEL as the
 * `mcp_complete_argument` tool. The model deliberately resolves a reference
 * argument (e.g. a `session_key`) BEFORE invoking the target tool; the runtime
 * never rewrites call arguments behind the model's back. Servers that do not
 * advertise the `completions` capability short-circuit to a structured no-op.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type {
	McpClientManager,
	McpCompletionRef,
	McpCompletionResult,
} from "../src/client-manager";
import { McpClientManager as RealManager } from "../src/client-manager";
import { TedixMcpRuntime } from "../src/runtime";
import type { McpServerConfig } from "../src/types";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

interface CompleteCall {
	serverId: string;
	ref: McpCompletionRef;
	argument: { name: string; value: string };
	context?: { arguments?: Record<string, string> };
}

function stubManager(opts: {
	supports: boolean;
	complete: (call: CompleteCall) => McpCompletionResult;
	calls: CompleteCall[];
}): McpClientManager {
	return {
		serverSupportsCompletions: () => opts.supports,
		complete: async (
			serverId: string,
			ref: McpCompletionRef,
			argument: { name: string; value: string },
			context?: { arguments?: Record<string, string> },
		) => {
			const call: CompleteCall = { serverId, ref, argument, context };
			opts.calls.push(call);
			return opts.complete(call);
		},
		listConnections: () => [],
	} as unknown as McpClientManager;
}

function makeRuntime(manager: McpClientManager): TedixMcpRuntime {
	return new TedixMcpRuntime({
		manager,
		platform: {
			listServers: async () => [],
			resolveCredentials: async () => ({ headers: {} }),
		},
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("mcp_complete_argument tool", () => {
	it("is advertised in the tool specs with server+argument required", () => {
		const runtime = makeRuntime(
			stubManager({
				supports: true,
				complete: () => ({ values: [] }),
				calls: [],
			}),
		);
		const spec = runtime
			.getToolSpecs()
			.find((entry) => entry.function.name === "mcp_complete_argument");
		expect(spec).toBeDefined();
		expect(spec?.function.parameters.required).toEqual(["server", "argument"]);
		expect(spec?.function.description).toContain("never guess");
	});

	it("lists session_key candidates for a tedi→tedi call when completions are advertised", async () => {
		const calls: CompleteCall[] = [];
		const runtime = makeRuntime(
			stubManager({
				supports: true,
				complete: () => ({
					values: ["sess_abc", "sess_def"],
					total: 2,
					hasMore: false,
				}),
				calls,
			}),
		);
		const result = await runtime.executeTool("mcp_complete_argument", {
			server: "peer-tedi",
			argument: "session_key",
			partial: "sess_",
			prompt: "resume_session",
			context: { tediId: "tedi_42" },
		});
		expect(result).toEqual({
			supported: true,
			values: ["sess_abc", "sess_def"],
			total: 2,
			hasMore: false,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			serverId: "peer-tedi",
			ref: { type: "ref/prompt", name: "resume_session" },
			argument: { name: "session_key", value: "sess_" },
			context: { arguments: { tediId: "tedi_42" } },
		});
	});

	it("uses a ref/resource ref when a resourceUri is supplied", async () => {
		const calls: CompleteCall[] = [];
		const runtime = makeRuntime(
			stubManager({
				supports: true,
				complete: () => ({ values: ["main"] }),
				calls,
			}),
		);
		const result = (await runtime.executeTool("mcp_complete_argument", {
			server: "peer-tedi",
			argument: "branch",
			resourceUri: "repo://{branch}/tree",
		})) as { values: string[] };
		expect(result.values).toEqual(["main"]);
		expect(calls[0]?.ref).toEqual({
			type: "ref/resource",
			uri: "repo://{branch}/tree",
		});
		// Defaulted ref/prompt name when neither resourceUri nor prompt is given.
		await runtime.executeTool("mcp_complete_argument", {
			server: "peer-tedi",
			argument: "branch",
		});
		expect(calls[1]?.ref).toEqual({
			type: "ref/prompt",
			name: "tool_arguments",
		});
	});

	it("no-ops with a structured result when the target does not advertise completions", async () => {
		const calls: CompleteCall[] = [];
		const runtime = makeRuntime(
			stubManager({
				supports: false,
				complete: () => ({ values: ["never"] }),
				calls,
			}),
		);
		const result = await runtime.executeTool("mcp_complete_argument", {
			server: "legacy-server",
			argument: "session_key",
		});
		expect(result).toMatchObject({ supported: false, values: [] });
		// No round-trip: the model keeps its argument untouched.
		expect(calls).toHaveLength(0);
	});

	it("returns an empty non-error result when the server has no candidates", async () => {
		const calls: CompleteCall[] = [];
		const runtime = makeRuntime(
			stubManager({ supports: true, complete: () => ({ values: [] }), calls }),
		);
		const result = await runtime.executeTool("mcp_complete_argument", {
			server: "peer-tedi",
			argument: "session_key",
			partial: "zzz_",
		});
		expect(result).toEqual({ supported: true, values: [] });
		expect(calls).toHaveLength(1);
	});

	it("rejects calls without a server or argument name", async () => {
		const runtime = makeRuntime(
			stubManager({
				supports: true,
				complete: () => ({ values: [] }),
				calls: [],
			}),
		);
		await expect(
			runtime.executeTool("mcp_complete_argument", { argument: "session_key" }),
		).rejects.toThrow("server is required");
		await expect(
			runtime.executeTool("mcp_complete_argument", { server: "peer-tedi" }),
		).rejects.toThrow("argument is required");
	});
});

describe("manager completions capability detection", () => {
	it("records the completions capability from server/discover for stateless snapshots", async () => {
		const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
			const parsed = JSON.parse(String(init.body)) as { method: string };
			if (parsed.method === "server/discover") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: "d",
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {}, completions: {} },
					},
				});
			}
			if (parsed.method === "tools/list") {
				return jsonResponse({ jsonrpc: "2.0", id: "t", result: { tools: [] } });
			}
			// resources/templates/prompts lists
			return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
		});
		vi.stubGlobal("fetch", fetchMock);

		const config: McpServerConfig = { url: "https://peer.example/mcp" };
		const manager = new RealManager();
		const info = await manager.connectStatelessSnapshot("peer", config);
		expect(info.capabilities?.completions).toBe(true);
		expect(manager.serverSupportsCompletions("peer")).toBe(true);
	});
});
