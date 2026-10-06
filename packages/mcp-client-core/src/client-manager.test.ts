import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "./client-manager.js";
import type { McpServerConfig } from "./types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("McpClientManager trace context", () => {
	it("propagates Tedix run metadata in MCP request _meta", async () => {
		const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: unknown;
				method?: string;
			};
			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					},
				});
			}
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
				},
			});
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const manager = new McpClientManager(1, {
			traceContext: () => ({
				traceId: "4bf92f35-77b3-4da6-a3ce-929d0e0e4736",
				metadata: {
					"io.tedix/conversationId": "cto:agent:main:main",
					"io.tedix/kernelRunId": "child-run-1",
					"io.tedix/workItemId": "work-item-1",
				},
			}),
		});
		const rawMcpPost = (
			manager as unknown as {
				rawMcpPost: (
					config: McpServerConfig,
					method: string,
					params?: Record<string, unknown>,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);

		await rawMcpPost(
			{
				url: "https://tedix.mcp.tedix.dev/mcp",
				transport: "streamable-http",
			},
			"tools/call",
			{ name: "code", arguments: { code: "async () => 1" } },
		);

		const [, callInit] = fetchMock.mock.calls[1] as [unknown, RequestInit];
		const callBody = JSON.parse(String(callInit.body)) as {
			params: { _meta?: Record<string, unknown> };
		};
		expect(callBody.params._meta).toMatchObject({
			"io.tedix/conversationId": "cto:agent:main:main",
			"io.tedix/kernelRunId": "child-run-1",
			"io.tedix/workItemId": "work-item-1",
		});
		expect(callBody.params._meta?.traceparent).toMatch(
			/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
		);
	});
});

describe("McpClientManager SSRF containment", () => {
	it("does not let a configured endpoint reach another Tedix internal host", async () => {
		const fetchMock = vi.fn(async () => Response.json({ ok: true }));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const manager = new McpClientManager();
		const rawMcpPost = (
			manager as unknown as {
				rawMcpPost: (
					config: McpServerConfig,
					method: string,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);

		await expect(
			rawMcpPost(
				{ url: "https://api.tedix.dev/internal", transport: "streamable-http" },
				"tools/list",
			),
		).rejects.toThrow("Blocked host");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("private provider proof transport", () => {
	it("keeps concurrent proofs in per-call metadata, never connection headers or arguments", async () => {
		const manager = new McpClientManager();
		const internal = manager as unknown as {
			connections: Map<string, unknown>;
			rawMcpPost: (
				config: McpServerConfig,
				method: string,
				params: Record<string, unknown>,
			) => Promise<unknown>;
		};
		const config = {
			url: "https://provider.mcp.tedix.dev/mcp",
			transport: "streamable-http" as const,
		};
		internal.connections.set("provider", {
			config,
			info: { serverId: "provider" },
			mode: "stateless",
			tools: [{ name: "code" }],
		});
		const requests: Record<string, unknown>[] = [];
		vi.spyOn(internal, "rawMcpPost").mockImplementation(
			async (_config, _method, params) => {
				requests.push(params);
				await Promise.resolve();
				return { content: [{ type: "text", text: "ok" }] };
			},
		);
		await Promise.all(
			["proof-one", "proof-two"].map((embeddedSessionToken) =>
				manager.callTool(
					"provider",
					"code",
					{ code: "async () => 1" },
					{ embeddedSessionToken },
				),
			),
		);
		await manager.callTool("provider", "code", { code: "async () => 2" });
		expect(requests.map((request) => request._meta)).toEqual([
			{ "tedix/embedded-session": "proof-one" },
			{ "tedix/embedded-session": "proof-two" },
			undefined,
		]);
		expect(
			JSON.stringify(requests.map((request) => request.arguments)),
		).not.toContain("proof-");
		expect(JSON.stringify(config)).not.toContain("proof-");
	});
});

describe("SDK output schema refresh", () => {
	it("refreshes the cached tools after validation failure without replaying the action", async () => {
		const { ProtocolError, ProtocolErrorCode } =
			await import("@modelcontextprotocol/client");
		const failure = new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			"Structured content does not match the tool's output schema: additionalProperties",
		);
		const callTool = vi
			.fn()
			.mockRejectedValueOnce(failure)
			.mockResolvedValue({ content: [] });
		const nextTools = [
			{
				name: "get_item",
				inputSchema: { type: "object" },
				outputSchema: {
					type: "object",
					properties: { tags: { type: "array" } },
				},
			},
		];
		const listTools = vi.fn().mockResolvedValue({ tools: nextTools });
		const manager = new McpClientManager(1, { deferOptionalDiscovery: true });
		const internal = manager as unknown as {
			connections: Map<string, unknown>;
		};
		internal.connections.set("provider", {
			mode: "sdk",
			info: { serverId: "provider" },
			config: { url: "https://provider.example/mcp" },
			tools: [{ name: "get_item", inputSchema: { type: "object" } }],
			resources: [],
			resourceTemplates: [],
			prompts: [],
			guidance: [],
			client: {
				callTool,
				listTools,
				getServerCapabilities: () => ({ tools: {} }),
			},
		});
		await expect(manager.callTool("provider", "get_item", {})).rejects.toBe(
			failure,
		);
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(listTools).toHaveBeenCalledWith(undefined, { cacheMode: "refresh" });
		expect(manager.listTools("provider")[0]?.outputSchema).toEqual(
			nextTools[0]!.outputSchema,
		);
		await manager.callTool("provider", "get_item", {});
		expect(callTool).toHaveBeenCalledTimes(2);
	});

	it("does not refresh or replay ordinary invalid input", async () => {
		const { ProtocolError, ProtocolErrorCode } =
			await import("@modelcontextprotocol/client");
		const failure = new ProtocolError(
			ProtocolErrorCode.InvalidParams,
			"Invalid tool arguments",
		);
		const manager = new McpClientManager();
		const refresh = vi.spyOn(manager, "refreshConnection");
		const callTool = vi.fn().mockRejectedValue(failure);
		(
			manager as unknown as { connections: Map<string, unknown> }
		).connections.set("provider", {
			mode: "sdk",
			info: { serverId: "provider" },
			config: { url: "https://provider.example/mcp" },
			tools: [],
			client: { callTool },
		});
		await expect(manager.callTool("provider", "get_item", {})).rejects.toBe(
			failure,
		);
		expect(refresh).not.toHaveBeenCalled();
		expect(callTool).toHaveBeenCalledTimes(1);
	});
});
