/**
 * Synchronous MRTR (`resultType: "input_required"`) retry path. A `tools/call`
 * that answers directly (no Tasks round-trip) with `input_required` is resolved
 * by the configured `onTaskInputRequired` resolver and RETRIED with the echoed
 * `inputResponses` + `requestState`. Bounded by MAX_SYNC_INPUT_ROUNDS.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { McpClientManager } from "../src/client-manager";
import { createAgentElicitationResolver } from "../src/elicitation-resolver";
import type { McpServerConfig } from "../src/types";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

type FetchCall = { method: string; params: Record<string, unknown> };

afterEach(() => vi.unstubAllGlobals());

function rawPost(
	manager: McpClientManager,
	config: McpServerConfig,
	method: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	return (
		manager as unknown as {
			rawMcpPost: (
				c: McpServerConfig,
				m: string,
				p?: Record<string, unknown>,
			) => Promise<unknown>;
		}
	).rawMcpPost(config, method, params);
}

describe("synchronous MRTR retry", () => {
	it("answers input_required and retries with inputResponses + requestState", async () => {
		const calls: FetchCall[] = [];
		let toolCallSeq = 0;
		const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
			const parsed = JSON.parse(String(init.body)) as {
				method: string;
				params: Record<string, unknown>;
			};
			if (parsed.method === "server/discover") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: "d",
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					},
				});
			}
			calls.push({ method: parsed.method, params: parsed.params });
			toolCallSeq += 1;
			if (toolCallSeq === 1) {
				// First tools/call → server needs input.
				return jsonResponse({
					jsonrpc: "2.0",
					id: "1",
					result: {
						resultType: "input_required",
						requestState: "opaque-state-token",
						inputRequests: {
							approval: {
								method: "elicitation/create",
								params: {
									message: "Confirm?",
									requestedSchema: {
										type: "object",
										properties: { reason: { type: "string" } },
										required: ["reason"],
									},
								},
							},
						},
					},
				});
			}
			// Retry → final result.
			return jsonResponse({
				jsonrpc: "2.0",
				id: "2",
				result: { content: [{ type: "text", text: "done" }] },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const resolverCalls: Array<Record<string, unknown>> = [];
		const config: McpServerConfig = {
			url: "https://peer.example/mcp",
			onTaskInputRequired: createAgentElicitationResolver({
				model: async (req) => {
					resolverCalls.push({ key: req.key, message: req.message });
					return { reason: "agent approved" };
				},
			}),
		};

		const manager = new McpClientManager();
		const result = await rawPost(manager, config, "tools/call", {
			name: "do_thing",
			arguments: {},
		});

		// Two tools/call round-trips: initial + retry.
		expect(calls).toHaveLength(2);
		expect(calls[0]?.params).toMatchObject({ name: "do_thing" });
		// The retry echoes the resolver answer (spec-shaped ElicitResult) + the
		// opaque requestState.
		expect(calls[1]?.params).toMatchObject({
			name: "do_thing",
			inputResponses: {
				approval: {
					action: "accept",
					content: { reason: "agent approved" },
				},
			},
			requestState: "opaque-state-token",
		});
		// The agent's model seam was consulted (agent-to-agent, no human).
		expect(resolverCalls).toEqual([{ key: "approval", message: "Confirm?" }]);
		// Final tool result is returned to the caller.
		expect(result).toMatchObject({ content: [{ type: "text", text: "done" }] });
	});

	it("surfaces input_required unresolved when no resolver is configured", async () => {
		const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
			const parsed = JSON.parse(String(init.body)) as { method: string };
			if (parsed.method === "server/discover") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: "d",
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
					},
				});
			}
			return jsonResponse({
				jsonrpc: "2.0",
				id: "1",
				result: { resultType: "input_required", inputRequests: {} },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const manager = new McpClientManager();
		const result = (await rawPost(
			manager,
			{ url: "https://peer.example/mcp" },
			"tools/call",
			{
				name: "x",
				arguments: {},
			},
		)) as Record<string, unknown>;
		expect(result.resultType).toBe("input_required");
	});
});

describe("invocation resolver on the actual stateless MRTR wire", () => {
	it("isolates concurrent replies and keeps the shared connection resolver unchanged", async () => {
		const old = vi.fn(async () => ({
			form: { action: "accept", content: { reason: "wrong turn" } },
		}));
		const config = {
			url: "https://peer.example/mcp",
			onTaskInputRequired: old,
		};
		const manager = new McpClientManager();
		(
			manager as unknown as { connections: Map<string, unknown> }
		).connections.set("srv", {
			config,
			mode: "stateless",
			tools: [],
			info: { serverId: "srv" },
		});
		const gates: Record<string, () => void> = {};
		const answers: Record<string, unknown> = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const body = JSON.parse(String(init.body));
				if (body.method === "server/discover")
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
						},
					});
				const key = body.params.arguments.key;
				if (!body.params.inputResponses) {
					await new Promise<void>((resolve) => {
						gates[key] = resolve;
					});
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "input_required",
							requestState: key,
							inputRequests: {
								form: {
									requestedSchema: {
										type: "object",
										properties: { reason: { type: "string" } },
										required: ["reason"],
									},
								},
							},
						},
					});
				}
				answers[key] = body.params.inputResponses;
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: key }] },
				});
			}),
		);
		const resolver = (key: string) =>
			createAgentElicitationResolver({ model: async () => ({ reason: key }) });
		const a = manager.callTool(
			"srv",
			"code",
			{ key: "a" },
			{ onTaskInputRequired: resolver("a") },
		);
		const b = manager.callTool(
			"srv",
			"code",
			{ key: "b" },
			{ onTaskInputRequired: resolver("b") },
		);
		await vi.waitFor(() => {
			expect(gates.a).toBeTypeOf("function");
			expect(gates.b).toBeTypeOf("function");
		});
		gates.b!();
		await b;
		gates.a!();
		await a;
		expect(answers).toEqual({
			b: { form: { action: "accept", content: { reason: "b" } } },
			a: { form: { action: "accept", content: { reason: "a" } } },
		});
		expect(config.onTaskInputRequired).toBe(old);
		expect(old).not.toHaveBeenCalled();
	});
	it("denies an already-aborted original invocation without a wire or resolver", async () => {
		const manager = new McpClientManager();
		const resolver = vi.fn();
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		(
			manager as unknown as { connections: Map<string, unknown> }
		).connections.set("srv", {
			config: { url: "https://peer.example/mcp" },
			mode: "stateless",
			tools: [],
		});
		await expect(
			manager.callTool(
				"srv",
				"code",
				{},
				{
					signal: AbortSignal.abort(new Error("cancelled original")),
					onTaskInputRequired: resolver,
				},
			),
		).rejects.toThrow("cancelled original");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(resolver).not.toHaveBeenCalled();
	});
});

it("retains invocation answers through HeaderMismatch schema refresh and synchronous retry", async () => {
	const manager = new McpClientManager();
	const shared = vi.fn();
	const connection = {
		config: { url: "https://peer.example/mcp", onTaskInputRequired: shared },
		mode: "stateless",
		info: { serverId: "srv" },
		tools: [],
	};
	(manager as unknown as { connections: Map<string, unknown> }).connections.set(
		"srv",
		connection,
	);
	let calls = 0;
	const methods: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url, init) => {
			const body = JSON.parse(String(init.body));
			methods.push(body.method);
			if (body.method === "server/discover")
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: { resultType: "complete", supportedVersions: ["2026-07-28"] },
				});
			if (body.method === "tools/list")
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: [{ name: "code", inputSchema: { type: "object" } }],
					},
				});
			if (++calls === 1)
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32020, message: "HeaderMismatch" },
				});
			if (calls === 2)
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "input_required",
						inputRequests: {
							form: {
								requestedSchema: {
									type: "object",
									properties: { reason: { type: "string" } },
									required: ["reason"],
								},
							},
						},
					},
				});
			expect(body.params.inputResponses).toEqual({
				form: { action: "accept", content: { reason: "original" } },
			});
			return jsonResponse({
				jsonrpc: "2.0",
				id: body.id,
				result: { content: [{ type: "text", text: "done" }] },
			});
		}),
	);
	await manager.callTool(
		"srv",
		"code",
		{},
		{
			onTaskInputRequired: createAgentElicitationResolver({
				model: async () => ({ reason: "original" }),
			}),
		},
	);
	expect(methods.filter((m) => m !== "server/discover")).toEqual([
		"tools/call",
		"tools/list",
		"tools/call",
		"tools/call",
	]);
	expect(shared).not.toHaveBeenCalled();
	expect(connection.config.onTaskInputRequired).toBe(shared);
});
