// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleWidgetMcp, handleWidgetResource } from "./proxy";

interface UpstreamCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

interface MockUpstreamOptions {
	/** Advertise the 2026-07-28 stateless protocol (default true). */
	modern?: boolean;
	/** Response for the actual method call. */
	result?: unknown;
	/** Frame the method response as SSE instead of plain JSON. */
	sse?: boolean;
	/** Fail protocol discovery with this HTTP status. */
	discoverStatus?: number;
	/** Fail the method request with this HTTP status. */
	callStatus?: number;
}

/**
 * Mocks the modern stateless cycle: discovery followed by the configured call.
 * Records every upstream request for assertions.
 */
function mockUpstream(options: MockUpstreamOptions = {}): UpstreamCall[] {
	const calls: UpstreamCall[] = [];
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const headers: Record<string, string> = {};
			new Headers(init?.headers).forEach((value, key) => {
				headers[key] = value;
			});
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			calls.push({ url: String(input), headers, body });

			if (body.method === "server/discover") {
				if (options.discoverStatus) {
					return new Response(
						JSON.stringify({ error: { code: -32000, message: "denied" } }),
						{ status: options.discoverStatus },
					);
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							supportedVersions: options.modern === false ? [] : ["2026-07-28"],
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}

			if (options.callStatus) {
				return new Response(
					JSON.stringify({ error: { code: -32001, message: "no access" } }),
					{ status: options.callStatus },
				);
			}
			const envelope = {
				jsonrpc: "2.0",
				id: body.id,
				result: options.result ?? { ok: true },
			};
			if (options.sse) {
				const frames = [
					"event: message",
					'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
					"",
					"event: message",
					`data: ${JSON.stringify(envelope)}`,
					"",
					"",
				].join("\n");
				return new Response(frames, {
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response(JSON.stringify(envelope), {
				headers: { "Content-Type": "application/json" },
			});
		},
	);
	return calls;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function mcpRequest(
	body: unknown,
	init: { origin?: string | null; headers?: Record<string, string> } = {},
): [Request, URL] {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...init.headers,
	};
	if (init.origin) headers.Origin = init.origin;
	const request = new Request("https://acme.os.tedix.dev/widgets/mcp", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	return [request, new URL(request.url)];
}

function resourceRequest(
	app: string,
	uri: string,
	headers: Record<string, string> = {},
): [Request, URL] {
	const url = new URL("https://acme.os.tedix.dev/widgets/resource");
	url.searchParams.set("app", app);
	url.searchParams.set("uri", uri);
	return [new Request(url, { headers }), url];
}

describe("handleWidgetResource", () => {
	it("logs only exception types when the upstream transport throws", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const [request, url] = resourceRequest(
			"acme",
			"ui://widgets/mcp-app/acme/private-customer-token",
			{ Authorization: "Bearer user-jwt" },
		);
		const response = await handleWidgetResource(request, url, async () => {
			throw new Error("private-customer-token", {
				cause: new TypeError("secret bearer"),
			});
		});
		expect(response.status).toBe(502);
		expect(errorLog).toHaveBeenCalledWith({
			component: "os.widget.proxy",
			event: "widget.proxy.upstream_failed",
			failure: { name: "Error", cause: { name: "TypeError" } },
			message: "Widget proxy upstream failed",
		});
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
			"private-customer-token",
		);
		expect(JSON.stringify(errorLog.mock.calls)).not.toContain("secret bearer");
		errorLog.mockRestore();
	});

	it("reads the ui:// resource via MCP and preserves _meta on the contents", async () => {
		const contents = [
			{
				uri: "ui://widgets/mcp-app/acme/orders.html",
				mimeType: "text/html;profile=mcp-app",
				text: "<html></html>",
				_meta: { ui: { csp: { connectDomains: ["https://api.tedix.dev"] } } },
			},
		];
		const calls = mockUpstream({ result: { contents } });
		const response = await handleWidgetResource(
			...resourceRequest("acme", "ui://widgets/mcp-app/acme/orders.html", {
				Authorization: "Bearer user-jwt",
			}),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ contents });
		// Modern stateless cycle: discover, then resources/read at the app host.
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe("https://acme.mcp.tedix.dev/mcp");
		expect(calls[0]?.body.method).toBe("server/discover");
		expect(calls[1]?.body).toMatchObject({
			method: "resources/read",
			params: { uri: "ui://widgets/mcp-app/acme/orders.html" },
		});
		expect(calls.some((call) => call.body.method === "initialize")).toBe(false);
		expect(calls.every((call) => call.headers["mcp-session-id"] == null)).toBe(
			true,
		);
	});

	it("promotes the caller's canonical browser session to MCP bearer auth", async () => {
		const calls = mockUpstream({ result: { contents: [] } });
		const response = await handleWidgetResource(
			...resourceRequest("acme", "ui://widgets/mcp-app/acme/orders.html", {
				Cookie: "theme=dark; DS=browser-session-jwt",
			}),
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.headers.authorization).toBe("Bearer browser-session-jwt");
			expect(call.headers.cookie).toBe("theme=dark; DS=browser-session-jwt");
		}
	});

	it("keeps an explicit bearer instead of replacing it from a cookie", async () => {
		const calls = mockUpstream({ result: { contents: [] } });
		const response = await handleWidgetResource(
			...resourceRequest("acme", "ui://widgets/mcp-app/acme/orders.html", {
				Authorization: "Bearer explicit-jwt",
				Cookie: "DS=browser-session-jwt",
			}),
		);
		expect(response.status).toBe(200);
		expect(calls[0]?.headers.authorization).toBe("Bearer explicit-jwt");
	});

	it("forwards only a verified service-binding user projection when supplied", async () => {
		const calls = mockUpstream({ result: { contents: [] } });
		const [request, url] = resourceRequest(
			"acme",
			"ui://widgets/mcp-app/acme/orders.html",
			{ Authorization: "Bearer browser-jwt", Cookie: "DS=browser-jwt" },
		);
		const response = await handleWidgetResource(request, url, undefined, {
			sessionToken: "browser-jwt",
			tenantId: "T-org-1",
		});
		expect(response.status).toBe(200);
		for (const call of calls) {
			expect(call.headers.authorization).toBe("Bearer browser-jwt");
			expect(call.headers.cookie).toBeUndefined();
			expect(call.headers["x-service-binding"]).toBe("true");
			expect(call.headers["x-tedix-browser-bridge"]).toBe("true");
			expect(call.headers["x-tedix-tenant-id"]).toBe("T-org-1");
		}
	});

	it("refuses a malformed app slug without touching upstream", async () => {
		const calls = mockUpstream();
		for (const slug of ["Evil", "-bad", "a", "app.slug", "app slug", ""]) {
			const response = await handleWidgetResource(
				...resourceRequest(slug, "ui://widgets/x.html"),
			);
			expect(response.status).toBe(400);
		}
		expect(calls).toHaveLength(0);
	});

	it("refuses a non-ui:// uri without touching upstream", async () => {
		const calls = mockUpstream();
		const response = await handleWidgetResource(
			...resourceRequest("acme", "https://evil.example.com/x.html"),
		);
		expect(response.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("refuses non-GET methods", async () => {
		const calls = mockUpstream();
		const [_, url] = resourceRequest("acme", "ui://widgets/x.html");
		const response = await handleWidgetResource(
			new Request(url, { method: "POST", body: "{}" }),
			url,
		);
		expect(response.status).toBe(405);
		expect(calls).toHaveLength(0);
	});

	it("passes an upstream 401 through and maps other failures to 502", async () => {
		mockUpstream({ callStatus: 401 });
		const unauthorized = await handleWidgetResource(
			...resourceRequest("acme", "ui://widgets/x.html"),
		);
		expect(unauthorized.status).toBe(401);

		vi.unstubAllGlobals();
		mockUpstream({ callStatus: 500 });
		const failed = await handleWidgetResource(
			...resourceRequest("acme", "ui://widgets/x.html"),
		);
		expect(failed.status).toBe(502);
	});
});

describe("handleWidgetMcp", () => {
	const ALLOWED = [
		"tools/call",
		"resources/list",
		"resources/templates/list",
		"resources/read",
		"prompts/list",
		"tasks/get",
		"tasks/update",
		"tasks/cancel",
	];

	it.each(ALLOWED)("relays the allowlisted %s operation", async (method) => {
		const calls = mockUpstream({ result: { relayed: method } });
		const response = await handleWidgetMcp(
			...mcpRequest({ app: "acme", method, params: { a: 1 } }),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ relayed: method });
		expect(calls[1]?.body).toMatchObject({ method, params: { a: 1 } });
	});

	it("binds modern method/name headers and declares Tasks in request metadata", async () => {
		const calls = mockUpstream({ result: { acknowledged: true } });
		const response = await handleWidgetMcp(
			...mcpRequest({
				app: "acme",
				method: "tasks/update",
				params: { taskId: "task-1", inputResponses: { approval: true } },
			}),
		);
		expect(response.status).toBe(200);
		expect(calls[1]?.headers["mcp-protocol-version"]).toBe("2026-07-28");
		expect(calls[1]?.headers["mcp-method"]).toBe("tasks/update");
		expect(calls[1]?.headers["mcp-name"]).toBe("task-1");
		expect(calls[1]?.body).toMatchObject({
			method: "tasks/update",
			params: {
				taskId: "task-1",
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientCapabilities": {
						extensions: { "io.modelcontextprotocol/tasks": {} },
					},
				},
			},
		});
	});

	it("bounds upstream response bytes", async () => {
		const calls = mockUpstream();
		vi.stubGlobal(
			"fetch",
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					id: unknown;
					method: string;
				};
				if (body.method === "server/discover") {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { supportedVersions: ["2026-07-28"] },
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(1024 * 1024));
							controller.enqueue(new Uint8Array(1));
							controller.close();
						},
					}),
				);
			},
		);
		const response = await handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "tools/call", params: {} }),
		);
		expect(response.status).toBe(502);
		expect(calls).toHaveLength(0);
	});

	it("terminates an upstream request at the host deadline", async () => {
		vi.useFakeTimers();
		let callCount = 0;
		vi.stubGlobal(
			"fetch",
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				callCount++;
				if (callCount === 1) {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: "discover",
							result: { supportedVersions: ["2026-07-28"] },
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				});
			},
		);
		const pending = handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "tools/call", params: {} }),
		);
		await vi.advanceTimersByTimeAsync(15_000);
		const response = await pending;
		expect(response.status).toBe(504);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: "Upstream MCP request timed out." },
		});
	});

	it.each(["tools/list", "sampling/createMessage"])(
		"refuses %s with 403 without touching upstream",
		async (method) => {
			const calls = mockUpstream();
			const response = await handleWidgetMcp(
				...mcpRequest({ app: "acme", method, params: {} }),
			);
			expect(response.status).toBe(403);
			expect(calls).toHaveLength(0);
		},
	);

	it("refuses non-POST with 405", async () => {
		const calls = mockUpstream();
		const url = new URL("https://acme.os.tedix.dev/widgets/mcp");
		const response = await handleWidgetMcp(new Request(url), url);
		expect(response.status).toBe(405);
		expect(calls).toHaveLength(0);
	});

	it("refuses a mismatched Origin with 403 and accepts the same origin", async () => {
		const calls = mockUpstream();
		const mismatch = await handleWidgetMcp(
			...mcpRequest(
				{ app: "acme", method: "tools/call", params: {} },
				{ origin: "https://evil.example.com" },
			),
		);
		expect(mismatch.status).toBe(403);
		expect(calls).toHaveLength(0);

		const match = await handleWidgetMcp(
			...mcpRequest(
				{ app: "acme", method: "tools/call", params: {} },
				{ origin: "https://acme.os.tedix.dev" },
			),
		);
		expect(match.status).toBe(200);
	});

	it("refuses a body over 256 KiB with 413", async () => {
		const calls = mockUpstream();
		const padding = "x".repeat(256 * 1024);
		const response = await handleWidgetMcp(
			...mcpRequest({
				app: "acme",
				method: "tools/call",
				params: { padding },
			}),
		);
		expect(response.status).toBe(413);
		expect(calls).toHaveLength(0);
	});

	it("refuses a malformed slug and a non-JSON body with 400", async () => {
		const calls = mockUpstream();
		const badSlug = await handleWidgetMcp(
			...mcpRequest({ app: "Not-Valid", method: "tools/call", params: {} }),
		);
		expect(badSlug.status).toBe(400);
		const badBody = await handleWidgetMcp(...mcpRequest("not json"));
		expect(badBody.status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("forwards only the caller's Authorization and Cookie credentials", async () => {
		const calls = mockUpstream();
		const response = await handleWidgetMcp(
			...mcpRequest(
				{ app: "acme", method: "tools/call", params: {} },
				{
					headers: {
						Authorization: "Bearer user-jwt",
						Cookie: "DS=session",
						"X-Tedix-Tenant-Id": "T-evil",
						"X-Service-Binding": "true",
					},
				},
			),
		);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		for (const call of calls) {
			expect(call.headers.authorization).toBe("Bearer user-jwt");
			expect(call.headers.cookie).toBe("DS=session");
			// Only caller credentials and proxy-owned HTTP/MCP protocol headers ride
			// along: never a tenant override or service-binding claim.
			const allowed = new Set([
				"authorization",
				"cookie",
				"content-type",
				"accept",
				"mcp-protocol-version",
				"mcp-method",
				"mcp-name",
			]);
			for (const name of Object.keys(call.headers)) {
				expect(allowed.has(name)).toBe(true);
			}
		}
	});

	it("fails closed when a managed host does not advertise the required protocol", async () => {
		const calls = mockUpstream({ modern: false });
		const response = await handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "tools/call", params: {} }),
		);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: expect.stringContaining("2026-07-28") },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body.method).toBe("server/discover");
	});

	it("omits credential headers upstream when the caller sent none", async () => {
		const calls = mockUpstream();
		await handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "prompts/list", params: {} }),
		);
		expect(calls[0]?.headers.authorization).toBeUndefined();
		expect(calls[0]?.headers.cookie).toBeUndefined();
	});

	it("parses an SSE-framed method response", async () => {
		mockUpstream({
			sse: true,
			result: { structuredContent: { rows: [1, 2] } },
		});
		const response = await handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "tools/call", params: {} }),
		);
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			structuredContent: { rows: [1, 2] },
		});
	});

	it("passes an upstream 401 through with its JSON-RPC error attached", async () => {
		mockUpstream({ discoverStatus: 401 });
		const response = await handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "tools/call", params: {} }),
		);
		expect(response.status).toBe(401);
		const body = (await response.json()) as {
			error: { message: string; rpc?: { code: number } };
		};
		expect(body.error.rpc?.code).toBe(-32000);
	});

	it("maps a JSON-RPC error on a 2xx transport to 502", async () => {
		vi.stubGlobal(
			"fetch",
			async (_input: RequestInfo | URL, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					id: number;
					method: string;
				};
				if (body.method === "server/discover") {
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: { supportedVersions: ["2026-07-28"] },
						}),
						{ headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32602, message: "unknown tool" },
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			},
		);
		const response = await handleWidgetMcp(
			...mcpRequest({ app: "acme", method: "tools/call", params: {} }),
		);
		expect(response.status).toBe(502);
	});
});
