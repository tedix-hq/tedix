// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleOsPortableCall, handleWebMcpEndpoint } from "./endpoint";

interface UpstreamCall {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** Mocks the modern stateless cycle: discovery, then the configured call. */
function mockUpstream(result: unknown = { ok: true }): UpstreamCall[] {
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
				JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
				{ headers: { "Content-Type": "application/json" } },
			);
		},
	);
	return calls;
}

function post(body: unknown, init: RequestInit = {}): [Request, URL] {
	const url = new URL("https://acme.os.tedix.dev/mcp");
	const request = new Request(url, {
		...init,
		method: "POST",
		body: JSON.stringify(body),
		headers: {
			Cookie: "DS=session-jwt",
			"Content-Type": "application/json",
			...init.headers,
		},
	});
	return [request, url];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("signed OS portable relay", () => {
	const identity = {
		sessionToken: "signed-user",
		tenantId: "org_tedix",
		browserMcpScopes: ["mcp:apps.read"],
	};
	function portable(
		body: unknown,
		referer = "https://tedix.os.tedix.dev/workspaces",
	) {
		const url = new URL(
			"https://tedix.os.tedix.dev/_tedix/webmcp/portable-call",
		);
		return [
			new Request(url, {
				method: "POST",
				headers: {
					Origin: url.origin,
					Referer: referer,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			}),
			url,
		] as const;
	}
	it("verifies route before invoking the exact callable under the human MCP session", async () => {
		const calls = mockUpstream({
			structuredContent: { executionId: "one", result: { data: [] } },
		});
		const authorize = vi.fn(async () => true);
		const [request, url] = portable({
			token: "signed-route",
			routeId: "workspaces",
			callable: "os.list_os_workspaces",
			args: { limit: 2 },
		});
		const response = await handleOsPortableCall(
			request,
			url,
			"tedix",
			identity,
			authorize,
		);
		expect(response.status).toBe(200);
		expect(authorize).toHaveBeenCalledWith({
			token: "signed-route",
			routeId: "workspaces",
			callable: "os.list_os_workspaces",
			args: { limit: 2 },
			origin: url.origin,
			refererPathname: "/workspaces",
		});
		expect(calls.at(-1)?.body).toMatchObject({
			method: "tools/call",
			params: {
				name: "code",
				arguments: {
					code: 'async () => await os.list_os_workspaces({"limit":2})',
				},
			},
		});
	});
	it("refuses a stale page, invalid callable or denied token before MCP", async () => {
		const calls = mockUpstream();
		const deny = vi.fn(async () => false);
		const valid = {
			token: "signed-route",
			routeId: "workspaces",
			callable: "os.list_os_workspaces",
			args: {},
		};
		for (const [request, url] of [
			portable(valid, "https://other.os.tedix.dev/workspaces"),
			portable({ ...valid, callable: "os.list();evil" }),
			portable(valid, "https://tedix.os.tedix.dev/skills"),
		]) {
			const response = await handleOsPortableCall(
				request,
				url,
				"tedix",
				identity,
				deny,
			);
			expect(response.status).toBeGreaterThanOrEqual(400);
		}
		expect(calls).toHaveLength(0);
	});
});

describe("handleWebMcpEndpoint", () => {
	it("answers initialize locally without an upstream call", async () => {
		const calls = mockUpstream();
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 7,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			id: number;
			result: { protocolVersion: string; serverInfo: { name: string } };
		};
		expect(body.id).toBe(7);
		expect(body.result.protocolVersion).toBe("2025-06-18");
		expect(body.result.serverInfo.name).toBe("tedix-os-webmcp");
		expect(calls).toHaveLength(0);
	});

	it("advertises resources and the skills extension to legacy hosts", async () => {
		mockUpstream();
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 9,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		const body = (await response.json()) as {
			result: { capabilities: Record<string, unknown> };
		};
		expect(body.result.capabilities).toEqual({
			tools: {},
			resources: {},
			extensions: { "io.modelcontextprotocol/skills": {} },
		});
	});

	it("negotiates the supported legacy version instead of echoing arbitrary input", async () => {
		const calls = mockUpstream();
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 8,
			method: "initialize",
			params: { protocolVersion: "2099-01-01" },
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		const body = (await response.json()) as {
			result: { protocolVersion: string };
		};
		expect(body.result.protocolVersion).toBe("2025-06-18");
		expect(calls).toHaveLength(0);
	});

	it("rejects malformed JSON-RPC envelopes and non-object params", async () => {
		mockUpstream();
		for (const body of [
			{ id: 1, method: "tools/list" },
			{ jsonrpc: "1.0", id: 1, method: "tools/list" },
			{ jsonrpc: "2.0", id: true, method: "tools/list" },
			{ jsonrpc: "2.0", id: 1, method: "tools/list", params: [] },
		]) {
			const [request, url] = post(body);
			const response = await handleWebMcpEndpoint(request, url, "acme");
			expect(response.status).toBe(400);
			const payload = (await response.json()) as { error: { code: number } };
			expect([-32600, -32602]).toContain(payload.error.code);
		}
	});

	it("requires an application/json content type", async () => {
		mockUpstream();
		const [request, url] = post(
			{ jsonrpc: "2.0", id: 1, method: "tools/list" },
			{ headers: { "Content-Type": "text/plain" } },
		);
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(415);
	});

	it("accepts notifications with 202 and no body", async () => {
		mockUpstream();
		const [request, url] = post({
			jsonrpc: "2.0",
			method: "notifications/initialized",
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(202);
	});

	it("relays tools/list to the tenant's unified gateway by default", async () => {
		const calls = mockUpstream({ tools: [{ name: "code" }] });
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			id: number;
			result: { tools: Array<{ name: string }> };
		};
		expect(body.id).toBe(1);
		expect(body.result.tools[0]?.name).toBe("code");
		expect(calls[0]?.url).toBe("https://acme-unified.mcp.tedix.dev/mcp");
		// The browser session cookie is promoted to the upstream bearer.
		expect(calls[0]?.headers.authorization).toBe("Bearer session-jwt");
	});

	it("targets an explicit ?app= slug instead of the default", async () => {
		const calls = mockUpstream();
		const url = new URL("https://acme.os.tedix.dev/mcp?app=example-app");
		const request = new Request(url, {
			method: "POST",
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "list_skills", arguments: {} },
			}),
			headers: {
				Cookie: "DS=session-jwt",
				"Content-Type": "application/json",
			},
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(200);
		expect(calls[0]?.url).toBe("https://example-app.mcp.tedix.dev/mcp");
		expect(calls[1]?.body.method).toBe("tools/call");
	});

	it("relays skills/list and returns the upstream result", async () => {
		const calls = mockUpstream({ skills: [{ uri: "skill://acme/triage" }] });
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 10,
			method: "skills/list",
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			id: number;
			result: { skills: Array<{ uri: string }> };
		};
		expect(body.id).toBe(10);
		expect(body.result.skills[0]?.uri).toBe("skill://acme/triage");
		expect(calls[0]?.url).toBe("https://acme-unified.mcp.tedix.dev/mcp");
		expect(calls[1]?.body.method).toBe("skills/list");
	});

	it("relays skills/get with the uri param and bound Mcp-Name header", async () => {
		const calls = mockUpstream({ skill: { uri: "skill://acme/triage" } });
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 11,
			method: "skills/get",
			params: { uri: "skill://acme/triage" },
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(200);
		const upstream = calls[1];
		expect(upstream?.body.method).toBe("skills/get");
		expect(
			(upstream?.body.params as Record<string, unknown> | undefined)?.uri,
		).toBe("skill://acme/triage");
		expect(upstream?.headers["mcp-name"]).toBe("skill://acme/triage");
	});

	it("relays resources/read for a skill:// uri", async () => {
		const calls = mockUpstream({
			contents: [{ uri: "skill://acme/triage/SKILL.md", text: "# Triage" }],
		});
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 12,
			method: "resources/read",
			params: { uri: "skill://acme/triage/SKILL.md" },
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			result: { contents: Array<{ uri: string }> };
		};
		expect(body.result.contents[0]?.uri).toBe("skill://acme/triage/SKILL.md");
		const upstream = calls[1];
		expect(upstream?.body.method).toBe("resources/read");
		expect(upstream?.headers["mcp-name"]).toBe("skill://acme/triage/SKILL.md");
	});

	it("forwards the verified service identity across the binding", async () => {
		const calls = mockUpstream();
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 3,
			method: "tools/list",
		});
		await handleWebMcpEndpoint(request, url, "acme", fetch, {
			sessionToken: "verified-jwt",
			tenantId: "T1",
			browserMcpScopes: ["mcp:apps.read", "mcp:work.read"],
		});
		expect(calls[0]?.headers.authorization).toBe("Bearer verified-jwt");
		expect(calls[0]?.headers["x-service-binding"]).toBe("true");
		expect(calls[0]?.headers["x-tedix-tenant-id"]).toBe("T1");
		expect(calls[0]?.headers["x-tedix-browser-scopes"]).toBe(
			"mcp:apps.read mcp:work.read",
		);
	});

	it("refuses methods outside the relay allowlist", async () => {
		const calls = mockUpstream();
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 4,
			method: "prompts/get",
			params: { name: "x" },
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		const body = (await response.json()) as { error: { code: number } };
		expect(body.error.code).toBe(-32601);
		expect(calls).toHaveLength(0);
	});

	it("refuses a cross-origin caller", async () => {
		mockUpstream();
		const [request, url] = post(
			{ jsonrpc: "2.0", id: 5, method: "tools/list" },
			{ headers: { Origin: "https://evil.example" } },
		);
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(403);
	});

	it("refuses non-POST requests", async () => {
		mockUpstream();
		const url = new URL("https://acme.os.tedix.dev/mcp");
		const response = await handleWebMcpEndpoint(
			new Request(url, { method: "GET" }),
			url,
			"acme",
		);
		expect(response.status).toBe(405);
	});

	it("maps an upstream auth failure onto the JSON-RPC envelope", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					JSON.stringify({ error: { code: -32001, message: "no access" } }),
					{ status: 401 },
				),
		);
		const [request, url] = post({
			jsonrpc: "2.0",
			id: 6,
			method: "tools/list",
		});
		const response = await handleWebMcpEndpoint(request, url, "acme");
		expect(response.status).toBe(401);
		const body = (await response.json()) as {
			id: number;
			error: { message: string };
		};
		expect(body.id).toBe(6);
		expect(body.error.message).toBe("no access");
	});

	describe("relay telemetry log line", () => {
		function spyLog() {
			return vi.spyOn(console, "log").mockImplementation(() => {});
		}

		it("logs one ok line per relayed tools/call with the tool name", async () => {
			const log = spyLog();
			mockUpstream();
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "list_work_items", arguments: { secret: "hidden" } },
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log).toHaveBeenCalledTimes(1);
			const [prefix, line] = log.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(prefix).toBe("webmcp.relay");
			expect(line).toEqual({
				method: "tools/call",
				tool: "list_work_items",
				app: "acme-unified",
				outcome: "ok",
				durationMs: expect.any(Number),
				status: 200,
			});
			// Never payloads: the line must not carry arguments or results.
			expect(JSON.stringify(line)).not.toContain("hidden");
			log.mockRestore();
		});

		it("logs tools/list with no tool field", async () => {
			const log = spyLog();
			mockUpstream();
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log.mock.calls[0]?.[1]).toEqual({
				method: "tools/list",
				app: "acme-unified",
				outcome: "ok",
				durationMs: expect.any(Number),
				status: 200,
			});
			log.mockRestore();
		});

		it("omits caller-controlled resource URIs and params from relay logs", async () => {
			const log = spyLog();
			mockUpstream();
			const longUri = "skill://acme/private-customer-token";
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 7,
				method: "skills/get",
				params: { uri: longUri, secretArgument: "hidden" },
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log).toHaveBeenCalledTimes(1);
			const [prefix, line] = log.mock.calls[0] as [
				string,
				Record<string, unknown>,
			];
			expect(prefix).toBe("webmcp.relay");
			expect(line).toEqual({
				method: "skills/get",
				app: "acme-unified",
				outcome: "ok",
				durationMs: expect.any(Number),
				status: 200,
			});
			// A bounded URI can still contain credentials or private content.
			expect(JSON.stringify(line)).not.toContain(longUri);
			expect(JSON.stringify(line)).not.toContain("hidden");
			log.mockRestore();
		});

		it("keeps nested upstream exception content out of durable logs", async () => {
			const failure = new Error("private request URI", {
				cause: new TypeError("secret bearer"),
			});
			vi.stubGlobal("fetch", async () => {
				throw failure;
			});
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
			const relayLog = spyLog();
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 9,
				method: "tools/list",
			});
			const response = await handleWebMcpEndpoint(request, url, "acme");
			expect(response.status).toBe(502);
			expect(errorLog).toHaveBeenCalledWith({
				component: "os.webmcp.relay",
				event: "webmcp.endpoint.upstream_failed",
				failure: { name: "Error", cause: { name: "TypeError" } },
				message: "WebMCP endpoint upstream failed",
			});
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
				"private request URI",
			);
			expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
				"secret bearer",
			);
			expect(relayLog).toHaveBeenCalledTimes(1);
			errorLog.mockRestore();
			relayLog.mockRestore();
		});

		it("logs skills/list with no target field", async () => {
			const log = spyLog();
			mockUpstream();
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 8,
				method: "skills/list",
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log.mock.calls[0]?.[1]).toEqual({
				method: "skills/list",
				app: "acme-unified",
				outcome: "ok",
				durationMs: expect.any(Number),
				status: 200,
			});
			log.mockRestore();
		});

		it("classifies an upstream auth refusal as unauthorized", async () => {
			const log = spyLog();
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({ error: { code: -32001, message: "no access" } }),
						{ status: 401 },
					),
			);
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 3,
				method: "tools/list",
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log.mock.calls[0]?.[1]).toMatchObject({
				method: "tools/list",
				outcome: "unauthorized",
				status: 401,
			});
			log.mockRestore();
		});

		it("classifies an upstream JSON-RPC error as rpc_error", async () => {
			const log = spyLog();
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify({ error: { code: -32002, message: "tool broke" } }),
						{ status: 500 },
					),
			);
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "get_work_item" },
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log.mock.calls[0]?.[1]).toMatchObject({
				tool: "get_work_item",
				outcome: "rpc_error",
				status: 502,
			});
			log.mockRestore();
		});

		it("classifies an unreachable upstream as upstream_error", async () => {
			const log = spyLog();
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.stubGlobal("fetch", async () => {
				throw new Error("connection refused");
			});
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 5,
				method: "tools/list",
			});
			const response = await handleWebMcpEndpoint(request, url, "acme");
			expect(response.status).toBe(502);
			expect(log.mock.calls[0]?.[1]).toMatchObject({
				outcome: "upstream_error",
				status: 502,
			});
			log.mockRestore();
			error.mockRestore();
		});

		it("logs nothing for locally answered lifecycle methods", async () => {
			const log = spyLog();
			const [request, url] = post({
				jsonrpc: "2.0",
				id: 6,
				method: "initialize",
				params: { protocolVersion: "2025-06-18" },
			});
			await handleWebMcpEndpoint(request, url, "acme");
			expect(log).not.toHaveBeenCalled();
			log.mockRestore();
		});
	});
});
