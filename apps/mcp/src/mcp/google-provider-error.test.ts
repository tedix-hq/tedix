import { describe, expect, it, afterEach, vi } from "vite-plus/test";
import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { ToolHandler, type ToolExecutionContext } from "./handler";
import { googleProviderFailure, isGoogleMcp } from "./google-provider-error";
import {
	callUpstreamMcpTool,
	resetUpstreamEraCache,
} from "./upstream-mcp-client";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	resetUpstreamEraCache();
});

describe("Google provider failure mapping", () => {
	it.each([
		[401, "authenticate"],
		[403, "permissions"],
		[429, "quota"],
		[503, "unavailable"],
	])("explains HTTP %s without provider content", (status, reason) => {
		const mapped = googleProviderFailure(
			{ status, message: "Bearer secret private email body" },
			true,
		);
		expect(mapped.error).toContain(reason as string);
		expect(mapped.providerStatus).toBe(status);
		expect(mapped.error).not.toMatch(/secret|private email/);
	});
	it("preserves only known Google codes and numeric protocol codes", () => {
		expect(
			googleProviderFailure(
				{
					code: -32603,
					data: { code: 503, status: "UNAVAILABLE", message: "secret" },
				},
				true,
			),
		).toMatchObject({
			providerStatus: 503,
			providerCode: "UNAVAILABLE",
			retrySafe: true,
		});
		expect(googleProviderFailure({ code: -32603 }, false).error).toContain(
			"-32603",
		);
		expect(
			googleProviderFailure({ code: "private-content" }, false).error,
		).not.toContain("private-content");
	});
	it("does not infer a transient status from a bare connector error", () => {
		expect(googleProviderFailure(undefined, true)).toMatchObject({
			status: 502,
			retrySafe: false,
		});
	});
	it("restricts provider selection to official hosts", () => {
		expect(isGoogleMcp("https://gmailmcp.googleapis.com/mcp/v1")).toBe(true);
		expect(isGoogleMcp("https://gmailmcp.googleapis.com.evil.test/mcp")).toBe(
			false,
		);
	});
});

function call(
	fetcher: typeof fetch,
	readOnly = true,
	toolName = "search_threads",
	signal = new AbortController().signal,
) {
	return callUpstreamMcpTool({
		url: "https://gmailmcp.googleapis.com/mcp/v1",
		fetcher,
		headers: {},
		toolName,
		args: {},
		modernOnly: true,
		readOnly,
		signal,
		timeoutMs: 10000,
	});
}
function success(init?: RequestInit) {
	return Response.json({
		jsonrpc: "2.0",
		id: JSON.parse(String(init?.body)).id,
		result: { resultType: "complete", content: [] },
	});
}

describe("Google read retry", () => {
	it.each([429, 500, 503])("backs off and recovers HTTP %s", async (status) => {
		vi.useFakeTimers();
		const times: number[] = [];
		const fetcher = vi.fn(async (_input, init) => {
			times.push(Date.now());
			return times.length < 3
				? new Response("secret", { status })
				: success(init);
		}) as typeof fetch;
		const pending = call(fetcher);
		await vi.runAllTimersAsync();
		expect((await pending).ok).toBe(true);
		expect(times.map((t) => t - times[0]!)).toEqual([0, 250, 750]);
	});
	it.each([429, 500, 503])(
		"never replays create_draft after HTTP %s",
		async (status) => {
			const fetcher = vi.fn(
				async () => new Response("private content", { status }),
			);
			const result = await call(fetcher, false, "create_draft");
			expect(fetcher).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({
				ok: false,
				retrySafe: false,
				providerStatus: status,
			});
			expect(JSON.stringify(result)).not.toContain("private content");
		},
	);
	it("honors Retry-After and stops after three attempts", async () => {
		vi.useFakeTimers();
		const times: number[] = [];
		const pending = call(
			vi.fn(async () => {
				times.push(Date.now());
				return new Response(null, {
					status: 429,
					headers: { "Retry-After": "1" },
				});
			}),
		);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({
			ok: false,
			providerStatus: 429,
			retrySafe: true,
		});
		expect(times.map((t) => t - times[0]!)).toEqual([0, 1000, 2000]);
	});
	it.each([400, 401, 403, 404])("does not retry HTTP %s", async (status) => {
		const fetcher = vi.fn(async () => new Response(null, { status }));
		await call(fetcher);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("maps a bare JSON-RPC connector error without exposing text", async () => {
		const fetcher = vi.fn(async (_input, init) =>
			Response.json({
				jsonrpc: "2.0",
				id: JSON.parse(String(init?.body)).id,
				error: {
					code: -32603,
					message: "The connector's server returned an error secret",
				},
			}),
		);
		const result = await call(fetcher);
		expect(result).toMatchObject({ ok: false, retrySafe: false });
		expect(JSON.stringify(result)).toContain("-32603");
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("cancels backoff without another provider call", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
		const pending = call(fetcher, true, "list_drafts", controller.signal);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort();
		await vi.runAllTimersAsync();
		await pending;
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("retries a Google status inside a JSON-RPC error", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn(async (_input, init) =>
			Response.json({
				jsonrpc: "2.0",
				id: JSON.parse(String(init?.body)).id,
				error: {
					code: -32603,
					message: "secret",
					data: { error: { code: 503, status: "UNAVAILABLE" } },
				},
			}),
		);
		const pending = call(fetcher);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({
			ok: false,
			providerStatus: 503,
			providerCode: "UNAVAILABLE",
			retrySafe: true,
		});
		expect(fetcher).toHaveBeenCalledTimes(3);
	});
	it("maps structured tool errors and keeps writes single-shot", async () => {
		const fetcher = vi.fn(async (_input, init) =>
			Response.json({
				jsonrpc: "2.0",
				id: JSON.parse(String(init?.body)).id,
				result: {
					resultType: "complete",
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: {
									code: 429,
									status: "RESOURCE_EXHAUSTED",
									message: "secret body",
								},
							}),
						},
					],
				},
			}),
		);
		const result = await call(fetcher, false, "create_draft");
		expect(result).toMatchObject({
			ok: false,
			providerStatus: 429,
			providerCode: "RESOURCE_EXHAUSTED",
			retrySafe: false,
		});
		expect(JSON.stringify(result)).not.toContain("secret body");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("does not retry without a trusted read-only annotation", async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
		await callUpstreamMcpTool({
			url: "https://gmailmcp.googleapis.com/mcp/v1",
			fetcher,
			headers: {},
			toolName: "search_threads",
			args: { readOnly: true },
			modernOnly: true,
			signal: new AbortController().signal,
			timeoutMs: 10000,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("leaves other MCP providers' retry policy unchanged", async () => {
		const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
		await callUpstreamMcpTool({
			url: "https://provider.example.test/mcp",
			fetcher,
			headers: {},
			toolName: "search_threads",
			args: {},
			modernOnly: true,
			readOnly: true,
			signal: new AbortController().signal,
			timeoutMs: 10000,
		});
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});

it.each([
	[true, "search_threads", 3],
	[false, "create_draft", 1],
] as const)(
	"surfaces safe Google failure through ToolHandler (%s, %s)",
	async (readOnlyHint, toolName, attempts) => {
		vi.useFakeTimers();
		let calls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				const body = JSON.parse(String(init?.body));
				if (body.method === "server/discover")
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							supportedVersions: ["2026-07-28"],
							capabilities: { tools: {} },
						},
					});
				calls++;
				return new Response("private provider body", { status: 503 });
			}),
		);
		const context = {
			appId: "app_1",
			app: {
				id: "app_1",
				slug: "google-gmail",
				name: "Gmail",
				organizationId: "org_1",
			},
			appCapabilities: {},
			env: { ENVIRONMENT: "test" },
			config: {
				transport: "mcp",
				mcpServerUrl: "https://gmailmcp.googleapis.com/mcp/v1",
				mcpToolName: toolName,
			},
			toolId: toolName,
			requestId: "req_1",
			readOnlyHint,
		} as ToolExecutionContext<ToolConfig>;
		const pending = new ToolHandler().execute({}, context);
		await vi.runAllTimersAsync();
		expect(await pending).toMatchObject({
			status: 503,
			data: {
				providerStatus: 503,
				retrySafe: readOnlyHint,
				error: expect.stringContaining("Google is temporarily unavailable"),
			},
		});
		expect(JSON.stringify(await pending)).not.toContain(
			"private provider body",
		);
		expect(calls).toBe(attempts);
	},
);
