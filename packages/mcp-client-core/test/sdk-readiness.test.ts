import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "../src/client-manager";
const config = {
	url: "https://sdk.mcp.tedix.dev/mcp",
	headers: { Authorization: "Bearer fixture" },
};
const response = (id: unknown, result: object) =>
	new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id,
			result: { resultType: "complete", ...result },
		}),
		{ headers: { "Content-Type": "application/json" } },
	);
afterEach(() => vi.unstubAllGlobals());
describe("official SDK request-only readiness", () => {
	it("connects and calls tools without optional discovery, preserving pagination and trace", async () => {
		const methods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const request = JSON.parse(init.body);
				methods.push(request.method);
				expect(new Headers(init.headers).get("authorization")).toBe(
					"Bearer fixture",
				);
				expect(new Headers(init.headers).get("traceparent")).toBeTruthy();
				if (request.method === "server/discover")
					return response(request.id, {
						supportedVersions: ["2026-07-28"],
						capabilities: {
							tools: {},
							resources: {},
							prompts: {},
							extensions: { "io.modelcontextprotocol/skills": {} },
						},
					});
				if (request.method === "tools/list")
					return response(request.id, {
						ttlMs: 0,
						cacheScope: "private",
						tools: [
							{
								name: request.params.cursor ? "second" : "code",
								inputSchema: { type: "object" },
							},
						],
						...(request.params.cursor ? {} : { nextCursor: "page2" }),
					});
				if (request.method === "tools/call")
					return response(request.id, {
						content: [{ type: "text", text: "ok" }],
					});
				throw new Error(
					`Optional discovery must not block readiness: ${request.method}`,
				);
			}),
		);
		const manager = new McpClientManager(5, {
			deferOptionalDiscovery: true,
			traceContext: () => ({ traceId: "0123456789abcdef0123456789abcdef" }),
		});
		try {
			await manager.connect("sdk", config);
			expect(manager.listTools("sdk").map((t) => t.name)).toEqual([
				"code",
				"second",
			]);
			expect(await manager.callTool("sdk", "code", {})).toMatchObject({
				content: [{ text: "ok" }],
			});
			expect(methods).toEqual([
				"server/discover",
				"tools/list",
				"tools/list",
				"tools/call",
			]);
		} finally {
			await manager.disconnectAll();
		}
	});
	it("aborts required discovery and never publishes a timed-out connection", async () => {
		let aborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const request = JSON.parse(init.body);
				if (request.method === "server/discover")
					return response(request.id, {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					});
				return new Promise<Response>((resolve) =>
					init.signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve(
								response(request.id, {
									ttlMs: 0,
									cacheScope: "private",
									tools: [],
								}),
							);
						},
						{ once: true },
					),
				);
			}),
		);
		const manager = new McpClientManager(5, { deferOptionalDiscovery: true });
		await expect(
			manager.connect("sdk", config, { signal: AbortSignal.timeout(30) }),
		).rejects.toThrow();
		expect(aborted).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(manager.listConnections()).toEqual([]);
	});
	it("passes tool cancellation into SDK HTTP requests", async () => {
		let aborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const request = JSON.parse(init.body);
				if (request.method === "server/discover")
					return response(request.id, {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					});
				if (request.method === "tools/list")
					return response(request.id, {
						ttlMs: 0,
						cacheScope: "private",
						tools: [{ name: "code", inputSchema: { type: "object" } }],
					});
				return new Promise<Response>((_resolve, reject) =>
					init.signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new DOMException("aborted", "AbortError"));
						},
						{ once: true },
					),
				);
			}),
		);
		const manager = new McpClientManager(5, { deferOptionalDiscovery: true });
		try {
			await manager.connect("sdk", config);
			await expect(
				manager.callTool(
					"sdk",
					"code",
					{},
					{ signal: AbortSignal.timeout(30) },
				),
			).rejects.toThrow();
			expect(aborted).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	});
	it("aborts the SDK initial discovery probe", async () => {
		let aborted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async (_url, init) =>
					new Promise<Response>((_resolve, reject) => {
						init.signal.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(new DOMException("aborted", "AbortError"));
							},
							{ once: true },
						);
					}),
			),
		);
		const manager = new McpClientManager(5, { deferOptionalDiscovery: true });
		await expect(
			manager.connect("sdk", config, { signal: AbortSignal.timeout(30) }),
		).rejects.toThrow();
		expect(aborted).toBe(true);
		expect(manager.listConnections()).toEqual([]);
	});
	it("keeps the network guard on SDK requests", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const manager = new McpClientManager(5, { deferOptionalDiscovery: true });
		await expect(
			manager.connect("sdk", { url: "https://127.0.0.1/mcp" }),
		).rejects.toThrow();
		expect(fetch).not.toHaveBeenCalled();
		expect(manager.listConnections()).toEqual([]);
	});
});

describe("invocation context through auth and transport recovery", () => {
	it("keeps the original resolver through reconnect, fresh client and stateless fallback", async () => {
		const manager = new McpClientManager();
		const shared = vi.fn();
		const original = vi.fn(async () => ({ answer: "original" }));
		const connection = {
			config: { url: "https://peer.example/mcp", onTaskInputRequired: shared },
			info: { serverId: "srv" },
			tools: [{ name: "code", annotations: { readOnlyHint: true } }],
		};
		const internals = manager as unknown as {
			connections: Map<string, unknown>;
			reconnect: () => Promise<typeof connection>;
			callToolOnConnectionWithAuthResultCheck: (
				conn: typeof connection,
			) => Promise<unknown>;
			callToolWithFreshClient: (conn: typeof connection) => Promise<unknown>;
			callToolWithStatelessPost: (conn: typeof connection) => Promise<unknown>;
		};
		internals.connections.set("srv", connection);
		const resolvers: unknown[] = [];
		let attempts = 0;
		internals.callToolOnConnectionWithAuthResultCheck = async (conn) => {
			resolvers.push(conn.config.onTaskInputRequired);
			attempts++;
			throw new Error(attempts === 1 ? "unauthorized" : "transport closed");
		};
		internals.reconnect = async () => ({
			...connection,
			config: { ...connection.config, onTaskInputRequired: shared },
		});
		internals.callToolWithFreshClient = async (conn) => {
			resolvers.push(conn.config.onTaskInputRequired);
			throw new Error("transport closed");
		};
		internals.callToolWithStatelessPost = async (conn) => {
			resolvers.push(conn.config.onTaskInputRequired);
			return conn.config.onTaskInputRequired({ taskId: "", inputRequests: {} });
		};
		expect(
			await manager.callTool(
				"srv",
				"code",
				{},
				{ onTaskInputRequired: original },
			),
		).toEqual({ answer: "original" });
		expect(resolvers).toHaveLength(4);
		expect(new Set(resolvers).size).toBe(1);
		expect(original).toHaveBeenCalledTimes(1);
		expect(shared).not.toHaveBeenCalled();
		expect(connection.config.onTaskInputRequired).toBe(shared);
	});
});
