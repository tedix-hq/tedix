import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { type ToolExecutionContext, ToolHandler } from "./handler";

const originalFetch = globalThis.fetch;

function ctx(
	config: Record<string, unknown>,
): ToolExecutionContext<ToolConfig> {
	return {
		appId: "app_1",
		app: {
			id: "app_1",
			slug: "test",
			name: "Test",
			organizationId: "org_1",
		} as ToolExecutionContext["app"],
		appCapabilities: {},
		env: { ENVIRONMENT: "test" } as unknown as CloudflareEnv,
		config: config as unknown as ToolConfig,
		toolId: "upload_file",
		requestId: "req_1",
	};
}

function gmailCtx(
	config: Record<string, unknown>,
	toolId = "gmail_send",
): ToolExecutionContext<ToolConfig> {
	return {
		...ctx(config),
		toolId,
	};
}

describe("ToolHandler external transport", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("encodes and consumes hyphenated OpenAPI Graph path parameters", async () => {
		globalThis.fetch = vi.fn(async (url) => {
			expect(String(url)).toBe(
				"https://graph.microsoft.com/v1.0/me/messages/AAMk%2B%2F%3D?%24select=id%2CisRead",
			);
			return new Response(JSON.stringify({ id: "AAMk+/=" }), {
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				context: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ status: number }>;
		};
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://graph.microsoft.com/v1.0",
			queryParams: ["$select"],
			queryArrayFormats: { $select: "comma" },
		};
		const result = await handler.executeExternal(
			{ "message-id": "AAMk+/=", $select: ["id", "isRead"] },
			ctx(config),
			config,
			"me/messages/{message-id}",
		);
		expect(result.status).toBe(200);
	});

	it.each(["me/messages/{message-id}?extra=1", "me/messages/{bad?name}"])(
		"rejects unsafe OpenAPI endpoint templates: %s",
		async (endpoint) => {
			globalThis.fetch = vi.fn();
			const handler = new ToolHandler() as unknown as {
				executeExternal: (
					input: Record<string, unknown>,
					context: ToolExecutionContext,
					config: Record<string, unknown>,
					endpoint: string,
				) => Promise<{ status: number }>;
			};
			const config = {
				transport: "external",
				method: "GET",
				baseUrl: "https://graph.microsoft.com/v1.0",
			};
			expect(
				(await handler.executeExternal({}, ctx(config), config, endpoint))
					.status,
			).toBe(400);
			expect(globalThis.fetch).not.toHaveBeenCalled();
		},
	);

	it("rejects missing OpenAPI path parameters before fetching", async () => {
		globalThis.fetch = vi.fn();
		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				context: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ status: number }>;
		};
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://graph.microsoft.com/v1.0",
		};
		expect(
			(
				await handler.executeExternal(
					{},
					ctx(config),
					config,
					"me/messages/{message-id}",
				)
			).status,
		).toBe(400);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("allows OpenAPI root path tools with an empty external endpoint", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe("https://api.example.test/");
				expect(init?.method).toBe("GET");
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler();
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://api.example.test",
			endpoint: "",
		};

		const result = await handler.execute({}, ctx(config));

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ ok: true });
	});

	it("attaches exact source and tenant lineage for opted-in research tools", async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ success: true, result: { summary_0: { HTTPv3: "42" } } }),
		) as unknown as typeof fetch;

		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://api.cloudflare.com/client/v4",
			endpoint: "radar/http/summary/:dimension",
			pathParamCase: { dimension: "lower" },
			staticParams: { format: "JSON", dateRange: "7d" },
			sourceProvenance: {
				provider: "Cloudflare Radar",
				documentationUrl:
					"https://developers.cloudflare.com/api/resources/radar/subresources/http/",
				rateBudget: { requestsPerMinute: 100, retryAfterSeconds: 60 },
			},
		};
		const context = {
			...ctx(config),
			toolId: "query_http_summary",
			traceId: "trace-1",
			executionId: "execution-1",
			callerIdentity: {
				authType: "tedi" as const,
				organizationId: "org_1",
				tediId: "tedi_1",
			},
		};

		const result = await new ToolHandler().execute(
			{ dimension: "HTTP_VERSION", location: "PT" },
			context,
		);

		expect(globalThis.fetch).toHaveBeenCalledWith(
			"https://api.cloudflare.com/client/v4/radar/http/summary/http_version?format=JSON&dateRange=7d&location=PT",
			expect.objectContaining({ method: "GET", redirect: "manual" }),
		);
		expect(result).toMatchObject({
			status: 200,
			data: {
				success: true,
				_tedixProvenance: {
					provider: "Cloudflare Radar",
					sourceUrl:
						"https://api.cloudflare.com/client/v4/radar/http/summary/http_version?format=JSON&dateRange=7d&location=PT",
					organizationId: "org_1",
					tediId: "tedi_1",
					toolId: "query_http_summary",
					traceId: "trace-1",
					executionId: "execution-1",
					rateBudget: { requestsPerMinute: 100, retryAfterSeconds: 60 },
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("credential");
	});

	it.each([
		{
			label: "service tedi actor id",
			authType: "service" as const,
			userId: "tedi_1",
			connectionId: "firecrawl-service",
		},
		{
			label: "AIH M2M client record",
			authType: "tedi" as const,
			userId: "aih_client_record_1",
			connectionId: "firecrawl-aih",
		},
		{
			label: "direct-tedi JWT user record",
			authType: "tedi" as const,
			userId: "descope_tedi_user_1",
			connectionId: "firecrawl-direct",
		},
	])(
		"does not present a machine $label as an acting human when resolving tenant credentials",
		async ({ authType, userId, connectionId }) => {
			const apiFetch = vi.fn(
				async (input: string | URL | Request, init?: RequestInit) => {
					const request =
						input instanceof Request ? input : new Request(input, init);
					const body = (await request.json()) as {
						json?: Record<string, unknown>;
					};
					const headers = request.headers;
					// Tenant scope resolves by organization (connections/fetchOrgToken),
					// not through the tedi proxy: the tenant credential belongs to the
					// app's org, so the tedi UUID is lineage here, carried in the
					// X-Tedix-Tedi-Id header rather than as an RPC subject.
					expect(request.url).toContain("connections/fetchOrgToken");
					expect(body.json).toMatchObject({
						organizationId: "org_1",
						providerId: connectionId,
						scope: "tenant",
					});
					// The property this test exists to pin: a service tedi's actor UUID
					// never reaches the human-credential axis, on either the RPC body or
					// the acting-user header the API's authz trusts.
					expect(body.json).not.toHaveProperty("userId");
					expect(headers.get("X-Tedix-Acting-User")).toBeNull();
					expect(headers.get("X-Tedix-End-User-Id")).toBeNull();
					expect(headers.get("X-Tedix-Mcp-Tool-Id")).toBe("upload_file");
					expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi_1");
					expect(headers.get("X-Tedix-Tedi-Scopes")).toBe(
						"tools:read connections:read",
					);
					return Response.json({ json: { accessToken: "tenant-token" } });
				},
			);
			globalThis.fetch = vi.fn(
				async (_url: string | URL | Request, init?: RequestInit) => {
					expect(new Headers(init?.headers).get("Authorization")).toBe(
						"Bearer tenant-token",
					);
					return Response.json({ ok: true });
				},
			) as unknown as typeof fetch;

			const config = {
				transport: "external",
				method: "GET",
				baseUrl: "https://api.firecrawl.dev",
				endpoint: "v2/search",
				auth: {
					type: "connection",
					connectionId,
					credentialScope: "tenant",
				},
			};
			const context = {
				...ctx(config),
				env: {
					ENVIRONMENT: "test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType,
					userId,
					tediId: "tedi_1",
					organizationId: "org_1",
					scopes: ["tools:read", "connections:read"],
				},
			};

			const result = await new ToolHandler().execute({}, context);

			expect(result).toMatchObject({ status: 200, data: { ok: true } });
			expect(apiFetch).toHaveBeenCalledOnce();
		},
	);

	it("delegates a human connected-tool actor and its granular scope", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				const headers = request.headers;
				expect(headers.get("X-Tedix-Mcp-Tool-Id")).toBe("upload_file");
				expect(headers.get("X-Tedix-End-User-Id")).toBe("user_1");
				expect(headers.get("X-Tedix-Tedi-Id")).toBeNull();
				expect(headers.get("X-Tedix-Tedi-Scopes")).toBe("connections.execute");
				return Response.json({ json: { accessToken: "user-token" } });
			},
		);
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer user-token",
				);
				return Response.json({ ok: true });
			},
		) as unknown as typeof fetch;

		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://api.firecrawl.dev",
			endpoint: "v2/search",
			auth: {
				type: "connection",
				connectionId: "firecrawl",
				credentialScope: "tenant",
			},
		};
		const context = {
			...ctx(config),
			env: {
				ENVIRONMENT: "test",
				API_SERVICE: { fetch: apiFetch },
			} as unknown as CloudflareEnv,
			callerIdentity: {
				authType: "oauth" as const,
				userId: "user_1",
				organizationId: "org_1",
				scopes: ["connections.execute"],
			},
		};

		const result = await new ToolHandler().execute({}, context);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("forwards the initiating human for a kernel read through the trusted service bridge", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				expect(request.headers.get("X-Tedix-End-User-Id")).toBe("user_1");
				expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe(
					"connections.read",
				);
				return Response.json({ json: { accessToken: "user-token" } });
			},
		);
		globalThis.fetch = vi.fn(async () =>
			Response.json({ ok: true }),
		) as unknown as typeof fetch;

		const result = await new ToolHandler().execute(
			{},
			{
				...ctx({
					transport: "external",
					method: "GET",
					baseUrl: "https://api.firecrawl.dev",
					endpoint: "v2/search",
					auth: {
						type: "connection",
						connectionId: "firecrawl-kernel-direct-read",
						credentialScope: "tenant",
					},
				}),
				env: {
					ENVIRONMENT: "test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "service",
					kernel: true,
					userId: "user_1",
					organizationId: "org_1",
					scopes: ["connections.read"],
				},
			},
		);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("sends OpenAPI file params as multipart form data", async () => {
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				if (!init) throw new Error("expected RequestInit");
				const headers = init.headers as Record<string, string>;
				expect(
					Object.keys(headers).some(
						(key) => key.toLowerCase() === "content-type",
					),
				).toBe(false);
				expect(init.body).toBeInstanceOf(FormData);

				const form = init.body as FormData;
				const file = form.get("file") as unknown;
				expect(file).toBeInstanceOf(Blob);
				if (!(file instanceof Blob)) throw new Error("expected file blob");
				expect(await file.text()).toBe("hello");
				expect(form.get("note")).toBe("receipt");

				return new Response(
					JSON.stringify({ objects: { filename: "tmp.pdf" } }),
					{
						status: 201,
						headers: { "content-type": "application/json" },
					},
				);
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://api.example.test",
			endpoint: "upload",
			requestContentType: "multipart/form-data",
			fileParams: ["file"],
		};

		const result = await handler.executeExternal(
			{
				file: {
					content: btoa("hello"),
					filename: "receipt.pdf",
					mimeType: "application/pdf",
				},
				note: "receipt",
			},
			ctx(config),
			config,
			"upload",
		);

		expect(result.status).toBe(201);
		expect(result.data).toEqual({ objects: { filename: "tmp.pdf" } });
	});

	it("returns non-text external responses as base64 envelopes", async () => {
		globalThis.fetch = vi.fn(async () => {
			return new Response(new TextEncoder().encode("%PDF"), {
				status: 200,
				headers: {
					"content-type": "application/pdf",
					"content-disposition": 'attachment; filename="invoice.pdf"',
				},
			});
		}) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://api.example.test",
			endpoint: "download",
		};

		const result = await handler.executeExternal(
			{},
			ctx(config),
			config,
			"download",
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual({
			filename: "invoice.pdf",
			mimeType: "application/pdf",
			base64encoded: true,
			content: btoa("%PDF"),
		});
	});

	it("sends configured requestBodyParam as body and leaves remaining params in query", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://sheets.googleapis.com/v4/spreadsheets/sheet_1/values/A1%3AB2:append?valueInputOption=USER_ENTERED",
				);
				expect(init?.method).toBe("POST");
				expect(init?.body).toBe(JSON.stringify({ values: [["hello"]] }));
				return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://sheets.googleapis.com",
			endpoint: "v4/spreadsheets/:spreadsheetId/values/:range:append",
			requestBodyParam: "body",
		};

		const result = await handler.executeExternal(
			{
				spreadsheetId: "sheet_1",
				range: "A1:B2",
				valueInputOption: "USER_ENTERED",
				body: { values: [["hello"]] },
			},
			ctx(config),
			config,
			"v4/spreadsheets/:spreadsheetId/values/:range:append",
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ updates: { updatedRows: 1 } });
	});

	it("expands a fixed external body template and keeps its constraints out of tool input", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://analyticsdata.googleapis.com/v1beta/properties/395322781:runReport",
				);
				expect(init?.body).toBe(
					JSON.stringify({
						dateRanges: [{ startDate: "2026-06-14", endDate: "2026-07-11" }],
						dimensionFilter: {
							filter: {
								fieldName: "landingPagePlusQueryString",
								stringFilter: { matchType: "BEGINS_WITH", value: "/ratgeber/" },
							},
						},
					}),
				);
				return new Response(JSON.stringify({ rows: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler();
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://analyticsdata.googleapis.com",
			endpoint: "v1beta/properties/:property:runReport",
			staticParams: { property: "395322781" },
			requestBodyParam: "body",
			requestBodyTemplateParams: ["startDate", "endDate"],
			requestBodyTemplate: {
				dateRanges: [{ startDate: "{startDate}", endDate: "{endDate}" }],
				dimensionFilter: {
					filter: {
						fieldName: "landingPagePlusQueryString",
						stringFilter: { matchType: "BEGINS_WITH", value: "/ratgeber/" },
					},
				},
			},
		};

		const result = await handler.execute(
			{ startDate: "2026-06-14", endDate: "2026-07-11" },
			ctx(config),
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ rows: [] });
	});

	it("preserves configured vendor JSON request content type", async () => {
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
					"application/vnd.olrapi.jsonlogic+json",
				);
				expect(init?.body).toBe(
					JSON.stringify({ in: ["tedix", { var: "tags" }] }),
				);
				return new Response(
					JSON.stringify([{ filename: "note.md", result: true }]),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://obsidian.example.test",
			endpoint: "search/",
			requestBodyParam: "body",
			requestContentType: "application/vnd.olrapi.jsonlogic+json",
		};

		const result = await handler.executeExternal(
			{ body: { in: ["tedix", { var: "tags" }] } },
			ctx(config),
			config,
			"search/",
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual([{ filename: "note.md", result: true }]);
	});

	it("sends text OpenAPI request bodies without JSON wrapping", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://obsidian.example.test/vault/Tedix%20MCP.md",
				);
				expect(init?.method).toBe("PUT");
				expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
					"text/markdown",
				);
				expect(init?.body).toBe("# Tedix MCP\n\nValidated.\n");
				return new Response(null, { status: 204 });
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "PUT",
			baseUrl: "https://obsidian.example.test",
			endpoint: "vault/:filename",
			requestContentType: "text/markdown",
		};

		const result = await handler.executeExternal(
			{
				filename: "Tedix MCP.md",
				body: "# Tedix MCP\n\nValidated.\n",
			},
			ctx(config),
			config,
			"vault/:filename",
		);

		expect(result.status).toBe(204);
	});

	it("sends configured OpenAPI header params as headers", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://obsidian.example.test/vault/Tedix%20MCP.md",
				);
				const headers = init?.headers as Record<string, string>;
				expect(headers["Target-Type"]).toBe("heading");
				expect(headers.Target).toBe("Readiness Checklist");
				expect(init?.body).toBe("- patched\n");
				return new Response("# ok", {
					status: 200,
					headers: { "content-type": "text/markdown" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "PUT",
			baseUrl: "https://obsidian.example.test",
			endpoint: "vault/:filename",
			requestContentType: "text/markdown",
			headerParams: ["Target-Type", "Target"],
		};

		const result = await handler.executeExternal(
			{
				filename: "Tedix MCP.md",
				"Target-Type": "heading",
				Target: "Readiness Checklist",
				body: "- patched\n",
			},
			ctx(config),
			config,
			"vault/:filename",
		);

		expect(result.status).toBe(200);
		expect(result.data).toBe("# ok");
	});

	it("sends configured OpenAPI query params on non-GET requests", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://obsidian.example.test/search/simple/?query=martin&contextLength=120",
				);
				expect(init?.method).toBe("POST");
				expect(init?.body).toBe("{}");
				return new Response(
					JSON.stringify([{ filename: "note.md", score: 1 }]),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://obsidian.example.test",
			endpoint: "search/simple/",
			queryParams: ["query", "contextLength"],
		};

		const result = await handler.executeExternal(
			{ query: "martin", contextLength: 120 },
			ctx(config),
			config,
			"search/simple/",
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual([{ filename: "note.md", score: 1 }]);
	});

	it("never forwards OpenAPI runtime-only arguments", async () => {
		globalThis.fetch = vi.fn(
			async (url: string | URL | Request, init?: RequestInit) => {
				expect(String(url)).toBe(
					"https://orders.example.test/orders/attention?limit=2",
				);
				expect(init?.method).toBe("GET");
				return Response.json({ items: [] });
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://orders.example.test",
			endpoint: "orders/attention",
			queryParams: ["limit"],
			runtimeOnlyParams: ["companyId"],
		};

		const result = await handler.executeExternal(
			{ limit: 2, companyId: "1" },
			ctx(config),
			config,
			"orders/attention",
		);

		expect(result).toMatchObject({ status: 200, data: { items: [] } });
	});

	it("keeps JSON vendor errors readable for binary response tools", async () => {
		globalThis.fetch = vi.fn(async () => {
			return new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				headers: {
					"content-type": "application/json",
				},
			});
		}) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://api.example.test",
			endpoint: "download",
			responseMode: "base64",
		};

		const result = await handler.executeExternal(
			{},
			ctx(config),
			config,
			"download",
		);

		expect(result.status).toBe(404);
		expect(result.data).toEqual({ error: "not found" });
	});

	it("encodes Gmail sends as RFC 5322 messages with optional sender aliases", async () => {
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				if (!init) throw new Error("expected RequestInit");
				const body = JSON.parse(String(init.body)) as { raw: string };
				const paddedRaw = body.raw
					.replace(/-/g, "+")
					.replace(/_/g, "/")
					.padEnd(Math.ceil(body.raw.length / 4) * 4, "=");
				const decoded = new TextDecoder().decode(
					Uint8Array.from(atob(paddedRaw), (char) => char.charCodeAt(0)),
				);

				expect(String(_url)).toBe(
					"https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
				);
				expect(init.method).toBe("POST");
				expect(decoded).toContain("From: alias@example.com");
				expect(decoded).toContain("To: recipient@example.com");
				expect(decoded).toContain("Subject: Hello");
				expect(decoded).toContain("body text");

				return new Response(JSON.stringify({ id: "msg_1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{
				data: unknown;
				status: number;
				providerConfirmation?: string;
			}>;
		};
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://gmail.googleapis.com",
			endpoint: "gmail/v1/users/me/messages/send",
			bodyEncoding: "gmail-rfc2822",
		};

		const result = await handler.executeExternal(
			{
				to: "recipient@example.com",
				from: "alias@example.com",
				subject: "Hello",
				body: "body text",
			},
			gmailCtx(config),
			config,
			"gmail/v1/users/me/messages/send",
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ id: "msg_1" });
		expect(result.providerConfirmation).toBe("gmail-message:msg_1");
	});

	it("does not mint Gmail confirmation from invalid IDs or draft writes", async () => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ id: "provider id with spaces" }),
		) as unknown as typeof fetch;

		const handler = new ToolHandler();
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://gmail.googleapis.com",
			endpoint: "gmail/v1/users/me/messages/send",
			bodyEncoding: "gmail-rfc2822",
		};

		const invalid = await handler.execute(
			{ to: "recipient@example.com", subject: "Hello", body: "body" },
			gmailCtx(config),
		);
		expect(invalid.providerConfirmation).toBeUndefined();

		globalThis.fetch = vi.fn(async () =>
			Response.json({ id: "draft_1" }),
		) as unknown as typeof fetch;
		const draft = await handler.execute(
			{
				to: "recipient@example.com",
				subject: "Draft",
				body: "body",
				draft: true,
			},
			gmailCtx(config),
		);
		expect(draft.providerConfirmation).toBeUndefined();
	});

	it("updates Gmail drafts through the draft resource instead of sending", async () => {
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				if (!init) throw new Error("expected RequestInit");
				const body = JSON.parse(String(init.body)) as {
					message?: { raw?: string };
				};

				expect(String(_url)).toBe(
					"https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft_1",
				);
				expect(init.method).toBe("PUT");
				expect(body.message?.raw).toBeTruthy();

				return new Response(JSON.stringify({ id: "draft_1" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler() as unknown as {
			executeExternal: (
				input: Record<string, unknown>,
				ctx: ToolExecutionContext,
				config: Record<string, unknown>,
				endpoint: string,
			) => Promise<{ data: unknown; status: number }>;
		};
		const config = {
			transport: "external",
			method: "PUT",
			baseUrl: "https://gmail.googleapis.com",
			endpoint: "gmail/v1/users/me/drafts/:id",
			bodyEncoding: "gmail-rfc2822",
		};

		const result = await handler.executeExternal(
			{
				to: "recipient@example.com",
				subject: "Updated",
				body: "updated body",
			},
			gmailCtx(config, "gmail_drafts_update"),
			config,
			"gmail/v1/users/me/drafts/draft_1",
		);

		expect(result.status).toBe(200);
		expect(result.data).toEqual({ id: "draft_1" });
	});

	it("forwards Tedix-private x-mcp-header custom headers (with {param} resolution)", async () => {
		let seenHeaders: Record<string, string> = {};
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				seenHeaders = (init?.headers as Record<string, string>) ?? {};
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		) as unknown as typeof fetch;

		const handler = new ToolHandler();
		const config = {
			transport: "external",
			method: "POST",
			baseUrl: "https://api.example.test",
			endpoint: "x",
			"x-mcp-header": {
				"X-Trace-Tag": "static-tag",
				"X-Tenant": "{tenant}",
				// Tedix-managed headers must not be overridable.
				Authorization: "Bearer spoofed",
				"X-Tedix-Org-Id": "spoofed-org",
			},
		};

		await handler.execute({ tenant: "acme" }, ctx(config));

		expect(seenHeaders["X-Trace-Tag"]).toBe("static-tag");
		expect(seenHeaders["X-Tenant"]).toBe("acme");
		// Reserved headers are dropped, never forwarded from config.
		expect(seenHeaders.Authorization).toBeUndefined();
		expect(seenHeaders["X-Tedix-Org-Id"]).toBeUndefined();
	});
});

describe("external embedded delegation dispatch", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});
	it("uses provider tenant transport credentials, sends only provider assertion, and refuses redirects", async () => {
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://provider.example/api",
			endpoint: "orders",
			_sourceAppId: "source",
			_aggregateConnectionLabel: "forged-label",
			auth: {
				type: "connection",
				connectionId: "delegation-test-provider",
				clientCredentials: { tokenUrl: "https://attacker.example/token" },
				credentialScope: "user",
			},
			headers: {
				"x-tedix-host-delegation": "forged",
				authorization: "forged-transport",
			},
		};
		const apiFetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				const body = (await request.json()) as {
					json: Record<string, unknown>;
				};
				if (request.url.includes("resolveEmbeddedHostDelegation")) {
					expect(body.json).toMatchObject({
						token: "private-browser-token",
						sourceAppId: "source",
						callable: "acme_staging.orders_detail",
						organizationId: "customer",
					});
					return Response.json({
						json: {
							token: "provider-assertion",
							providerOrganizationId: "provider-org",
							connectionProviderId: "source-connection",
							connectionScopes: ["orders:read"],
							authHeader: "Authorization",
							authTemplate: "{token}",
							audience: "https://provider.example",
							expiresAt: Date.now() / 1000 + 60,
						},
					});
				}
				expect(request.url).toContain("connections/fetchOrgToken");
				expect(body.json).toMatchObject({
					organizationId: "provider-org",
					scope: "tenant",
					providerId: "source-connection",
					scopes: ["orders:read"],
				});
				expect(request.headers.get("X-Tedix-Tedi-Id")).toBe("worker");
				expect(request.headers.get("X-Tedix-Tedi-Scopes")).toBe(
					"connections.execute",
				);
				expect(request.headers.get("X-Tedix-Mcp-Tool-Id")).toBeTruthy();
				expect(request.headers.get("X-Tedix-End-User-Id")).toBeNull();
				expect(body.json).not.toHaveProperty("userId");
				expect(body.json).not.toHaveProperty("label");
				return Response.json({ json: { accessToken: "provider-transport" } });
			},
		);
		globalThis.fetch = vi.fn(async (_url, init) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("Authorization")).toBe("provider-transport");
			expect(headers.get("X-Tedix-Host-Delegation")).toBe("provider-assertion");
			expect(JSON.stringify(init)).not.toContain("private-browser-token");
			expect(init?.redirect).toBe("manual");
			return new Response(null, {
				status: 302,
				headers: { Location: "https://elsewhere.example" },
			});
		}) as typeof fetch;
		const result = await new ToolHandler().execute(
			{},
			{
				...ctx(config),
				env: {
					ENVIRONMENT: "test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				toolId: "acme_staging__orders_detail",
				callable: "acme_staging.orders_detail",
				callerIdentity: {
					authType: "tedi",
					tediId: "worker",
					organizationId: "customer",
				},
				requestMeta: { "tedix/embedded-session": "private-browser-token" },
			},
		);
		expect(result.status).toBe(403);
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(apiFetch).toHaveBeenCalledTimes(2);
	});
	it("fails closed before provider credential lookup or external fetch when resolution is denied", async () => {
		const config = {
			transport: "external",
			method: "GET",
			baseUrl: "https://provider.example",
			endpoint: "orders",
			auth: { type: "connection", connectionId: "source" },
		};
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { error: "denied" } }, { status: 403 }),
		);
		globalThis.fetch = vi.fn();
		const result = await new ToolHandler().execute(
			{},
			{
				...ctx(config),
				env: { API_SERVICE: { fetch: apiFetch } } as unknown as CloudflareEnv,
				callable: "acme.orders_detail",
				callerIdentity: {
					authType: "tedi",
					tediId: "worker",
					organizationId: "customer",
				},
				requestMeta: { "tedix/embedded-session": "invalid" },
			},
		);
		expect(result.status).toBe(403);
		expect(apiFetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("omits credential exception content from the diagnostic log", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const handler = new ToolHandler() as unknown as {
				fetchOrgConnectionToken: (
					context: ToolExecutionContext<ToolConfig>,
					connectionId: string,
					organizationId: string,
					scope: "tenant",
				) => Promise<{ token: string | null }>;
			};
			const result = await handler.fetchOrgConnectionToken(
				{
					...ctx({}),
					env: {
						API_SERVICE: {
							fetch: vi.fn(async () => {
								throw new Error("vault failed with sensitive-token", {
									cause: new Error("signed credential secret"),
								});
							}),
						},
					} as unknown as CloudflareEnv,
				},
				"source",
				"org_1",
				"tenant",
			);
			expect(result.token).toBeNull();
			const diagnostic = errorSpy.mock.calls
				.map(([entry]) => entry as Record<string, unknown>)
				.find(
					(entry) => entry?.event === "handler.org_credential_lookup_exception",
				);
			expect(diagnostic).toMatchObject({
				connectionId: "source",
				exception: {
					message: "Content omitted",
					cause: { message: "Content omitted" },
				},
			});
			expect(JSON.stringify(diagnostic)).not.toContain("sensitive-token");
			expect(JSON.stringify(diagnostic)).not.toContain("credential secret");
		} finally {
			errorSpy.mockRestore();
		}
	});
});

describe("background named credential provenance", () => {
	it("forwards actual calendar arguments and live epoch on every lookup instead of using cached credentials", async () => {
		const requests: Request[] = [];
		const apiFetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(
					input instanceof Request ? input : new Request(input, init),
				);
				return requests.length === 1
					? Response.json({ json: { accessToken: "first", scopes: ["read"] } })
					: Response.json(
							{ json: { code: "FORBIDDEN", message: "revoked" } },
							{ status: 403 },
						);
			},
		);
		const context = {
			...ctx({}),
			toolId: "list_events",
			appId: "10000000-0000-4000-8000-000000000001",
			env: {
				API_URL: "https://api",
				API_SERVICE: { fetch: apiFetch },
				ENVIRONMENT: "test",
			},
			callerIdentity: {
				authType: "service",
				tediId: "worker",
				organizationId: "org",
				scopes: ["connections.read"],
				skillRunId: "run",
				workflowExecutionEpoch: 3,
			},
		} as unknown as ToolExecutionContext<ToolConfig>;
		const handler = new ToolHandler() as unknown as {
			fetchTediConnectionToken(
				context: ToolExecutionContext<ToolConfig>,
				tedi: string,
				provider: string,
				scope: string,
				scopes?: string[],
				label?: string,
				preference?: string,
				args?: Record<string, unknown>,
			): Promise<{ token: string | null; status?: number }>;
		};
		expect(
			await handler.fetchTediConnectionToken(
				context,
				"worker",
				"google",
				"user",
				["read"],
				undefined,
				undefined,
				{ calendarId: "calendar-a" },
			),
		).toMatchObject({ token: "first" });
		expect(
			await handler.fetchTediConnectionToken(
				context,
				"worker",
				"google",
				"user",
				["read"],
				undefined,
				undefined,
				{ calendarId: "calendar-a" },
			),
		).toMatchObject({ token: null, status: 403 });
		expect(apiFetch).toHaveBeenCalledTimes(2);
		expect(requests[0]!.headers.get("X-Tedix-Skill-Run-Id")).toBe("run");
		expect(requests[0]!.headers.get("X-Tedix-Workflow-Execution-Epoch")).toBe(
			"3",
		);
		const body = (await requests[0]!.json()) as {
			json: { delegatedToolUse: unknown };
		};
		expect(body.json.delegatedToolUse).toEqual({
			appId: context.appId,
			arguments: { calendarId: "calendar-a" },
		});
	});
});
