import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { skillsContract } from "@tedix/api-contract/contracts/cognitive";
import { procedureInputSchema } from "@tedix/api-contract/utils/procedure-schemas";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { ZodType } from "zod";
import { buildAggregateTediTools } from "./aggregate-tedis";
import { buildHomeSurfaceTools } from "./home-surface";
import {
	resolveInternalTransportTimeout,
	type ToolExecutionContext,
	ToolHandler,
} from "./handler";

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
		env: {
			ENVIRONMENT: "test",
			API_URL: "https://api.example.test",
		} as unknown as CloudflareEnv,
		config: config as unknown as ToolConfig,
		toolId: "create_secret",
		requestId: "req_1",
		traceId: "trace_1",
		executionId: "exec_1",
		callerIdentity: {
			authType: "tedi",
			tediId: "tedi_1",
			organizationId: "org_1",
		},
	};
}

function headersFromFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Headers {
	return input instanceof Request ? input.headers : new Headers(init?.headers);
}

async function jsonFromFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<{ json?: Record<string, unknown> }> {
	return input instanceof Request
		? ((await input.clone().json()) as { json?: Record<string, unknown> })
		: (JSON.parse(String(init?.body)) as {
				json?: Record<string, unknown>;
			});
}

describe("browser RPC timeout", () => {
	const config = { transport: "rpc" } as ToolConfig;

	it("covers browser navigation and post-load waits with API headroom", () => {
		expect(
			resolveInternalTransportTimeout("browser/extractMarkdown", config),
		).toBe(45_000);
		expect(
			resolveInternalTransportTimeout("browser/extractMarkdown", config, {
				timeoutMs: 60_000,
				waitForTimeoutMs: 60_000,
			}),
		).toBe(135_000);
	});

	it("keeps configured longer browser and ordinary RPC timeouts", () => {
		expect(
			resolveInternalTransportTimeout(
				"browser/capturePage",
				{ ...config, timeout: 90_000 },
				{ timeoutMs: 10_000 },
			),
		).toBe(90_000);
		expect(resolveInternalTransportTimeout("content/search", config)).toBe(
			15_000,
		);
	});
});

describe("ToolHandler RPC transport logging", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("logs upstream status without request or response content", async () => {
		globalThis.fetch = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				expect(String(init?.body)).toContain("sk_live_request_secret");
				return new Response(
					JSON.stringify({
						error: {
							code: "UNAUTHORIZED",
							message:
								"Authorization Bearer response-token-secret-value failed",
							accessToken: "response_access_token_secret",
							nested: { password: "response_password_secret" },
						},
					}),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				);
			},
		) as unknown as typeof fetch;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const handler = new ToolHandler();
		const result = await handler.execute(
			{
				apiKey: "sk_live_request_secret",
				password: "request_password_secret",
			},
			ctx({
				transport: "rpc",
				endpoint: "secrets/create",
			}),
		);

		expect(result.status).toBe(401);
		expect(warn).toHaveBeenCalledOnce();

		const [payload] = warn.mock.calls[0] as [Record<string, unknown>];
		expect(payload).toMatchObject({
			component: "mcp.tool_handler",
			event: "handler.rpc_upstream_error",
			appId: "app_1",
			toolName: "create_secret",
			status: 401,
			traceId: "trace_1",
			executionId: "exec_1",
			outcome: "denied",
		});
		expect(payload).not.toHaveProperty("request");
		expect(payload).not.toHaveProperty("args");
		expect(payload).not.toHaveProperty("body");
		expect(payload).not.toHaveProperty("responseError");

		const serializedLog = JSON.stringify(payload);
		expect(serializedLog).not.toContain("sk_live_request_secret");
		expect(serializedLog).not.toContain("request_password_secret");
		expect(serializedLog).not.toContain("response_access_token_secret");
		expect(serializedLog).not.toContain("response_password_secret");
		expect(serializedLog).not.toContain("response-token-secret-value");
		expect(serializedLog).not.toContain("Bearer");
	});

	it("does not forward caller OAuth tokens for public source RPC tools", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = headersFromFetch(input, init);
				expect(headers.get("X-Service-Binding")).toBe("true");
				expect(headers.get("X-Forwarded-Authorization")).toBeNull();
				expect(headers.get("X-Tedix-Caller-Type")).toBeNull();
				return Response.json({ json: { ok: true } });
			},
		);

		const result = await new ToolHandler().execute(
			{ query: "widgets" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "content/search",
					staticParams: { appId: "source_app_1" },
					_sourceAppId: "source_app_1",
					_sourceAuthRequired: false,
					_sourceVisibility: "public",
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "oauth",
					tediId: "tedi_1",
					organizationId: "org_1",
				},
				bearerToken: "user.jwt.token",
			},
		);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("preserves an explicit null at the RPC response path", async () => {
		const apiFetch = vi.fn(async () => Response.json({ json: null }));
		const executionContext = {
			...ctx({ transport: "rpc", endpoint: "adapterBindings/get" }),
			env: {
				ENVIRONMENT: "test",
				API_URL: "https://api.example.test",
				API_SERVICE: { fetch: apiFetch },
			} as unknown as CloudflareEnv,
		};

		const handler = new ToolHandler();
		const result = await handler.execute({}, executionContext);

		expect(result).toMatchObject({ status: 200, data: null });
		expect(handler.buildStructuredContent(result, executionContext)).toEqual({
			data: null,
		});
	});

	it("does not inject appId/tediId into a strict schema that omits them", async () => {
		// 116 of 280 destructive tools declare additionalProperties:false. The
		// confirmed-destructive path requires a `reason`, and supplying one drove
		// the context injection into those strict oRPC contracts, which answered
		// "Unrecognized key: appId" — naming a key the caller never sent. Every one
		// of those tools was unreachable by an agent, which is what blocks
		// agent-in-the-loop autonomy. Injecting is also pointless there: a
		// procedure that does not declare the field cannot read it.
		let body: Record<string, unknown> | undefined;
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const parsed = await jsonFromFetch(input, init);
				body = parsed as unknown as Record<string, unknown>;
				return Response.json({ json: { ok: true } });
			},
		);

		await new ToolHandler().execute(
			{ campaignKey: "dogfood" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "fleetMarketing/authorizeOwnedChannel",
				}),
				toolInputSchema: {
					type: "object",
					properties: { campaignKey: { type: "string" } },
					required: ["campaignKey"],
					additionalProperties: false,
				},
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(apiFetch).toHaveBeenCalledOnce();
		// Params ride under `json` on the RPC envelope — assert against that, not
		// the envelope, or the test passes for the wrong reason.
		const params = (body?.json ?? {}) as Record<string, unknown>;
		expect(params).toMatchObject({ campaignKey: "dogfood" });
		expect(Object.hasOwn(params, "appId")).toBe(false);
		expect(Object.hasOwn(params, "tediId")).toBe(false);
	});

	it("drops the ownership-reasserted tediId when a strict schema omits it", async () => {
		// The allowExplicitTediId:false ownership reassert runs after the
		// schema-aware caller-context guard, so it re-injected tediId into
		// strict org-scoped contracts and made every home-mirror tool on a
		// tedi-prefixed surface (cto.create_work_item and siblings) answer
		// "Unrecognized key: tediId". The final chokepoint must strip it.
		let body: Record<string, unknown> | undefined;
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const parsed = await jsonFromFetch(input, init);
				body = parsed as unknown as Record<string, unknown>;
				return Response.json({ json: { id: "wi_1" } });
			},
		);

		await new ToolHandler().execute(
			{ title: "probe" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "workItems/create",
					allowExplicitTediId: false,
					_aggregateTediId: "aggregate_owner_tedi",
				}),
				toolInputSchema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
					additionalProperties: false,
				},
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(apiFetch).toHaveBeenCalledOnce();
		const params = (body?.json ?? {}) as Record<string, unknown>;
		expect(params).toMatchObject({ title: "probe" });
		expect(Object.hasOwn(params, "tediId")).toBe(false);
	});

	it("keeps the ownership reassert when the schema declares tediId", async () => {
		let body: Record<string, unknown> | undefined;
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const parsed = await jsonFromFetch(input, init);
				body = parsed as unknown as Record<string, unknown>;
				return Response.json({ json: { ok: true } });
			},
		);

		await new ToolHandler().execute(
			{ title: "probe", tediId: "caller_supplied_tedi" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "workItems/create",
					allowExplicitTediId: false,
					staticParams: { tediId: "aggregate_owner_tedi" },
					_aggregateTediId: "aggregate_owner_tedi",
				}),
				toolInputSchema: {
					type: "object",
					properties: {
						title: { type: "string" },
						tediId: { type: "string" },
					},
					required: ["title"],
					additionalProperties: false,
				},
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(apiFetch).toHaveBeenCalledOnce();
		const params = (body?.json ?? {}) as Record<string, unknown>;
		expect(params.tediId).toBe("aggregate_owner_tedi");
	});

	it("still injects appId/tediId when the schema declares them", async () => {
		// The security guard is defence-in-depth and must survive the fix above.
		let body: Record<string, unknown> | undefined;
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				body = (await jsonFromFetch(input, init)) as unknown as Record<
					string,
					unknown
				>;
				return Response.json({ json: { ok: true } });
			},
		);

		await new ToolHandler().execute(
			{ q: "x" },
			{
				...ctx({ transport: "rpc", endpoint: "content/search" }),
				toolInputSchema: {
					type: "object",
					properties: {
						q: { type: "string" },
						appId: { type: "string" },
						tediId: { type: "string" },
					},
				},
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(apiFetch).toHaveBeenCalledOnce();
		expect((body?.json ?? {}) as Record<string, unknown>).toMatchObject({
			appId: "app_1",
			tediId: "tedi_1",
		});
	});

	it("still injects appId/tediId when no input schema is stored", async () => {
		// Legacy hand-authored rows without an advertised schema keep the
		// permissive defence-in-depth read.
		let body: Record<string, unknown> | undefined;
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				body = (await jsonFromFetch(input, init)) as unknown as Record<
					string,
					unknown
				>;
				return Response.json({ json: { ok: true } });
			},
		);

		await new ToolHandler().execute(
			{ q: "x" },
			{
				...ctx({ transport: "rpc", endpoint: "content/search" }),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(apiFetch).toHaveBeenCalledOnce();
		expect((body?.json ?? {}) as Record<string, unknown>).toMatchObject({
			appId: "app_1",
			tediId: "tedi_1",
		});
	});

	it("does not inject undeclared context keys into a lax schema row", async () => {
		// A contract can turn `.strict()` while the gateway's D1 row still
		// advertises the lax pre-strict schema (no additionalProperties). If
		// laxness were read as acceptance, the guard would inject appId and the
		// strict contract would answer "Unrecognized key: appId" on a key the
		// caller never sent. The composed input for an
		// internal rpc contract must carry only keys the schema declares: zod
		// strips undeclared keys on a lax contract (injection inert) and rejects
		// them on a strict one (injection fatal).
		let body: Record<string, unknown> | undefined;
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				body = (await jsonFromFetch(input, init)) as unknown as Record<
					string,
					unknown
				>;
				return Response.json({ json: { data: [], pagination: {} } });
			},
		);

		await new ToolHandler().execute(
			{ disposition: "accepted", limit: 50 },
			{
				...ctx({
					transport: "rpc",
					endpoint: "workItems/list",
					// Aggregate gateway routing metadata, as stored for the
					// admin-app work board rows surfaced under the `work.*`
					// Code Mode namespace.
					_sourceAppId: "admin_app_1",
				}),
				// The stale synced row: property map present, additionalProperties
				// absent — the exact shape a pre-`.strict()` zod object produces.
				toolInputSchema: {
					type: "object",
					properties: {
						disposition: { type: "string" },
						workKind: { type: "string" },
						projectId: { type: "string" },
						limit: { type: "number" },
						offset: { type: "number" },
					},
				},
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(apiFetch).toHaveBeenCalledOnce();
		const params = (body?.json ?? {}) as Record<string, unknown>;
		expect(params).toEqual({ disposition: "accepted", limit: 50 });
		expect(Object.hasOwn(params, "appId")).toBe(false);
		expect(Object.hasOwn(params, "tediId")).toBe(false);
	});

	it("keeps injecting a context key the endpoint spends as a path placeholder", async () => {
		// A REST route like `apps/{appId}/stats` consumes appId into the path —
		// it never travels as a body/query key, so schema acceptance must not
		// block the injection even when the schema omits the field.
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				expect(url).toContain("/v1/apps/app_1/stats");
				expect(init?.method ?? (input as Request).method).toBe("GET");
				return Response.json({ ok: true });
			},
		);

		const result = await new ToolHandler().execute(
			{ q: "x" },
			{
				...ctx({
					transport: "rest",
					method: "GET",
					endpoint: "apps/{appId}/stats",
				}),
				toolInputSchema: {
					type: "object",
					properties: { q: { type: "string" } },
				},
				callerIdentity: undefined,
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(result.status).toBe(200);
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("forwards explicit tedi identity on trusted service-binding RPC calls", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = headersFromFetch(input, init);
				expect(headers.get("X-Service-Binding")).toBe("true");
				expect(headers.get("X-Tedix-Tedi-Id")).toBe("tedi_1");
				expect(headers.get("X-Tedix-Org-Id")).toBe("org_1");
				expect(headers.get("X-Tedix-Trace-Id")).toBe("trace_1");
				expect(headers.get("X-Tedix-Mcp-Execution-Id")).toBe("exec_1");
				expect(headers.get("X-Tedix-Mcp-Tool-Id")).toBe("create_secret");
				return Response.json({ json: { ok: true } });
			},
		);

		const result = await new ToolHandler().execute(
			{ catalogAppSlug: "astro-docs" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "tenantCatalog/installTenantMcpApp",
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("forwards verified external-agent identity without a tedi id", async () => {
		const principalId = "00000000-0000-4000-8000-000000000002";
		const sessionId = "00000000-0000-4000-8000-000000000003";
		const clientRecordId = "aih-client-record-1";
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = headersFromFetch(input, init);
				expect(headers.get("X-Service-Binding")).toBe("true");
				expect(headers.get("X-Tedix-Caller-Type")).toBe(
					"mcp-edge-external-agent",
				);
				expect(headers.get("X-Tedix-External-Agent-Principal-Id")).toBe(
					principalId,
				);
				expect(headers.get("X-Tedix-External-Agent-Session-Id")).toBe(
					sessionId,
				);
				expect(headers.get("X-Tedix-External-Agent-Client-Record-Id")).toBe(
					clientRecordId,
				);
				expect(headers.get("X-Tedix-Tedi-Id")).toBeNull();
				return Response.json({ json: { ok: true } });
			},
		);

		const result = await new ToolHandler().execute(
			{},
			{
				...ctx({ transport: "rpc", endpoint: "workItems/list" }),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "external_agent",
					externalAgentPrincipalId: principalId,
					externalAgentSessionId: sessionId,
					externalAgentClientRecordId: clientRecordId,
					organizationId: "org_1",
				},
			},
		);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
	});

	it("keeps aggregate workflow RPCs scoped to their owner tedi", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const body = await jsonFromFetch(input, init);
				expect(body.json).toMatchObject({
					skillId: "skill_1",
					tediId: "aggregate_owner_tedi",
				});
				expect(body.json?.tediId).not.toBe("caller_supplied_tedi");
				expect(body.json?.tediId).not.toBe("authenticated_caller_tedi");
				return Response.json({ json: { runId: "run_1" } });
			},
		);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		const result = await new ToolHandler().execute(
			{
				skillId: "skill_1",
				tediId: "caller_supplied_tedi",
			},
			{
				...ctx({
					transport: "rpc",
					endpoint: "skills/runWorkflow",
					allowExplicitAppId: true,
					allowExplicitTediId: false,
					staticParams: { tediId: "aggregate_owner_tedi" },
					_aggregateTediId: "aggregate_owner_tedi",
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "tedi",
					tediId: "authenticated_caller_tedi",
					organizationId: "org_1",
				},
			},
		);

		expect(result).toMatchObject({ status: 200, data: { runId: "run_1" } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it.each([
		{
			name: "run_skill_workflow",
			input: { skillId: "skill_1" },
			schema: procedureInputSchema(skillsContract.runWorkflow),
		},
		{
			name: "list_skill_workflow_history",
			input: { limit: 1 },
			schema: procedureInputSchema(skillsContract.runWorkflowHistory),
		},
	])(
		"retains the generated owner for $name with a hidden identity input",
		async ({ name, input, schema }) => {
			const tools = buildAggregateTediTools(
				[{ slug: "cto", tediId: "aggregate_owner_tedi", runtimeKind: "agent" }],
				{ MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv,
			);
			const tool = tools.find((entry) => entry.toolId === `cto__${name}`)!;
			expect(tool.inputSchema.properties).not.toHaveProperty("tediId");
			let params: Record<string, unknown> | undefined;
			const apiFetch = vi.fn(
				async (request: string | URL | Request, init?: RequestInit) => {
					params = (await jsonFromFetch(request, init)).json;
					return Response.json({ json: { runId: "run_1" } });
				},
			);
			await new ToolHandler().execute(
				{ ...input, tediId: "caller_supplied_tedi" },
				{
					...ctx(tool.config as Record<string, unknown>),
					toolId: tool.toolId,
					toolInputSchema: tool.inputSchema,
					env: {
						ENVIRONMENT: "test",
						API_SERVICE: { fetch: apiFetch },
					} as unknown as CloudflareEnv,
				},
			);
			expect(apiFetch).toHaveBeenCalledOnce();
			expect(params).toMatchObject({
				...input,
				tediId: "aggregate_owner_tedi",
			});
			expect((schema as ZodType).safeParse(params).success).toBe(true);
		},
	);

	it.each(["create_work_item", "get_skill_portfolio_balance"])(
		"preserves the generated org-scoped identity opt-out for %s",
		async (name) => {
			const tools = buildAggregateTediTools(
				[{ slug: "cto", tediId: "aggregate_owner_tedi", runtimeKind: "agent" }],
				{ MCP_URL: "https://mcp.tedix.dev" } as CloudflareEnv,
			);
			const tool = tools.find((entry) => entry.toolId === `cto__${name}`)!;
			let params: Record<string, unknown> | undefined;
			const apiFetch = vi.fn(
				async (request: string | URL | Request, init?: RequestInit) => {
					params = (await jsonFromFetch(request, init)).json;
					return Response.json({ json: { ok: true } });
				},
			);
			await new ToolHandler().execute(
				{ tediId: "caller_supplied_tedi" },
				{
					...ctx(tool.config as Record<string, unknown>),
					toolId: tool.toolId,
					toolInputSchema: tool.inputSchema,
					env: {
						ENVIRONMENT: "test",
						API_SERVICE: { fetch: apiFetch },
					} as unknown as CloudflareEnv,
				},
			);
			expect(apiFetch).toHaveBeenCalledOnce();
			expect(params).not.toHaveProperty("tediId");
			expect(params).not.toHaveProperty("__tedixOmitAggregateTediId");
		},
	);

	it("retains a trusted aggregate tedi binding omitted from the public schema", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const body = await jsonFromFetch(input, init);
				expect(body.json).toEqual({ tediId: "aggregate_owner_tedi" });
				return Response.json({ json: { runtimeStatus: "running" } });
			},
		);

		const result = await new ToolHandler().execute(
			{},
			{
				...ctx({
					transport: "rpc",
					endpoint: "cognitiveRuntime/getStatus",
					allowExplicitTediId: true,
					staticParams: { tediId: "aggregate_owner_tedi" },
					_aggregateTediId: "aggregate_owner_tedi",
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				// The public aggregate schema deliberately hides tediId; it is a
				// server-bound identity, not caller-selectable input.
				toolInputSchema: {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
			},
		);

		expect(result).toMatchObject({
			status: 200,
			data: { runtimeStatus: "running" },
		});
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("does not inject an aggregate tedi into an org-scoped RPC contract", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const body = await jsonFromFetch(input, init);
				expect(body.json).toEqual({ limit: 1 });
				return Response.json({ json: { items: [] } });
			},
		);

		const result = await new ToolHandler().execute(
			{ limit: 1 },
			{
				...ctx({
					transport: "rpc",
					endpoint: "workItems/list",
					allowExplicitTediId: true,
					allowExplicitAppId: true,
					staticParams: { __tedixOmitAggregateTediId: true },
					_aggregateTediId: "aggregate_owner_tedi",
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "service",
					tediId: "aggregate_owner_tedi",
					organizationId: "org_1",
				},
				// Aggregate catalog execution can arrive without a hydrated input
				// schema. The durable opt-out must still prevent caller identity from
				// being injected into an org-scoped RPC contract.
				toolInputSchema: undefined,
			},
		);

		expect(result).toMatchObject({ status: 200, data: { items: [] } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("binds a matching verified tedi credential and ignores spoofed actor input", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				const body = await request
					.clone()
					.json<{ json?: Record<string, unknown> }>();
				expect(request.headers.get("X-Tedix-Tedi-Id")).toBe(
					"aggregate_owner_tedi",
				);
				expect(body.json).toMatchObject({ id: "work_1" });
				expect(body.json).not.toHaveProperty("tediId");
				return Response.json({ json: { readiness: "ready" } });
			},
		);

		const result = await new ToolHandler().execute(
			{ id: "work_1", tediId: "caller_supplied_tedi" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "workItems/getReadiness",
					allowExplicitTediId: false,
					includeTediIdParam: false,
					_aggregateTediId: "aggregate_owner_tedi",
					_aggregateTediOrgId: "org_1",
					_credentialDerivedTediActor: true,
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "tedi",
					tediId: "aggregate_owner_tedi",
					organizationId: "org_1",
				},
			},
		);

		expect(result).toMatchObject({
			status: 200,
			data: { readiness: "ready" },
		});
	});

	it.each([
		[
			"human OAuth",
			{ authType: "oauth", userId: "user_1", organizationId: "org_1" },
		],
		["no identity", undefined],
		[
			"a different tedi",
			{ authType: "tedi", tediId: "other_tedi", organizationId: "org_1" },
		],
	] as const)(
		"denies credential-derived mutations for %s",
		async (_label, callerIdentity) => {
			const apiFetch = vi.fn(async () => Response.json({ json: { ok: true } }));
			const result = await new ToolHandler().execute(
				{ id: "work_1", tediId: "aggregate_owner_tedi" },
				{
					...ctx({
						transport: "rpc",
						endpoint: "workItems/startAttempt",
						allowExplicitTediId: false,
						includeTediIdParam: false,
						_aggregateTediId: "aggregate_owner_tedi",
						_aggregateTediOrgId: "org_1",
						_credentialDerivedTediActor: true,
					}),
					env: {
						ENVIRONMENT: "test",
						API_URL: "https://api.example.test",
						API_SERVICE: { fetch: apiFetch },
					} as unknown as CloudflareEnv,
					callerIdentity,
				},
			);

			expect(result).toMatchObject({ status: 403 });
			expect(apiFetch).not.toHaveBeenCalled();
		},
	);

	it("accepts an exact tedi actor from the trusted service-delegation identity", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				expect(request.headers.get("X-Tedix-Tedi-Id")).toBe("delegated_tedi");
				return Response.json({ json: { ok: true } });
			},
		);
		const result = await new ToolHandler().execute(
			{ id: "work_1" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "workItems/heartbeatAttempt",
					_aggregateTediId: "delegated_tedi",
					_aggregateTediOrgId: "org_1",
					_credentialDerivedTediActor: true,
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
				callerIdentity: {
					authType: "service",
					tediId: "delegated_tedi",
					organizationId: "org_1",
				},
			},
		);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it.each([true, false])(
		"forwards explicit Home Workspace selection without inventing omitted context (%s)",
		async (selected) => {
			const workspaceContext = {
				workspaceId: "workspace_selected",
				workpiece: { kind: "output", id: "output_selected" },
			};
			const args = {
				content: "Inspect the selected Workspace",
				conversationId: "home:agent:workspace-proof",
				...(selected ? { workspaceContext } : {}),
			};
			const apiFetch = vi.fn(
				async (input: string | URL | Request, init?: RequestInit) => {
					const body = await jsonFromFetch(input, init);
					expect(body.json).toMatchObject(args);
					if (!selected)
						expect(body.json).not.toHaveProperty("workspaceContext");
					return Response.json({
						json: {
							status: "queued",
							conversationId: args.conversationId,
							run: { id: "home_run_workspace", status: "queued" },
						},
					});
				},
			);
			const ask = buildHomeSurfaceTools().find(
				(tool) => tool.toolId === "ask",
			)!;
			const result = await new ToolHandler().execute(args, {
				...ctx(ask.config as Record<string, unknown>),
				toolId: ask.toolId,
				toolInputSchema: ask.inputSchema,
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			});
			expect(apiFetch).toHaveBeenCalledOnce();
			expect(result.status).toBe(200);
			expect(result.data).toMatchObject({
				run: { id: "home_run_workspace" },
				task: { id: "home_run_workspace", pollWith: "tasks/get" },
			});
		},
	);

	it("injects MCP task linkage on _emitTaskLinkage results (task.id = run.id)", async () => {
		const apiFetch = vi.fn(async () =>
			Response.json({
				json: {
					status: "queued",
					conversationId: "home:main",
					run: { id: "home_run_42", status: "queued" },
				},
			}),
		);

		const result = await new ToolHandler().execute(
			{ content: "check my Gmail" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "kernelRuntime/enqueueMessage",
					_emitTaskLinkage: true,
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(result.status).toBe(200);
		expect(result.data).toMatchObject({
			run: { id: "home_run_42" },
			task: { id: "home_run_42", pollWith: "tasks/get" },
		});
	});

	it("resolves aggregate tedi spoken-reply synthesis into a voice subject", async () => {
		const apiFetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const body = await jsonFromFetch(input, init);
				expect(body.json).toMatchObject({
					text: "Say this out loud",
					subject: { type: "tedi", tediId: "tedi_2" },
				});
				expect(body.json).not.toHaveProperty("tediId");
				return Response.json({
					json: {
						audioBase64: "AAAA",
						mimeType: "audio/mpeg",
						provider: "workers-ai",
					},
				});
			},
		);

		const result = await new ToolHandler().execute(
			{ text: "Say this out loud" },
			{
				...ctx({
					transport: "rpc",
					endpoint: "voice/synthesizeSpokenReply",
					allowExplicitTediId: true,
					_aggregateTediId: "tedi_2",
					_voiceSubject: "aggregateTedi",
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);

		expect(result).toMatchObject({
			status: 200,
			data: {
				audioBase64: "AAAA",
				mimeType: "audio/mpeg",
				provider: "workers-ai",
			},
		});
		expect(apiFetch).toHaveBeenCalledOnce();
	});

	it("does not inject task linkage on errors or without the opt-in flag", async () => {
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { run: { id: "home_run_42" } } }),
		);

		// No _emitTaskLinkage flag → untouched result
		const plain = await new ToolHandler().execute(
			{},
			{
				...ctx({ transport: "rpc", endpoint: "kernelRuntime/enqueueMessage" }),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: apiFetch },
				} as unknown as CloudflareEnv,
			},
		);
		expect(plain.data).not.toHaveProperty("task");

		// Upstream error → no task linkage even with the flag
		const failingFetch = vi.fn(async () =>
			Response.json(
				{ json: { code: "UNAUTHORIZED", message: "nope" } },
				{ status: 401 },
			),
		);
		const failed = await new ToolHandler().execute(
			{},
			{
				...ctx({
					transport: "rpc",
					endpoint: "kernelRuntime/enqueueMessage",
					_emitTaskLinkage: true,
				}),
				env: {
					ENVIRONMENT: "test",
					API_URL: "https://api.example.test",
					API_SERVICE: { fetch: failingFetch },
				} as unknown as CloudflareEnv,
			},
		);
		expect(failed.status).toBe(401);
		expect(failed.data).not.toHaveProperty("task");
	});

	it("forwards canonical run lineage metadata on the trusted API binding", async () => {
		const apiFetch = vi.fn(async (request: Request) => {
			const headers = request.headers;
			expect(headers.get("X-Tedix-Kernel-Run-Id")).toBe("kernel-run-1");
			expect(headers.get("X-Tedix-Work-Item-Id")).toBe("work-item-1");
			expect(headers.get("X-Tedix-Trace-Bundle-Id")).toBe("trace-1");
			return Response.json({ json: { ok: true } });
		});
		const executionContext = {
			...ctx({ transport: "rpc", endpoint: "osWorkspaces/outputs/revise" }),
			env: {
				ENVIRONMENT: "test",
				API_URL: "https://api.example.test",
				API_SERVICE: { fetch: apiFetch },
			} as unknown as CloudflareEnv,
			requestMeta: {
				"io.tedix/kernelRunId": "kernel-run-1",
				"io.tedix/workItemId": "work-item-1",
				"io.tedix/traceBundleId": "trace-1",
			},
		};

		const result = await new ToolHandler().execute({}, executionContext);
		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(apiFetch).toHaveBeenCalledOnce();
	});
});

describe("ToolHandler result ergonomics", () => {
	const handler = new ToolHandler();

	describe("text truncation", () => {
		it("returns text unchanged at or below the limit", () => {
			const data = { value: "x".repeat(100) };
			const text = handler.buildTextContent({ data, status: 200 }, ctx({}));
			expect(text).toBe(JSON.stringify(data, null, 2));
		});

		it("head-truncates long text with an actionable hint carrying exact char counts", () => {
			const data = { value: "x".repeat(10_000) };
			const full = JSON.stringify(data, null, 2);
			const text = handler.buildTextContent({ data, status: 200 }, ctx({}));
			expect(text.startsWith(full.slice(0, 4000))).toBe(true);
			expect(text).toContain(
				`\n[Truncated: showing first 4,000 of ${full.length.toLocaleString("en-US")} chars.`,
			);
			expect(text).toContain(
				"Narrow the query with this tool's pagination/filter parameters, or call it via Code Mode and select only the fields you need.]",
			);
		});
	});

	describe("modelSummaryTemplate projection", () => {
		const data = {
			items: [{ id: "a" }, { id: "b" }, { id: "c" }],
			meta: { total: 41, query: "printers" },
		};

		it("renders {path} and {count:path} placeholders", () => {
			const text = handler.buildTextContent(
				{ data, status: 200 },
				ctx({
					modelSummaryTemplate:
						'Found {count:items} of {meta.total} results for "{meta.query}".',
				}),
			);
			expect(text).toBe('Found 3 of 41 results for "printers".');
		});

		it("resolves paths against the shaped structured output (post responseMap)", () => {
			const text = handler.buildTextContent(
				{ data: { data: [{ id: 1 }, { id: 2 }] }, status: 200 },
				ctx({
					responseMap: { data: "items" },
					modelSummaryTemplate: "{count:items} items",
				}),
			);
			expect(text).toBe("2 items");
		});

		it("renders empty string for missing paths and 0 for non-array counts", () => {
			const text = handler.buildTextContent(
				{ data, status: 200 },
				ctx({
					modelSummaryTemplate: "[{missing.path}] count={count:meta.total}",
				}),
			);
			expect(text).toBe("[] count=0");
		});

		it("still truncates a rendered template above the max text length", () => {
			const text = handler.buildTextContent(
				{ data: { blob: "y".repeat(9_000) }, status: 200 },
				ctx({ modelSummaryTemplate: "blob: {blob}" }),
			);
			expect(text).toContain(
				"\n[Truncated: showing first 4,000 of 9,006 chars.",
			);
			expect(text.startsWith(`blob: ${"y".repeat(3_994)}`)).toBe(true);
		});

		it("leaves structuredContent unaffected by the projection", () => {
			const c = ctx({ modelSummaryTemplate: "{count:items} items" });
			const structured = handler.buildStructuredContent(
				{ data, status: 200 },
				c,
			);
			expect(structured).toEqual(data);
		});

		it("does not apply to error results", () => {
			const text = handler.buildTextContent(
				{ data: { error: "boom" }, status: 500 },
				ctx({ modelSummaryTemplate: "{count:items} items" }),
			);
			expect(text).toBe("Error: boom");
		});

		it("absent field keeps byte-identical default text output", () => {
			const text = handler.buildTextContent({ data, status: 200 }, ctx({}));
			expect(text).toBe(JSON.stringify(data, null, 2));
		});

		it("fails soft to the default JSON text when modelSummaryTemplate is not a string", () => {
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			try {
				const text = handler.buildTextContent(
					{ data, status: 200 },
					ctx({ modelSummaryTemplate: 123 }),
				);
				expect(text).toBe(JSON.stringify(data, null, 2));
				expect(errSpy).toHaveBeenCalledOnce();
			} finally {
				errSpy.mockRestore();
			}
		});

		it("fails soft to the default JSON text when the projection render throws", () => {
			const local = new ToolHandler();
			const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(local, "buildStructuredContent").mockImplementation(() => {
				throw new Error("shaping exploded with private-result");
			});
			try {
				const text = local.buildTextContent(
					{ data, status: 200 },
					ctx({ modelSummaryTemplate: "{count:items} items" }),
				);
				expect(text).toBe(JSON.stringify(data, null, 2));
				expect(errSpy).toHaveBeenCalledOnce();
				expect(errSpy.mock.calls[0]?.[0]).toMatchObject({
					event: "handler.model_summary_render_failed",
					exception: { message: "Content omitted" },
				});
				expect(JSON.stringify(errSpy.mock.calls[0]?.[0])).not.toContain(
					"private-result",
				);
			} finally {
				vi.restoreAllMocks();
			}
		});

		it("does not double-apply responseTransforms to the already-built structuredContent", () => {
			const result = { data: { items: [{ id: "a" }] }, status: 200 };
			const c = ctx({
				responseTransforms: [
					{ arrayPath: "items", set: "label", template: "{label}{id}" },
				],
				modelSummaryTemplate: "{count:items} items",
			});
			// Same order as tool-execution: structuredContent first, text second.
			const structured = handler.buildStructuredContent(result, c);
			const text = handler.buildTextContent(result, c);
			expect(text).toBe("1 items");
			const items = structured.items as Array<Record<string, unknown>>;
			expect(items[0]?.label).toBe("a");
		});
	});
});
