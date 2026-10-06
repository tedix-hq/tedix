import { describe, expect, it } from "vite-plus/test";
import {
	DOCS_DELEGATED_SCOPE_BY_TOOL,
	callDocsMcpTool,
	docsActorHeaders,
	isAttributableDocsActor,
	resolveDocsCallerAuthorization,
} from "./docs";
import type { BaseContext } from "../orpc";

describe("docs caller attribution", () => {
	const contextWith = (fields: Record<string, unknown>) =>
		fields as unknown as BaseContext;

	it("identifies a tedi that arrives without any bearer token", () => {
		const headers = docsActorHeaders(contextWith({ tediId: "tedi-cto" }));
		expect(headers).toMatchObject({
			"X-Tedix-Actor-Type": "tedi",
			"X-Tedix-Actor-Id": "tedi-cto",
		});
		expect(isAttributableDocsActor(headers)).toBe(true);
	});

	it("identifies an external agent and carries its session", () => {
		const headers = docsActorHeaders(
			contextWith({
				externalAgentPrincipalId: "principal-1",
				externalAgentSessionId: "session-1",
			}),
		);
		expect(headers).toMatchObject({
			"X-Tedix-Actor-Type": "external_agent",
			"X-Tedix-Agent-Session-Id": "session-1",
		});
		expect(isAttributableDocsActor(headers)).toBe(true);
	});

	it("treats the bare service fallback as unattributable", () => {
		// No principal resolved — this must not pass as a caller identity.
		expect(isAttributableDocsActor(docsActorHeaders(contextWith({})))).toBe(
			false,
		);
	});
});

describe("resolveDocsCallerAuthorization", () => {
	it("reads the token apps/mcp forwards on service-binding calls", () => {
		// apps/mcp/src/mcp/handler.ts sets only these two headers for an
		// authenticated MCP caller on the rpc transport — no Authorization.
		const headers = new Headers({
			"X-Forwarded-Authorization": "Bearer user-jwt",
			"X-Tedix-Caller-Type": "mcp-edge-user",
		});
		expect(resolveDocsCallerAuthorization(headers)).toBe("Bearer user-jwt");
	});

	it("accepts a lowercased forwarded header", () => {
		const headers = new Headers({
			"x-forwarded-authorization": "Bearer user-jwt",
		});
		expect(resolveDocsCallerAuthorization(headers)).toBe("Bearer user-jwt");
	});

	it("reads Authorization for direct Tedix OS callers", () => {
		const headers = new Headers({ Authorization: "Bearer direct-user-jwt" });
		expect(resolveDocsCallerAuthorization(headers)).toBe(
			"Bearer direct-user-jwt",
		);
	});

	it("never relays the platform service token as the caller identity", () => {
		// Upstream-MCP transport: Authorization is PLATFORM_SERVICE_TOKEN while the
		// real caller rides in the forwarded header. Picking Authorization here
		// would hand Docs Studio service authority under a user's name.
		const headers = new Headers({
			Authorization: "Bearer platform-service-token",
			"X-Forwarded-Authorization": "Bearer user-jwt",
		});
		expect(resolveDocsCallerAuthorization(headers)).toBe("Bearer user-jwt");
	});

	it("fails closed when no caller token is present", () => {
		expect(resolveDocsCallerAuthorization(new Headers())).toBeNull();
		expect(
			resolveDocsCallerAuthorization(new Headers({ Authorization: "Basic x" })),
		).toBeNull();
	});
});

describe("Docs delegated scopes", () => {
	it("delegates the exact required scope for every API-reachable Docs tool", () => {
		expect(DOCS_DELEGATED_SCOPE_BY_TOOL).toEqual({
			list_docs_sites: "mcp:content.read",
			get_docs_site: "mcp:content.read",
			list_docs_builds: "mcp:content.read",
			get_docs_preview_link: "mcp:content.read",
			list_docs_changes: "mcp:content.read",
			list_docs_releases: "mcp:content.read",
			get_docs_diff: "mcp:content.read",
			start_docs_build: "mcp:content.write",
			validate_docs_change: "mcp:content.write",
			upsert_docs_site: "mcp:content.admin",
			import_docs_repository: "mcp:content.admin",
			commit_docs_change: "mcp:content.admin",
			publish_docs_build: "mcp:content.admin",
			rollback_docs_build: "mcp:content.admin",
		});
	});
});

describe("callDocsMcpTool", () => {
	function docsBinding(reply: (body: { id: unknown }) => Response) {
		const requests: Array<{
			url: string;
			headers: Headers;
			body: Record<string, unknown>;
		}> = [];
		return {
			requests,
			fetch: async (url: string, init: RequestInit) => {
				const body = JSON.parse(String(init.body)) as {
					id: unknown;
				} & Record<string, unknown>;
				requests.push({ url, headers: new Headers(init.headers), body });
				return reply(body);
			},
		};
	}

	const call = (fetch: ReturnType<typeof docsBinding>["fetch"]) =>
		callDocsMcpTool({
			fetch,
			organizationSlug: "acme",
			headers: { "X-Tedix-Delegated-Scope": "mcp:content.read" },
			name: "list_docs_sites",
			args: { includeDisabled: false },
		});

	it("binds the internal Docs call to the 2026 stateless protocol", async () => {
		const binding = docsBinding((body) =>
			Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: { resultType: "complete", content: [] },
			}),
		);

		await call(binding.fetch);

		expect(binding.requests).toHaveLength(1);
		const [request] = binding.requests;
		expect(request?.url).toBe("https://docs.internal/mcp?org=acme");
		expect(request?.headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
		expect(request?.headers.get("Mcp-Method")).toBe("tools/call");
		expect(request?.headers.get("Mcp-Name")).toBe("list_docs_sites");
		expect(request?.headers.get("X-Tedix-Delegated-Scope")).toBe(
			"mcp:content.read",
		);
		expect(request?.body).toMatchObject({
			jsonrpc: "2.0",
			method: "tools/call",
			params: {
				name: "list_docs_sites",
				arguments: { includeDisabled: false },
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				},
			},
		});
	});

	it("returns structured MCP content", async () => {
		const binding = docsBinding((body) =>
			Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					resultType: "complete",
					content: [],
					structuredContent: { sites: [{ id: "site-1" }] },
				},
			}),
		);

		await expect(call(binding.fetch)).resolves.toEqual({
			sites: [{ id: "site-1" }],
		});
	});

	it("parses a Streamable HTTP SSE response", async () => {
		const binding = docsBinding(
			(body) =>
				new Response(
					[
						"event: message",
						`data: ${JSON.stringify({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								content: [],
								structuredContent: { sites: [] },
							},
						})}`,
						"",
						"",
					].join("\n"),
					{ headers: { "Content-Type": "text/event-stream" } },
				),
		);

		await expect(call(binding.fetch)).resolves.toEqual({ sites: [] });
	});

	it("does not turn an MCP tool error into a successful API response", async () => {
		const binding = docsBinding((body) =>
			Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					resultType: "complete",
					isError: true,
					content: [
						{
							type: "text",
							text: 'insufficient_scope: requires "mcp:content.admin"',
						},
					],
				},
			}),
		);

		await expect(call(binding.fetch)).rejects.toThrow("insufficient_scope");
	});

	it("keeps an unauthorized Docs answer unauthorized", async () => {
		const binding = docsBinding(
			() => new Response("missing caller token", { status: 401 }),
		);

		await expect(call(binding.fetch)).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: expect.stringContaining("missing caller token"),
		});
	});
});
