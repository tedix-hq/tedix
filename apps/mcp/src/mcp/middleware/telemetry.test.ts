/**
 * Telemetry cardinality tests — proves exactly-one event semantics for the
 * registration-time telemetry wrappers. Guards against duplicate or missing
 * analytics events, the main regression risk when consolidating per-handler
 * emission into a single wrapper per tool/prompt callback.
 *
 * Mocks `./utils/analytics` and asserts the call counts to `trackMcpEvent`
 * and `emitMcpAuditEvent` per scenario.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { createMcpServer } from "@tedix/mcp-shared/server";
import { mountMcp } from "@tedix/mcp-shared/transport";
import {
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	vi,
} from "vite-plus/test";
import * as z from "zod";

const { enterSpanSpy, setSpanAttributeSpy } = vi.hoisted(() => ({
	enterSpanSpy: vi.fn(),
	setSpanAttributeSpy: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
	tracing: { enterSpan: enterSpanSpy },
}));

vi.mock("../utils/analytics", async () => {
	const actual =
		await vi.importActual<typeof import("../utils/analytics")>(
			"../utils/analytics",
		);
	return {
		...actual,
		trackMcpEvent: vi.fn(),
		emitMcpAuditEvent: vi.fn(),
	};
});

import { emitMcpAuditEvent, trackMcpEvent } from "../utils/analytics";
import { wrapPromptGetTelemetry } from "./prompts-telemetry";
import { wrapToolCallTelemetry } from "./telemetry";

// =============================================================================
// FIXTURES
// =============================================================================

const URL_OK = "https://test.local/mcp";
const ACCEPT_BOTH = "application/json, text/event-stream";

function makeServerCtx() {
	return {
		env: {} as never,
		ctx: { waitUntil: () => undefined } as never,
		appId: "app-uuid",
		appSlug: "test-app",
		app: { organizationId: "org-uuid" } as never,
		callerIdentity: {
			userId: "user-uuid",
			tediId: "tedi-uuid",
			clientId: "client-id",
			authType: "user" as const,
			scopes: ["mcp:apps.read", "mcp:observe.read"],
		} as never,
		traceId: "trace-uuid",
	};
}

function buildServer(): McpServer {
	const server = createMcpServer({
		name: "telemetry-test",
		version: "0.0.1",
	});

	const ctx = makeServerCtx();

	server.registerTool(
		"echo",
		{
			title: "echo",
			description: "Echo input",
			inputSchema: z.object({ msg: z.string() }),
		},
		wrapToolCallTelemetry("echo", ctx as never, async ({ msg }) => ({
			content: [{ type: "text" as const, text: `echo:${msg}` }],
		})) as unknown as Parameters<typeof server.registerTool>[2],
	);

	server.registerTool(
		"boom",
		{
			title: "boom",
			description: "Throw",
			inputSchema: z.object({}),
		},
		wrapToolCallTelemetry("boom", ctx as never, async () => {
			throw new Error("intentional-failure");
		}) as unknown as Parameters<typeof server.registerTool>[2],
	);

	server.registerTool(
		"is_error",
		{
			title: "is_error",
			description: "Returns isError result without throwing",
			inputSchema: z.object({}),
		},
		wrapToolCallTelemetry("is_error", ctx as never, async () => ({
			content: [{ type: "text" as const, text: "soft fail" }],
			isError: true,
		})) as unknown as Parameters<typeof server.registerTool>[2],
	);

	// Regression guard for the bug Codex flagged: handlers that catch their
	// own errors and return an error-shaped response without setting
	// isError: true would be reported as success by middleware.
	server.registerTool(
		"silent_error",
		{
			title: "silent_error",
			description: "Returns error-looking response without isError flag (BAD)",
			inputSchema: z.object({}),
		},
		wrapToolCallTelemetry("silent_error", ctx as never, async () => ({
			// Intentionally not setting isError — this is what executeWithHandler
			// did before the fix. Middleware should not treat this as a failure.
			content: [{ type: "text" as const, text: "Error: something went wrong" }],
			structuredContent: { error: "something went wrong" },
		})) as unknown as Parameters<typeof server.registerTool>[2],
	);

	server.registerPrompt(
		"greet",
		{
			title: "greet",
			description: "Static greeting",
			argsSchema: z.object({ who: z.string() }),
		},
		wrapPromptGetTelemetry("greet", ctx as never, ({ who }) => ({
			messages: [
				{
					role: "user" as const,
					content: { type: "text" as const, text: `Hello ${who}` },
				},
			],
		})) as unknown as Parameters<typeof server.registerPrompt>[2],
	);

	server.registerPrompt(
		"prompt_boom",
		{
			title: "prompt_boom",
			description: "Throwing prompt",
			argsSchema: z.object({}),
		},
		wrapPromptGetTelemetry("prompt_boom", ctx as never, () => {
			throw new Error("prompt-failure");
		}) as unknown as Parameters<typeof server.registerPrompt>[2],
	);

	return server;
}

async function call(req: Request) {
	// `requiredClientExtensions: []` presence-pins the hand-rolled
	// StatelessMcpTransport engine — the one the production apps/mcp mount uses
	// (its options are extension-shaped: cacheHints/taskHandlers/...). A
	// simple-shaped mount would dispatch to the SDK's createMcpHandler instead.
	return mountMcp(buildServer(), req, {
		cors: { origin: "https://example.com" },
		requiredClientExtensions: [],
	});
}

function postRpc(body: unknown) {
	return new Request(URL_OK, {
		method: "POST",
		headers: {
			Accept: ACCEPT_BOTH,
			"Content-Type": "application/json",
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

// Each test gets fresh mocks
const trackSpy = trackMcpEvent as unknown as MockInstance;
const auditSpy = emitMcpAuditEvent as unknown as MockInstance;

beforeEach(() => {
	trackSpy.mockClear();
	auditSpy.mockClear();
	enterSpanSpy.mockReset();
	setSpanAttributeSpy.mockClear();
	enterSpanSpy.mockImplementation((_name, callback) =>
		callback({ setAttribute: setSpanAttributeSpy }),
	);
});

// =============================================================================
// CARDINALITY ASSERTIONS
// =============================================================================

describe("telemetry middleware — exactly-one cardinality", () => {
	it("emits exactly 1 tool_call on success", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: "hello" } },
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(auditSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "tool_call",
			toolName: "echo",
			success: true,
		});
		expect(enterSpanSpy).toHaveBeenCalledWith(
			"tedix.mcp.tool_call",
			expect.any(Function),
		);
		expect(setSpanAttributeSpy.mock.calls).toEqual(
			expect.arrayContaining([
				["tedix.trace_id", "trace-uuid"],
				["tedix.app_id", "app-uuid"],
				["tedix.event_type", "tool_call"],
				["tedix.outcome", "success"],
			]),
		);
	});

	it("emits exactly 1 tool_call on thrown handler error", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "boom", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(auditSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "tool_call",
			toolName: "boom",
			success: false,
			errorMessage: expect.stringMatching(/intentional-failure/),
		});
	});

	it("treats handler responses without isError as success (contract)", async () => {
		// Codex-flagged regression guard: when a handler returns an
		// error-looking shape without isError: true, middleware MUST log
		// success: true. The fix is at the handler layer (executeWithHandler
		// must set isError: true on its catch path + when result.status >= 400),
		// not in the middleware. This test pins that contract — middleware
		// trusts what the handler tells it.
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 99,
				method: "tools/call",
				params: { name: "silent_error", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "tool_call",
			toolName: "silent_error",
			success: true, // Contract: middleware trusts the handler's flag
		});
	});

	it("emits exactly 1 tool_call (success: false) on isError result", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/call",
				params: { name: "is_error", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "tool_call",
			toolName: "is_error",
			success: false,
		});
	});

	it("emits 0 events for notifications (202 path)", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				method: "notifications/initialized",
				params: {},
			}),
		);
		expect(res.status).toBe(202);
		expect(trackSpy).toHaveBeenCalledTimes(0);
		expect(auditSpy).toHaveBeenCalledTimes(0);
	});

	it("emits 0 events for rejected JSON-RPC batches", async () => {
		const res = await call(
			postRpc([
				{
					jsonrpc: "2.0",
					id: 10,
					method: "tools/call",
					params: { name: "echo", arguments: { msg: "a" } },
				},
				{
					jsonrpc: "2.0",
					id: 11,
					method: "tools/call",
					params: { name: "echo", arguments: { msg: "b" } },
				},
				{
					jsonrpc: "2.0",
					id: 12,
					method: "tools/call",
					params: { name: "echo", arguments: { msg: "c" } },
				},
			]),
		);
		expect(res.status).toBe(400);
		expect(trackSpy).toHaveBeenCalledTimes(0);
		expect(auditSpy).toHaveBeenCalledTimes(0);
	});

	it("emits 0 tool_call for tools/list (different filter)", async () => {
		const res = await call(
			postRpc({ jsonrpc: "2.0", id: 20, method: "tools/list" }),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(0);
		expect(auditSpy).toHaveBeenCalledTimes(0);
	});

	it("emits 0 tool_call for initialize", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 21,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "0.0.1" },
				},
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(0);
	});

	it("emits exactly 1 prompt_get on success", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 30,
				method: "prompts/get",
				params: { name: "greet", arguments: { who: "world" } },
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(auditSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "prompt_get",
			toolName: "greet",
			success: true,
		});
	});

	it("emits exactly 1 failed prompt_get when prompt handler throws", async () => {
		const res = await call(
			postRpc({
				jsonrpc: "2.0",
				id: 31,
				method: "prompts/get",
				params: { name: "prompt_boom", arguments: {} },
			}),
		);
		expect(res.status).toBe(200);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(auditSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			eventType: "prompt_get",
			toolName: "prompt_boom",
			success: false,
			errorCode: "UNHANDLED_ERROR",
			errorMessage: "prompt-failure",
			traceId: "trace-uuid",
		});
	});

	it("does not emit telemetry for rejected mixed batches", async () => {
		const res = await call(
			postRpc([
				{
					jsonrpc: "2.0",
					id: 40,
					method: "tools/call",
					params: { name: "echo", arguments: { msg: "x" } },
				},
				{
					jsonrpc: "2.0",
					id: 41,
					method: "prompts/get",
					params: { name: "greet", arguments: { who: "y" } },
				},
			]),
		);
		expect(res.status).toBe(400);
		expect(trackSpy).toHaveBeenCalledTimes(0);
	});

	it("includes baseEvent context (appId, traceId, callerIdentity)", async () => {
		await call(
			postRpc({
				jsonrpc: "2.0",
				id: 50,
				method: "tools/call",
				params: { name: "echo", arguments: { msg: "ctx" } },
			}),
		);
		expect(trackSpy).toHaveBeenCalledTimes(1);
		expect(trackSpy.mock.calls[0]?.[1]).toMatchObject({
			appId: "app-uuid",
			appSlug: "test-app",
			organizationId: "org-uuid",
			userId: "user-uuid",
			tediId: "tedi-uuid",
			clientId: "client-id",
			authType: "user",
			traceId: "trace-uuid",
			metadata: {
				agentTediId: "tedi-uuid",
				subjectUserId: "user-uuid",
				oauthClientId: "client-id",
				grantedScopeCount: 2,
				delegationMode: "user",
			},
		});
	});
});
