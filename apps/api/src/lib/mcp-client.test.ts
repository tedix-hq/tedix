import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { MCP_LIST_MAX_PAGES } from "@tedix/mcp-shared/bounded-list";
import {
	callMcpTool,
	connectMcpServer,
	resetMcpEraCache,
	serviceBindingFetchFn,
} from "./mcp-client";

// 2026-07-28 results carry `resultType`; cacheable list pages also carry the
// SEP-2549 freshness fields. Older-protocol fixtures send neither.
const MODERN_COMPLETE = { resultType: "complete" } as const;
const MODERN_LIST_PAGE = {
	resultType: "complete",
	ttlMs: 0,
	cacheScope: "private",
} as const;

describe("connectMcpServer", () => {
	beforeEach(() => resetMcpEraCache());
	afterEach(() => resetMcpEraCache());

	it("rejects a server without current discovery instead of probing legacy methods", async () => {
		const requests: Array<{ authorization?: string; method?: string }> = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			requests.push({
				authorization: headers.get("Authorization") ?? undefined,
				method: body.method,
			});

			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					tools: [
						{
							name: "content_publish",
							inputSchema: {
								type: "object",
								properties: { collection: { type: "string" } },
							},
						},
					],
				},
			});
		};

		const result = await connectMcpServer("https://builder.tedix.dev/mcp", {
			fetchFn,
			headers: { Authorization: "Bearer platform-token" },
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("server/discover must advertise 2026-07-28");
		expect(requests).toEqual([
			{ authorization: "Bearer platform-token", method: "server/discover" },
		]);
	});

	it("scans an authenticated external server using older Streamable HTTP", async () => {
		const requests: Array<{
			method: string;
			protocolVersion: string | null;
			mcpMethod: string | null;
			sessionId: string | null;
			authorization: string | null;
		}> = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method: string;
			};
			const headers = new Headers(init?.headers);
			requests.push({
				method: body.method,
				protocolVersion: headers.get("MCP-Protocol-Version"),
				mcpMethod: headers.get("Mcp-Method"),
				sessionId: headers.get("Mcp-Session-Id"),
				authorization: headers.get("Authorization"),
			});
			if (body.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: { supportedVersions: ["2025-03-26"] },
				});
			if (body.method === "initialize")
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							serverInfo: { name: "Ref", version: "1.0.0" },
							capabilities: { tools: {} },
						},
					},
					{ headers: { "Mcp-Session-Id": "ref-session" } },
				);
			if (body.method === "notifications/initialized")
				return new Response(null, { status: 202 });
			if (body.method === "tools/list")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						tools: [
							{
								name: "ref_search_documentation",
								inputSchema: { type: "object" },
							},
						],
					},
				});
			return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
		};

		const result = await connectMcpServer("https://api.ref.tools/mcp", {
			fetchFn,
			headers: { Authorization: "Bearer test-token" },
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.protocolVersion).toBe("2025-03-26");
		expect(result.serverInfo?.tools.map((tool) => tool.name)).toEqual([
			"ref_search_documentation",
		]);
		expect(requests.map((request) => request.method)).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		expect(requests[1]).toMatchObject({
			protocolVersion: null,
			mcpMethod: null,
			authorization: "Bearer test-token",
		});
		expect(requests[3]).toMatchObject({
			protocolVersion: "2025-03-26",
			mcpMethod: null,
			sessionId: "ref-session",
		});
	});

	it("reports an external auth challenge during older-protocol negotiation", async () => {
		const result = await connectMcpServer("https://api.ref.tools/mcp", {
			fetchFn: async () =>
				new Response("Authentication required", { status: 401 }),
		});
		expect(result.success).toBe(false);
		expect(result.requiresAuth).toBe(true);
		expect(result.errorCode).toBe("AUTH_REQUIRED");
	});

	it("continues direct MCP list pagination when nextCursor is an empty string", async () => {
		const toolParams: unknown[] = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
				params?: Record<string, unknown>;
			};

			if (body.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});

			if (body.method === "tools/list") {
				toolParams.push(body.params ?? {});
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						toolParams.length === 1
							? {
									...MODERN_LIST_PAGE,
									tools: [
										{
											name: "first_tool",
											inputSchema: { type: "object", properties: {} },
										},
									],
									nextCursor: "",
								}
							: {
									...MODERN_LIST_PAGE,
									tools: [
										{
											name: "second_tool",
											inputSchema: { type: "object", properties: {} },
										},
									],
								},
				});
			}

			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {},
			});
		};

		const result = await connectMcpServer("https://builder.tedix.dev/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.tools.map((tool) => tool.name)).toEqual([
			"first_tool",
			"second_tool",
		]);
		expect(toolParams).toEqual([
			expect.objectContaining({ _meta: expect.any(Object) }),
			expect.objectContaining({ cursor: "", _meta: expect.any(Object) }),
		]);
	});

	it("lists advertised SEP-2640 manifests with bounded cursor pagination only", async () => {
		const skillCalls: Array<Record<string, unknown>> = [];
		const fetchedMethods: string[] = [];
		const entry = (name: string) => ({
			uri: `skill://${name}/SKILL.md`,
			frontmatter: { name, description: `${name} skill` },
			resources: [
				{
					uri: `skill://${name}/SKILL.md`,
					digest: `sha256:${"a".repeat(64)}`,
					size: 12,
				},
			],
		});
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
				params?: Record<string, unknown>;
			};
			fetchedMethods.push(body.method ?? "");
			if (body.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: {
							tools: {},
							extensions: { "io.modelcontextprotocol/skills": {} },
						},
					},
				});
			if (body.method === "skills/list") {
				skillCalls.push(body.params ?? {});
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result:
						skillCalls.length === 1
							? {
									...MODERN_COMPLETE,
									skills: [entry("first")],
									nextCursor: "page-2",
								}
							: { ...MODERN_COMPLETE, skills: [entry("second")] },
				});
			}
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: { ...MODERN_LIST_PAGE, tools: [] },
			});
		};

		const result = await connectMcpServer("https://skills.example/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.skills.map((skill) => skill.uri)).toEqual([
			"skill://first/SKILL.md",
			"skill://second/SKILL.md",
		]);
		expect(skillCalls.map((params) => params.cursor)).toEqual([
			undefined,
			"page-2",
		]);
		expect(fetchedMethods).not.toContain("resources/read");
	});

	it("does not call Skills methods unless the extension is advertised", async () => {
		const methods: string[] = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			methods.push(body.method ?? "");
			if (body.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: { ...MODERN_LIST_PAGE, tools: [] },
			});
		};

		const result = await connectMcpServer("https://ordinary.example/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.skills).toEqual([]);
		expect(methods).not.toContain("skills/list");
	});

	it("bounds a hostile server whose tools/list cursor never terminates", async () => {
		let toolPages = 0;
		const fetchFn: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});
			}
			if (body.method === "tools/list") {
				toolPages += 1;
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						...MODERN_LIST_PAGE,
						tools: [
							{ name: `tool_${toolPages}`, inputSchema: { type: "object" } },
						],
						nextCursor: `cursor-${toolPages}`,
					},
				});
			}
			return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
		};

		const result = await connectMcpServer("https://hostile.example/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(toolPages).toBe(MCP_LIST_MAX_PAGES);
		expect(result.serverInfo?.tools).toHaveLength(MCP_LIST_MAX_PAGES);
		// The catalog is known incomplete, and says so: nothing downstream may
		// conclude this server lacks a tool it never got to see.
		expect(result.serverInfo?.listsTruncated.tools).toBe(true);
	});

	it("marks only a failed list incomplete and preserves other complete lists", async () => {
		const fetchFn: typeof fetch = async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {}, resources: {} },
					},
				});
			}
			if (body.method === "tools/list")
				return new Response("Unauthorized", { status: 401 });
			if (body.method === "resources/list")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						...MODERN_LIST_PAGE,
						resources: [{ name: "readme", uri: "file:///readme.md" }],
					},
				});
			return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
		};

		const result = await connectMcpServer("https://partial.example/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.listsTruncated).toMatchObject({
			tools: true,
			resources: false,
		});
		expect(result.serverInfo?.resources).toEqual([
			{ name: "readme", uri: "file:///readme.md" },
		]);
		expect(result.partialAuth).toBe(true);
	});

	it("adapts a Cloudflare service binding into the MCP fetch function", async () => {
		let forwardedRequest: Request | undefined;
		const fetchFn = serviceBindingFetchFn({
			async fetch(input) {
				forwardedRequest =
					input instanceof Request ? input : new Request(input);
				return Response.json({ ok: true });
			},
		});

		const response = await fetchFn("https://builder.tedix.dev/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer platform-token" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
		});

		expect(response.ok).toBe(true);
		expect(forwardedRequest?.url).toBe("https://builder.tedix.dev/mcp");
		expect(forwardedRequest?.method).toBe("POST");
		expect(forwardedRequest?.headers.get("Authorization")).toBe(
			"Bearer platform-token",
		);
		expect(await forwardedRequest?.json()).toMatchObject({
			method: "tools/list",
		});
	});

	it("keeps a vendor session and cookie through older Streamable HTTP lists", async () => {
		const requests: Array<{
			method?: string;
			cookie?: string;
			sessionId?: string;
			capabilities?: unknown;
			hasId: boolean;
		}> = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number;
				method?: string;
				params?: { capabilities?: unknown };
			};
			requests.push({
				method: body.method,
				cookie: headers.get("Cookie") ?? undefined,
				sessionId: headers.get("Mcp-Session-Id") ?? undefined,
				capabilities: body.params?.capabilities,
				hasId: "id" in body,
			});

			if (body.method === "initialize") {
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							serverInfo: { name: "sticky-session", version: "1.0.0" },
							capabilities: { tools: { listChanged: true } },
						},
					},
					{
						headers: {
							"Mcp-Session-Id": "session-1",
							"Set-Cookie": "AWSALB=sticky; Path=/; HttpOnly",
						},
					},
				);
			}

			if (body.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}

			if (headers.get("Cookie") !== "AWSALB=sticky") {
				return Response.json(
					{ message: "Session not found: session-1" },
					{ status: 404 },
				);
			}

			if (body.method === "tools/list") {
				return new Response(
					`event:message\ndata:${JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							tools: [
								{
									name: "search_products",
									inputSchema: { type: "object", properties: {} },
								},
							],
						},
					})}\n\n`,
					{
						headers: {
							"Content-Type": "text/event-stream",
							"Mcp-Session-Id": "rogue-mid-session-id",
						},
					},
				);
			}

			return Response.json(
				{
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32601, message: "Method not found" },
				},
				{ status: 200 },
			);
		};

		const result = await connectMcpServer("https://vendor.example/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.tools.map((tool) => tool.name)).toEqual([
			"search_products",
		]);
		expect(requests.map((request) => request.method)).toEqual([
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/list",
		]);
		expect(requests[3]).toMatchObject({
			cookie: "AWSALB=sticky",
			sessionId: "session-1",
		});
	});

	it("negotiates the modern revision and skips initialize for 2026-07-28 servers", async () => {
		const requests: Array<{
			method?: string;
			protocolVersion?: string;
			mcpMethod?: string;
			sessionId?: string;
			meta?: unknown;
		}> = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
				params?: { _meta?: unknown };
			};
			requests.push({
				method: body.method,
				protocolVersion: headers.get("MCP-Protocol-Version") ?? undefined,
				mcpMethod: headers.get("Mcp-Method") ?? undefined,
				sessionId: headers.get("Mcp-Session-Id") ?? undefined,
				meta: body.params?._meta,
			});

			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28", "2025-06-18"],
						_meta: {
							"io.modelcontextprotocol/serverInfo": {
								name: "tedix",
								version: "1.0.0",
							},
						},
						capabilities: { tools: {} },
					},
				});
			}

			if (body.method === "tools/list") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						...MODERN_LIST_PAGE,
						tools: [{ name: "list_skills", inputSchema: { type: "object" } }],
					},
				});
			}

			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				error: { code: -32601, message: "Method not found" },
			});
		};

		const result = await connectMcpServer("https://tedix.mcp.tedix.dev/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.name).toBe("tedix");
		expect(result.serverInfo?.protocolVersion).toBe("2026-07-28");
		expect(result.serverInfo?.tools.map((tool) => tool.name)).toEqual([
			"list_skills",
		]);

		const methods = requests.map((request) => request.method);
		// Modern is sessionless: no initialize, no notifications/initialized.
		expect(methods).not.toContain("initialize");
		expect(methods).not.toContain("notifications/initialized");
		// server/discover used both for negotiation (cached) and for identity.
		expect(methods[0]).toBe("server/discover");
		expect(methods).toContain("tools/list");

		const toolsListReq = requests.find((r) => r.method === "tools/list");
		expect(toolsListReq?.protocolVersion).toBe("2026-07-28");
		expect(toolsListReq?.mcpMethod).toBe("tools/list");
		expect(toolsListReq?.sessionId).toBeUndefined();
		expect(toolsListReq?.meta).toMatchObject({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": {
				name: "tedix-mcp-scanner",
				version: "1.0.0",
			},
			"io.modelcontextprotocol/clientCapabilities": {},
		});
		for (const discoverReq of requests.filter(
			(request) => request.method === "server/discover",
		)) {
			expect(discoverReq.protocolVersion).toBe("2026-07-28");
			expect(discoverReq.meta).toMatchObject({
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": {
					name: expect.any(String),
					version: "1.0.0",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			});
		}
	});

	it("rejects a legacy service-binding MCP server after discovery", async () => {
		const requests: Array<{
			method?: string;
			authorization?: string;
			host?: string;
			serviceBinding?: string;
			orgId?: string;
			sessionId?: string;
			clientName?: string;
		}> = [];
		const fetchFn = serviceBindingFetchFn({
			async fetch(input): Promise<Response> {
				const request = input instanceof Request ? input : new Request(input);
				const body = JSON.parse(await request.text()) as {
					id?: number;
					method?: string;
					params?: {
						clientInfo?: { name?: string };
					};
				};
				requests.push({
					method: body.method,
					authorization: request.headers.get("Authorization") ?? undefined,
					host: request.headers.get("X-Tedix-Host") ?? undefined,
					serviceBinding: request.headers.get("X-Service-Binding") ?? undefined,
					orgId: request.headers.get("X-Tedix-Org-Id") ?? undefined,
					sessionId: request.headers.get("Mcp-Session-Id") ?? undefined,
					clientName: body.params?.clientInfo?.name,
				});

				if (body.method === "server/discover") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { supportedVersions: ["2025-03-26"] },
					});
				}

				if (body.method === "initialize") {
					return Response.json(
						{
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-03-26",
								serverInfo: { name: "widgets", version: "1.0.0" },
								capabilities: { tools: {} },
							},
						},
						{ headers: { "Mcp-Session-Id": "session-widget-1" } },
					);
				}

				if (body.method === "notifications/initialized") {
					return new Response(null, { status: 202 });
				}

				if (body.method === "tools/call") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [{ type: "text", text: "ok" }],
							structuredContent: { items: [{ id: "item-1" }] },
						},
					});
				}

				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					error: { code: -32601, message: "Method not found" },
				});
			},
		});

		const result = await callMcpTool(
			"https://mcp.tedix.dev/mcp",
			"search_listings",
			{ q: "chairs" },
			{
				clientName: "tedix-mcp-test-client",
				fetchFn,
				headers: {
					Authorization: "Bearer service-token",
					"X-Service-Binding": "true",
					"X-Tedix-Host": "acme.mcp.tedix.dev",
					"X-Tedix-Org-Id": "org-1",
				},
			},
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain("server/discover must advertise 2026-07-28");
		expect(requests.map((request) => request.method)).toEqual([
			"server/discover",
		]);
		expect(requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "server/discover",
					authorization: "Bearer service-token",
					host: "acme.mcp.tedix.dev",
					serviceBinding: "true",
					orgId: "org-1",
				}),
			]),
		);
	});

	it("calls a modern streamable tool with widget client metadata and request-bound headers", async () => {
		const requests: Array<{
			method?: string;
			mcpMethod?: string;
			mcpName?: string;
			host?: string;
			meta?: unknown;
		}> = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const headers = new Headers(init?.headers);
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
				params?: { _meta?: unknown };
			};
			requests.push({
				method: body.method,
				mcpMethod: headers.get("Mcp-Method") ?? undefined,
				mcpName: headers.get("Mcp-Name") ?? undefined,
				host: headers.get("X-Tedix-Host") ?? undefined,
				meta: body.params?._meta,
			});

			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						_meta: {
							"io.modelcontextprotocol/serverInfo": {
								name: "widgets",
								version: "1.0.0",
							},
						},
						capabilities: { tools: {} },
					},
				});
			}

			if (body.method === "tools/call") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						...MODERN_COMPLETE,
						content: [{ type: "text", text: "ok" }],
						structuredContent: { rows: [1] },
					},
				});
			}

			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				error: { code: -32601, message: "Method not found" },
			});
		};

		const result = await callMcpTool(
			"https://mcp.tedix.dev/mcp",
			"search_listings",
			{ q: "chairs" },
			{
				clientName: "tedix-mcp-test-client",
				fetchFn,
				headers: { "X-Tedix-Host": "acme.mcp.tedix.dev" },
			},
		);

		expect(result.success).toBe(true);
		expect(requests.map((request) => request.method)).not.toContain(
			"initialize",
		);
		const toolCall = requests.find(
			(request) => request.method === "tools/call",
		);
		expect(toolCall).toMatchObject({
			mcpMethod: "tools/call",
			mcpName: "search_listings",
			host: "acme.mcp.tedix.dev",
		});
		expect(toolCall?.meta).toMatchObject({
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientInfo": {
				name: "tedix-mcp-test-client",
				version: "1.0.0",
			},
			"io.modelcontextprotocol/clientCapabilities": {},
		});
	});

	it("reports an input_required tool result as INPUT_REQUIRED, not success", async () => {
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};

			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						_meta: {
							"io.modelcontextprotocol/serverInfo": {
								name: "widgets",
								version: "1.0.0",
							},
						},
						capabilities: { tools: {} },
					},
				});
			}

			if (body.method === "tools/call") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "input_required",
						requestState: "opaque-state-1",
						inputRequests: { approval: { method: "elicitation/create" } },
						content: [
							{
								type: "text",
								text: 'Approval required for destructive action "delete_listing". Provide a reason and retry with inputResponses + requestState.',
							},
						],
					},
				});
			}

			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				error: { code: -32601, message: "Method not found" },
			});
		};

		const result = await callMcpTool(
			"https://mcp.tedix.dev/mcp",
			"delete_listing",
			{ id: "listing-1" },
			{ fetchFn },
		);

		expect(result.success).toBe(false);
		expect(result.isError).toBe(true);
		expect(result.errorCode).toBe("INPUT_REQUIRED");
		expect(result.error).toContain("input_required");
		expect(result.error).toContain("delete_listing");
		expect(result.rawResult).toEqual({
			resultType: "input_required",
			requestState: "opaque-state-1",
			inputRequests: { approval: { method: "elicitation/create" } },
		});
	});

	it("parses CRLF-delimited SSE responses with multi-line data fields", async () => {
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			if (body.method === "server/discover")
				return new Response("Unsupported protocol version", { status: 400 });
			if (body.method === "initialize")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-06-18",
						serverInfo: { name: "crlf", version: "1.0.0" },
						capabilities: { tools: {} },
					},
				});
			if (body.method === "notifications/initialized")
				return new Response(null, { status: 202 });
			// One JSON-RPC response split across two `data:` lines, CRLF line
			// endings throughout: the lines join with "\n", which JSON tolerates.
			const json = JSON.stringify({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					tools: [{ name: "crlf_tool", inputSchema: { type: "object" } }],
				},
			});
			const split = json.indexOf('"result"');
			return new Response(
				`event: message\r\ndata: ${json.slice(0, split)}\r\ndata: ${json.slice(split)}\r\n\r\n`,
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		};

		const result = await connectMcpServer("https://crlf.example/mcp", {
			fetchFn,
		});

		expect(result.success).toBe(true);
		expect(result.serverInfo?.protocolVersion).toBe("2025-06-18");
		expect(result.serverInfo?.tools.map((tool) => tool.name)).toEqual([
			"crlf_tool",
		]);
		expect(result.serverInfo?.listsTruncated.tools).toBe(false);
	});

	it("reports a WAF 403 as WAF_BLOCKED rather than an auth requirement", async () => {
		const result = await connectMcpServer("https://waf.example/mcp", {
			fetchFn: async () =>
				new Response("Access Denied", {
					status: 403,
					headers: { Server: "cloudflare" },
				}),
		});

		expect(result.success).toBe(false);
		expect(result.requiresAuth).toBe(false);
		expect(result.errorCode).toBe("WAF_BLOCKED");
		expect(result.wafProvider).toBe("Cloudflare");
	});

	it("reports the protected-resource metadata URL from an auth challenge", async () => {
		const result = await connectMcpServer("https://oauth.example/mcp", {
			fetchFn: async () =>
				new Response("Unauthorized", {
					status: 401,
					headers: {
						"WWW-Authenticate":
							'Bearer resource_metadata="https://oauth.example/.well-known/oauth-protected-resource"',
					},
				}),
		});

		expect(result.errorCode).toBe("AUTH_REQUIRED");
		expect(result.requiresAuth).toBe(true);
		expect(result.authUrl).toBe(
			"https://oauth.example/.well-known/oauth-protected-resource",
		);
	});

	it("reports an unanswered tool call as TIMEOUT", async () => {
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			if (body.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
		};

		const result = await callMcpTool(
			"https://slow.example/mcp",
			"slow_tool",
			{},
			{ fetchFn, timeout: 50 },
		);

		expect(result.success).toBe(false);
		expect(result.errorCode).toBe("TIMEOUT");
	});

	it("remembers a negotiated era so a warm tool call skips the discover probe", async () => {
		const methods: string[] = [];
		const fetchFn = async (
			_url: string,
			init?: RequestInit,
		): Promise<Response> => {
			const body = JSON.parse(String(init?.body ?? "{}")) as {
				id?: number | string;
				method?: string;
			};
			methods.push(body.method ?? "");
			if (body.method === "server/discover")
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					...MODERN_COMPLETE,
					content: [{ type: "text", text: "ok" }],
				},
			});
		};

		const call = () =>
			callMcpTool("https://warm.example/mcp", "echo", {}, { fetchFn });
		expect((await call()).success).toBe(true);
		expect((await call()).success).toBe(true);
		expect(methods).toEqual(["server/discover", "tools/call", "tools/call"]);
	});
});
