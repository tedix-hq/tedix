/**
 * Modern (2026-07-28) stateless client protocol emission.
 *
 * Asserts the stateless raw-POST path negotiates via `server/discover` and
 * emits the request-bound headers + `_meta` the modern transport enforces:
 * - `Mcp-Method` / `Mcp-Name` are always sent (legacy servers ignore them).
 * - `MCP-Protocol-Version: 2026-07-28` is sent only when the server advertised
 *   it via discover.
 */
import { type Client, UnauthorizedError } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isAuthRecoveryError, McpClientManager } from "../src/client-manager";
import { createAgentElicitationResolver } from "../src/elicitation-resolver";
import type { McpServerConfig } from "../src/types";

const CONFIG: McpServerConfig = { url: "https://srv.example/mcp" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function discoverBody(versions: string[]) {
	return {
		jsonrpc: "2.0",
		id: "d",
		result: { resultType: "complete", supportedVersions: versions },
	};
}

function toolsCallBody() {
	return {
		jsonrpc: "2.0",
		id: "c",
		result: { content: [{ type: "text", text: "ok" }] },
	};
}

type FetchCall = {
	url: string;
	headers: Record<string, string>;
	body: unknown;
};

function installFetch(versions: string[]): FetchCall[] {
	const calls: FetchCall[] = [];
	const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as { method: string };
		calls.push({
			url: String(_url),
			headers: { ...(init.headers as Record<string, string>) },
			body: JSON.parse(String(init.body)),
		});
		if (body.method === "server/discover")
			return jsonResponse(discoverBody(versions));
		return jsonResponse(toolsCallBody());
	});
	vi.stubGlobal("fetch", fetchMock);
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("mcp-client-core — 2026-07-28 stateless emission", () => {
	it("keys discovery verdicts by URL and resolved header identity", async () => {
		let token = "legacy-token";
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				const headers = { ...(init.headers as Record<string, string>) };
				calls.push({ url: String(_url), headers, body });
				if (body.method === "server/discover") {
					return jsonResponse(
						discoverBody(
							headers.Authorization === "Bearer modern-token"
								? ["2026-07-28"]
								: ["2025-11-25"],
						),
					);
				}
				return jsonResponse(toolsCallBody());
			}),
		);
		const config: McpServerConfig = {
			...CONFIG,
			headerFactory: async () => ({ Authorization: `Bearer ${token}` }),
		};
		const manager = new McpClientManager();
		const rawPost = (
			manager as unknown as {
				rawMcpPost: (
					config: McpServerConfig,
					method: string,
					params?: Record<string, unknown>,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);

		await expect(
			rawPost(config, "tools/call", { name: "legacy" }),
		).rejects.toThrow("server/discover must advertise 2026-07-28");
		token = "modern-token";
		await rawPost(config, "tools/call", { name: "modern" });

		expect(
			calls.filter((call) => call.body.method === "server/discover"),
		).toHaveLength(2);
		const toolCalls = calls.filter((call) => call.body.method === "tools/call");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
	});

	it("retries transient discovery failures after the short negative TTL", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
		let discoveryCalls = 0;
		const requestHeaders: Array<Record<string, string>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover") {
					discoveryCalls += 1;
					return discoveryCalls === 1
						? jsonResponse({ error: "temporarily unavailable" }, 503)
						: jsonResponse(discoverBody(["2026-07-28"]));
				}
				requestHeaders.push({ ...(init.headers as Record<string, string>) });
				return jsonResponse(toolsCallBody());
			}),
		);
		const manager = new McpClientManager();
		const rawPost = (
			manager as unknown as {
				rawMcpPost: (
					config: McpServerConfig,
					method: string,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);

		await expect(rawPost(CONFIG, "tools/list")).rejects.toThrow(
			"server/discover must advertise 2026-07-28",
		);
		await expect(rawPost(CONFIG, "tools/list")).rejects.toThrow(
			"server/discover must advertise 2026-07-28",
		);
		expect(discoveryCalls).toBe(1);
		expect(requestHeaders).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(5_001);
		await rawPost(CONFIG, "tools/list");
		expect(discoveryCalls).toBe(2);
		expect(requestHeaders[0]?.["MCP-Protocol-Version"]).toBe("2026-07-28");
	});

	it("expires completions and extension metadata with the discovery verdict", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
		let discoveryCalls = 0;
		let directoryCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover") {
					discoveryCalls += 1;
					return jsonResponse({
						jsonrpc: "2.0",
						id: "d",
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities:
								discoveryCalls === 1
									? { tools: {} }
									: {
											tools: {},
											completions: {},
											extensions: {
												"io.modelcontextprotocol/skills": {
													directoryRead: true,
												},
											},
										},
						},
					});
				}
				if (body.method === "resources/directory/read") {
					directoryCalls += 1;
					return jsonResponse({ jsonrpc: "2.0", id: "r", result: {} });
				}
				const key =
					body.method === "tools/list"
						? "tools"
						: body.method === "resources/list"
							? "resources"
							: body.method === "resources/templates/list"
								? "resourceTemplates"
								: "prompts";
				return jsonResponse({ jsonrpc: "2.0", id: "l", result: { [key]: [] } });
			}),
		);
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("before", CONFIG);
		expect(manager.serverSupportsCompletions("before")).toBe(false);
		await expect(
			manager.readDirectory("before", "skill://example"),
		).rejects.toThrow("did not declare");

		await manager.connectStatelessSnapshot("cached", CONFIG);
		expect(discoveryCalls).toBe(1);
		await vi.advanceTimersByTimeAsync(60_001);
		await manager.connectStatelessSnapshot("after", CONFIG);

		expect(discoveryCalls).toBe(2);
		expect(manager.serverSupportsCompletions("after")).toBe(true);
		await expect(
			manager.readDirectory("after", "skill://example"),
		).resolves.toEqual({});
		expect(directoryCalls).toBe(1);
	});

	it("bounds a slow optional list so it degrades to [] without gating the snapshot", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		let resourcesResolve: ((r: Response) => void) | undefined;
		let resourcesStarted!: () => void;
		const resourcesRequested = new Promise<void>((resolve) => {
			resourcesStarted = resolve;
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "resources/list") {
					// Never settles within the bound — models the 8-10s aggregate
					// gateway `resources/list` observed live.
					return new Promise<Response>((resolve) => {
						resourcesResolve = resolve;
						resourcesStarted();
					});
				}
				const key =
					body.method === "tools/list"
						? "tools"
						: body.method === "resources/templates/list"
							? "resourceTemplates"
							: "prompts";
				return jsonResponse({
					jsonrpc: "2.0",
					id: "l",
					result: {
						[key]:
							key === "tools"
								? [{ name: "do_thing", inputSchema: { type: "object" } }]
								: [],
					},
				});
			}),
		);
		const manager = new McpClientManager(50, {
			optionalSnapshotListTimeoutMs: 5_000,
		});
		const connectPromise = manager.connectStatelessSnapshot("srv", CONFIG);
		// Start the bound after asynchronous discovery has reached the list request.
		await resourcesRequested;
		// Cross the optional-list bound; the required tools/list already resolved.
		await vi.advanceTimersByTimeAsync(5_001);
		const info = await connectPromise;
		expect(info.capabilities.tools).toBe(true);
		// The slow optional list degraded rather than blocking or throwing.
		expect(info.capabilities.resources).toBe(false);
		expect(manager.listTools("srv").map((tool) => tool.name)).toEqual([
			"do_thing",
		]);
		// Release the dangling upstream promise so it cannot leak into later tests.
		resourcesResolve?.(jsonResponse({ jsonrpc: "2.0", id: "r", result: {} }));
	});

	it("recognizes beta.3 branded SDK auth failures without parsing text", () => {
		expect(isAuthRecoveryError(new UnauthorizedError("opaque"))).toBe(true);
	});

	it("declares the modern version + binding headers when discover advertises it", async () => {
		const calls = installFetch(["2026-07-28", "2025-11-25"]);
		const manager = new McpClientManager();
		await (
			manager as unknown as {
				rawMcpPost: (
					c: McpServerConfig,
					m: string,
					p?: Record<string, unknown>,
				) => Promise<unknown>;
			}
		).rawMcpPost(CONFIG, "tools/call", { name: "echo", arguments: { x: 1 } });

		// First call is discover, second is the tools/call.
		expect(calls[0]?.body).toMatchObject({ method: "server/discover" });
		expect(calls[0]?.headers["Mcp-Method"]).toBe("server/discover");
		const call = calls[1];
		if (!call) throw new Error("Expected tools/call after discovery");
		expect(call.body).toMatchObject({ method: "tools/call" });
		expect(call.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
		expect(call.headers["Mcp-Method"]).toBe("tools/call");
		expect(call.headers["Mcp-Name"]).toBe("echo");
		const meta = (call.body as { params: { _meta: Record<string, unknown> } })
			.params._meta;
		// clientCapabilities is required; Tedix also sends optional clientInfo.
		expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
		expect(meta["io.modelcontextprotocol/clientInfo"]).toMatchObject({
			name: "tedi-mcp-client",
		});
		expect(meta["io.modelcontextprotocol/clientCapabilities"]).toMatchObject({
			extensions: { "io.modelcontextprotocol/tasks": {} },
		});
	});

	it("emits schema-declared Mcp-Param headers for tools/call", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/list")
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result: {
							resultType: "complete",
							tools: [
								{
									name: "execute_sql",
									inputSchema: {
										type: "object",
										properties: {
											region: { type: "string", "x-mcp-header": "Region" },
											query: { type: "string" },
										},
									},
								},
							],
						},
					});
				return jsonResponse(toolsCallBody());
			}),
		);
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("db", CONFIG);
		await manager.callTool("db", "execute_sql", {
			region: "eu-west1",
			query: "select 1",
		});
		const call = calls.find((entry) => entry.body.method === "tools/call");
		expect(call?.headers["Mcp-Param-Region"]).toBe("eu-west1");
	});

	it("refreshes a drifted tool schema and retries HeaderMismatch exactly once", async () => {
		const calls: FetchCall[] = [];
		let toolsListCount = 0;
		let toolsCallCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				const headers = { ...(init.headers as Record<string, string>) };
				calls.push({ url: String(_url), headers, body });
				if (body.method === "server/discover") {
					return jsonResponse(discoverBody(["2026-07-28"]));
				}
				if (body.method === "tools/list") {
					toolsListCount++;
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result: {
							tools: [
								{
									name: "execute_sql",
									inputSchema: {
										type: "object",
										properties: {
											region:
												toolsListCount === 1
													? { type: "string" }
													: {
															type: "string",
															"x-mcp-header": "Region",
														},
										},
									},
								},
							],
						},
					});
				}
				if (body.method.endsWith("/list")) {
					const key = body.method.startsWith("resources/templates")
						? "resourceTemplates"
						: body.method.startsWith("resources")
							? "resources"
							: "prompts";
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result: { [key]: [] },
					});
				}
				if (body.method !== "tools/call") {
					return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
				}
				toolsCallCount++;
				if (toolsCallCount === 1) {
					return jsonResponse(
						{
							jsonrpc: "2.0",
							id: "c1",
							error: { code: -32020, message: "HeaderMismatch" },
						},
						400,
					);
				}
				return jsonResponse(toolsCallBody());
			}),
		);

		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("db", CONFIG);
		await expect(
			manager.callTool("db", "execute_sql", { region: "eu-west1" }),
		).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });

		const toolCalls = calls.filter(
			(entry) => (entry.body as { method?: string }).method === "tools/call",
		);
		expect(toolsListCount).toBe(2);
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]?.headers["Mcp-Param-Region"]).toBeUndefined();
		expect(toolCalls[1]?.headers["Mcp-Param-Region"]).toBe("eu-west1");
	});

	it("base64-encodes unsafe Mcp-Param values", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/list")
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result: {
							resultType: "complete",
							tools: [
								{
									name: "say",
									inputSchema: {
										type: "object",
										properties: {
											greeting: { type: "string", "x-mcp-header": "Greeting" },
										},
									},
								},
							],
						},
					});
				return jsonResponse(toolsCallBody());
			}),
		);
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("say", CONFIG);
		await manager.callTool("say", "say", { greeting: "Hello, 世界" });
		const call = calls.find((entry) => entry.body.method === "tools/call");
		expect(call?.headers["Mcp-Param-Greeting"]).toBe(
			"=?base64?SGVsbG8sIOS4lueVjA==?=",
		);
	});

	it("filters tools with invalid x-mcp-header annotations", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/list")
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result: {
							resultType: "complete",
							tools: [
								{
									name: "invalid",
									inputSchema: {
										type: "object",
										properties: {
											items: {
												type: "array",
												items: { type: "string", "x-mcp-header": "Item" },
											},
										},
									},
								},
							],
						},
					});
				return jsonResponse(toolsCallBody());
			}),
		);
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("bad", CONFIG);
		expect(manager.listTools("bad")).toEqual([]);
	});

	it("propagates active trace context through stateless headers and SEP-414 _meta", async () => {
		const calls = installFetch(["2026-07-28"]);
		const manager = new McpClientManager(50, {
			traceContext: () => ({
				traceId: "11111111-2222-4333-8444-555555555555",
				tracestate: "vendor=1",
			}),
		});
		await (
			manager as unknown as {
				rawMcpPost: (
					c: McpServerConfig,
					m: string,
					p?: Record<string, unknown>,
				) => Promise<unknown>;
			}
		).rawMcpPost(CONFIG, "tools/call", { name: "echo", arguments: {} });

		const call = calls[1];
		if (!call) throw new Error("Expected tools/call after discovery");
		expect(call.headers["X-Trace-Id"]).toBe(
			"11111111-2222-4333-8444-555555555555",
		);
		expect(call.headers.traceparent).toMatch(
			/^00-11111111222243338444555555555555-[0-9a-f]{16}-01$/,
		);
		expect(call.headers.tracestate).toBe("vendor=1");
		const meta = (call.body as { params: { _meta: Record<string, string> } })
			.params._meta;
		expect(meta.traceparent).toBe(call.headers.traceparent);
		expect(meta.tracestate).toBe("vendor=1");
	});

	it("rejects a server that does not advertise the current protocol", async () => {
		const calls = installFetch(["2025-11-25", "2024-11-05"]);
		const manager = new McpClientManager();
		await expect(
			(
				manager as unknown as {
					rawMcpPost: (
						c: McpServerConfig,
						m: string,
						p?: Record<string, unknown>,
					) => Promise<unknown>;
				}
			).rawMcpPost(CONFIG, "tools/call", { name: "echo", arguments: {} }),
		).rejects.toThrow("server/discover must advertise 2026-07-28");
		expect(calls).toHaveLength(1);
	});

	it("caches negotiation so discover runs once per URL", async () => {
		const calls = installFetch(["2026-07-28"]);
		const cacheEvents: Array<Record<string, unknown>> = [];
		const manager = new McpClientManager(50, {
			onDiscoveryCacheEvent: (event) => cacheEvents.push(event),
		});
		const post = (
			manager as unknown as {
				rawMcpPost: (
					c: McpServerConfig,
					m: string,
					p?: Record<string, unknown>,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);
		await post(CONFIG, "tools/call", { name: "a", arguments: {} });
		await post(CONFIG, "resources/read", { uri: "ui://x" });

		const discoverCalls = calls.filter(
			(c) => (c.body as { method: string }).method === "server/discover",
		);
		expect(discoverCalls).toHaveLength(1);
		expect(cacheEvents.map((event) => event.outcome)).toEqual(["miss", "hit"]);
		expect(cacheEvents[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		// resources/read binds Mcp-Name to the uri.
		const readCall = calls.find(
			(c) => (c.body as { method: string }).method === "resources/read",
		);
		expect(readCall?.headers["Mcp-Name"]).toBe("ui://x");
	});

	it("honors private zero-TTL hints and emits stable credential-free digests", async () => {
		let discoveryCalls = 0;
		const cacheEvents: Array<Record<string, unknown>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method !== "server/discover") {
					return jsonResponse(toolsCallBody());
				}
				discoveryCalls += 1;
				const result =
					discoveryCalls === 1
						? {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: {}, resources: {} },
								ttlMs: 0,
								cacheScope: "private",
							}
						: {
								cacheScope: "private",
								ttlMs: 0,
								capabilities: { resources: {}, tools: {} },
								supportedVersions: ["2026-07-28"],
								resultType: "complete",
							};
				return jsonResponse({ jsonrpc: "2.0", id: "d", result });
			}),
		);
		const manager = new McpClientManager(50, {
			onDiscoveryCacheEvent: (event) => cacheEvents.push(event),
		});
		const config: McpServerConfig = {
			url: "https://srv.example/mcp?tenant=secret",
			headers: { Authorization: "Bearer do-not-observe" },
		};
		const post = (
			manager as unknown as {
				rawMcpPost: (
					config: McpServerConfig,
					method: string,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);

		await post(config, "tools/list");
		await post(config, "tools/list");

		expect(discoveryCalls).toBe(2);
		expect(cacheEvents).toHaveLength(2);
		expect(cacheEvents.map((event) => event.ttlMs)).toEqual([0, 0]);
		expect(cacheEvents[0]?.digest).toBe(cacheEvents[1]?.digest);
		expect(cacheEvents[0]?.endpoint).toBe("https://srv.example/mcp");
		expect(JSON.stringify(cacheEvents)).not.toContain("secret");
		expect(JSON.stringify(cacheEvents)).not.toContain("do-not-observe");
	});

	it("keeps discovery negotiation fail-soft when the metrics sink throws", async () => {
		const calls = installFetch(["2026-07-28"]);
		const manager = new McpClientManager(50, {
			onDiscoveryCacheEvent: () => {
				throw new Error("metrics unavailable");
			},
		});
		const post = (
			manager as unknown as {
				rawMcpPost: (
					config: McpServerConfig,
					method: string,
				) => Promise<unknown>;
			}
		).rawMcpPost.bind(manager);

		await expect(post(CONFIG, "tools/list")).resolves.toBeDefined();
		await expect(post(CONFIG, "tools/list")).resolves.toBeDefined();
		expect(
			calls.filter((call) => call.body.method === "server/discover"),
		).toHaveLength(1);
	});

	it("binds resources/directory/read Mcp-Name to the directory URI", async () => {
		const calls = installFetch(["2026-07-28"]);
		const manager = new McpClientManager();
		await (
			manager as unknown as {
				rawMcpPost: (
					c: McpServerConfig,
					m: string,
					p?: Record<string, unknown>,
				) => Promise<unknown>;
			}
		).rawMcpPost(CONFIG, "resources/directory/read", {
			uri: "skill://deploy-review/references",
		});

		const call = calls.find(
			(c) =>
				(c.body as { method: string }).method === "resources/directory/read",
		);
		expect(call?.headers["MCP-Protocol-Version"]).toBe("2026-07-28");
		expect(call?.headers["Mcp-Method"]).toBe("resources/directory/read");
		expect(call?.headers["Mcp-Name"]).toBe("skill://deploy-review/references");
	});

	it("emits schema annotated Mcp-Param headers for stateless tools/call", async () => {
		const calls = installFetch(["2026-07-28"]);
		const manager = new McpClientManager();
		(
			manager as unknown as {
				connections: Map<string, unknown>;
			}
		).connections.set("srv", {
			mode: "stateless",
			config: CONFIG,
			info: { serverId: "srv", url: CONFIG.url },
			tools: [
				{
					serverId: "srv",
					name: "echo",
					inputSchema: {
						type: "object",
						properties: {
							tenant: { type: "string", "x-mcp-header": "Tenant" },
							token: { type: "string", "x-mcp-header": "Auth-Token" },
						},
					},
				},
			],
		});

		await manager.callTool("srv", "echo", {
			tenant: "org_tedix",
			token: "päss",
		});

		const call = calls.find((c) => c.body.method === "tools/call");
		expect(call?.headers["Mcp-Param-Tenant"]).toBe("org_tedix");
		expect(call?.headers["Mcp-Param-Auth-Token"]).toBe("=?base64?cMOkc3M=?=");
	});

	it("filters tools with invalid x-mcp-header annotations from snapshots", async () => {
		const manager = new McpClientManager();
		const out = (
			manager as unknown as {
				mapToolsListResult: (
					serverId: string,
					result: unknown,
				) => Array<{ name: string }>;
			}
		).mapToolsListResult("srv", {
			tools: [
				{
					name: "good",
					inputSchema: {
						type: "object",
						properties: {
							tenant: { type: "string", "x-mcp-header": "Tenant" },
						},
					},
				},
				{
					name: "bad",
					inputSchema: {
						type: "object",
						properties: {
							tenant: { type: "string", "x-mcp-header": "Bad Header" },
						},
					},
				},
				{
					name: "duplicate",
					inputSchema: {
						type: "object",
						properties: {
							a: { type: "string", "x-mcp-header": "Tenant" },
							b: { type: "string", "x-mcp-header": "tenant" },
						},
					},
				},
			],
		});

		expect(out.map((tool) => tool.name)).toEqual(["good"]);
	});

	it("continues stateless list pagination when nextCursor is an empty string", async () => {
		const calls: FetchCall[] = [];
		let listCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as {
					method: string;
					params?: Record<string, unknown>;
				};
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/list") {
					listCalls += 1;
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result:
							listCalls === 1
								? { tools: [{ name: "first" }], nextCursor: "" }
								: { tools: [{ name: "second" }] },
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const manager = new McpClientManager();
		const result = await (
			manager as unknown as {
				rawMcpListAll: (
					c: McpServerConfig,
					m: string,
					k: "tools",
				) => Promise<Record<string, unknown[]>>;
			}
		).rawMcpListAll(CONFIG, "tools/list", "tools");

		expect(result.tools).toEqual([{ name: "first" }, { name: "second" }]);
		const listBodies = calls
			.filter(
				(call) => (call.body as { method: string }).method === "tools/list",
			)
			.map((call) => call.body as { params?: Record<string, unknown> });
		expect(listBodies).toHaveLength(2);
		expect(listBodies[1]?.params?.cursor).toBe("");
	});

	it("stops stateless list pagination on a repeated cursor", async () => {
		let listCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/list") {
					listCalls += 1;
					return jsonResponse({
						jsonrpc: "2.0",
						id: "l",
						result: { tools: [{ name: "same" }], nextCursor: "stuck" },
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const manager = new McpClientManager();
		const result = await (
			manager as unknown as {
				rawMcpListAll: (
					c: McpServerConfig,
					m: string,
					k: "tools",
				) => Promise<Record<string, unknown[]>>;
			}
		).rawMcpListAll(CONFIG, "tools/list", "tools");

		expect(listCalls).toBe(2);
		expect(result.tools).toEqual([{ name: "same" }, { name: "same" }]);
	});
});

describe("mcp-client-core — bounded SDK PriorDiscovery reuse", () => {
	function installSdkFetch(methods: string[]) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				if (init?.method === "DELETE")
					return new Response(null, { status: 200 });
				const body = JSON.parse(String(init?.body ?? "{}")) as {
					id?: string | number;
					method?: string;
				};
				methods.push(body.method ?? "unknown");
				if (body.method === "server/discover") {
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: {} },
						},
					});
				}
				if (body.method === "tools/list") {
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: { resultType: "complete", tools: [] },
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
			}),
		);
	}

	it("skips a second discovery probe during an immediate same-auth reconnect", async () => {
		const methods: string[] = [];
		installSdkFetch(methods);
		const manager = new McpClientManager();
		await manager.connect("modern", {
			...CONFIG,
			headerFactory: async () => ({ Authorization: "Bearer stable-token" }),
		});
		await (
			manager as unknown as {
				reconnect: (serverId: string) => Promise<unknown>;
			}
		).reconnect("modern");
		expect(
			methods.filter((method) => method === "server/discover"),
		).toHaveLength(1);
	});

	it("re-probes when credential invalidation changes the auth context", async () => {
		const methods: string[] = [];
		installSdkFetch(methods);
		let token = "first-token";
		const manager = new McpClientManager();
		await manager.connect("modern", {
			...CONFIG,
			headerFactory: async () => ({ Authorization: `Bearer ${token}` }),
			onCredentialInvalidate: () => {
				token = "rotated-token";
			},
		});
		await (
			manager as unknown as {
				reconnect: (serverId: string) => Promise<unknown>;
			}
		).reconnect("modern");
		expect(
			methods.filter((method) => method === "server/discover"),
		).toHaveLength(2);
	});
});

describe("mcp-client-core — client-side Tasks + MRTR", () => {
	it("uses finalized task notifications to wake a managed Tedix task without another poll", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover") {
					return jsonResponse(discoverBody(["2026-07-28"]));
				}
				if (body.method === "subscriptions/listen") {
					return new Response(
						[
							`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: {} })}`,
							`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tasks", params: { taskId: "task_push", status: "completed", result: { content: [{ type: "text", text: "pushed" }] } } })}`,
							"",
						].join("\n\n"),
						{ headers: { "Content-Type": "text/event-stream" } },
					);
				}
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tasks/get") {
					return jsonResponse({
						jsonrpc: "2.0",
						id: "g",
						result: {
							taskId: "task_push",
							status: "working",
							pollIntervalMs: 1_000,
						},
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const manager = new McpClientManager();
		const out = await (
			manager as unknown as {
				resolveTaskResult: (c: McpServerConfig, r: unknown) => Promise<unknown>;
			}
		).resolveTaskResult(
			{
				url: "https://tenant.mcp.tedix.dev/mcp",
				taskPolling: { maxIntervalMs: 1_000 },
			},
			{ resultType: "task", taskId: "task_push", status: "working" },
		);

		expect(out).toMatchObject({
			content: [{ type: "text", text: "pushed" }],
		});
		expect(
			calls.filter((call) => call.body.method === "tasks/get"),
		).toHaveLength(0);
		expect(
			calls.find((call) => call.body.method === "subscriptions/listen"),
		).toMatchObject({
			headers: {
				"Mcp-Method": "subscriptions/listen",
				"MCP-Protocol-Version": "2026-07-28",
			},
		});
	});

	it("polls tasks/get to completion and returns the terminal result", async () => {
		const calls: FetchCall[] = [];
		let getN = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/call")
					return jsonResponse({
						jsonrpc: "2.0",
						id: "c",
						result: { resultType: "task", taskId: "task_1", status: "working" },
					});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tasks/get") {
					getN += 1;
					const status = getN >= 2 ? "completed" : "working";
					return jsonResponse({
						jsonrpc: "2.0",
						id: "g",
						result: {
							resultType: "complete",
							taskId: "task_1",
							status,
							pollIntervalMs: 0,
							...(status === "completed"
								? { result: { content: [{ type: "text", text: "done" }] } }
								: {}),
						},
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const manager = new McpClientManager();
		const out = await (
			manager as unknown as {
				resolveTaskResult: (c: McpServerConfig, r: unknown) => Promise<unknown>;
			}
		).resolveTaskResult(
			{ url: CONFIG.url, taskPolling: { maxIntervalMs: 0 } },
			{ resultType: "task", taskId: "task_1", status: "working" },
		);

		expect(out).toMatchObject({ content: [{ type: "text", text: "done" }] });
		const getCalls = calls.filter((c) => c.body.method === "tasks/get");
		expect(getCalls).toHaveLength(2);
	});

	it("resolves a resultType:'task' result reached via an sdk-mode connection, not just raw POST", async () => {
		const calls: FetchCall[] = [];
		let getN = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tasks/get") {
					getN += 1;
					const status = getN >= 2 ? "completed" : "working";
					return jsonResponse({
						jsonrpc: "2.0",
						id: "g",
						result: {
							resultType: "complete",
							taskId: "task_sdk",
							status,
							pollIntervalMs: 0,
							...(status === "completed"
								? {
										result: {
											content: [{ type: "text", text: "done via sdk" }],
										},
									}
								: {}),
						},
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const manager = new McpClientManager();
		// sdk-mode `client.callTool()` answers with a task envelope directly (no
		// raw POST involved for the tools/call leg) — only the polling leg hits fetch.
		const fakeClient = {
			callTool: vi.fn(async () => ({
				resultType: "task",
				taskId: "task_sdk",
				status: "working",
			})),
		};
		(
			manager as unknown as { connections: Map<string, unknown> }
		).connections.set("srv", {
			mode: "sdk",
			client: fakeClient,
			config: { url: CONFIG.url, taskPolling: { maxIntervalMs: 0 } },
			info: { serverId: "srv", url: CONFIG.url },
			tools: [],
		});

		const out = await manager.callTool("srv", "do_thing", {});

		expect(fakeClient.callTool).toHaveBeenCalledTimes(1);
		expect(out).toMatchObject({
			content: [{ type: "text", text: "done via sdk" }],
		});
		const getCalls = calls.filter((c) => c.body.method === "tasks/get");
		expect(getCalls).toHaveLength(2);
	});

	it("drives the MRTR input_required → tasks/update round-trip", async () => {
		const calls: FetchCall[] = [];
		let getN = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as {
					method: string;
					params?: Record<string, unknown>;
				};
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tasks/get") {
					getN += 1;
					if (getN === 1)
						return jsonResponse({
							jsonrpc: "2.0",
							id: "g",
							result: {
								resultType: "complete",
								taskId: "task_2",
								status: "input_required",
								pollIntervalMs: 0,
								inputRequests: {
									approval_1: {
										method: "elicitation/create",
										params: { message: "Approve?" },
									},
								},
							},
						});
					return jsonResponse({
						jsonrpc: "2.0",
						id: "g",
						result: {
							resultType: "complete",
							taskId: "task_2",
							status: "completed",
							result: { ok: true },
						},
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const seen: Record<string, unknown>[] = [];
		const manager = new McpClientManager();
		const out = await (
			manager as unknown as {
				resolveTaskResult: (c: McpServerConfig, r: unknown) => Promise<unknown>;
			}
		).resolveTaskResult(
			{
				url: CONFIG.url,
				taskPolling: { maxIntervalMs: 0 },
				onTaskInputRequired: async ({ inputRequests }) => {
					seen.push(inputRequests);
					return { approval_1: { ok: true } };
				},
			},
			{ resultType: "task", taskId: "task_2", status: "working" },
		);

		expect(out).toMatchObject({ ok: true });
		// The resolver saw the input request and a tasks/update was sent.
		expect(seen).toHaveLength(1);
		const update = calls.find((c) => c.body.method === "tasks/update");
		expect(update?.body).toMatchObject({
			params: {
				taskId: "task_2",
				inputResponses: { approval_1: { ok: true } },
			},
		});
	});

	it("does not resolve the same task input request twice across polls", async () => {
		let getN = 0;
		const resolver = vi.fn(async () => ({ approval_1: { ok: true } }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tasks/get") {
					getN += 1;
					if (getN < 3) {
						return jsonResponse({
							jsonrpc: "2.0",
							id: "g",
							result: {
								status: "input_required",
								pollIntervalMs: 0,
								inputRequests: { approval_1: { method: "elicitation/create" } },
							},
						});
					}
					return jsonResponse({
						jsonrpc: "2.0",
						id: "g",
						result: { status: "completed", result: { ok: true } },
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "u", result: {} });
			}),
		);

		const manager = new McpClientManager();
		const out = await (
			manager as unknown as {
				resolveTaskResult: (c: McpServerConfig, r: unknown) => Promise<unknown>;
			}
		).resolveTaskResult(
			{
				url: CONFIG.url,
				taskPolling: { maxIntervalMs: 0 },
				onTaskInputRequired: resolver,
			},
			{ resultType: "task", taskId: "task_dedupe", status: "working" },
		);

		expect(out).toMatchObject({ ok: true });
		expect(resolver).toHaveBeenCalledTimes(1);
	});

	it("surfaces an input_required task when no resolver is configured", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tasks/get")
					return jsonResponse({
						jsonrpc: "2.0",
						id: "g",
						result: {
							resultType: "complete",
							taskId: "task_3",
							status: "input_required",
							inputRequests: { a: { method: "elicitation/create" } },
						},
					});
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const manager = new McpClientManager();
		const out = (await (
			manager as unknown as {
				resolveTaskResult: (c: McpServerConfig, r: unknown) => Promise<unknown>;
			}
		).resolveTaskResult(
			{ url: CONFIG.url },
			{
				resultType: "task",
				taskId: "task_3",
				status: "working",
			},
		)) as Record<string, unknown>;

		expect(out.status).toBe("input_required");
	});

	it("passes non-task results through untouched", async () => {
		const manager = new McpClientManager();
		const plain = { content: [{ type: "text", text: "hi" }] };
		const out = await (
			manager as unknown as {
				resolveTaskResult: (c: McpServerConfig, r: unknown) => Promise<unknown>;
			}
		).resolveTaskResult({ url: CONFIG.url }, plain);
		expect(out).toBe(plain);
	});
});

type RawPost = (
	c: McpServerConfig,
	m: string,
	p?: Record<string, unknown>,
) => Promise<unknown>;

describe("mcp-client-core — synchronous MRTR (input_required on tools/call)", () => {
	it("retries the original request with inputResponses + echoed requestState", async () => {
		const calls: FetchCall[] = [];
		let callN = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as {
					method: string;
					params?: Record<string, unknown>;
				};
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "tools/call") {
					callN += 1;
					// First call: synchronous input_required with an opaque requestState.
					if (callN === 1)
						return jsonResponse({
							jsonrpc: "2.0",
							id: "c",
							result: {
								resultType: "input_required",
								inputRequests: {
									approval_1: {
										method: "elicitation/create",
										params: { message: "Approve?" },
									},
								},
								requestState: "opaque-state-token",
							},
						});
					// Retry: completes.
					return jsonResponse({
						jsonrpc: "2.0",
						id: "c",
						result: { content: [{ type: "text", text: "done" }] },
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const seen: Record<string, unknown>[] = [];
		const manager = new McpClientManager();
		const post = (
			manager as unknown as { rawMcpPost: RawPost }
		).rawMcpPost.bind(manager);
		const out = await post(
			{
				url: CONFIG.url,
				onTaskInputRequired: async ({ inputRequests }) => {
					seen.push(inputRequests);
					return { approval_1: { ok: true } };
				},
			},
			"tools/call",
			{ name: "echo", arguments: { x: 1 } },
		);

		expect(out).toMatchObject({ content: [{ type: "text", text: "done" }] });
		expect(seen).toHaveLength(1);
		const toolCalls = calls.filter((c) => c.body.method === "tools/call");
		expect(toolCalls).toHaveLength(2);
		// Retry echoes requestState + carries inputResponses, keeping original args.
		expect(toolCalls[1]?.body).toMatchObject({
			params: {
				name: "echo",
				arguments: { x: 1 },
				inputResponses: { approval_1: { ok: true } },
				requestState: "opaque-state-token",
			},
		});
	});

	it("surfaces a synchronous input_required when no resolver is configured", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				return jsonResponse({
					jsonrpc: "2.0",
					id: "c",
					result: {
						resultType: "input_required",
						inputRequests: { a: { method: "elicitation/create" } },
					},
				});
			}),
		);

		const manager = new McpClientManager();
		const post = (
			manager as unknown as { rawMcpPost: RawPost }
		).rawMcpPost.bind(manager);
		const out = (await post({ url: CONFIG.url }, "tools/call", {
			name: "echo",
			arguments: {},
		})) as Record<string, unknown>;
		expect(out.resultType).toBe("input_required");
	});
});

describe("mcp-client-core — completion/complete", () => {
	it("sends completion/complete and returns the capped completion result", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as { method: string };
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse(discoverBody(["2026-07-28"]));
				if (body.method === "completion/complete")
					return jsonResponse({
						jsonrpc: "2.0",
						id: "k",
						result: {
							completion: { values: ["en", "es"], total: 2, hasMore: false },
						},
					});
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: {} });
			}),
		);

		const manager = new McpClientManager();
		// Register a stateless connection so `complete()` can resolve it.
		(
			manager as unknown as {
				connections: Map<string, unknown>;
			}
		).connections.set("srv", {
			mode: "stateless",
			config: CONFIG,
			info: { serverId: "srv", url: CONFIG.url },
		});

		const out = await manager.complete(
			"srv",
			{ type: "ref/prompt", name: "greet" },
			{ name: "lang", value: "e" },
			{ arguments: { region: "eu" } },
		);

		expect(out).toEqual({ values: ["en", "es"], total: 2, hasMore: false });
		const completionCall = calls.find(
			(c) => c.body.method === "completion/complete",
		);
		expect(completionCall?.body).toMatchObject({
			params: {
				ref: { type: "ref/prompt", name: "greet" },
				argument: { name: "lang", value: "e" },
				context: { arguments: { region: "eu" } },
			},
		});
	});
});

describe("mcp-client-core — sdk-mode elicitation/create handler", () => {
	type Elicitation = {
		action: "accept" | "decline" | "cancel";
		content?: Record<string, unknown>;
	};

	/**
	 * `registerElicitationHandler` only calls `client.setRequestHandler(...)` —
	 * stub that one call to capture the registered handler without driving a
	 * real SDK dispatch (initialize handshake, wire codec, era negotiation).
	 */
	function captureElicitationHandler(
		manager: McpClientManager,
		config: McpServerConfig,
	): (request: {
		method: "elicitation/create";
		params: Record<string, unknown>;
	}) => Promise<Elicitation> {
		(
			manager as unknown as { connections: Map<string, unknown> }
		).connections.set("sdk", { config });
		let captured: ((request: unknown) => Promise<Elicitation>) | undefined;
		const fakeClient = {
			setRequestHandler: (
				_method: string,
				handler: (request: unknown) => Promise<Elicitation>,
			) => {
				captured = handler;
			},
		} as unknown as Client;
		(
			manager as unknown as {
				registerElicitationHandler: (c: Client) => void;
			}
		).registerElicitationHandler(fakeClient);
		if (!captured) throw new Error("elicitation/create handler not registered");
		return captured;
	}

	it("does not borrow a connection model for unsolicited SDK elicitation", async () => {
		const seen: Array<{ message?: string }> = [];
		const config: McpServerConfig = {
			url: "https://peer.example/mcp",
			onTaskInputRequired: createAgentElicitationResolver({
				model: async (req) => {
					seen.push({ message: req.message });
					return { reason: "agent approved" };
				},
			}),
		};
		const handler = captureElicitationHandler(new McpClientManager(), config);

		const result = await handler({
			method: "elicitation/create",
			params: {
				message: "Confirm?",
				requestedSchema: {
					type: "object",
					properties: { reason: { type: "string" } },
					required: ["reason"],
				},
			},
		});

		expect(seen).toEqual([]);
		expect(result).toEqual({
			action: "accept",
			content: { reason: "" },
		});
	});

	it("deterministically fills an unsolicited form without a resolver", async () => {
		const handler = captureElicitationHandler(new McpClientManager(), {
			url: "https://peer.example/mcp",
		});

		const result = await handler({
			method: "elicitation/create",
			params: {
				message: "Confirm?",
				requestedSchema: { type: "object", properties: {} },
			},
		});

		expect(result).toEqual({ action: "accept", content: {} });
	});

	it("declines URL-mode elicitation (no browser round-trip available)", async () => {
		const config: McpServerConfig = {
			url: "https://peer.example/mcp",
			onTaskInputRequired: createAgentElicitationResolver(),
		};
		const handler = captureElicitationHandler(new McpClientManager(), config);

		const result = await handler({
			method: "elicitation/create",
			params: {
				mode: "url",
				message: "Open this link to continue",
				url: "https://example.com/auth",
			},
		});

		expect(result).toEqual({ action: "decline" });
	});
});

/**
 * Skills extension (SEP-2640) `resources/directory/read` gating. A conformant
 * client only calls the method against servers that declared the extension's
 * `directoryRead` flag — via `server/discover` (stateless) or the legacy
 * `initialize` capabilities (SDK). Undeclared servers get no round-trip; the
 * client surfaces the same method-not-found error a non-implementing server
 * would return, so callers keep their existing failure path.
 */
describe("mcp-client-core — skills extension directoryRead gating", () => {
	function installStatelessFetch(
		skillsEntry?: Record<string, unknown>,
	): FetchCall[] {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as {
					id?: unknown;
					method: string;
				};
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				if (body.method === "server/discover")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: {
								tools: {},
								...(skillsEntry
									? {
											extensions: {
												"io.modelcontextprotocol/skills": skillsEntry,
											},
										}
									: {}),
							},
						},
					});
				if (body.method === "tools/list")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [] },
					});
				if (body.method === "resources/directory/read")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resources: [
								{ uri: "skill://git-workflow/SKILL.md", name: "SKILL.md" },
							],
						},
					});
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
			}),
		);
		return calls;
	}

	function directoryReadCalls(calls: FetchCall[]): FetchCall[] {
		return calls.filter(
			(c) =>
				(c.body as { method: string }).method === "resources/directory/read",
		);
	}

	it("calls resources/directory/read when server/discover declares directoryRead", async () => {
		const calls = installStatelessFetch({ directoryRead: true });
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("skills", CONFIG);
		expect(manager.serverSupportsDirectoryRead("skills")).toBe(true);

		const result = await manager.readDirectory(
			"skills",
			"skill://git-workflow",
		);
		expect(result).toMatchObject({
			resources: [{ uri: "skill://git-workflow/SKILL.md" }],
		});
		const call = directoryReadCalls(calls)[0];
		expect(call?.body).toMatchObject({
			params: { uri: "skill://git-workflow" },
		});
	});

	it("skips the round-trip and surfaces the method-not-found fallback when directoryRead is not declared", async () => {
		// Both undeclared shapes: no extensions at all, and the skills extension
		// declared without its optional directoryRead flag.
		for (const skillsEntry of [undefined, {}]) {
			const calls = installStatelessFetch(skillsEntry);
			const manager = new McpClientManager();
			await manager.connectStatelessSnapshot("skills", CONFIG);
			expect(manager.serverSupportsDirectoryRead("skills")).toBe(false);

			await expect(
				manager.readDirectory("skills", "skill://git-workflow"),
			).rejects.toThrow(/MCP resources\/directory\/read error:.*-32601/);
			expect(directoryReadCalls(calls)).toHaveLength(0);
		}
	});

	it("calls resources/directory/read when modern discovery declares directoryRead", async () => {
		const calls: FetchCall[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				// The SDK client's standalone GET SSE stream probe — not offered.
				if (!init?.body) return new Response(null, { status: 405 });
				const body = JSON.parse(String(init.body)) as {
					id?: unknown;
					method: string;
					params?: Record<string, unknown>;
				};
				calls.push({
					url: String(_url),
					headers: { ...(init.headers as Record<string, string>) },
					body,
				});
				// Current server declares the Skills extension during discovery.
				if (body.method === "server/discover")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: {
								tools: {},
								extensions: {
									"io.modelcontextprotocol/skills": { directoryRead: true },
								},
							},
							_meta: {
								"io.modelcontextprotocol/serverInfo": {
									name: "skills",
									version: "1.0.0",
								},
							},
						},
					});
				if (body.method === "tools/list")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [] },
					});
				if (body.method === "resources/directory/read")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: { resources: [] },
					});
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
			}),
		);

		const manager = new McpClientManager();
		await manager.connect("skills", CONFIG);
		expect(manager.serverSupportsDirectoryRead("skills")).toBe(true);

		await manager.readDirectory("skills", "skill://git-workflow");
		const call = directoryReadCalls(calls)[0];
		expect(call?.body).toMatchObject({
			params: { uri: "skill://git-workflow" },
		});
	});
});

describe("mcp-client-core — SEP-2640 skill discovery", () => {
	function installSkillsFetch(
		skillsPayload?: unknown,
		options: {
			advertiseSkills?: boolean;
			skillPayload?: unknown;
			skillError?: { code: number; message: string };
		} = {},
	): Array<{ url: string; body: { method: string; params?: unknown } }> {
		const calls: Array<{
			url: string;
			body: { method: string; params?: unknown };
		}> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init?: RequestInit) => {
				if (!init?.body) return new Response(null, { status: 405 });
				const body = JSON.parse(String(init.body)) as {
					id?: unknown;
					method: string;
					params?: { uri?: string };
				};
				calls.push({ url: String(_url), body });
				switch (body.method) {
					case "skills/list":
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: skillsPayload ?? {},
						});
					case "skills/get":
						if (options.skillError)
							return jsonResponse({
								jsonrpc: "2.0",
								id: body.id,
								error: options.skillError,
							});
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: options.skillPayload ?? {
								skill: {
									uri: body.params?.uri,
									frontmatter: { name: "not-loaded", description: "metadata" },
									resources: [],
								},
							},
						});
					case "server/discover":
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: {
									tools: {},
									resources: {},
									extensions:
										options.advertiseSkills === false
											? {}
											: { "io.modelcontextprotocol/skills": {} },
								},
							},
						});
					case "tools/list":
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: { tools: [] },
						});
					case "prompts/list":
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: { prompts: [] },
						});
					case "resources/list":
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resources: [
									{
										uri: "skill://git-workflow/SKILL.md",
										name: "git-workflow",
									},
								],
							},
						});
					case "resources/read":
						return jsonResponse({
							jsonrpc: "2.0",
							id: body.id,
							result: { contents: [] },
						});
					default:
						return jsonResponse({ jsonrpc: "2.0", id: body.id, result: {} });
				}
			}),
		);
		return calls;
	}

	it("prefers skills/list and preserves the complete digest manifest", async () => {
		installSkillsFetch({
			skills: [
				{
					uri: "skill://git-workflow/SKILL.md",
					frontmatter: {
						name: "git-workflow",
						description: "Git conventions",
					},
					resources: [
						{
							uri: "skill://git-workflow/SKILL.md",
							digest: `sha256:${"a".repeat(64)}`,
							size: 190,
						},
					],
				},
			],
		});
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("skills", CONFIG);
		const resource = manager
			.listResources("skills")
			.find((entry) => entry.uri === "skill://git-workflow/SKILL.md");
		expect(resource?.name).toBe("git-workflow");
		expect(resource?.annotations?.resources).toEqual([
			{
				uri: "skill://git-workflow/SKILL.md",
				digest: `sha256:${"a".repeat(64)}`,
				size: 190,
			},
		]);
	});

	it("does not probe the removed pre-v1 skill index", async () => {
		installSkillsFetch();
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("skills", CONFIG);
		expect(
			manager
				.listResources("skills")
				.some((entry) => entry.uri.includes("legacy")),
		).toBe(false);
	});

	it("gets one exact skill manifest on demand from the selected server", async () => {
		const uri = "skill://private/source/SKILL.md";
		const calls = installSkillsFetch(undefined, {
			skillPayload: {
				skill: {
					uri,
					frontmatter: { name: "source", description: "inert metadata" },
					resources: [{ uri, digest: `sha256:${"b".repeat(64)}`, size: 64 }],
				},
			},
		});
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("skills-origin-a", {
			...CONFIG,
			url: "https://skills-origin-a.example/mcp",
		});

		const result = await manager.getSkill("skills-origin-a", uri);
		expect(result).toMatchObject({
			skill: { uri, frontmatter: { name: "source" } },
		});
		const getCall = calls.find(({ body }) => body.method === "skills/get");
		expect(getCall?.url).toBe("https://skills-origin-a.example/mcp");
		expect(getCall?.body).toMatchObject({
			method: "skills/get",
			params: { uri },
		});
		await expect(manager.getSkill("unassigned-origin", uri)).rejects.toThrow(
			/Connection "unassigned-origin" not found/,
		);
		expect(
			calls.filter(({ body }) => body.method === "skills/get"),
		).toHaveLength(1);
		expect(calls.some(({ body }) => body.method === "resources/read")).toBe(
			false,
		);
	});

	it("fails closed without the Skills extension and never calls skills/get", async () => {
		const calls = installSkillsFetch(undefined, { advertiseSkills: false });
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("no-skills", CONFIG);
		await expect(
			manager.getSkill("no-skills", "skill://not-advertised/SKILL.md"),
		).rejects.toThrow(/did not declare io\.modelcontextprotocol\/skills/);
		expect(calls.some(({ body }) => body.method === "skills/get")).toBe(false);
	});

	it("rejects oversized or malformed skills/get metadata", async () => {
		const uri = "skill://origin/large/SKILL.md";
		const calls = installSkillsFetch(undefined, {
			skillPayload: {
				skill: {
					uri,
					frontmatter: { name: "large", description: "x".repeat(1_048_577) },
					resources: [],
				},
			},
		});
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("origin", CONFIG);
		await expect(manager.getSkill("origin", uri)).rejects.toThrow(
			/1 MiB metadata limit/,
		);
		expect(
			calls.filter(({ body }) => body.method === "skills/get"),
		).toHaveLength(1);
	});

	it("rejects a skills/get response for a different URI", async () => {
		const calls = installSkillsFetch(undefined, {
			skillPayload: {
				skill: {
					uri: "skill://origin/substituted/SKILL.md",
					frontmatter: { name: "substituted", description: "wrong resource" },
					resources: [],
				},
			},
		});
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("origin", CONFIG);
		await expect(
			manager.getSkill("origin", "skill://origin/requested/SKILL.md"),
		).rejects.toThrow(/returned URI .* for requested URI/);
		expect(
			calls.filter(({ body }) => body.method === "skills/get"),
		).toHaveLength(1);
	});

	it("preserves upstream skills/get errors", async () => {
		const calls = installSkillsFetch(undefined, {
			skillError: { code: -32602, message: "Unknown skill URI" },
		});
		const manager = new McpClientManager();
		await manager.connectStatelessSnapshot("origin", CONFIG);
		await expect(
			manager.getSkill("origin", "skill://origin/missing/SKILL.md"),
		).rejects.toThrow(/Unknown skill URI/);
		expect(
			calls.filter(({ body }) => body.method === "skills/get"),
		).toHaveLength(1);
	});
});
