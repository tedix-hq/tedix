import { beforeEach, describe, expect, it } from "vite-plus/test";
import { type CmsProxyContext } from "./cms-proxy-runtime";
import {
	callCmsRest,
	callCmsFormsTool,
	completeExistingCmsSetup,
} from "./cms-proxy-rest";
import {
	callTenantMcpTool,
	clearTenantMcpEras,
	listTenantMcpTools,
	shouldForwardCmsRestToTenantMcp,
} from "./cms-proxy-tenant-mcp";
import { registerCmsProxyTools } from "./cms-proxy-tools";
import { encodeCmsHumanIdentity } from "./cms-human-auth";

import {
	baseContext,
	emdashMcpHandshake,
	EMDASH_HANDSHAKE,
} from "./__tests__/cms-proxy-fixtures";

// Load installed upstream source during collection, outside the permission test's deadline.
const { dispatchPluginApiRequest } = await import(
	new URL(
		"../../templates/tedix/node_modules/emdash/src/plugins/http-route-dispatch.ts",
		import.meta.url,
	).href
);
const { default: forms } = await import(
	new URL(
		"../../templates/tedix/node_modules/@emdash-cms/plugin-forms/src/index.ts",
		import.meta.url,
	).href
);

// Each test starts without a remembered tenant MCP era, so the first native
// call pays the discover probe exactly as a cold isolate does.
beforeEach(() => clearTenantMcpEras());

describe("generic native tenant MCP dispatch", () => {
	/** Fake tenant MCP endpoint: answers discovery, records tools/call. */
	const tenantMcpDispatch = (
		respond: (name: string, args: Record<string, unknown>) => unknown,
		calls: Array<{ name: string; arguments: Record<string, unknown> }>,
		requests?: Array<{
			path: string;
			authorization: string | null;
			protocolVersion: string | null;
		}>,
	) =>
		({
			fetch: async (request: Request) => {
				const body = (await request.json()) as Record<string, any>;
				requests?.push({
					path: new URL(request.url).pathname,
					authorization: request.headers.get("authorization"),
					protocolVersion: request.headers.get("mcp-protocol-version"),
				});
				const handshake = emdashMcpHandshake(body);
				if (handshake) return handshake;
				calls.push({
					name: body.params?.name,
					arguments: body.params?.arguments,
				});
				const data = respond(body.params?.name, body.params?.arguments ?? {});
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						content: [{ type: "text", text: JSON.stringify(data) }],
					},
				});
			},
		}) as Fetcher;

	it("forwards taxonomy definition and term locale fields to native MCP under a service PAT", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: tenantMcpDispatch(() => ({ taxonomy: { id: "x" } }), calls),
		};
		await callCmsRest(ctx, "taxonomy_create", {
			name: "topics",
			label: "Themen",
			locale: "de",
			translationOf: "definition_en",
		});
		await callCmsRest(ctx, "taxonomy_create_term", {
			taxonomy: "topics",
			label: "Klima",
			locale: "de",
			translationOf: "term_en",
		});
		await callCmsRest(ctx, "taxonomy_update_term", {
			taxonomy: "topics",
			termSlug: "climate",
			locale: "de",
			label: "Klima",
		});
		await callCmsRest(ctx, "taxonomy_delete_term", {
			taxonomy: "topics",
			termSlug: "climate",
			locale: "de",
		});
		expect(calls).toEqual([
			{
				name: "taxonomy_create",
				arguments: {
					name: "topics",
					label: "Themen",
					locale: "de",
					translationOf: "definition_en",
				},
			},
			{
				name: "taxonomy_create_term",
				arguments: {
					taxonomy: "topics",
					label: "Klima",
					locale: "de",
					translationOf: "term_en",
				},
			},
			{
				name: "taxonomy_update_term",
				arguments: {
					taxonomy: "topics",
					termSlug: "climate",
					locale: "de",
					label: "Klima",
				},
			},
			{
				name: "taxonomy_delete_term",
				arguments: { taxonomy: "topics", termSlug: "climate", locale: "de" },
			},
		]);
	});

	it("gates native forwarding on mapping, PAT, human JWT, and REST-only args", () => {
		const pat: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
		};
		// mapped + PAT, no human session → native
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_get", {
				collection: "posts",
				id: "post_1",
			}),
		).toBe(true);
		// unmapped row → REST
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_unpublish", {
				collection: "posts",
				id: "post_1",
			}),
		).toBe(false);
		// the native tool requires _rev; without one the optional-_rev REST
		// contract keeps the call
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_publish", {
				collection: "posts",
				id: "post_1",
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_publish", {
				collection: "posts",
				id: "post_1",
				_rev: "rev_1",
			}),
		).toBe(true);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_update", {
				collection: "posts",
				id: "post_1",
				data: { title: "x" },
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_update", {
				collection: "posts",
				id: "post_1",
				data: { title: "x" },
				_rev: "rev_1",
			}),
		).toBe(true);
		for (const restOnly of [{ status: "draft" }, { references: {} }]) {
			expect(
				shouldForwardCmsRestToTenantMcp(pat, "content_update", {
					collection: "posts",
					id: "post_1",
					_rev: "rev_1",
					...restOnly,
				}),
			).toBe(false);
		}
		// locale-scoped slug lookups and REST-only collection settings stay REST
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_delete", {
				collection: "posts",
				id: "mein-beitrag",
				locale: "de",
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "schema_update_collection", {
				slug: "pages",
				admin: { quickCreate: false },
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "schema_update_collection", {
				slug: "pages",
				label: "Seiten",
			}),
		).toBe(true);
		// no PAT → REST
		expect(
			shouldForwardCmsRestToTenantMcp(
				{ ...baseContext, internalAuthToken: "internal_secret" },
				"content_get",
				{ collection: "posts", id: "post_1" },
			),
		).toBe(false);
		// forwarded human JWT keeps per-user Descope attribution on REST even
		// when the org PAT is provisioned
		expect(
			shouldForwardCmsRestToTenantMcp(
				{ ...pat, forwardedAuth: "aaa.bbb.ccc" },
				"content_get",
				{
					collection: "posts",
					id: "post_1",
				},
			),
		).toBe(false);
		// filters the native tool cannot express stay on REST
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_list", {
				collection: "posts",
				q: "vorsorge",
			}),
		).toBe(false);
		expect(
			shouldForwardCmsRestToTenantMcp(pat, "content_list", {
				collection: "posts",
				status: "published",
			}),
		).toBe(true);
	});

	it("forwards a mapped tool natively with the PAT and re-wraps the REST envelope", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const requests: Array<{
			path: string;
			authorization: string | null;
			protocolVersion: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: tenantMcpDispatch(
				() => ({
					item: { id: "post_1", slug: "hello", status: "draft" },
					_rev: "rev_1",
				}),
				calls,
				requests,
			),
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "post_1",
			locale: "de",
			unknownExtra: "dropped",
		});

		expect(result.isError).toBeUndefined();
		expect(
			requests.every((request) => request.path === "/_emdash/api/mcp"),
		).toBe(true);
		expect(
			requests.every(
				(request) => request.authorization === "Bearer ec_pat_secret",
			),
		).toBe(true);
		// 2026 probe, then the 2025 handshake and call on the negotiated revision.
		expect(requests.map((request) => request.protocolVersion)).toEqual([
			"2026-07-28",
			null,
			"2025-11-25",
			"2025-11-25",
		]);
		expect(calls).toEqual([
			{
				name: "content_get",
				arguments: { collection: "posts", id: "post_1", locale: "de" },
			},
		]);
		// Same envelope the REST transport emits: { success, data } text plus the
		// normalized get-one structuredContent.
		expect(JSON.parse(result.content[0]?.text ?? "{}")).toEqual({
			success: true,
			data: {
				item: { id: "post_1", slug: "hello", status: "draft" },
				_rev: "rev_1",
			},
		});
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toMatchObject({
			data: {
				item: { id: "post_1", slug: "hello", status: "draft" },
				_rev: "rev_1",
			},
		});
	});

	it("calls a 2026 tenant endpoint sessionlessly and remembers the modern era", async () => {
		const requests: Array<{
			method: string;
			protocolVersion: string | null;
			mcpMethod: string | null;
		}> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					requests.push({
						method: body.method,
						protocolVersion: request.headers.get("mcp-protocol-version"),
						mcpMethod: request.headers.get("mcp-method"),
					});
					if (body.method === "server/discover") {
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								resultType: "complete",
								supportedVersions: ["2026-07-28"],
								capabilities: { tools: {} },
								_meta: {
									"io.modelcontextprotocol/serverInfo": {
										name: "emdash",
										version: "2.0.0",
									},
								},
							},
						});
					}
					if (body.method !== "tools/call") {
						throw new Error(`unexpected method ${body.method}`);
					}
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							resultType: "complete",
							content: [{ type: "text", text: body.params.name }],
						},
					});
				},
			} as Fetcher,
		};

		const first = await callTenantMcpTool(ctx, "content_get", { id: "a" });
		const second = await callTenantMcpTool(ctx, "content_list", {});

		expect(first.content[0]?.text).toBe("content_get");
		expect(second.content[0]?.text).toBe("content_list");
		expect(requests).toEqual([
			{
				method: "server/discover",
				protocolVersion: "2026-07-28",
				mcpMethod: "server/discover",
			},
			{
				method: "tools/call",
				protocolVersion: "2026-07-28",
				mcpMethod: "tools/call",
			},
			{
				method: "tools/call",
				protocolVersion: "2026-07-28",
				mcpMethod: "tools/call",
			},
		]);
	});

	it("fails closed when the tenant offers only unsupported 2026+ revisions", async () => {
		let requests = 0;
		const result = await callTenantMcpTool(
			{
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						requests += 1;
						const body = (await request.json()) as { id: unknown };
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							error: {
								code: -32022,
								message: "Unsupported protocol version",
								data: { supported: ["2099-01-01"], requested: "2026-07-28" },
							},
						});
					},
				} as unknown as Fetcher,
			},
			"content_get",
			{ collection: "posts", id: "post_1" },
		);

		expect(requests).toBe(1);
		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toContain("CMS_MCP_PROTOCOL_UNSUPPORTED");
	});

	it("forgets a remembered era when its handshake fails, then re-probes", async () => {
		const methods: string[] = [];
		let rejectInitialize = false;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const body = (await request.json()) as Record<string, any>;
					methods.push(body.method);
					if (rejectInitialize && body.method === "initialize") {
						return new Response("Not authenticated", { status: 401 });
					}
					const handshake = emdashMcpHandshake(body);
					if (handshake) return handshake;
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "ok" }] },
					});
				},
			} as Fetcher,
		};

		expect((await callTenantMcpTool(ctx, "content_get", {})).isError).toBe(
			undefined,
		);
		rejectInitialize = true;
		const failed = await callTenantMcpTool(ctx, "content_get", {});
		expect(failed.content[0]?.text).toMatch(
			/^\[CMS_MCP_DISCOVERY_FAILED\] Tenant MCP discovery failed \(401\)/,
		);
		rejectInitialize = false;
		await callTenantMcpTool(ctx, "content_get", {});

		expect(methods).toEqual([
			...EMDASH_HANDSHAKE,
			"tools/call",
			// Remembered legacy era: no probe; initialize is refused.
			"initialize",
			// Verdict evicted: the next call probes again.
			...EMDASH_HANDSHAKE,
			"tools/call",
		]);
	});

	it("keeps the same tool on REST when no PAT exists", async () => {
		const seen: Array<{ method: string; path: string; auth: string | null }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			internalAuthToken: "internal_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						method: request.method,
						path: new URL(request.url).pathname,
						auth: request.headers.get("x-tedix-cms-internal-auth"),
					});
					return Response.json({
						success: true,
						data: { item: { id: "post_1" }, _rev: "rev_1" },
					});
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "post_1",
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{
				method: "GET",
				path: "/_emdash/api/content/posts/post_1",
				auth: "internal_secret",
			},
		]);
	});

	it("keeps a human session on REST for attribution even when the PAT is provisioned", async () => {
		const seen: Array<{ path: string; cookie: string | null }> = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						path: new URL(request.url).pathname,
						cookie: request.headers.get("cookie"),
					});
					return Response.json({ success: true, data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "byline_list", { limit: 5 });

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{ path: "/_emdash/api/admin/bylines", cookie: "DS=aaa.bbb.ccc" },
		]);
	});

	it("always routes an unmapped tool over REST, even with the PAT", async () => {
		const seen: Array<{ method: string; path: string; auth: string | null }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					seen.push({
						method: request.method,
						path: new URL(request.url).pathname,
						auth: request.headers.get("authorization"),
					});
					return Response.json({ success: true, data: { id: "post_1" } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_publish", {
			collection: "posts",
			id: "post_1",
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual([
			{
				method: "POST",
				path: "/_emdash/api/content/posts/post_1/publish",
				auth: "Bearer ec_pat_secret",
			},
		]);
	});

	it("keeps content_list on REST when native-unsupported filters are present", async () => {
		const seen: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					seen.push(`${url.pathname}?${url.searchParams.toString()}`);
					return Response.json({ success: true, data: { items: [] } });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			q: "vorsorge",
			limit: 5,
		});

		expect(result.isError).toBeUndefined();
		expect(seen).toEqual(["/_emdash/api/content/posts?q=vorsorge&limit=5"]);
	});

	it("projects a native list payload into the REST list envelope", async () => {
		const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
			[];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: tenantMcpDispatch(
				() => ({
					items: [{ id: "post_1", slug: "hello", status: "published" }],
					nextCursor: "cursor_2",
				}),
				calls,
			),
		};

		const result = await callCmsRest(ctx, "content_list", {
			collection: "posts",
			status: "published",
			limit: 1,
		});

		expect(result.isError).toBeUndefined();
		expect(calls).toEqual([
			{
				name: "content_list",
				arguments: { collection: "posts", status: "published", limit: 1 },
			},
		]);
		const parsed = JSON.parse(result.content[0]?.text ?? "{}");
		expect(parsed).toEqual({
			success: true,
			data: {
				items: [{ id: "post_1", slug: "hello", status: "published" }],
				nextCursor: "cursor_2",
			},
		});
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toEqual(parsed);
	});

	it("propagates native tool errors without falling back to REST", async () => {
		const restPaths: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					const url = new URL(request.url);
					if (url.pathname === "/_emdash/api/mcp") {
						const body = (await request.json()) as Record<string, any>;
						const handshake = emdashMcpHandshake(body);
						if (handshake) return handshake;
						return Response.json({
							jsonrpc: "2.0",
							id: body.id,
							result: {
								content: [
									{
										type: "text",
										text: "[NOT_FOUND] Content item not found: x",
									},
								],
								isError: true,
							},
						});
					}
					restPaths.push(url.pathname);
					return Response.json({ success: true, data: {} });
				},
			} as Fetcher,
		};

		const result = await callCmsRest(ctx, "content_get", {
			collection: "posts",
			id: "x",
		});

		expect(result).toMatchObject({ isError: true });
		expect(result.content[0]?.text).toBe(
			"[NOT_FOUND] Content item not found: x",
		);
		expect(restPaths).toEqual([]);
	});
});

describe("released Emdash MCP negotiation", () => {
	it.each([false, true])(
		"uses native tools once after official SDK negotiation (tool error=%s)",
		async (toolError) => {
			const methods: string[] = [];
			const ctx: CmsProxyContext = {
				...baseContext,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async (request: Request) => {
						expect(request.headers.get("authorization")).toBe(
							"Bearer ec_pat_secret",
						);
						const body = (await request.json()) as {
							method: string;
							id?: number;
							params?: unknown;
						};
						methods.push(body.method);
						if (body.method === "server/discover")
							return new Response(
								"Unsupported protocol version: 2026-07-28 (supported versions: 2025-11-25)",
								{ status: 400 },
							);
						if (body.method === "initialize")
							return Response.json({
								jsonrpc: "2.0",
								id: body.id,
								result: {
									protocolVersion: "2025-11-25",
									capabilities: { tools: {} },
									serverInfo: { name: "Emdash", version: "0.38.0" },
								},
							});
						if (body.method === "notifications/initialized")
							return new Response(null, { status: 202 });
						if (body.method === "tools/call")
							return Response.json({
								jsonrpc: "2.0",
								id: body.id,
								result: {
									content: [{ type: "text", text: "native result" }],
									...(toolError ? { isError: true } : {}),
								},
							});
						throw Error("unexpected method " + body.method);
					},
				} as Fetcher,
			};
			const r = await callTenantMcpTool(ctx, "media_upload", {
				filename: "cover.png",
				url: "https://example.com/cover.png",
			});
			expect(r.content[0]?.text).toBe("native result");
			expect(Boolean(r.isError)).toBe(toolError);
			expect(methods).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);
		},
	);
});

it("preserves native REST error codes and lock details for agents", async () => {
	const ctx: CmsProxyContext = {
		...baseContext,
		internalAuthToken: "internal",
		cmsDispatch: {
			fetch: async () =>
				Response.json(
					{
						success: false,
						error: {
							code: "ENTRY_LOCKED",
							message: "Ada is holding this entry",
							details: { holder: "Ada" },
						},
					},
					{ status: 409 },
				),
		} as unknown as Fetcher,
	};
	const result = await callCmsRest(ctx, "content_update", {
		collection: "pages",
		id: "home",
		_rev: "read-revision",
		data: { title: "Edit" },
	});
	expect(result.isError).toBe(true);
	expect(result._meta).toEqual({
		code: "ENTRY_LOCKED",
		details: { holder: "Ada" },
	});
});

describe("native tenant tool metadata", () => {
	it("returns installed metadata through the shared negotiated tenant session", async () => {
		const methods: string[] = [];
		const tools = [
			{
				name: "content_update",
				inputSchema: { type: "object", required: ["_rev"] },
				annotations: { destructiveHint: false },
			},
		];
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_secret",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.headers.get("authorization")).toBe(
						"Bearer ec_pat_secret",
					);
					const body = (await request.json()) as {
						method: string;
						id?: unknown;
					};
					methods.push(body.method);
					return (
						emdashMcpHandshake(body) ??
						Response.json({ jsonrpc: "2.0", id: body.id, result: { tools } })
					);
				},
			} as unknown as Fetcher,
		};
		const result = await listTenantMcpTools(ctx);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.content[0]!.text)).toEqual({ tools });
		expect(
			(result as { structuredContent?: unknown }).structuredContent,
		).toEqual({ tools });
		expect(methods).toEqual([...EMDASH_HANDSHAKE, "tools/list"]);
	});
	it.each([{ humanAuthRequired: true }, { forwardedAuth: "aaa.bbb.ccc" }])(
		"does not borrow the service PAT for a human metadata read",
		async (human) => {
			let calls = 0;
			const ctx: CmsProxyContext = {
				...baseContext,
				...human,
				serviceApiKey: "ec_pat_secret",
				cmsDispatch: {
					fetch: async () => {
						calls++;
						return Response.json({});
					},
				} as unknown as Fetcher,
			};
			const result = await listTenantMcpTools(ctx);
			expect(result._meta?.code).toBe("CMS_MCP_HUMAN_METADATA_UNAVAILABLE");
			expect(calls).toBe(0);
		},
	);
});

describe("Fixed native Forms forwarding", () => {
	const identity = {
		siteId: "site-one",
		slug: "tedix",
		bundleEtag: "bundle-one",
		tenantId: "tenant-one",
		subject: "editor-one",
		email: "editor@example.com",
		name: "Editor",
		role: 40 as const,
	};
	it("retains human assertions and propagates native REST permission failures without PAT or retry", async () => {
		const calls: string[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			mediaMaintenanceAuthorized: true,
			humanAuthRequired: true,
			humanIdentity: identity,
			internalAuthToken: "trusted",
			serviceApiKey: "ec_pat_must_not_be_used",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(request.headers.get("authorization")).toBeNull();
					expect(request.headers.get("X-Tedix-CMS-Forwarded-User-Auth")).toBe(
						"trusted",
					);
					expect(
						request.headers.get("X-Tedix-CMS-Human-Identity"),
					).toBeTruthy();
					expect(request.method).toBe("POST");
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/plugins/emdash-forms/submissions/list",
					);
					calls.push("list_form_submissions");
					expect(await request.json()).toEqual({
						formId: "form-one",
						limit: 20,
					});
					return Response.json(
						{
							success: false,
							error: { code: "FORBIDDEN", message: "Native permission denied" },
						},
						{ status: 403 },
					);
				},
			} as unknown as Fetcher,
		};
		const result = await callCmsFormsTool(ctx, "list_form_submissions", {
			formId: "form-one",
			limit: 20,
		});
		expect(calls).toEqual(["list_form_submissions"]);
		expect(result.isError).toBe(true);
		expect(result._meta?.code).toBe("FORBIDDEN");
	});
	it("refuses arbitrary names, missing authority and missing human assertions before dispatch", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_service",
			cmsDispatch: {
				fetch: async () => {
					calls++;
					return Response.json({});
				},
			} as unknown as Fetcher,
		};
		expect(
			(
				await callCmsFormsTool(
					{ ...ctx, mediaMaintenanceAuthorized: true },
					"content_publish",
					{},
				)
			).isError,
		).toBe(true);
		expect((await callCmsFormsTool(ctx, "list_forms", {})).isError).toBe(true);
		expect(
			(
				await callCmsFormsTool(
					{ ...ctx, mediaMaintenanceAuthorized: true, humanAuthRequired: true },
					"list_forms",
					{},
				)
			).isError,
		).toBe(true);
		expect(calls).toBe(0);
	});
	it("registers fixed operations and sends narrow consent PUT under human authority", async () => {
		const tools = new Map<
			string,
			{ definition: any; handler: (args: any) => Promise<any> }
		>();
		const requests: Request[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			humanAuthRequired: true,
			humanIdentity: identity,
			internalAuthToken: "trusted",
			serviceApiKey: "ec_pat_unused",
			mediaMaintenanceAuthorized: true,
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push(request);
					return Response.json({
						success: true,
						data: { enabled: true, tools: [] },
					});
				},
			} as unknown as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any, handler: any) =>
					tools.set(name, { definition, handler }),
			} as any,
			ctx,
		);
		for (const name of [
			"list_forms",
			"create_form",
			"update_form",
			"list_form_submissions",
			"get_form_submission",
			"set_plugin_mcp",
		])
			expect(tools.has(name)).toBe(true);
		for (const name of [
			"list_forms",
			"list_form_submissions",
			"get_form_submission",
		])
			expect(tools.get(name)!.definition.annotations.readOnlyHint).toBe(true);
		expect(
			[...tools.keys()].filter(
				(name) => name.includes("-") || name.includes("__"),
			),
		).toEqual([]);
		expect(tools.has("import_form_submissions")).toBe(false);
		expect(tools.has("delete_migrated_leads")).toBe(false);
		expect(tools.has("list_legacy_leads")).toBe(false);
		expect(tools.has("call_native_plugin_tool")).toBe(false);
		expect(
			tools.get("set_plugin_mcp")!.definition.inputSchema.safeParse({
				id: "arbitrary-plugin",
				enabled: true,
			}).success,
		).toBe(false);
		await tools
			.get("set_plugin_mcp")!
			.handler({ id: "emdash-forms", enabled: true });
		expect(requests).toHaveLength(1);
		expect(requests[0]!.method).toBe("PUT");
		expect(new URL(requests[0]!.url).pathname).toBe(
			"/_emdash/api/admin/plugins/emdash-forms/mcp",
		);
		expect(requests[0]!.headers.get("authorization")).toBeNull();
		expect(await requests[0]!.json()).toEqual({ enabled: true });
	});
});

it("enforces installed native Forms permissions and token scopes before handler execution", async () => {
	const plugin = forms();
	let dispatched = 0;
	const runtime = {
		getPluginRouteMeta: (_id: string, path: string) =>
			plugin.routes[path.replace(/^\//, "")],
		handlePluginApiRoute: async (...args: any[]) => {
			dispatched++;
			expect(args[4].id).toBe("human-admin");
			return { success: true, data: { items: [] } };
		},
	};
	const request = new Request(
		"https://tedix.cms.tedix.dev/_emdash/api/plugins/emdash-forms/forms/list",
		{ method: "POST", headers: { "X-EmDash-Request": "1" }, body: "{}" },
	);
	const ctx = {
		runtime,
		pluginId: "emdash-forms",
		path: "/forms/list",
		request,
	};
	for (const role of [10, 40]) {
		const response = await dispatchPluginApiRequest({
			...ctx,
			user: { id: "human-viewer", role },
		});
		expect(response.status).toBe(403);
		expect((await response.json()).error.code).toBe("FORBIDDEN");
	}
	const denied = await dispatchPluginApiRequest({
		...ctx,
		user: { id: "service", role: 50 },
		tokenScopes: ["content:read"],
	});
	expect(denied.status).toBe(403);
	expect(dispatched).toBe(0);
	const allowed = await dispatchPluginApiRequest({
		...ctx,
		user: { id: "human-admin", role: 50 },
	});
	expect(allowed.status).toBe(200);
	expect(dispatched).toBe(1);
});

describe("Native existing-site onboarding forwarding", () => {
	it("registers one empty-input REST operation and preserves the human administrator", async () => {
		const tools = new Map<
			string,
			{ definition: any; handler: (args: any) => Promise<any> }
		>();
		const requests: Request[] = [];
		const identity = {
			siteId: "site-one",
			slug: "tedix",
			bundleEtag: "bundle-one",
			tenantId: "tenant-one",
			subject: "owner-one",
			email: "owner@example.com",
			name: "Owner",
			role: 50 as const,
		};
		const ctx: CmsProxyContext = {
			...baseContext,
			mediaMaintenanceAuthorized: true,
			humanAuthRequired: true,
			humanIdentity: identity,
			internalAuthToken: "trusted",
			serviceApiKey: "ec_pat_never_used",
			cmsDispatch: {
				fetch: async (request: Request) => {
					requests.push(request);
					expect(request.headers.get("authorization")).toBeNull();
					expect(request.headers.get("X-Tedix-CMS-Forwarded-User-Auth")).toBe(
						"trusted",
					);
					expect(request.headers.get("X-Tedix-CMS-Human-Identity")).toBe(
						encodeCmsHumanIdentity(identity),
					);
					expect(request.method).toBe("POST");
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/tedix/complete-existing-setup",
					);
					expect(await request.json()).toEqual({});
					return Response.json({
						success: true,
						data: { setupComplete: true, alreadyComplete: false },
					});
				},
			} as unknown as Fetcher,
		};
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any, handler: any) =>
					tools.set(name, { definition, handler }),
			} as any,
			ctx,
		);
		const operation = tools.get("complete_existing_setup")!;
		expect(operation.definition.annotations.idempotentHint).toBe(true);
		const result = await operation.handler({});
		expect(result.structuredContent).toEqual({
			success: true,
			data: { setupComplete: true, alreadyComplete: false },
		});
		expect(requests).toHaveLength(1);
	});
	it("denies missing platform authority or human identity without dispatch or PAT fallback", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			serviceApiKey: "ec_pat_must_not_be_used",
			internalAuthToken: "trusted",
			cmsDispatch: {
				fetch: async () => {
					calls++;
					return Response.json({});
				},
			} as unknown as Fetcher,
		};
		expect((await completeExistingCmsSetup(ctx)).isError).toBe(true);
		expect(
			(
				await completeExistingCmsSetup({
					...ctx,
					mediaMaintenanceAuthorized: true,
					humanAuthRequired: true,
				})
			).isError,
		).toBe(true);
		expect(calls).toBe(0);
	});
	it("preserves native administrator permission failure without retry", async () => {
		let calls = 0;
		const ctx: CmsProxyContext = {
			...baseContext,
			mediaMaintenanceAuthorized: true,
			forwardedAuth: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlZGl0b3IifQ.sig",
			cmsDispatch: {
				fetch: async () => {
					calls++;
					return Response.json(
						{
							success: false,
							error: {
								code: "FORBIDDEN",
								message: "Site administrator required",
							},
						},
						{ status: 403 },
					);
				},
			} as unknown as Fetcher,
		};
		const result = await completeExistingCmsSetup(ctx);
		expect(result.isError).toBe(true);
		expect(result._meta?.code).toBe("FORBIDDEN");
		expect(calls).toBe(1);
	});
});

describe("native revision restore lock override", () => {
	it("exposes only a boolean and forwards REST override only when explicitly true", async () => {
		const definitions = new Map<string, any>();
		registerCmsProxyTools(
			{
				registerTool: (name: string, definition: any) =>
					definitions.set(name, definition),
			} as any,
			baseContext,
		);
		const schema = definitions.get("revision_restore").inputSchema;
		expect(schema.safeParse({ revisionId: "revision" }).success).toBe(true);
		expect(
			schema.safeParse({ revisionId: "revision", overrideLock: true }).success,
		).toBe(true);
		expect(
			schema.safeParse({ revisionId: "revision", overrideLock: "true" })
				.success,
		).toBe(false);
		const bodies: unknown[] = [];
		const ctx: CmsProxyContext = {
			...baseContext,
			forwardedAuth: "aaa.bbb.ccc",
			cmsDispatch: {
				fetch: async (request: Request) => {
					expect(new URL(request.url).pathname).toBe(
						"/_emdash/api/revisions/revision/restore",
					);
					bodies.push(await request.json());
					return Response.json({ success: true, data: {} });
				},
			} as Fetcher,
		};
		for (const overrideLock of [undefined, false, true])
			await callCmsRest(ctx, "revision_restore", {
				revisionId: "revision",
				overrideLock,
			});
		expect(bodies).toEqual([{}, {}, { overrideLock: true }]);
	});
});
