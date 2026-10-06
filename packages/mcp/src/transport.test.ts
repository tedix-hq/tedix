/**
 * Transport parity tests — locks the wire protocol contract for our
 * stateless Web transport (`@tedix/mcp-shared/transport::mountMcp`).
 *
 * What we assert: behaviors MCP / Apps SDK clients depend on:
 * - HTTP method semantics (POST/GET/DELETE/OPTIONS, 405 for others)
 * - CORS preflight + headers
 * - Content negotiation (Accept, Content-Type) with correct status codes
 * - JSON-RPC error envelopes (codes, ids)
 * - initialize / tools/list / tools/call success shapes
 * - Notifications get 202 No Content
 *
 * What we deliberately do NOT pin: stateful sessions, SSE streams, event
 * resumption — those are out of scope for our stateless transport.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import * as z from "zod";
import { encodeMcpHeaderValue } from "./mcp-param-headers";
import { buildPaymentRequiredResult, getPaymentRequiredMeta } from "./payment";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_CLIENT_INFO_META_KEY,
	MCP_METHOD_HEADER,
	MCP_NAME_HEADER,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_SERVER_INFO_META_KEY,
	MCP_TASKS_EXTENSION,
} from "./protocol";
import { createMcpServer } from "./server";
import {
	GetSkillParamsSchema,
	GetSkillResultSchema,
	ListSkillsParamsSchema,
	ListSkillsResultSchema,
	McpSkillEntrySchema,
} from "./skills";
import { McpTaskError } from "./tasks";
import {
	enforceModernMcpProtocol,
	MCP_RESULT_CACHE_HINT_META_KEY,
	mountMcp,
	requiresLegacyMcpTransport,
	StatelessMcpTransport,
	validateModernProtocolHeaders,
} from "./transport";

const URL_OK = "https://test.local/mcp";
const URL_OTHER = "https://test.local/elsewhere";
const ACCEPT_BOTH = "application/json, text/event-stream";

describe("SEP-2640 skill manifest schema", () => {
	it("requires resources and accepts the explicit dynamic marker", () => {
		expect(
			McpSkillEntrySchema.safeParse({
				uri: "skill://sample/SKILL.md",
				frontmatter: { name: "sample" },
				resources: "dynamic",
			}).success,
		).toBe(true);
		expect(
			McpSkillEntrySchema.safeParse({
				uri: "skill://sample/SKILL.md",
				frontmatter: { name: "sample" },
			}).success,
		).toBe(false);
	});

	it("requires a byte size for each static resource", () => {
		expect(
			McpSkillEntrySchema.safeParse({
				uri: "skill://sample/SKILL.md",
				frontmatter: { name: "sample" },
				resources: [
					{
						uri: "skill://sample/SKILL.md",
						digest: `sha256:${"a".repeat(64)}`,
						size: 0,
					},
				],
			}).success,
		).toBe(true);
		expect(
			McpSkillEntrySchema.safeParse({
				uri: "skill://sample/SKILL.md",
				frontmatter: { name: "sample" },
				resources: [
					{
						uri: "skill://sample/SKILL.md",
						digest: `sha256:${"a".repeat(64)}`,
					},
				],
			}).success,
		).toBe(false);
	});
});

function buildServer() {
	const server = createMcpServer({
		name: "parity-test",
		version: "0.0.1",
	});

	server.registerTool(
		"echo",
		{
			title: "echo",
			description: "Echo back input",
			inputSchema: { msg: z.string() },
		},
		async ({ msg }) => ({
			content: [{ type: "text" as const, text: `echo:${msg}` }],
		}),
	);

	server.registerTool(
		"boom",
		{
			title: "boom",
			description: "Throw an error",
			inputSchema: {},
		},
		async () => {
			throw new Error("intentional-failure");
		},
	);

	server.registerTool(
		"meta_echo",
		{
			title: "meta_echo",
			description: "Echo request metadata",
			inputSchema: {},
		},
		async (_args, ctx) => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(ctx?.mcpReq?._meta ?? {}),
				},
			],
		}),
	);

	server.registerTool(
		"paid",
		{
			title: "paid",
			description: "Requires x402 payment",
			inputSchema: {},
		},
		async () =>
			buildPaymentRequiredResult({
				protocol: "x402",
				toolId: "paid",
				requirementId: "req_test_123",
				requirements: {
					x402Version: 1,
					accepts: [
						{
							scheme: "exact",
							network: "solana-devnet",
							maxAmountRequired: "0.01",
							resource: "mcp://parity-test/tools/paid#req_test_123",
							description: "Pay 0.01 USDC to call paid",
							mimeType: "application/json",
							payTo: "TestRecipient111111111111111111111111111111",
							maxTimeoutSeconds: 300,
							asset: "USDC",
							extra: {
								requirementId: "req_test_123",
								toolId: "paid",
							},
						},
					],
				},
			}),
	);

	server.registerTool(
		"paid_v2",
		{
			title: "paid_v2",
			description: "Requires x402 v2 payment",
			inputSchema: {},
		},
		async () =>
			buildPaymentRequiredResult({
				protocol: "x402",
				toolId: "paid_v2",
				requirementId: "req_v2_123",
				requirements: {
					x402Version: 2,
					resource: {
						url: "mcp://parity-test/tools/paid_v2#req_v2_123",
						description: "Pay to call paid_v2",
						mimeType: "application/json",
					},
					accepts: [
						{
							scheme: "exact",
							network: "eip155:84532",
							asset: "0x0000000000000000000000000000000000000001",
							amount: "10000",
							payTo: "0x0000000000000000000000000000000000000002",
							maxTimeoutSeconds: 300,
							extra: { requirementId: "req_v2_123" },
						},
					],
				},
			}),
	);

	return server;
}

async function call(req: Request, opts?: Parameters<typeof mountMcp>[2]) {
	// `requiredClientExtensions: []` is behaviorally the hand-rolled engine's
	// default, but its PRESENCE pins these parity tests to that engine
	// (`requiresLegacyMcpTransport`): extension-shaped mounts (apps/mcp,
	// apps/tedi-runtime) still serve through it. Simple-shaped mounts dispatch
	// to the SDK's `createMcpHandler` — covered by the "engine dispatch"
	// describe block below.
	return mountMcp(buildServer(), req, {
		cors: { origin: "https://example.com" },
		requiredClientExtensions: [],
		...opts,
	});
}

function postRpc(
	body: unknown,
	init: { accept?: string; contentType?: string } = {},
) {
	return new Request(URL_OK, {
		method: "POST",
		headers: {
			Accept: init.accept ?? ACCEPT_BOTH,
			"Content-Type": init.contentType ?? "application/json",
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

// =============================================================================
// CORS / OPTIONS
// =============================================================================

describe("transport — CORS", () => {
	it("OPTIONS preflight returns 200 with CORS headers", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "OPTIONS",
				headers: {
					Origin: "https://example.com",
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "Content-Type",
				},
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://example.com",
		);
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
			"Content-Type",
		);
		expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
	});

	it("non-preflight responses include CORS exposure headers", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://example.com",
		);
	});
});

// =============================================================================
// ROUTE FILTERING
// =============================================================================

describe("transport — route filtering", () => {
	it("non-/mcp paths return 404", async () => {
		const res = await call(new Request(URL_OTHER, { method: "POST" }));
		expect(res.status).toBe(404);
	});

	it("route: null disables path check", async () => {
		const res = await call(
			new Request(URL_OTHER, {
				method: "OPTIONS",
				headers: { Origin: "https://example.com" },
			}),
			{ route: null, cors: { origin: "https://example.com" } },
		);
		expect(res.status).toBe(200);
	});
});

// =============================================================================
// METHOD ALLOW-LIST
// =============================================================================

describe("transport — method allow-list", () => {
	it("PUT returns 405 with JSON-RPC error envelope and Allow header", async () => {
		const res = await call(new Request(URL_OK, { method: "PUT" }));
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET, POST, DELETE, OPTIONS");
		const body = (await res.json()) as {
			jsonrpc: string;
			error: { message: string };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error.message).toMatch(/method not allowed/i);
	});

	it("PATCH returns 405", async () => {
		const res = await call(new Request(URL_OK, { method: "PATCH" }));
		expect(res.status).toBe(405);
	});
});

// =============================================================================
// POST CONTENT NEGOTIATION
// =============================================================================

describe("transport — POST content negotiation", () => {
	it("rejects POST without text/event-stream in Accept (406)", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		);
		expect(res.status).toBe(406);
	});

	it("rejects POST without application/json in Accept (406)", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: "text/event-stream",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		);
		expect(res.status).toBe(406);
	});

	it("rejects non-JSON Content-Type (415)", async () => {
		const res = await call(postRpc("{}", { contentType: "text/plain" }));
		expect(res.status).toBe(415);
	});

	it("rejects a Content-Type that only contains application/json as a substring", async () => {
		const res = await call(
			postRpc("{}", { contentType: "text/plain; type=application/json" }),
		);
		expect(res.status).toBe(415);
	});

	it("accepts application/json with parameters", async () => {
		const res = await call(
			postRpc(
				{ jsonrpc: "2.0", id: 1, method: "tools/list" },
				{ contentType: "application/json; charset=utf-8" },
			),
		);
		expect(res.status).toBe(200);
	});

	it("rejects malformed JSON with -32700 parse error (400)", async () => {
		const res = await call(postRpc("{not valid json"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32700);
	});

	it("rejects an oversized declared body before reading or parsing it", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: ACCEPT_BOTH,
					"Content-Type": "application/json",
					"Content-Length": String(4 * 1024 * 1024 + 1),
				},
				body: "{}",
			}),
		);
		expect(res.status).toBe(413);
		const body = (await res.json()) as {
			jsonrpc: string;
			error: { code: number; message: string };
		};
		expect(body.jsonrpc).toBe("2.0");
		expect(body.error.code).toBe(-32000);
		expect(body.error.message).toContain("4194304 bytes");
	});

	it("bounds streamed bodies even without a declared Content-Length", async () => {
		const bytes = new TextEncoder().encode(" ".repeat(4 * 1024 * 1024 + 1));
		const res = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: ACCEPT_BOTH,
					"Content-Type": "application/json",
				},
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
		);
		expect(res.status).toBe(413);
	});

	it("rejects invalid JSON-RPC shape with -32700 (400)", async () => {
		const res = await call(postRpc({ foo: "bar" }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32700);
	});

	it("rejects unsupported MCP-Protocol-Version with -32022 (400)", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: ACCEPT_BOTH,
					"Content-Type": "application/json",
					"MCP-Protocol-Version": "1999-01-01",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: number; message: string; data: Record<string, unknown> };
		};
		// 2026-07-28: UnsupportedProtocolVersion is -32022, not -32602.
		expect(body.error.code).toBe(-32022);
		expect(body.error.message).toMatch(/unsupported protocol version/i);
		expect(body.error.data).toMatchObject({
			requested: "1999-01-01",
		});
	});

	it("echoes the request id on an unsupported-version rejection (SEP-2575)", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: ACCEPT_BOTH,
					"Content-Type": "application/json",
					"MCP-Protocol-Version": "1999-01-01",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 301,
					method: "tools/list",
				}),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { id?: unknown };
		// The version check runs after body parse specifically so the JSON-RPC
		// error can carry the request id instead of `id: null`.
		expect(body.id).toBe(301);
	});
});

// =============================================================================
// MCP 2026-07-28 — modern protocol mode
// =============================================================================

const MODERN = MCP_MODERN_PROTOCOL_VERSION;
// The finalized 2026-07-28 revision requires all three request _meta fields.
const MODERN_META = {
	[MCP_PROTOCOL_VERSION_META_KEY]: MODERN,
	[MCP_CLIENT_INFO_META_KEY]: { name: "test-client", version: "1" },
	[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
};

// A caller that DECLARED the tasks extension — the only shape accepted for task
// RPCs now that the no-capabilities exemption is removed.
// Only the clientCapabilities block is set (no protocolVersion key) so these
// legacy-header `postRpc` requests carry the capability the gate reads without
// tripping the MCP-Protocol-Version header/_meta equality check.
const TASKS_META = {
	[MCP_CLIENT_CAPABILITIES_META_KEY]: {
		extensions: { [MCP_TASKS_EXTENSION]: {} },
	},
};

function modernPost(
	body: { id: number; method: string; params?: Record<string, unknown> },
	headers: Record<string, string | null> = {},
) {
	const requestHeaders = new Headers({
		Accept: ACCEPT_BOTH,
		"Content-Type": "application/json",
		"MCP-Protocol-Version": MODERN,
		[MCP_METHOD_HEADER]: body.method,
	});
	for (const [name, value] of Object.entries(headers)) {
		if (value === null) requestHeaders.delete(name);
		else requestHeaders.set(name, value);
	}
	return new Request(URL_OK, {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({ jsonrpc: "2.0", ...body }),
	});
}

describe("transport — MCP 2026-07-28 modern mode", () => {
	it("provides a fail-closed gate for Tedix-owned POST mounts", async () => {
		const missing = enforceModernMcpProtocol(
			new Request(URL_OK, { method: "POST" }),
		);
		expect(missing?.status).toBe(400);
		expect(await missing?.json()).toMatchObject({
			error: { code: -32_022 },
		});
		expect(
			enforceModernMcpProtocol(modernPost({ id: 1, method: "ping" })),
		).toBeNull();
		expect(
			enforceModernMcpProtocol(new Request(URL_OK, { method: "DELETE" })),
		).toBeNull();
	});
	it("server/discover advertises the modern protocol version", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 50, method: "server/discover" }),
			{
				discover: {
					serverInfo: { name: "parity-test", version: "0.0.1" },
					capabilities: { tools: {} },
				},
			},
		);
		const body = (await res.json()) as {
			result: {
				supportedVersions: string[];
				ttlMs?: number;
				cacheScope?: string;
			};
		};
		expect(body.result.supportedVersions).toContain(MODERN);
		// Additive: legacy versions remain advertised for external/legacy hosts.
		expect(body.result.supportedVersions).toContain("2025-11-25");
		expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
	});

	it("server/discover requires its matching method header", async () => {
		const res = await call(
			modernPost({
				id: 51,
				method: "server/discover",
				params: { _meta: MODERN_META },
			}),
			{
				discover: {
					serverInfo: { name: "parity-test", version: "0.0.1" },
					capabilities: { tools: {} },
				},
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result?: { _meta?: Record<string, unknown> };
		};
		expect(body.result?._meta?.[MCP_SERVER_INFO_META_KEY]).toEqual({
			name: "parity-test",
			version: "0.0.1",
		});
	});

	it("stamps trusted serverInfo onto every successful modern result", async () => {
		const res = await call(
			modernPost({
				id: 510,
				method: "tools/list",
				params: { _meta: MODERN_META },
			}),
			{
				discover: {
					serverInfo: { name: "trusted-transport", version: "1.2.3" },
				},
				resultTransform: ({ response }) => {
					if (
						!("result" in response) ||
						response.result === null ||
						typeof response.result !== "object" ||
						Array.isArray(response.result)
					) {
						return response;
					}
					return {
						...response,
						result: {
							...response.result,
							_meta: {
								[MCP_SERVER_INFO_META_KEY]: {
									name: "forged-handler",
									version: "0",
								},
							},
						},
					};
				},
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result?: { _meta?: Record<string, unknown> };
		};
		expect(body.result?._meta?.[MCP_SERVER_INFO_META_KEY]).toEqual({
			name: "trusted-transport",
			version: "1.2.3",
		});
	});

	it("requires the modern _meta envelope on server/discover (-32602)", async () => {
		const res = await call(
			modernPost({ id: 511, method: "server/discover", params: {} }),
			{
				discover: {
					serverInfo: { name: "parity-test", version: "0.0.1" },
					capabilities: { tools: {} },
				},
			},
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { code?: number } };
		expect(body.error?.code).toBe(-32602);
	});

	it("rejects the removed initialize handshake under 2026-07-28 (-32601, HTTP 404)", async () => {
		const res = await call(
			modernPost({
				id: 52,
				method: "initialize",
				params: {
					protocolVersion: MODERN,
					capabilities: {},
					clientInfo: { name: "c", version: "1" },
				},
			}),
		);
		// Removed-method parity: `initialize` answers method-not-found + 404
		// exactly like every other removed 2025 method.
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
	});

	it("accepts a fully-bound modern tools/call", async () => {
		const res = await call(
			modernPost(
				{
					id: 53,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "modern" },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ text: string }> };
		};
		expect(body.result.content[0]?.text).toBe("echo:modern");
	});

	// SEP-2243 inbound Mcp-Param-* validation is wired through mountMcp via a
	// toolSchemaLookup that binds `echo`'s `msg` arg to an `Msg` header.
	const echoHeaderSchema = {
		type: "object",
		properties: { msg: { type: "string", "x-mcp-header": "Msg" } },
		required: ["msg"],
	};
	const callWithParamSchema = (req: Request) =>
		call(req, { toolSchemaLookup: () => echoHeaderSchema });

	it("accepts a modern tools/call whose Mcp-Param header matches the body", async () => {
		const res = await callWithParamSchema(
			modernPost(
				{
					id: 570,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "bound" },
						_meta: MODERN_META,
					},
				},
				{
					"Mcp-Method": "tools/call",
					"Mcp-Name": "echo",
					"Mcp-Param-Msg": "bound",
				},
			),
		);
		expect(res.status).toBe(200);
	});

	it("rejects a modern tools/call whose bound Mcp-Param header is omitted (-32020)", async () => {
		const res = await callWithParamSchema(
			modernPost(
				{
					id: 571,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "bound" },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: number; data?: { header?: string } };
		};
		expect(body.error.code).toBe(-32020);
		expect(body.error.data?.header).toBe("Mcp-Param-Msg");
	});

	it("rejects a modern tools/call whose Mcp-Param header disagrees with the body (-32020)", async () => {
		const res = await callWithParamSchema(
			modernPost(
				{
					id: 572,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "bound" },
						_meta: MODERN_META,
					},
				},
				{
					"Mcp-Method": "tools/call",
					"Mcp-Name": "echo",
					"Mcp-Param-Msg": "different",
				},
			),
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
			-32020,
		);
	});

	it("rejects modern request missing Mcp-Method (-32020)", async () => {
		const res = await call(
			modernPost(
				{
					id: 540,
					method: "tools/list",
					params: { _meta: MODERN_META },
				},
				{ [MCP_METHOD_HEADER]: null },
			),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32020);
	});

	it("rejects modern request with mismatched Mcp-Method (-32020)", async () => {
		const res = await call(
			modernPost(
				{
					id: 54,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "tools/list", "Mcp-Name": "echo" },
			),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			id: number | null;
			error: { code: number };
		};
		// The rejection echoes the request id (the id is known at this point).
		expect(body.id).toBe(54);
		expect(body.error.code).toBe(-32020);
	});

	it("rejects modern tools/call with mismatched Mcp-Name (-32020)", async () => {
		const res = await call(
			modernPost(
				{
					id: 55,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "boom" },
			),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32020);
	});

	it("validates Mcp-Name on modern task methods only when present (current SDK v2 clients never send it for tasks/*)", async () => {
		const now = new Date().toISOString();
		const taskHandlers = {
			async get({ taskId }: { taskId: string }) {
				return {
					taskId,
					status: "working" as const,
					createdAt: now,
					lastUpdatedAt: now,
					ttlMs: 60_000,
				};
			},
			async update() {},
			async cancel() {},
		};
		// Declares the tasks extension so this stays a pure Mcp-Name binding
		// test — capability-gate rejection is covered separately below.
		const params = {
			taskId: "task_modern",
			_meta: {
				...MODERN_META,
				[MCP_CLIENT_CAPABILITIES_META_KEY]: {
					extensions: { [MCP_TASKS_EXTENSION]: {} },
				},
			},
		};

		// Absent header → pass (lenient inbound; Tedix stays strict outbound).
		const absent = await call(
			modernPost(
				{ id: 550, method: "tasks/get", params },
				{ "Mcp-Method": "tasks/get" },
			),
			{ taskHandlers },
		);
		expect(absent.status).toBe(200);
		await expect(absent.json()).resolves.toMatchObject({
			result: { resultType: "complete", taskId: "task_modern" },
		});

		// Present-but-mismatched header → still -32020.
		const mismatched = await call(
			modernPost(
				{ id: 552, method: "tasks/get", params },
				{ "Mcp-Method": "tasks/get", "Mcp-Name": "task_other" },
			),
			{ taskHandlers },
		);
		expect(mismatched.status).toBe(400);
		await expect(mismatched.json()).resolves.toMatchObject({
			id: 552,
			error: { code: -32020 },
		});

		const matched = await call(
			modernPost(
				{ id: 551, method: "tasks/get", params },
				{ "Mcp-Method": "tasks/get", "Mcp-Name": "task_modern" },
			),
			{ taskHandlers },
		);
		expect(matched.status).toBe(200);
		await expect(matched.json()).resolves.toMatchObject({
			result: { resultType: "complete", taskId: "task_modern" },
		});
	});

	it("rejects modern request missing protocol version in _meta (-32602)", async () => {
		const res = await call(
			modernPost(
				{
					id: 56,
					method: "tools/call",
					params: { name: "echo", arguments: { msg: "x" } },
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32602);
	});

	it("accepts a modern request without optional clientInfo", async () => {
		const res = await call(
			modernPost(
				{
					id: 58,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: {
							"io.modelcontextprotocol/protocolVersion": MODERN,
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
		);
		expect(res.status).toBe(200);
	});

	it("does not enforce modern binding for legacy callers", async () => {
		// No MCP-Protocol-Version header → legacy path, no Mcp-Method/Mcp-Name required.
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 57,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: "legacy" } },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ text: string }> };
		};
		expect(body.result.content[0]?.text).toBe("echo:legacy");
	});

	it("decodes a =?base64?…?= sentinel Mcp-Name before the body comparison", async () => {
		const matched = await call(
			modernPost(
				{
					id: 590,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "encoded" },
						_meta: MODERN_META,
					},
				},
				{
					"Mcp-Method": "tools/call",
					// base64("echo") — spec: servers MUST decode before comparing.
					"Mcp-Name": "=?base64?ZWNobw==?=",
				},
			),
		);
		expect(matched.status).toBe(200);
		const body = (await matched.json()) as {
			result: { content: Array<{ text: string }> };
		};
		expect(body.result.content[0]?.text).toBe("echo:encoded");

		const mismatched = await call(
			modernPost(
				{
					id: 591,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: MODERN_META,
					},
				},
				{
					"Mcp-Method": "tools/call",
					// base64("boom") — decoded value must still match the body.
					"Mcp-Name": "=?base64?Ym9vbQ==?=",
				},
			),
		);
		expect(mismatched.status).toBe(400);
		await expect(mismatched.json()).resolves.toMatchObject({
			id: 591,
			error: { code: -32020 },
		});
	});

	it("answers a modern method-not-found with HTTP 404, legacy with 200 (body unchanged)", async () => {
		const modern = await call(
			modernPost(
				{
					id: 592,
					method: "nonexistent/method",
					params: { _meta: MODERN_META },
				},
				{ "Mcp-Method": "nonexistent/method" },
			),
		);
		expect(modern.status).toBe(404);
		await expect(modern.json()).resolves.toMatchObject({
			id: 592,
			error: { code: -32601 },
		});

		const legacy = await call(
			postRpc({ jsonrpc: "2.0", id: 593, method: "nonexistent/method" }),
		);
		expect(legacy.status).toBe(200);
		await expect(legacy.json()).resolves.toMatchObject({
			id: 593,
			error: { code: -32601 },
		});
	});

	it("rejects a header ↔ _meta protocol-version mismatch as HeaderMismatch (-32020, HTTP 400)", async () => {
		// Header declares a supported legacy version while _meta claims the
		// modern one — this is a per-request binding mismatch, not an
		// unsupported version (-32022 stays reserved for the header ladder).
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 594,
				method: "tools/call",
				params: {
					name: "echo",
					arguments: { msg: "x" },
					_meta: { [MCP_PROTOCOL_VERSION_META_KEY]: MODERN },
				},
			}),
		);
		expect(res.status).toBe(400);
		await expect(res.json()).resolves.toMatchObject({
			id: 594,
			error: {
				code: -32020,
				data: {
					header: "MCP-Protocol-Version",
					expected: MODERN,
					received: null,
				},
			},
		});

		const legacyHeader = await call(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: ACCEPT_BOTH,
					"Content-Type": "application/json",
					"MCP-Protocol-Version": "2025-11-25",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 595,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: { [MCP_PROTOCOL_VERSION_META_KEY]: MODERN },
					},
				}),
			}),
		);
		expect(legacyHeader.status).toBe(400);
		await expect(legacyHeader.json()).resolves.toMatchObject({
			id: 595,
			error: {
				code: -32020,
				data: {
					header: "MCP-Protocol-Version",
					expected: MODERN,
					received: "2025-11-25",
				},
			},
		});
	});
});

// =============================================================================
// MCP PROTOCOL — initialize / tools/list / tools/call
// =============================================================================

describe("transport — MCP protocol", () => {
	it("initialize succeeds with capabilities + serverInfo", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "parity-test-client", version: "0.0.1" },
				},
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/json");
		const body = (await res.json()) as {
			id: number;
			result: { serverInfo: { name: string }; capabilities: object };
		};
		expect(body.id).toBe(1);
		expect(body.result.serverInfo.name).toBe("parity-test");
		expect(body.result.capabilities).toBeDefined();
	});

	it("tools/list returns the registered tools", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { resultType: string; tools: Array<{ name: string }> };
		};
		const names = body.result.tools.map((t) => t.name).sort();
		expect(names).toEqual(["boom", "echo", "meta_echo", "paid", "paid_v2"]);
		expect(body.result).toMatchObject({
			resultType: "complete",
			ttlMs: 60_000,
			cacheScope: "private",
		});
	});

	it("server/discover returns capability discovery when mounted", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 20, method: "server/discover" }),
			{
				discover: {
					serverInfo: { name: "parity-test", version: "0.0.1" },
					capabilities: { tools: {} },
				},
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: {
				resultType: string;
				supportedVersions: string[];
				_meta?: Record<string, unknown>;
			};
		};
		expect(body.result.resultType).toBe("complete");
		expect(body.result.supportedVersions).toContain("2025-11-25");
		expect(body.result._meta?.[MCP_SERVER_INFO_META_KEY]).toBeUndefined();
	});

	it("server/discover omits optional server identity when none is mounted", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 201, method: "server/discover" }),
			{
				discover: {},
			},
		);
		const body = (await res.json()) as {
			result: { _meta?: Record<string, unknown> };
		};
		expect(body.result._meta?.[MCP_SERVER_INFO_META_KEY]).toBeUndefined();
	});

	it("server/discover does not advertise Tasks without task handlers", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 20, method: "server/discover" }),
			{
				discover: {
					serverInfo: { name: "parity-test", version: "0.0.1" },
					capabilities: { tools: {} },
				},
			},
		);
		const body = (await res.json()) as {
			result: { capabilities: { extensions?: Record<string, unknown> } };
		};
		expect(body.result.capabilities.extensions?.[MCP_TASKS_EXTENSION]).toBe(
			undefined,
		);
	});

	it("server/discover advertises Tasks only when task handlers are mounted", async () => {
		const now = new Date().toISOString();
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 20, method: "server/discover" }),
			{
				discover: {
					serverInfo: { name: "parity-test", version: "0.0.1" },
					capabilities: { tools: {}, extensions: { existing: {} } },
				},
				taskHandlers: {
					async get() {
						return {
							taskId: "task_test",
							status: "working",
							createdAt: now,
							lastUpdatedAt: now,
							ttlMs: 60_000,
						};
					},
					async update() {
						return undefined;
					},
					async cancel() {
						return undefined;
					},
				},
			},
		);
		const body = (await res.json()) as {
			result: { capabilities: { extensions?: Record<string, unknown> } };
		};
		expect(body.result.capabilities.extensions).toMatchObject({
			existing: {},
			[MCP_TASKS_EXTENSION]: {},
		});
	});

	it("tasks/get returns method-not-found until task handlers are mounted", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 31,
				method: "tasks/get",
				params: { taskId: "task_missing" },
			}),
		);
		const body = (await res.json()) as {
			error: { code: number; message: string };
		};
		expect(body.error).toMatchObject({
			code: -32601,
			message: "Method not found: tasks/get",
		});
	});

	it("task handlers implement current tasks/get, tasks/update, and tasks/cancel", async () => {
		const now = new Date().toISOString();
		const task = {
			taskId: "task_live",
			status: "input_required" as const,
			statusMessage: "Waiting for approval",
			createdAt: now,
			lastUpdatedAt: now,
			ttlMs: 60_000,
			pollIntervalMs: 1_000,
			inputRequests: {
				approval_1: {
					method: "elicitation/create",
					params: { message: "Approve?" },
				},
			},
		};
		const taskHandlers = {
			async get({ taskId }: { taskId: string }) {
				if (taskId !== task.taskId) throw McpTaskError.notFound(taskId);
				return task;
			},
			async update({
				taskId,
				inputResponses,
			}: {
				taskId: string;
				inputResponses: Record<string, unknown>;
			}) {
				if (taskId !== task.taskId) throw McpTaskError.notFound(taskId);
				expect(inputResponses).toMatchObject({ approval_1: { ok: true } });
				return undefined;
			},
			async cancel({ taskId }: { taskId: string }) {
				if (taskId !== task.taskId) throw McpTaskError.notFound(taskId);
				return undefined;
			},
		};

		const getRes = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 32,
				method: "tasks/get",
				params: { taskId: task.taskId, _meta: TASKS_META },
			}),
			{ taskHandlers },
		);
		const getBody = (await getRes.json()) as {
			result: typeof task & { resultType: string };
		};
		expect(getBody.result).toMatchObject({
			resultType: "complete",
			taskId: task.taskId,
			status: "input_required",
			inputRequests: task.inputRequests,
		});

		const updateRes = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 33,
				method: "tasks/update",
				params: {
					taskId: task.taskId,
					inputResponses: { approval_1: { ok: true } },
					_meta: TASKS_META,
				},
			}),
			{ taskHandlers },
		);
		await expect(updateRes.json()).resolves.toMatchObject({
			result: { resultType: "complete" },
		});

		const cancelRes = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 34,
				method: "tasks/cancel",
				params: { taskId: task.taskId, _meta: TASKS_META },
			}),
			{ taskHandlers },
		);
		await expect(cancelRes.json()).resolves.toMatchObject({
			result: { resultType: "complete" },
		});
	});

	it("tasks/get unknown id returns InvalidParams when handler reports not found", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 35,
				method: "tasks/get",
				params: { taskId: "missing", _meta: TASKS_META },
			}),
			{
				taskHandlers: {
					async get({ taskId }) {
						throw McpTaskError.notFound(taskId);
					},
					async update() {
						return undefined;
					},
					async cancel() {
						return undefined;
					},
				},
			},
		);
		await expect(res.json()).resolves.toMatchObject({
			error: {
				code: -32602,
				message: "Task not found",
				data: { taskId: "missing" },
			},
		});
	});

	it("tasks/update requires inputResponses", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 36,
				method: "tasks/update",
				params: { taskId: "task_live", _meta: TASKS_META },
			}),
			{
				taskHandlers: {
					async get() {
						throw new Error("unused");
					},
					async update() {
						return undefined;
					},
					async cancel() {
						return undefined;
					},
				},
			},
		);
		await expect(res.json()).resolves.toMatchObject({
			error: {
				code: -32602,
				message: "Invalid params: inputResponses is required",
			},
		});
	});

	it("rejects tasks/get from a modern client that declared capabilities without the tasks extension (-32021)", async () => {
		const now = new Date().toISOString();
		const taskHandlers = {
			async get({ taskId }: { taskId: string }) {
				return {
					taskId,
					status: "working" as const,
					createdAt: now,
					lastUpdatedAt: now,
					ttlMs: 60_000,
				};
			},
			async update() {},
			async cancel() {},
		};
		const params = { taskId: "task_modern", _meta: MODERN_META };

		const res = await call(
			modernPost(
				{ id: 552, method: "tasks/get", params },
				{ "Mcp-Method": "tasks/get", "Mcp-Name": "task_modern" },
			),
			{ taskHandlers },
		);
		// Spec mandates HTTP 400 for -32021 with no origin condition (SDK
		// SDK v2 parity): the post-dispatch task-gate emission answers 400 too,
		// JSON-RPC body unchanged.
		expect(res.status).toBe(400);
		// `requiredCapabilities` is a ClientCapabilities OBJECT (spec schema +
		// SDK v2 MissingRequiredClientCapabilityError parser), not an array.
		await expect(res.json()).resolves.toMatchObject({
			error: {
				code: -32021,
				message:
					"Missing required client capability: io.modelcontextprotocol/tasks",
				data: {
					requiredCapabilities: {
						extensions: { [MCP_TASKS_EXTENSION]: {} },
					},
				},
			},
		});
	});

	it("rejects task RPCs from a legacy caller with no _meta (-32021, exemption removed)", async () => {
		// The Home/tedi compatibility-linkage exemption was removed with the compat
		// shims: a caller that never declares
		// `_meta.clientCapabilities` is no longer exempt. The 2026-07-28 tasks
		// extension is required, so task RPCs now reject with -32021 exactly as a
		// modern opt-out caller does.
		const now = new Date().toISOString();
		const taskHandlers = {
			async get({ taskId }: { taskId: string }) {
				return {
					taskId,
					status: "working" as const,
					createdAt: now,
					lastUpdatedAt: now,
					ttlMs: 60_000,
				};
			},
			async update() {
				return undefined;
			},
			async cancel() {
				return undefined;
			},
		};

		const getRes = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 560,
				method: "tasks/get",
				params: { taskId: "task_legacy" },
			}),
			{ taskHandlers },
		);
		await expect(getRes.json()).resolves.toMatchObject({
			error: {
				code: -32021,
				message:
					"Missing required client capability: io.modelcontextprotocol/tasks",
			},
		});
	});

	it("resultTransform can advertise array outputSchema on tools/list", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 21, method: "tools/list" }),
			{
				resultTransform: ({ request, response }) => {
					if (request.method !== "tools/list" || !("result" in response)) {
						return response;
					}
					const result = response.result as {
						tools?: Array<Record<string, unknown>>;
					};
					return {
						...response,
						result: {
							...result,
							tools: result.tools?.map((tool) =>
								tool.name === "echo"
									? {
											...tool,
											outputSchema: {
												type: "array",
												items: { type: "object" },
											},
										}
									: tool,
							),
						},
					};
				},
			},
		);
		const body = (await res.json()) as {
			result: { tools: Array<{ name: string; outputSchema?: unknown }> };
		};
		expect(
			body.result.tools.find((tool) => tool.name === "echo"),
		).toMatchObject({
			outputSchema: { type: "array" },
		});
	});

	it("tools/call success returns content", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: "hello" } },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		expect(body.result.content[0]).toMatchObject({
			type: "text",
			text: "echo:hello",
		});
	});

	it("tools/call handler error surfaces in result, not as protocol error", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "boom", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: number;
			result?: { isError?: boolean; content: Array<{ text: string }> };
			error?: { code: number };
		};
		expect(body.id).toBe(4);
		// SDK surfaces handler exceptions as { result: { isError: true, content } }
		// or as a JSON-RPC error envelope — both are valid; the message must reach
		// the client either way.
		const text =
			body.result?.content?.[0]?.text ??
			(body.error ? JSON.stringify(body.error) : "");
		expect(text).toMatch(/intentional-failure|-32603|-32000/);
	});

	it("tools/call with invalid arguments returns the SEP-1303 structured tool result, not -32602", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: 42 } },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: number;
			error?: { code: number };
			result?: {
				isError?: boolean;
				content: Array<{ type: string; text: string }>;
				structuredContent?: {
					error: string;
					tool: string;
					issues: Array<{ path?: string; message: string }>;
				};
				_meta?: Record<string, unknown>;
			};
		};
		expect(body.id).toBe(5);
		// SEP-1303 / 2026-07-28 spec: input validation errors are Tool Execution
		// Errors (result with isError: true), never a JSON-RPC Protocol Error.
		expect(body.error).toBeUndefined();
		expect(body.result?.isError).toBe(true);
		expect(body.result?.content[0]?.text).toMatch(
			/^Input validation error: Invalid arguments for tool echo: /,
		);
		// Tedix structured payload — deterministic self-correction, no prose parsing.
		expect(body.result?.structuredContent).toMatchObject({
			error: "input_validation_error",
			tool: "echo",
			issues: [{ path: "msg" }],
		});
		expect(body.result?.structuredContent?.issues[0]?.message).toBeTruthy();
		expect(body.result?._meta?.["com.tedix/error"]).toBe(
			"input_validation_error",
		);
	});

	it("tools/call with a missing required argument returns the structured validation result", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 6,
				method: "tools/call",
				params: { name: "echo", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			error?: unknown;
			result?: {
				isError?: boolean;
				structuredContent?: { error: string; tool: string };
			};
		};
		expect(body.error).toBeUndefined();
		expect(body.result?.isError).toBe(true);
		expect(body.result?.structuredContent).toMatchObject({
			error: "input_validation_error",
			tool: "echo",
		});
	});

	it("tools/call payment-required result becomes JSON-RPC 402", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 402,
				method: "tools/call",
				params: { name: "paid", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: number;
			error: {
				code: number;
				message: string;
				data: {
					x402Version: number;
					accepts: Array<{
						network: string;
						maxAmountRequired: string;
						extra?: { requirementId?: string };
					}>;
				};
			};
		};
		expect(body.id).toBe(402);
		expect(body.error.code).toBe(402);
		expect(body.error.message).toBe("Payment Required");
		expect(body.error.data.x402Version).toBe(1);
		expect(body.error.data.accepts[0]).toMatchObject({
			network: "solana-devnet",
			maxAmountRequired: "0.01",
			extra: { requirementId: "req_test_123" },
		});
	});

	it("keeps an x402 v2 payment challenge as a CallToolResult", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 403,
				method: "tools/call",
				params: { name: "paid_v2", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			error?: { code: number };
			result?: {
				isError?: boolean;
				_meta?: Record<string, { requirements?: { x402Version: number } }>;
			};
		};
		expect(body.error).toBeUndefined();
		expect(body.result?.isError).toBe(true);
		expect(
			body.result?._meta?.["x-tedix/payment-required"]?.requirements
				?.x402Version,
		).toBe(2);
	});

	it("reads an x402 v2 challenge without the Tedix bridge metadata", () => {
		const challenge = {
			x402Version: 2,
			resource: { url: "mcp://parity-test/tools/paid_v2" },
			accepts: [
				{
					scheme: "exact",
					network: "eip155:84532",
					asset: "USDC",
					amount: "10000",
					payTo: "test-recipient",
					maxTimeoutSeconds: 300,
					extra: { toolId: "paid_v2", requirementId: "req_v2_123" },
				},
			],
		};
		expect(
			getPaymentRequiredMeta({
				result: { _meta: { "x402/error": challenge } },
			}),
		).toMatchObject({
			toolId: "paid_v2",
			requirementId: "req_v2_123",
			requirements: challenge,
		});
	});

	it("notifications get 202 No Content", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
		);
		expect(res.status).toBe(202);
		expect(await res.text()).toBe("");
	});

	it("rejects JSON-RPC batches before dispatch", async () => {
		const res = await call(
			postRpc([
				{ jsonrpc: "2.0", id: 10, method: "tools/list" },
				{
					jsonrpc: "2.0",
					id: 11,
					method: "tools/call",
					params: { name: "echo", arguments: { msg: "batch" } },
				},
			]),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			error: { code: number; message: string };
		};
		expect(body.error.code).toBe(-32600);
		expect(body.error.message).toMatch(/batches are not supported/i);
	});
});

// =============================================================================
// DELETE — stateless cleanup
// =============================================================================

describe("transport — DELETE", () => {
	// MCP 2026-07-28 `basic/transports`: "HTTP GET or DELETE to the MCP endpoint:
	// respond with 405 Method Not Allowed." This previously asserted 200 ("parity
	// with WorkerTransport"), which told a client a session teardown had succeeded
	// when stateless transport has no session to tear down.
	it("DELETE returns 405 in stateless mode", async () => {
		const res = await call(new Request(URL_OK, { method: "DELETE" }));
		expect(res.status).toBe(405);
	});
});

// =============================================================================
// GET — server-initiated SSE not supported in stateless mode
// =============================================================================

describe("transport — GET", () => {
	it("GET returns 405 in stateless mode (no server-initiated stream)", async () => {
		const res = await call(
			new Request(URL_OK, {
				method: "GET",
				headers: { Accept: "text/event-stream" },
			}),
		);
		expect(res.status).toBe(405);
	});
});

// =============================================================================
// MCP 2026-07-28 — completion/complete (autocomplete)
// =============================================================================

describe("transport — completion/complete", () => {
	it("returns method-not-found when no completion handler is mounted", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 70,
				method: "completion/complete",
				params: {
					ref: { type: "ref/prompt", name: "greet" },
					argument: { name: "lang", value: "e" },
				},
			}),
		);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
	});

	it("server/discover advertises completions only when a handler is mounted", async () => {
		const withoutHandler = await call(
			postRpc({ jsonrpc: "2.0", id: 71, method: "server/discover" }),
			{ discover: { serverInfo: { name: "parity-test", version: "0.0.1" } } },
		);
		const withoutBody = (await withoutHandler.json()) as {
			result: { capabilities: Record<string, unknown> };
		};
		expect(withoutBody.result.capabilities.completions).toBeUndefined();

		const withHandler = await call(
			postRpc({ jsonrpc: "2.0", id: 72, method: "server/discover" }),
			{
				discover: { serverInfo: { name: "parity-test", version: "0.0.1" } },
				completionHandler: async () => ({ values: [] }),
			},
		);
		const withBody = (await withHandler.json()) as {
			result: { capabilities: Record<string, unknown> };
		};
		expect(withBody.result.capabilities.completions).toEqual({});
	});

	it("runs the handler and returns a capped completion result", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 73,
				method: "completion/complete",
				params: {
					ref: { type: "ref/prompt", name: "greet" },
					argument: { name: "lang", value: "e" },
					context: { arguments: { region: "eu" } },
				},
			}),
			{
				completionHandler: async (input) => {
					expect(input.ref).toMatchObject({
						type: "ref/prompt",
						name: "greet",
					});
					expect(input.argument).toEqual({ name: "lang", value: "e" });
					expect(input.context?.arguments).toEqual({ region: "eu" });
					return {
						// 150 values — must be capped to 100.
						values: Array.from({ length: 150 }, (_, i) => `v${i}`),
						total: 150,
						hasMore: true,
					};
				},
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: {
				completion: { values: string[]; total: number; hasMore: boolean };
			};
		};
		expect(body.result.completion.values).toHaveLength(100);
		expect(body.result.completion.total).toBe(150);
		expect(body.result.completion.hasMore).toBe(true);
	});

	it("rejects an invalid ref.type with -32602", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 74,
				method: "completion/complete",
				params: {
					ref: { type: "ref/bogus" },
					argument: { name: "x", value: "" },
				},
			}),
			{ completionHandler: async () => ({ values: [] }) },
		);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32602);
	});

	it("rejects incomplete completion refs with -32602", async () => {
		const promptRes = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 75,
				method: "completion/complete",
				params: {
					ref: { type: "ref/prompt" },
					argument: { name: "lang", value: "" },
				},
			}),
			{ completionHandler: async () => ({ values: [] }) },
		);
		const promptBody = (await promptRes.json()) as { error: { code: number } };
		expect(promptBody.error.code).toBe(-32602);

		const resourceRes = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 76,
				method: "completion/complete",
				params: {
					ref: { type: "ref/resource" },
					argument: { name: "branch", value: "" },
				},
			}),
			{ completionHandler: async () => ({ values: [] }) },
		);
		const resourceBody = (await resourceRes.json()) as {
			error: { code: number };
		};
		expect(resourceBody.error.code).toBe(-32602);
	});
});

// =============================================================================
// MCP 2026-07-28 — resources/directory/read
// =============================================================================

describe("transport — resources/directory/read", () => {
	it("returns method-not-found when no directory handler is mounted", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 80,
				method: "resources/directory/read",
				params: { uri: "skill://deploy-review" },
			}),
		);
		const body = (await res.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
	});

	it("routes directory reads to the mounted handler", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 81,
				method: "resources/directory/read",
				params: { uri: "skill://deploy-review" },
			}),
			{
				directoryReadHandler: ({ uri }) => ({
					resources: [
						{
							uri: `${uri}/SKILL.md`,
							name: "SKILL.md",
							mimeType: "text/markdown",
						},
						{
							uri: `${uri}/references`,
							name: "references",
							mimeType: "inode/directory",
						},
					],
				}),
			},
		);
		const body = (await res.json()) as {
			result: { resources: Array<Record<string, unknown>> };
		};
		expect(body.result.resources).toContainEqual({
			uri: "skill://deploy-review/SKILL.md",
			name: "SKILL.md",
			mimeType: "text/markdown",
		});
		expect(body.result.resources).toContainEqual({
			uri: "skill://deploy-review/references",
			name: "references",
			mimeType: "inode/directory",
		});
		expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
	});

	it("binds modern Mcp-Name to the directory URI", async () => {
		const res = await call(
			modernPost(
				{
					id: 82,
					method: "resources/directory/read",
					params: {
						uri: "skill://deploy-review",
						_meta: MODERN_META,
					},
				},
				{
					"Mcp-Method": "resources/directory/read",
					"Mcp-Name": "skill://deploy-review",
				},
			),
			{
				directoryReadHandler: ({ uri }) => ({
					resources: [
						{
							uri: `${uri}/SKILL.md`,
							name: "SKILL.md",
							mimeType: "text/markdown",
						},
					],
				}),
			},
		);
		const body = (await res.json()) as {
			result: { resources: Array<Record<string, unknown>> };
		};
		expect(body.result.resources[0]).toMatchObject({
			uri: "skill://deploy-review/SKILL.md",
		});
	});

	it("returns Invalid params for non-directory resources", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 83,
				method: "resources/directory/read",
				params: { uri: "skill://deploy-review/SKILL.md" },
			}),
			{
				directoryReadHandler: () => {
					throw new Error("Resource is not a directory");
				},
			},
		);
		const body = (await res.json()) as {
			error: { code: number; message: string };
		};
		expect(body.error.code).toBe(-32602);
		expect(body.error.message).toContain("Resource is not a directory");
	});
});

// =============================================================================
// MCP 2026-07-28 — -32021 MissingRequiredClientCapability
// =============================================================================

describe("transport — required client extensions (-32021)", () => {
	it("rejects a modern request missing a required client extension", async () => {
		const res = await call(
			modernPost(
				{
					id: 75,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: MODERN_META, // clientCapabilities = {} (no extensions)
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
			{ requiredClientExtensions: ["io.modelcontextprotocol/tasks"] },
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as {
			id: number | null;
			error: {
				code: number;
				data?: { requiredCapabilities?: Record<string, unknown> };
			};
		};
		expect(body.id).toBe(75);
		expect(body.error.code).toBe(-32021);
		expect(body.error.data?.requiredCapabilities).toEqual({
			extensions: { "io.modelcontextprotocol/tasks": {} },
		});
	});

	it("accepts a modern request that declares the required extension", async () => {
		const res = await call(
			modernPost(
				{
					id: 76,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "ok" },
						_meta: {
							[MCP_PROTOCOL_VERSION_META_KEY]: MODERN,
							[MCP_CLIENT_INFO_META_KEY]: { name: "c", version: "1" },
							[MCP_CLIENT_CAPABILITIES_META_KEY]: {
								extensions: { [MCP_TASKS_EXTENSION]: {} },
							},
						},
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
			{ requiredClientExtensions: [MCP_TASKS_EXTENSION] },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ text: string }> };
		};
		expect(body.result.content[0]?.text).toBe("echo:ok");
	});

	it("does not enforce required extensions on legacy callers", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 77,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: "legacy" } },
			}),
			{ requiredClientExtensions: ["io.modelcontextprotocol/tasks"] },
		);
		expect(res.status).toBe(200);
	});
});

// =============================================================================
// MCP 2026-07-28 — subscriptions/listen (stateless rejection)
// =============================================================================

describe("transport — subscriptions/listen", () => {
	it("rejects with a spec-shaped method-not-found explaining the stateless stance", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 78, method: "subscriptions/listen" }),
		);
		// Still a normal one-shot JSON response — never crashes or hangs.
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: number;
			error: { code: number; message: string; data?: { reason?: string } };
		};
		expect(body.id).toBe(78);
		expect(body.error.code).toBe(-32601);
		expect(body.error.message).toMatch(/stateless/i);
		expect(body.error.data?.reason).toBe("stateless-transport");
	});
});

describe("transport — canonical MRTR retry params", () => {
	it("adapts canonical inputResponses/requestState into handler metadata", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 91,
				method: "tools/call",
				params: {
					name: "meta_echo",
					arguments: {},
					inputResponses: {
						approval: { content: { reason: "approved by agent" } },
					},
					requestState: "opaque-state",
				},
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ text: string }> };
		};
		const meta = JSON.parse(body.result.content[0]!.text) as Record<
			string,
			unknown
		>;
		expect(meta["tedix/inputResponses"]).toMatchObject({
			requestState: "opaque-state",
			inputResponses: {
				approval: { content: { reason: "approved by agent" } },
			},
			content: { reason: "approved by agent" },
		});
	});
});

// =============================================================================
// validateModernProtocolHeaders — shared SEP-2243 ladder (unit, no HTTP)
// =============================================================================
// Direct unit coverage for the exported ladder, decoupled from mountMcp/HTTP
// so a non-transport caller (e.g. apps/mcp/src/index.ts's fast-path
// subscriptions/listen validation) can be confident the shared function
// behaves identically to the transport's own `validateModernRequest`, which
// is asserted end-to-end in the "MCP 2026-07-28 modern mode" suite above.

describe("validateModernProtocolHeaders", () => {
	const fullMeta = {
		[MCP_PROTOCOL_VERSION_META_KEY]: MODERN,
		[MCP_CLIENT_INFO_META_KEY]: { name: "test-client", version: "1" },
		[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
	};

	function headersWith(extra: Record<string, string> = {}) {
		return new Headers({ "MCP-Protocol-Version": MODERN, ...extra });
	}

	it("is a no-op when the caller does not declare the modern protocol version", () => {
		const result = validateModernProtocolHeaders({
			headers: new Headers(),
			method: "tools/call",
			params: {},
		});
		expect(result).toBeNull();
	});

	it("is a no-op when the caller declares a legacy protocol version", () => {
		const result = validateModernProtocolHeaders({
			headers: new Headers({ "MCP-Protocol-Version": "2025-11-25" }),
			method: "tools/call",
			params: {},
		});
		expect(result).toBeNull();
	});

	it("rejects the initialize handshake (-32601, removed-method parity)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith(),
			method: "initialize",
			params: {},
		});
		expect(result?.code).toBe(-32601);
		expect(result?.message).toMatch(/initialize handshake is removed/i);
	});

	it("requires server/discover to bind Mcp-Method", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ [MCP_METHOD_HEADER]: "server/discover" }),
			method: "server/discover",
			params: { _meta: fullMeta },
		});
		expect(result).toBeNull();
	});

	it("rejects server/discover without Mcp-Method", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith(),
			method: "server/discover",
			params: { _meta: fullMeta },
		});
		expect(result?.code).toBe(-32020);
	});

	it("requires server/discover to carry the modern meta envelope (-32602)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ [MCP_METHOD_HEADER]: "server/discover" }),
			method: "server/discover",
			params: {},
		});
		expect(result?.code).toBe(-32602);
	});

	it("rejects a mismatched Mcp-Method (-32020)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/list" }),
			method: "tools/call",
			params: { name: "echo", _meta: fullMeta },
		});
		expect(result?.code).toBe(-32020);
		expect(result?.data).toMatchObject({ header: "Mcp-Method" });
	});

	it("rejects a mismatched Mcp-Name for a name-required method (-32020)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({
				"Mcp-Method": "tools/call",
				"Mcp-Name": "other",
			}),
			method: "tools/call",
			params: { name: "echo", _meta: fullMeta },
		});
		expect(result?.code).toBe(-32020);
		expect(result?.data).toMatchObject({
			header: "Mcp-Name",
			expected: "echo",
		});
	});

	it("still requires Mcp-Name on tools/call when absent (-32020)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call" }),
			method: "tools/call",
			params: { name: "echo", _meta: fullMeta },
		});
		expect(result?.code).toBe(-32020);
		expect(result?.data).toMatchObject({ header: "Mcp-Name", received: null });
	});

	it("binds skills/get to its skill URI", () => {
		const uri = "skill://tedix/deploy-worker/SKILL.md";
		expect(
			validateModernProtocolHeaders({
				headers: headersWith({
					[MCP_METHOD_HEADER]: "skills/get",
					[MCP_NAME_HEADER]: uri,
				}),
				method: "skills/get",
				params: { uri, _meta: fullMeta },
			}),
		).toBeNull();
		expect(
			validateModernProtocolHeaders({
				headers: headersWith({ [MCP_METHOD_HEADER]: "skills/get" }),
				method: "skills/get",
				params: { uri, _meta: fullMeta },
			})?.code,
		).toBe(-32020);
	});

	it("validates Mcp-Name only when present for tasks/* and resources/directory/read", () => {
		for (const [method, params] of [
			["tasks/get", { taskId: "task_x", _meta: fullMeta }],
			["tasks/update", { taskId: "task_x", _meta: fullMeta }],
			["tasks/cancel", { taskId: "task_x", _meta: fullMeta }],
			["resources/directory/read", { uri: "skill://x", _meta: fullMeta }],
		] as const) {
			// Absent header → pass (the current SDK v2 client never sends it here).
			expect(
				validateModernProtocolHeaders({
					headers: headersWith({ "Mcp-Method": method }),
					method,
					params: { ...params },
				}),
			).toBeNull();

			// Present header → must still match the body target.
			const mismatch = validateModernProtocolHeaders({
				headers: headersWith({ "Mcp-Method": method, "Mcp-Name": "wrong" }),
				method,
				params: { ...params },
			});
			expect(mismatch?.code).toBe(-32020);
			expect(mismatch?.data).toMatchObject({ header: "Mcp-Name" });
		}
	});

	it("decodes an encoded Mcp-Name for a non-header-safe target before comparing", () => {
		const target = "wörld tool";
		const encoded = encodeMcpHeaderValue(target);
		expect(encoded).toMatch(/^=\?base64\?/);
		const result = validateModernProtocolHeaders({
			headers: headersWith({
				"Mcp-Method": "tools/call",
				"Mcp-Name": encoded as string,
			}),
			method: "tools/call",
			params: { name: target, _meta: fullMeta },
		});
		expect(result).toBeNull();

		const mismatch = validateModernProtocolHeaders({
			headers: headersWith({
				"Mcp-Method": "tools/call",
				"Mcp-Name": encodeMcpHeaderValue("änders") as string,
			}),
			method: "tools/call",
			params: { name: target, _meta: fullMeta },
		});
		expect(mismatch?.code).toBe(-32020);
	});

	it("rejects a request missing _meta protocol version (-32602)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: { name: "echo" },
		});
		expect(result?.code).toBe(-32602);
		expect(result?.data).toMatchObject({
			field: "_meta.io.modelcontextprotocol/protocolVersion",
		});
	});

	it("rejects a present-but-different _meta protocol version as HeaderMismatch (-32020)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: {
				name: "echo",
				_meta: {
					[MCP_PROTOCOL_VERSION_META_KEY]: "v999.0.0",
					[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		});
		expect(result?.code).toBe(-32020);
		expect(result?.data).toMatchObject({
			expected: MODERN,
			received: "v999.0.0",
		});
	});

	it("accepts a request missing optional _meta clientInfo", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: {
				name: "echo",
				_meta: {
					[MCP_PROTOCOL_VERSION_META_KEY]: MODERN,
					[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
				},
			},
		});
		expect(result).toBeNull();
	});

	it("rejects a request missing _meta clientCapabilities (-32602)", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: {
				name: "echo",
				_meta: {
					[MCP_PROTOCOL_VERSION_META_KEY]: MODERN,
					[MCP_CLIENT_INFO_META_KEY]: { name: "c", version: "1" },
				},
			},
		});
		expect(result?.code).toBe(-32602);
		expect(result?.data).toMatchObject({
			field: "_meta.io.modelcontextprotocol/clientCapabilities",
		});
	});

	it("passes a fully-bound modern request", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: { name: "echo", _meta: fullMeta },
		});
		expect(result).toBeNull();
	});

	it("rejects a request missing a required client extension (-32021) with a ClientCapabilities-shaped data object", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: { name: "echo", _meta: fullMeta },
			requiredClientExtensions: [MCP_TASKS_EXTENSION],
		});
		expect(result?.code).toBe(-32021);
		expect(result?.data).toEqual({
			requiredCapabilities: {
				extensions: { [MCP_TASKS_EXTENSION]: {} },
			},
		});
	});

	it("passes when the required client extension is declared", () => {
		const result = validateModernProtocolHeaders({
			headers: headersWith({ "Mcp-Method": "tools/call", "Mcp-Name": "echo" }),
			method: "tools/call",
			params: {
				name: "echo",
				_meta: {
					...fullMeta,
					[MCP_CLIENT_CAPABILITIES_META_KEY]: {
						extensions: { [MCP_TASKS_EXTENSION]: {} },
					},
				},
			},
			requiredClientExtensions: [MCP_TASKS_EXTENSION],
		});
		expect(result).toBeNull();
	});
});

// =============================================================================
// SEP-2549 — result-level cache hints (tedix/cacheHint marker)
// =============================================================================

describe("transport — SEP-2549 result-level cache hints", () => {
	/** Server with resources whose read handlers attach result-level hints. */
	function buildResourceServer() {
		const server = createMcpServer({ name: "hint-test", version: "0.0.1" });
		server.registerResource(
			"hinted",
			"res://hinted",
			{ description: "static template" },
			async () => ({
				contents: [{ uri: "res://hinted", mimeType: "text/plain", text: "ok" }],
				_meta: {
					[MCP_RESULT_CACHE_HINT_META_KEY]: {
						ttlMs: 3_600_000,
						cacheScope: "public" as const,
					},
					"io.tedix/keep": true,
				},
			}),
		);
		server.registerResource(
			"bad-hint",
			"res://bad-hint",
			{ description: "invalid marker" },
			async () => ({
				contents: [
					{ uri: "res://bad-hint", mimeType: "text/plain", text: "ok" },
				],
				_meta: {
					[MCP_RESULT_CACHE_HINT_META_KEY]: { ttlMs: -5, cacheScope: "org" },
				},
			}),
		);
		server.registerResource(
			"stale",
			"res://stale",
			{ description: "immediately stale" },
			async () => ({
				contents: [{ uri: "res://stale", mimeType: "text/plain", text: "ok" }],
				_meta: { [MCP_RESULT_CACHE_HINT_META_KEY]: { ttlMs: 0 } },
			}),
		);
		return server;
	}

	async function readResource(uri: string) {
		const res = await mountMcp(
			buildResourceServer(),
			postRpc({
				jsonrpc: "2.0",
				id: 90,
				method: "resources/read",
				params: { uri },
			}),
			// Presence of `requiredClientExtensions` pins the hand-rolled engine
			// (see `call()`): the tedix/cacheHint marker is that engine's plumbing.
			{
				cors: { origin: "https://example.com" },
				requiredClientExtensions: [],
			},
		);
		expect(res.status).toBe(200);
		return (await res.json()) as {
			result: {
				ttlMs?: number;
				cacheScope?: string;
				_meta?: Record<string, unknown>;
			};
		};
	}

	it("a handler-supplied marker wins over the per-method default and is stripped from _meta", async () => {
		const body = await readResource("res://hinted");
		expect(body.result).toMatchObject({
			ttlMs: 3_600_000,
			cacheScope: "public",
		});
		// The marker is transport plumbing, never wire payload — but sibling
		// _meta entries survive.
		expect(body.result._meta?.[MCP_RESULT_CACHE_HINT_META_KEY]).toBeUndefined();
		expect(body.result._meta?.["io.tedix/keep"]).toBe(true);
	});

	it("an invalid marker falls back to the per-method default (and is still stripped)", async () => {
		const body = await readResource("res://bad-hint");
		expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
		expect(body.result._meta?.[MCP_RESULT_CACHE_HINT_META_KEY]).toBeUndefined();
	});

	it("a partial marker overrides per field — ttlMs: 0 (immediately stale) is honored, scope filled from the default", async () => {
		const body = await readResource("res://stale");
		expect(body.result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
		// The marker was the only _meta entry → _meta is dropped entirely.
		expect(body.result._meta).toBeUndefined();
	});

	it("per-method cacheHints option overrides the transport default on list results", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 91, method: "tools/list" }),
			{
				cacheHints: {
					"tools/list": { ttlMs: 120_000, cacheScope: "private" },
				},
			},
		);
		const body = (await res.json()) as {
			result: { ttlMs?: number; cacheScope?: string };
		};
		expect(body.result).toMatchObject({
			ttlMs: 120_000,
			cacheScope: "private",
		});
	});
});

// =============================================================================
// SEP-2640 — skills/list is a cacheable list surface
// =============================================================================

describe("transport — skills/list cache-hint decoration (SEP-2640)", () => {
	function buildSkillsServer() {
		const server = buildServer();
		const entry = {
			uri: "skill://tedix/deploy-widget/SKILL.md",
			frontmatter: { name: "deploy-widget" },
			resources: [
				{
					uri: "skill://tedix/deploy-widget/SKILL.md",
					digest: `sha256:${"a".repeat(64)}`,
					size: 0,
				},
			],
		};
		server.server.setRequestHandler(
			"skills/list",
			{ params: ListSkillsParamsSchema, result: ListSkillsResultSchema },
			async () => ({ skills: [entry] }),
		);
		server.server.setRequestHandler(
			"skills/get",
			{ params: GetSkillParamsSchema, result: GetSkillResultSchema },
			async () => ({ skill: entry }),
		);
		return server;
	}

	async function callSkills(method: string, params: Record<string, unknown>) {
		const res = await mountMcp(
			buildSkillsServer(),
			postRpc({ jsonrpc: "2.0", id: 96, method, params }),
			{ cors: { origin: "https://example.com" }, requiredClientExtensions: [] },
		);
		expect(res.status).toBe(200);
		return (await res.json()) as {
			result?: { ttlMs?: number; cacheScope?: string };
		};
	}

	it("decorates skills/list results with the per-method default hint", async () => {
		const body = await callSkills("skills/list", {});
		expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
	});

	it("honors a mount-supplied per-method hint (the apps/mcp aggregate shape)", async () => {
		const res = await mountMcp(
			buildSkillsServer(),
			postRpc({ jsonrpc: "2.0", id: 97, method: "skills/list", params: {} }),
			{
				cors: { origin: "https://example.com" },
				requiredClientExtensions: [],
				cacheHints: {
					"skills/list": { ttlMs: 120_000, cacheScope: "private" },
				},
			},
		);
		const body = (await res.json()) as {
			result?: { ttlMs?: number; cacheScope?: string };
		};
		expect(body.result).toMatchObject({
			ttlMs: 120_000,
			cacheScope: "private",
		});
	});

	it("decorates skills/get results with the required cache metadata", async () => {
		const body = await callSkills("skills/get", {
			uri: "skill://tedix/deploy-widget/SKILL.md",
		});
		expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
	});
});

describe("transport — genuinely unknown method (regression probe)", () => {
	it("answers -32601 instead of hanging", async () => {
		const res = await Promise.race([
			call(
				postRpc({
					jsonrpc: "2.0",
					id: 9001,
					method: "totally/bogus",
					params: {},
				}),
			),
			new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), 4000)),
		]);
		expect(res).not.toBe("HUNG");
		const body = (await (res as Response).json()) as {
			error?: { code: number };
		};
		expect(body.error?.code).toBe(-32601);
	});

	it("answers server/discover without hanging (the CLI negotiation probe)", async () => {
		const res = await Promise.race([
			call(
				postRpc({
					jsonrpc: "2.0",
					id: 9002,
					method: "server/discover",
					params: {},
				}),
			),
			new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), 4000)),
		]);
		expect(res).not.toBe("HUNG");
	});
});

describe("transport — a dispatched request always terminates", () => {
	it("lets a configured tool finish after the default backstop without extending other calls", async () => {
		const transport = new StatelessMcpTransport({
			unansweredTimeoutMs: 25,
			toolResponseTimeoutMs: (name) => (name === "slow_tool" ? 150 : undefined),
		});
		transport.onmessage = (message) => {
			if ("id" in message && message.id === 81) {
				setTimeout(
					() =>
						void transport.send({
							jsonrpc: "2.0",
							id: 81,
							result: { content: [] },
						}),
					60,
				);
			}
		};
		const slow = transport.handleRequest(
			postRpc({
				jsonrpc: "2.0",
				id: 81,
				method: "tools/call",
				params: { name: "slow_tool", arguments: {} },
			}),
		);
		const ordinary = await transport.handleRequest(
			postRpc({
				jsonrpc: "2.0",
				id: 82,
				method: "tools/call",
				params: { name: "ordinary", arguments: {} },
			}),
		);
		expect(await ordinary.json()).toMatchObject({
			error: { data: { timeoutMs: 25 } },
		});
		expect(await (await slow).json()).toMatchObject({
			id: 81,
			result: { content: [] },
		});
	});

	it("reports the configured backstop and ignores tool-like names on other methods", async () => {
		const transport = new StatelessMcpTransport({
			unansweredTimeoutMs: 10,
			toolResponseTimeoutMs: () => 30,
		});
		transport.onmessage = () => {};
		const call = await transport.handleRequest(
			postRpc({
				jsonrpc: "2.0",
				id: 83,
				method: "tools/call",
				params: { name: "tool", arguments: {} },
			}),
		);
		expect(await call.json()).toMatchObject({
			error: { data: { timeoutMs: 30 } },
		});
		const other = await transport.handleRequest(
			postRpc({
				jsonrpc: "2.0",
				id: 84,
				method: "resources/read",
				params: { name: "tool", uri: "test://item" },
			}),
		);
		expect(await other.json()).toMatchObject({
			error: { data: { timeoutMs: 10 } },
		});
	});

	// A hang has no status and no body, so every client waits for its own
	// timeout (e.g. the CLI's version-negotiation probe). `ping`,
	// `server/discover` and unknown methods must always get an answer.
	it("answers -32601 when no server is connected instead of hanging", async () => {
		const transport = new StatelessMcpTransport({});
		// deliberately no `onmessage`: nothing can ever resolve this request
		const res = await Promise.race([
			transport.handleRequest(
				postRpc({ jsonrpc: "2.0", id: 77, method: "ping", params: {} }),
			),
			new Promise<"HUNG">((r) => setTimeout(() => r("HUNG"), 3000)),
		]);
		expect(res).not.toBe("HUNG");
		const body = (await (res as Response).json()) as {
			error?: { code: number; message: string };
		};
		expect(body.error?.code).toBe(-32601);
		expect(body.error?.message).toContain("ping");
	});

	it.each([false, true])(
		"reports stalled tools as timeout (stream=%s)",
		async (stream) => {
			const transport = new StatelessMcpTransport({ unansweredTimeoutMs: 25 });
			transport.onmessage = () => {
				if (stream)
					void transport.send(
						{
							jsonrpc: "2.0",
							method: "notifications/progress",
							params: { progressToken: 78, progress: 1 },
						},
						{ relatedRequestId: 78 },
					);
			};
			const res = await transport.handleRequest(
				modernPost(
					{
						id: 78,
						method: "tools/call",
						params: { name: "slow_tool", arguments: {}, _meta: MODERN_META },
					},
					{ "Mcp-Name": "slow_tool" },
				),
			);
			expect(res.status).toBe(200);
			const text = await res.text();
			const messages = stream
				? text
						.split("\n")
						.filter((line) => line.startsWith("data: "))
						.map((line) => JSON.parse(line.slice(6)))
				: [JSON.parse(text)];
			const response = messages.find((message) => message.id === 78);
			expect(response.error).toMatchObject({
				code: -32603,
				data: {
					reason: "response_timeout",
					timeoutMs: 25,
					executionOutcome: "unknown",
				},
			});
			expect(response.error.message).toContain(
				"Read back state before retrying",
			);
			// A late handler result is discarded, not sent into a closed stream.
			await expect(
				transport.send({ jsonrpc: "2.0", id: 78, result: {} }),
			).resolves.toBeUndefined();
		},
	);
});

// =============================================================================
// Engine dispatch — simple mounts serve through the SDK's createMcpHandler
// =============================================================================

describe("mountMcp — engine dispatch (createMcpHandler for simple mounts)", () => {
	it("each non-spec extension option forces the hand-rolled engine; simple shapes select the SDK engine", () => {
		expect(requiresLegacyMcpTransport({})).toBe(false);
		expect(
			requiresLegacyMcpTransport({ toolResponseTimeoutMs: () => 150_000 }),
		).toBe(false);
		expect(
			requiresLegacyMcpTransport({
				route: "/mcp",
				cors: { origin: "*" },
				discover: {
					serverInfo: { name: "s", version: "1" },
					capabilities: { tools: {} },
				},
			}),
		).toBe(false);

		const extensionShapes: Array<Parameters<typeof mountMcp>[2]> = [
			{
				taskHandlers: {
					get: async () => {
						throw new Error("unused");
					},
					update: async () => {},
					cancel: async () => {},
				},
			},
			{ completionHandler: () => ({ values: [] }) },
			{ directoryReadHandler: () => ({ resources: [] }) },
			{ resultTransform: ({ response }) => response },
			{ cacheHints: {} },
			{ requiredClientExtensions: [] },
			// An EXPLICIT toolSchemaLookup (custom source or `null` disable) is
			// extension-shaped; the SDK engine covers only the default
			// (`server.toolInputSchemaJson`) inbound-validation source.
			{ toolSchemaLookup: null },
			{ toolSchemaLookup: () => undefined },
		];
		for (const shape of extensionShapes) {
			expect(requiresLegacyMcpTransport(shape ?? {})).toBe(true);
		}
	});

	function buildSimpleServer() {
		const server = createMcpServer({
			name: "simple-engine",
			version: "0.0.9",
		});
		server.registerTool(
			"echo",
			{
				title: "echo",
				description: "Echo back input",
				inputSchema: { msg: z.string() },
			},
			async ({ msg }) => ({
				content: [{ type: "text" as const, text: `echo:${msg}` }],
			}),
		);
		server.registerTool(
			"progress_tool",
			{
				description: "Emits a mid-call progress notification",
				inputSchema: {},
			},
			async (_args, ctx) => {
				const progressToken =
					(ctx.mcpReq._meta as Record<string, unknown> | undefined)
						?.progressToken ?? 0;
				await ctx.mcpReq.notify({
					method: "notifications/progress",
					params: { progressToken, progress: 50, total: 100 },
				});
				return { content: [{ type: "text" as const, text: "progress-done" }] };
			},
		);
		return server;
	}

	/** Simple-shaped mount: MUST be served by the SDK engine. */
	async function simpleCall(
		req: Request,
		opts?: Parameters<typeof mountMcp>[2],
	) {
		return mountMcp(buildSimpleServer(), req, {
			cors: { origin: "https://example.com" },
			...opts,
		});
	}

	it("bounds the pre-SDK server/discover classifier read", async () => {
		const bytes = new TextEncoder().encode(" ".repeat(4 * 1024 * 1024 + 1));
		const response = await simpleCall(
			new Request(URL_OK, {
				method: "POST",
				headers: {
					Accept: ACCEPT_BOTH,
					"Content-Type": "application/json",
				},
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(bytes);
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
			{
				discover: {
					serverInfo: { name: "simple-engine", version: "0.0.1" },
				},
			},
		);
		expect(response.status).toBe(413);
	});

	/** Parse a JSON or SSE JSON-RPC response body into its messages. */
	async function jsonRpcMessages(res: Response): Promise<unknown[]> {
		const contentType = res.headers.get("Content-Type") ?? "";
		if (contentType.includes("text/event-stream")) {
			const text = await res.text();
			return text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => JSON.parse(line.slice(5).trim()) as unknown);
		}
		return [await res.json()];
	}

	function messageWithId(messages: unknown[], id: number) {
		return messages.find((m) => (m as { id?: unknown }).id === id) as Record<
			string,
			unknown
		> & {
			result?: Record<string, unknown> & {
				content?: Array<{ text?: string }>;
				tools?: Array<{ name: string }>;
				serverInfo?: Record<string, unknown>;
				ttlMs?: number;
			};
		};
	}

	it("serves a legacy-era initialize → tools/list → tools/call round trip end to end", async () => {
		const init = await simpleCall(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "t", version: "1" },
				},
			}),
		);
		expect(init.status).toBe(200);
		const initBody = messageWithId(await jsonRpcMessages(init), 1);
		expect(initBody.result?.serverInfo).toMatchObject({
			name: "simple-engine",
		});

		const list = await simpleCall(
			postRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
		);
		expect(list.status).toBe(200);
		const listBody = messageWithId(await jsonRpcMessages(list), 2);
		expect(listBody.result?.tools?.map((t) => t.name)).toContain("echo");
		// Engine marker: Tedix's hand-rolled transport decorates every cacheable
		// result with ttlMs/cacheScope even on legacy-era requests; the SDK's
		// legacy stateless leg serves the pure 2025 wire shape.
		expect(listBody.result?.ttlMs).toBeUndefined();

		const invoke = await simpleCall(
			postRpc({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: "sdk" } },
			}),
		);
		expect(invoke.status).toBe(200);
		const invokeBody = messageWithId(await jsonRpcMessages(invoke), 3);
		expect(invokeBody.result?.content?.[0]?.text).toBe("echo:sdk");
	});

	it("rejects subscriptions/listen before the SDK can hold an SSE stream open on a per-request bus", async () => {
		// SDK 2.2.0 only closes a listen stream when NO requested notification
		// type is honored; `McpServer` advertises `tools.listChanged`, so
		// `toolsListChanged` is honored and the stream would stay open forever
		// on a per-request bus nothing publishes to.
		const res = await simpleCall(
			modernPost(
				{
					id: 79,
					method: "subscriptions/listen",
					params: {
						notifications: { toolsListChanged: true },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "subscriptions/listen" },
			),
			{
				discover: {
					serverInfo: { name: "simple-engine", version: "0.0.9" },
				},
			},
		);
		const contentType = res.headers.get("Content-Type") ?? "";
		if (contentType.includes("text/event-stream")) {
			await res.body?.cancel();
		}
		expect(contentType).toContain("application/json");
		// Same one-shot answer the hand-rolled engine gives: modern-era -32601
		// maps to HTTP 404.
		expect(res.status).toBe(404);
		const body = (await res.json()) as {
			id: number;
			error: { code: number; message: string; data?: { reason?: string } };
		};
		expect(body.id).toBe(79);
		expect(body.error.code).toBe(-32601);
		expect(body.error.data?.reason).toBe("stateless-transport");
		expect(res.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("serves a fully-bound modern (2026-07-28) tools/call through the SDK pipeline", async () => {
		const res = await simpleCall(
			modernPost(
				{
					id: 4,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "modern-sdk" },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "echo" },
			),
		);
		expect(res.status).toBe(200);
		const body = messageWithId(await jsonRpcMessages(res), 4);
		expect(body.result?.content?.[0]?.text).toBe("echo:modern-sdk");
		const resultMeta = body.result?._meta as
			| Record<string, unknown>
			| undefined;
		expect(resultMeta?.[MCP_SERVER_INFO_META_KEY]).toMatchObject({
			name: "simple-engine",
		});
	});

	it("promotes a modern tools/call to SSE on a mid-call progress notification (responseMode: auto)", async () => {
		const res = await simpleCall(
			modernPost(
				{
					id: 5,
					method: "tools/call",
					params: {
						name: "progress_tool",
						arguments: {},
						_meta: { ...MODERN_META, progressToken: 7 },
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "progress_tool" },
			),
		);
		expect(res.status).toBe(200);
		// This simple mount has no Tedix extensions, so its SSE response proves the
		// SDK engine served it; the next test separately pins extension-rich SSE.
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");
		const messages = await jsonRpcMessages(res);
		const progress = messages.find(
			(m) => (m as { method?: string }).method === "notifications/progress",
		) as { params?: { progressToken?: number; progress?: number } };
		expect(progress?.params).toMatchObject({ progressToken: 7, progress: 50 });
		const final = messageWithId(messages, 5);
		expect(final.result?.content?.[0]?.text).toBe("progress-done");
	});

	it("promotes an extension-rich mount to request-scoped SSE for progress", async () => {
		const res = await simpleCall(
			modernPost(
				{
					id: 55,
					method: "tools/call",
					params: {
						name: "progress_tool",
						arguments: {},
						_meta: { ...MODERN_META, progressToken: 17 },
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "progress_tool" },
			),
			// A configured extension keeps this call on StatelessMcpTransport.
			{ cacheHints: {} },
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/event-stream");
		const messages = await jsonRpcMessages(res);
		const progress = messages.find(
			(m) => (m as { method?: string }).method === "notifications/progress",
		) as { params?: { progressToken?: number; progress?: number } };
		expect(progress?.params).toMatchObject({ progressToken: 17, progress: 50 });
		const final = messageWithId(messages, 55);
		expect(final.result?.content?.[0]?.text).toBe("progress-done");
	});

	it("the SDK engine's standard-header ladder rejects a mismatched Mcp-Name (-32020)", async () => {
		const res = await simpleCall(
			modernPost(
				{
					id: 6,
					method: "tools/call",
					params: {
						name: "echo",
						arguments: { msg: "x" },
						_meta: MODERN_META,
					},
				},
				{ "Mcp-Method": "tools/call", "Mcp-Name": "not-echo" },
			),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: { code?: number } };
		expect(body.error?.code).toBe(-32_020);
	});

	it("answers server/discover from the mount's own discover advertisement, exactly as the hand-rolled path presents it", async () => {
		const discover = {
			serverInfo: { name: "Advertised Name", version: "9.9.9" },
			capabilities: { tools: {} },
		};
		const res = await simpleCall(
			modernPost({
				id: 7,
				method: "server/discover",
				params: { _meta: MODERN_META },
			}),
			{ discover },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: {
				supportedVersions: string[];
				capabilities: Record<string, unknown>;
				ttlMs?: number;
				cacheScope?: string;
				_meta?: Record<string, unknown>;
			};
		};
		expect(body.result.supportedVersions).toContain(MODERN);
		// Additive legacy advertisement survives the engine switch.
		expect(body.result.supportedVersions).toContain("2025-11-25");
		expect(body.result.capabilities).toEqual({ tools: {} });
		expect(body.result._meta?.[MCP_SERVER_INFO_META_KEY]).toEqual(
			discover.serverInfo,
		);
		expect(body.result).toMatchObject({ ttlMs: 60_000, cacheScope: "private" });
	});

	it("preserves route 404, OPTIONS preflight, GET 405, DELETE 405 and response envelope headers", async () => {
		const wrongPath = await simpleCall(
			new Request(URL_OTHER, {
				method: "POST",
				headers: { Accept: ACCEPT_BOTH, "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
			}),
		);
		expect(wrongPath.status).toBe(404);

		const preflight = await simpleCall(
			new Request(URL_OK, { method: "OPTIONS" }),
		);
		expect(preflight.status).toBe(200);
		expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://example.com",
		);
		expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain(
			"POST",
		);

		const get = await simpleCall(new Request(URL_OK, { method: "GET" }));
		expect(get.status).toBe(405);

		// 405 per MCP 2026-07-28 `basic/transports`; byte-parity with the
		// hand-rolled engine is the stated invariant for these two paths.
		const del = await simpleCall(new Request(URL_OK, { method: "DELETE" }));
		expect(del.status).toBe(405);

		const post = await simpleCall(
			postRpc({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
		);
		expect(post.headers.get("Access-Control-Allow-Origin")).toBe(
			"https://example.com",
		);
		// Never let the Workers Cache edge tier store JSON-RPC results.
		expect(post.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("forwards the configured execution budget through the actual extension mount", async () => {
		vi.useFakeTimers();
		try {
			const server = buildSimpleServer();
			server.registerTool("slow", { inputSchema: {} }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 46_000));
				return { content: [{ type: "text" as const, text: "completed" }] };
			});
			const budget = vi.fn(() => 60_000);
			const response = mountMcp(
				server,
				postRpc({
					jsonrpc: "2.0",
					id: 91,
					method: "tools/call",
					params: { name: "slow", arguments: {} },
				}),
				{
					completionHandler: () => ({ values: [] }),
					toolResponseTimeoutMs: budget,
				},
			);
			await vi.advanceTimersByTimeAsync(46_001);
			expect(await (await response).json()).toMatchObject({
				result: { content: [{ text: "completed" }] },
			});
			expect(budget).toHaveBeenCalledWith("slow");
		} finally {
			vi.useRealTimers();
		}
	});

	it("an extension-shaped mount still serves through the hand-rolled transport", async () => {
		// completion/complete only exists on the hand-rolled engine (Tedix
		// extension handler); its answer proves the legacy dispatch.
		const completion = await mountMcp(
			buildSimpleServer(),
			postRpc({
				jsonrpc: "2.0",
				id: 10,
				method: "completion/complete",
				params: {
					ref: { type: "ref/prompt", name: "p" },
					argument: { name: "a", value: "al" },
				},
			}),
			{
				cors: { origin: "https://example.com" },
				completionHandler: () => ({ values: ["alpha", "alpine"] }),
			},
		);
		expect(completion.status).toBe(200);
		const body = (await completion.json()) as {
			result?: { completion?: { values?: string[] } };
		};
		expect(body.result?.completion?.values).toEqual(["alpha", "alpine"]);

		// Second marker: the hand-rolled engine decorates legacy-era cacheable
		// results with ttlMs/cacheScope; the SDK engine does not (see the
		// simple-mount round-trip test above).
		const list = await mountMcp(
			buildSimpleServer(),
			postRpc({ jsonrpc: "2.0", id: 11, method: "tools/list" }),
			{
				cors: { origin: "https://example.com" },
				completionHandler: () => ({ values: [] }),
			},
		);
		const listBody = (await list.json()) as {
			result?: { ttlMs?: number; cacheScope?: string };
		};
		expect(listBody.result).toMatchObject({
			ttlMs: 60_000,
			cacheScope: "private",
		});
	});
});
