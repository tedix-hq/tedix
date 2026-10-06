import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import { describe, expect, it } from "vite-plus/test";
import { MCP_LIST_MAX_PAGES } from "@tedix/mcp-shared/bounded-list";
import {
	executeApprovedKernelWrite,
	type HomeToolWritePayload,
	parseHomeToolWritePayload,
	type WriteExecutorEnv,
} from "./write-executor";

/**
 * Approved-write executor tests (v1). Stubs `MCP_SERVICE.fetch` to simulate
 * the provider — covering the stored-payload-only execution, upstream
 * revalidation, user-first → tenant credential fallback, and bounded
 * failures (mirrors execute.test.ts's MCP stub pattern without touching it).
 */

interface RecordedCall {
	url: string;
	headers: Headers;
	method: string;
	params: Record<string, unknown>;
}

/**
 * A 2026-07-28 server echoes the request id, stamps `resultType` on every
 * result, adds SEP-2549 freshness hints to list results, gives every listed
 * tool an object inputSchema and every tool result a content array; the fixtures
 * state only the payload that matters.
 */
function modernReply(
	body: { id?: unknown; method: string },
	json: unknown,
): unknown {
	if (!json || typeof json !== "object") return json;
	const envelope = json as { result?: Record<string, unknown> };
	return {
		...envelope,
		id: body.id,
		...(envelope.result
			? {
					result: {
						resultType: "complete",
						...(body.method.endsWith("/list")
							? { ttlMs: 0, cacheScope: "private" }
							: {}),
						...(body.method === "tools/call" ? { content: [] } : {}),
						...envelope.result,
						...(Array.isArray(envelope.result.tools)
							? {
									tools: envelope.result.tools.map(
										(tool: { inputSchema?: object }) => ({
											...tool,
											inputSchema: { type: "object", ...tool.inputSchema },
										}),
									),
								}
							: {}),
					},
				}
			: {}),
	};
}

/** The request `_meta` envelope the SDK client binds for Home's calls. */
const HOME_REQUEST_META = {
	"io.modelcontextprotocol/protocolVersion": MCP_MODERN_PROTOCOL_VERSION,
	"io.modelcontextprotocol/clientInfo": {
		name: "tedix-home",
		version: "1.0.0",
	},
	"io.modelcontextprotocol/clientCapabilities": {},
};

function mcpService(
	handler: (body: { method: string; params: Record<string, unknown> }) => {
		status?: number;
		json: unknown;
	},
) {
	const calls: RecordedCall[] = [];
	return {
		calls,
		fetch: async (input: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			const headers = new Headers(init?.headers);
			// The real gateway rejects legacy requests before dispatching tools.
			if (
				headers.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION ||
				headers.get("Mcp-Method") !== body.method ||
				body.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !==
					MCP_MODERN_PROTOCOL_VERSION ||
				!body.params?._meta?.["io.modelcontextprotocol/clientCapabilities"] ||
				(body.method === "tools/call" &&
					headers.get("Mcp-Name") !== body.params.name)
			)
				return new Response("Unsupported MCP request", { status: 400 });
			calls.push({
				url: input,
				headers,
				method: body.method,
				params: body.params,
			});
			const { status = 200, json } = handler(body);
			return new Response(JSON.stringify(modernReply(body, json)), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	};
}

function payload(
	overrides: Partial<HomeToolWritePayload> = {},
): HomeToolWritePayload {
	return {
		kind: "home_tool_write",
		appSlug: "globex-tedix",
		toolName: "globex__create_invoice",
		args: { amount: 100, customerName: "ACME" },
		organizationId: "org-1",
		homeRunId: "run-1",
		conversationId: "home:main",
		initiatedByUserId: "user-123",
		...overrides,
	};
}

function env(
	service: ReturnType<typeof mcpService>,
	overrides: Partial<WriteExecutorEnv> = {},
): WriteExecutorEnv {
	return {
		MCP_SERVICE: service,
		MCP_URL: "https://mcp.tedix.dev",
		PLATFORM_SERVICE_TOKEN: "svc-token",
		...overrides,
	};
}

const LISTED = {
	json: {
		jsonrpc: "2.0",
		id: 1,
		result: {
			tools: [
				{
					name: "globex__create_invoice",
					annotations: { destructiveHint: true },
				},
			],
		},
	},
};

describe("parseHomeToolWritePayload", () => {
	it("round-trips a valid payload and normalizes initiatedByUserId", () => {
		expect(parseHomeToolWritePayload(payload())).toEqual(payload());
		expect(
			parseHomeToolWritePayload(payload({ initiatedByUserId: null })),
		).toEqual(payload({ initiatedByUserId: null }));
	});

	it("rejects other kinds, missing fields, and non-object args", () => {
		expect(parseHomeToolWritePayload(null)).toBeNull();
		expect(
			parseHomeToolWritePayload({ ...payload(), kind: "workstation.attach" }),
		).toBeNull();
		expect(
			parseHomeToolWritePayload({ ...payload(), toolName: "" }),
		).toBeNull();
		expect(parseHomeToolWritePayload({ ...payload(), args: [1] })).toBeNull();
		expect(
			parseHomeToolWritePayload({ ...payload(), homeRunId: undefined }),
		).toBeNull();
	});
});

describe("executeApprovedKernelWrite", () => {
	it("executes the STORED call once with the acting user", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? LISTED
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: { id: "INV-1" },
								isError: false,
							},
						},
					},
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});

		expect(result).toEqual({ ok: true, data: { id: "INV-1" } });
		expect(service.calls.map((c) => c.method)).toEqual([
			"tools/list",
			"tools/call",
		]);
		const call = service.calls[1];
		expect(call?.headers.get("X-Tedix-Host")).toBe(
			"globex-tedix.mcp.tedix.dev",
		);
		expect(call?.headers.get("X-Tedix-Org-Id")).toBe("org-1");
		expect(call?.headers.get("X-Tedix-Acting-User")).toBe("user-123");
		// Tenant control-plane audit marker on BOTH the re-verify list and the
		// write itself (kernel actor in apps/mcp).
		for (const c of service.calls) {
			expect(c.headers.get("X-Tedix-Kernel")).toBe("true");
		}
		// EXACTLY the stored args reach the provider.
		expect(call?.params).toEqual({
			_meta: HOME_REQUEST_META,
			name: "globex__create_invoice",
			arguments: { amount: 100, customerName: "ACME" },
		});
	});

	it("falls back to the tenant credential when the personal one is missing", async () => {
		// First tools/call (with acting user) reports the missing credential,
		// the retry (without acting user) succeeds.
		let toolCallIndex = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") return LISTED;
			toolCallIndex += 1;
			if (toolCallIndex === 1) {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: {
							isError: true,
							content: [
								{ type: "text", text: "Connection credential not found" },
							],
						},
					},
				};
			}
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: { id: "INV-2" }, isError: false },
				},
			};
		});

		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});
		expect(result).toEqual({ ok: true, data: { id: "INV-2" } });
		const toolCalls = service.calls.filter((c) => c.method === "tools/call");
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]?.headers.get("X-Tedix-Acting-User")).toBe("user-123");
		expect(toolCalls[1]?.headers.get("X-Tedix-Acting-User")).toBeNull();
	});

	it("revalidates and executes an approved Code Mode callable", async () => {
		let codeCall = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			codeCall += 1;
			return codeCall === 1
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "exec-discovery",
									result: JSON.stringify([
										{
											callable: "work.create_work_items",
											annotations: { readOnlyHint: false },
											parameters: {
												properties: { title: { type: "string" } },
												required: ["title"],
											},
										},
									]),
								},
							},
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "exec-1",
									result: { id: "WI-1" },
								},
							},
						},
					};
		});
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "tedix-unified",
				toolName: "work.create_work_items",
				args: { title: "Release proof" },
				transport: "codemode",
			}),
		});

		expect(result).toEqual({ ok: true, data: { id: "WI-1" } });
		expect(service.calls.map((call) => call.method)).toEqual([
			"tools/list",
			"tools/call",
			"tools/call",
		]);
		expect(service.calls[2]?.params).toEqual({
			_meta: HOME_REQUEST_META,
			name: "code",
			arguments: {
				code: 'async () => await work.create_work_items({"title":"Release proof"})',
			},
		});
	});

	it("fails an approved Code Mode write when the outer code tool reports an inner MCP error", async () => {
		let codeCall = 0;
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result: { tools: [{ name: "code" }] },
					},
				};
			}
			codeCall += 1;
			return codeCall === 1
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								structuredContent: {
									executionId: "exec-discovery",
									result: JSON.stringify([
										{
											callable: "google_gmail.apply_sensitive_thread_label",
											annotations: {
												readOnlyHint: false,
												destructiveHint: true,
											},
											parameters: {
												properties: {
													threadId: { type: "string" },
													labelOption: { type: "string" },
												},
												required: ["threadId", "labelOption"],
											},
										},
									]),
								},
							},
						},
					}
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								isError: true,
								content: [
									{
										type: "text",
										text: "Execution error: Request had insufficient authentication scopes.",
									},
								],
								structuredContent: {
									error: "Request had insufficient authentication scopes.",
								},
							},
						},
					};
		});

		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({
				appSlug: "google-gmail-tedix",
				toolName: "google_gmail.apply_sensitive_thread_label",
				args: { threadId: "thread-1", labelOption: "TRASH" },
				transport: "codemode",
			}),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("insufficient authentication scopes");
		}
		expect(service.calls.map((call) => call.method)).toEqual([
			"tools/list",
			"tools/call",
			"tools/call",
		]);
	});

	it("aborts (no tools/call) when the stored tool no longer exists upstream", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: { tools: [{ name: "globex__something_else" }] },
						},
					}
				: { json: { jsonrpc: "2.0", id: 1, result: {} } },
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("no longer available");
		expect(service.calls.map((c) => c.method)).toEqual(["tools/list"]);
	});

	it("executes an approved write whose tool sorts past the first catalog page", async () => {
		const service = mcpService((body) => {
			if (body.method === "tools/list") {
				const cursor = (body.params as { cursor?: string }).cursor;
				return {
					json: {
						jsonrpc: "2.0",
						id: 1,
						result:
							cursor === undefined
								? {
										tools: Array.from({ length: 200 }, (_, i) => ({
											name: `globex__filler_${i}`,
										})),
										nextCursor: "page-2",
									}
								: {
										tools: [
											{
												name: "globex__create_invoice",
												annotations: { destructiveHint: true },
											},
										],
									},
					},
				};
			}
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: { structuredContent: { id: "INV-9" } },
				},
			};
		});
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});

		expect(result).toEqual({ ok: true, data: { id: "INV-9" } });
		expect(
			service.calls
				.filter((call) => call.method === "tools/list")
				.map((call) => call.params.cursor),
		).toEqual([undefined, "page-2"]);
	});

	it("reports a tool unverified — not missing — when the catalog hits the page bound", async () => {
		let page = 0;
		const service = mcpService((body) => {
			if (body.method !== "tools/list") {
				return { json: { jsonrpc: "2.0", id: 1, result: {} } };
			}
			page += 1;
			return {
				json: {
					jsonrpc: "2.0",
					id: 1,
					result: {
						tools: [{ name: `globex__filler_${page}` }],
						nextCursor: `page-${page}`,
					},
				},
			};
		});
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("could not be verified");
			expect(result.error).not.toContain("no longer available");
		}
		// The walk is bounded and no tools/call was attempted.
		expect(page).toBe(MCP_LIST_MAX_PAGES);
		expect(service.calls.every((call) => call.method === "tools/list")).toBe(
			true,
		);
	});

	it("aborts when the stored tool was re-published as read-only", async () => {
		const service = mcpService((body) =>
			body.method === "tools/list"
				? {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								tools: [
									{
										name: "globex__create_invoice",
										annotations: { readOnlyHint: true },
									},
								],
							},
						},
					}
				: { json: { jsonrpc: "2.0", id: 1, result: {} } },
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload(),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("read-only");
		expect(service.calls.map((c) => c.method)).toEqual(["tools/list"]);
	});

	it("returns a bounded upstream error on tools/call isError", async () => {
		const longError = "boom ".repeat(200);
		const service = mcpService((body) =>
			body.method === "tools/list"
				? LISTED
				: {
						json: {
							jsonrpc: "2.0",
							id: 1,
							result: {
								isError: true,
								content: [{ type: "text", text: longError }],
							},
						},
					},
		);
		const result = await executeApprovedKernelWrite({
			env: env(service),
			payload: payload({ initiatedByUserId: null }),
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.length).toBeLessThanOrEqual(301);
	});

	it("fails-soft when the MCP service binding is unavailable", async () => {
		const result = await executeApprovedKernelWrite({
			env: {},
			payload: payload(),
		});
		expect(result).toEqual({
			ok: false,
			error: "MCP service binding is not configured",
		});
	});
});
