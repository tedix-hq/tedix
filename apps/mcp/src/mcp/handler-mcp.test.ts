import type { ToolConfig } from "@tedix/api-contract/schemas/tools";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	classifyUpstreamProtocolCaller,
	emitUpstreamProtocolMetric,
	type ToolExecutionContext,
	ToolHandler,
} from "./handler";
import { resetUpstreamEraCache } from "./upstream-mcp-client";

const TRACE_UUID = "4bf92f35-77b3-4da6-a3ce-929d0e0e4736";

// The dual-era upstream client negotiates protocol once per origin and caches
// it on the module. Clear the cache so each test negotiates independently.
beforeEach(() => {
	resetUpstreamEraCache();
});

/**
 * Method-aware upstream mock. Routes by JSON-RPC method so it works for both
 * the modern (server/discover → tools/call) and legacy (initialize → tools/call)
 * flows. `discoverVersions` controls what server/discover advertises; default
 * advertises the modern revision (internal tedi servers are modern-capable).
 */
function methodAwareFetch(
	result: Record<string, unknown>,
	discoverVersions: string[] = ["2026-07-28", "2025-11-25"],
) {
	return vi.fn(async (_url: unknown, init: RequestInit) => {
		const body = JSON.parse(String(init.body)) as {
			id: unknown;
			method: string;
		};
		if (body.method === "server/discover") {
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					resultType: "complete",
					supportedVersions: discoverVersions,
					capabilities: { tools: {} },
				},
			});
		}
		if (body.method === "initialize") {
			return Response.json(
				{
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						serverInfo: { name: "legacy-test", version: "1.0.0" },
					},
				},
				{ headers: { "mcp-session-id": "session_1" } },
			);
		}
		if (body.method === "notifications/initialized") {
			return new Response(null, { status: 202 });
		}
		// A 2026-07-28 server MUST tag every result with its resultType.
		const modern =
			new Headers(init.headers).get("MCP-Protocol-Version") === "2026-07-28";
		return Response.json({
			jsonrpc: "2.0",
			id: body.id,
			result: modern ? { resultType: "complete", ...result } : result,
		});
	});
}

function mcpCtx(
	config: Record<string, unknown>,
	result: Record<string, unknown> = {
		content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
	},
	discoverVersions?: string[],
): ToolExecutionContext<ToolConfig> {
	const apiFetch = vi.fn(async () =>
		Response.json({
			json: { headers: { Authorization: "Bearer should-not-load" } },
		}),
	);
	const tediFetch = methodAwareFetch(result, discoverVersions);

	return {
		appId: "app_1",
		app: {
			id: "app_1",
			slug: "tedix-unified",
			name: "Tedix Unified",
			organizationId: "org_1",
		} as ToolExecutionContext["app"],
		appCapabilities: {},
		env: {
			ENVIRONMENT: "test",
			API_SERVICE: { fetch: apiFetch },
			TEDI_SERVICE: { fetch: tediFetch },
		} as unknown as CloudflareEnv,
		config: config as unknown as ToolConfig,
		toolId: "cto__run_tedi_turn",
		requestId: "req_1",
		traceId: "trace_1",
		executionId: "exec_1",
		callerIdentity: {
			authType: "oauth",
			tediId: "caller_tedi_1",
			organizationId: "org_1",
		},
	};
}

describe("ToolHandler MCP transport", () => {
	it("rejects a changed reconnect binding before credential lookup or provider execution", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://provider.example/mcp",
			mcpToolName: "create_event",
			auth: {
				type: "connection",
				connectionId: "calendar",
				credentialScope: "tenant",
				scopes: ["calendar"],
			},
		});
		ctx.requestMeta = {
			"tedix/expectedConnection": {
				providerId: "calendar",
				connectionInstanceId: "11111111-1111-4111-8111-111111111111",
				scope: "tenant",
				scopes: ["calendar"],
			},
		};
		const result = await new ToolHandler().execute({}, ctx);
		expect(result.status).toBe(409);
		expect(result.data).toMatchObject({
			error: expect.stringContaining("changed while awaiting reconnect"),
		});
		expect(result.connectionRecovery).toBeUndefined();
		expect(ctx.env.API_SERVICE!.fetch).not.toHaveBeenCalled();
		expect(ctx.env.TEDI_SERVICE!.fetch).not.toHaveBeenCalled();
		ctx.config.auth = undefined;
		const removed = await new ToolHandler().execute({}, ctx);
		expect(removed.status).toBe(409);
		expect(ctx.env.API_SERVICE!.fetch).not.toHaveBeenCalled();
	});
	it("emits a bounded upstream protocol metric without endpoint data", () => {
		const writeDataPoint = vi.fn();
		emitUpstreamProtocolMetric(
			{ ANALYTICS: { writeDataPoint } } as unknown as CloudflareEnv,
			{
				protocolEra: "legacy_sse_2024",
				appSlug: "tenant-app",
				toolName: "search",
				boundary: "external",
				callerClass: "external_agent",
			},
		);
		expect(writeDataPoint).toHaveBeenCalledWith({
			blobs: [
				"upstream_protocol",
				"legacy_sse_2024",
				"tenant-app",
				"search",
				"external",
				"external_agent",
				"caller_class_v1",
			],
			doubles: [1],
			indexes: ["tenant-app"],
		});
	});
	it("classifies callers without recording identity-bearing fields", () => {
		expect(classifyUpstreamProtocolCaller(undefined)).toBe("unknown");
		expect(classifyUpstreamProtocolCaller({ authType: "oauth" })).toBe(
			"human_client",
		);
		expect(
			classifyUpstreamProtocolCaller({ authType: "service", kernel: true }),
		).toBe("os");
		expect(
			classifyUpstreamProtocolCaller({
				authType: "tedi",
				tediId: "private-tedi-id",
			}),
		).toBe("tedi_runtime");
		expect(
			classifyUpstreamProtocolCaller({
				authType: "external_agent",
				externalAgentPrincipalId: "private-principal-id",
			}),
		).toBe("external_agent");
	});
	it("uses internal tedi service-binding auth without per-tedi AIH credentials", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "code",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
		});
		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });

		const apiFetch = (ctx.env.API_SERVICE as Fetcher).fetch as ReturnType<
			typeof vi.fn
		>;
		const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
			typeof vi.fn
		>;
		expect(apiFetch).not.toHaveBeenCalled();
		expect(tediFetch).toHaveBeenCalledTimes(1);

		for (const call of tediFetch.mock.calls) {
			const [, init] = call as [string, RequestInit];
			const headers = new Headers(init.headers);
			expect(headers.get("X-Service-Binding")).toBe("true");
			expect(headers.get("X-Tedix-Host")).toBe("cto.tedi.tedix.dev");
			expect(headers.get("X-Tedix-Org-Id")).toBe("org_1");
			expect(headers.get("X-Tedix-Tedi-Scopes")).toBe("tedi:channel.write");
			expect(headers.get("X-Tedix-Mcp-Delegated-Tool")).toBe("run_tedi_turn");
			expect(headers.get("Authorization")).toBeNull();
		}
	});

	it("does not count an upstream JSON-RPC tool error as compatibility use", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "code",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
		});
		const writeDataPoint = vi.fn();
		ctx.env.ANALYTICS = { writeDataPoint } as AnalyticsEngineDataset;
		ctx.env.TEDI_SERVICE = {
			fetch: vi.fn(async (_url: unknown, init: RequestInit) =>
				Response.json({
					jsonrpc: "2.0",
					id: (JSON.parse(String(init.body)) as { id: unknown }).id,
					error: { code: -32_603, message: "tool failed" },
				}),
			),
		} as unknown as Fetcher;

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 502 });
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it("attributes successful compatibility use to the aggregate source app", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "code",
			_sourceAppSlug: "cto-provider",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
		});
		const writeDataPoint = vi.fn();
		ctx.env.ANALYTICS = { writeDataPoint } as AnalyticsEngineDataset;

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200 });
		expect(writeDataPoint).toHaveBeenCalledWith(
			expect.objectContaining({
				blobs: expect.arrayContaining(["cto-provider"]),
			}),
		);
	});

	it("uses the Docs service binding and preserves external-agent attribution", async () => {
		const docsFetch = methodAwareFetch(
			{
				content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
			},
			["2025-11-25"],
		);
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
			mcpToolName: "start_docs_build",
		});
		ctx.env = {
			...ctx.env,
			DOCS: { fetch: docsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;
		ctx.bearerToken = "external-agent-jwt";
		ctx.callerIdentity = {
			authType: "external_agent",
			externalAgentPrincipalId: "principal-1",
			externalAgentSessionId: "session-1",
			externalAgentClientRecordId: "client-record-1",
			organizationId: "external_org_claim",
			scopes: ["mcp:content"],
		};

		const result = await new ToolHandler().execute({ siteId: "site-1" }, ctx);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(docsFetch).toHaveBeenCalledTimes(1);
		for (const call of docsFetch.mock.calls) {
			const [, init] = call as [string, RequestInit];
			const headers = new Headers(init.headers);
			const body = JSON.parse(String(init.body)) as {
				method: string;
				params: { _meta?: Record<string, unknown> };
			};
			expect(body.method).toBe("tools/call");
			expect(headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
			expect(headers.get("Mcp-Method")).toBe("tools/call");
			expect(headers.get("Mcp-Name")).toBe("start_docs_build");
			expect(headers.get("Mcp-Session-Id")).toBeNull();
			expect(
				body.params._meta?.["io.modelcontextprotocol/protocolVersion"],
			).toBe("2026-07-28");
			expect(headers.get("Authorization")).toBe(
				"Bearer platform-service-token",
			);
			expect(headers.get("X-Forwarded-Authorization")).toBe(
				"Bearer external-agent-jwt",
			);
			expect(headers.get("X-Tedix-Actor-Type")).toBe("external_agent");
			expect(headers.get("X-Tedix-Actor-Id")).toBe("principal-1");
			expect(headers.get("X-Tedix-Agent-Session-Id")).toBe("session-1");
			expect(headers.get("X-Tedix-Delegated-Scope")).toBe("mcp:content.write");
		}
	});

	it.each(["platform:admin", "mcp:content.admin"])(
		"carries a tedi's resolved %s scope on the CMS binding",
		async (scope) => {
			const cmsFetch = methodAwareFetch({
				content: [{ type: "text", text: "{}" }],
			});
			const ctx = mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://builder.tedix.dev/mcp",
				mcpToolName: "site_transfer_capabilities",
			});
			ctx.env = {
				...ctx.env,
				CMS: { fetch: cmsFetch },
				PLATFORM_SERVICE_TOKEN: "service-secret",
			} as unknown as CloudflareEnv;
			ctx.callerIdentity = {
				authType: "tedi",
				tediId: "cto-1",
				organizationId: "org_1",
				scopes: [scope],
			};
			expect(await new ToolHandler().execute({}, ctx)).toMatchObject({
				status: 200,
			});
			for (const [, init] of cmsFetch.mock.calls as Array<
				[string, RequestInit]
			>) {
				const headers = new Headers(init.headers);
				expect(headers.get("Authorization")).toBe("Bearer service-secret");
				expect(headers.get("X-Tedix-Tedi-Id")).toBe("cto-1");
				expect(headers.get("X-Tedix-Tedi-Scopes")).toBe(scope);
				expect(headers.get("X-Tedix-Actor-Type")).toBe("tedi");
				expect(headers.get("X-Tedix-Actor-Id")).toBe("cto-1");
			}
		},
	);

	it.each(["service", "oauth", "external_agent"] as const)(
		"does not turn a %s caller into a CMS tedi platform delegate",
		async (authType) => {
			const cmsFetch = methodAwareFetch({
				content: [{ type: "text", text: "{}" }],
			});
			const ctx = mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://builder.tedix.dev/mcp",
				mcpToolName: "site_transfer_capabilities",
			});
			ctx.env = {
				...ctx.env,
				CMS: { fetch: cmsFetch },
				PLATFORM_SERVICE_TOKEN: "service-secret",
			} as unknown as CloudflareEnv;
			ctx.callerIdentity = {
				authType,
				tediId: "cto-1",
				organizationId: "org_1",
				scopes: ["platform:admin"],
			};
			expect(await new ToolHandler().execute({}, ctx)).toMatchObject({
				status: 200,
			});
			for (const [, init] of cmsFetch.mock.calls as Array<
				[string, RequestInit]
			>) {
				const headers = new Headers(init.headers);
				expect(headers.has("X-Tedix-Tedi-Id")).toBe(false);
				expect(headers.has("X-Tedix-Tedi-Scopes")).toBe(false);
			}
		},
	);

	it("forwards only verified CMS maintenance authority on the CMS binding", async () => {
		const cmsFetch = methodAwareFetch({
			content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
		});
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://builder.tedix.dev/mcp",
			mcpToolName: "repair_media_usage",
		});
		ctx.env = {
			...ctx.env,
			CMS: { fetch: cmsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;
		ctx.callerIdentity = {
			authType: "oauth",
			organizationId: "org_1",
			scopes: ["mcp:content.write", "mcp:settings.admin"],
		};
		expect(
			await new ToolHandler().execute({ scope: "all" }, ctx),
		).toMatchObject({
			status: 200,
		});
		for (const [, init] of cmsFetch.mock.calls as Array<
			[string, RequestInit]
		>) {
			const headers = new Headers(init.headers);
			expect(headers.get("X-Tedix-Cms-Maintenance-Authorized")).toBe("true");
			expect(headers.get("Authorization")).toBe(
				"Bearer platform-service-token",
			);
		}

		cmsFetch.mockClear();
		ctx.callerIdentity.scopes = ["mcp:content.write"];
		expect(
			await new ToolHandler().execute({ scope: "all" }, ctx),
		).toMatchObject({
			status: 200,
		});
		for (const [, init] of cmsFetch.mock.calls as Array<
			[string, RequestInit]
		>) {
			expect(
				new Headers(init.headers).has("X-Tedix-Cms-Maintenance-Authorized"),
			).toBe(false);
		}
	});

	it("accepts only a matching first-party Docs file observation", async () => {
		const content = "hello\n";
		const observation = {
			version: 1,
			kind: "docs_file_observation",
			receiptId: "00000000-0000-4000-8000-000000000001",
			provider: { appSlug: "docs", toolName: "get_docs_file" },
			resource: {
				organizationSlug: "tedix",
				siteId: "00000000-0000-4000-8000-000000000002",
				path: "index.md",
			},
			evidence: {
				contentSha256:
					"5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
				byteLength: 6,
				observedGitRevision: "b".repeat(40),
			},
			observedAt: "2026-09-22T12:00:00.000Z",
		};
		const docsFetch = methodAwareFetch({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						content,
						path: "index.md",
						revision: "b".repeat(40),
						contentSha256: observation.evidence.contentSha256,
						byteLength: 6,
					}),
				},
			],
			structuredContent: {
				content,
				path: "index.md",
				revision: "b".repeat(40),
				contentSha256: observation.evidence.contentSha256,
				byteLength: 6,
			},
			_meta: { "io.tedix/readObservation": observation },
		});
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
			mcpToolName: "get_docs_file",
		});
		Object.assign(ctx, { appSlug: "tedix-docs", connectionLabel: "tedix" });
		ctx.app.slug = "tedix-docs";
		ctx.env = {
			...ctx.env,
			DOCS: { fetch: docsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;
		expect(
			await new ToolHandler().execute(
				{ siteId: observation.resource.siteId, path: "index.md" },
				ctx,
			),
		).toMatchObject({ readObservation: observation });
		// Actual production configuration supplies org in the registered URL;
		// aggregate execution owns a different app slug from the Docs provider.
		for (const appSlug of ["tedix-docs", "tedix-unified"]) {
			const configured = mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://docs-admin.tedix.dev/mcp?org=tedix",
				mcpToolName: "get_docs_file",
			});
			configured.app.slug = appSlug;
			configured.env = ctx.env;
			expect(
				await new ToolHandler().execute(
					{ siteId: observation.resource.siteId, path: "index.md" },
					configured,
				),
			).toMatchObject({ readObservation: observation });
			configured.connectionLabel = "other-org";
			expect(
				(
					await new ToolHandler().execute(
						{ siteId: observation.resource.siteId, path: "index.md" },
						configured,
					)
				).readObservation,
			).toBeUndefined();
		}
		for (const mutate of [
			(candidate: typeof ctx) => {
				candidate.connectionLabel = "other-org";
			},
			(candidate: typeof ctx) => {
				candidate.connectionLabel = undefined;
			},
		]) {
			const mismatch = mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
				mcpToolName: "get_docs_file",
			});
			mismatch.env = {
				...mismatch.env,
				DOCS: { fetch: docsFetch },
				PLATFORM_SERVICE_TOKEN: "platform-service-token",
			} as unknown as CloudflareEnv;
			mismatch.app.slug = "tedix-docs";
			mismatch.connectionLabel = "tedix";
			mutate(mismatch);
			expect(
				(
					await new ToolHandler().execute(
						{ siteId: observation.resource.siteId, path: "index.md" },
						mismatch,
					)
				).readObservation,
			).toBeUndefined();
		}
		expect(
			(
				await new ToolHandler().execute(
					{ siteId: "00000000-0000-4000-8000-000000000099", path: "index.md" },
					ctx,
				)
			).readObservation,
		).toBeUndefined();

		const forgedCtx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://attacker.example/mcp",
			mcpToolName: "get_docs_file",
		});
		forgedCtx.env = {
			...forgedCtx.env,
			DOCS: undefined,
		} as unknown as CloudflareEnv;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation((input, init) => docsFetch(input, init!));
		try {
			expect(
				(await new ToolHandler().execute({}, forgedCtx)).readObservation,
			).toBeUndefined();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("surfaces a Docs modern-call failure without probing or initializing", async () => {
		const docsFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as { method: string };
			if (body.method !== "tools/call") {
				throw new Error(`unexpected Docs handshake: ${body.method}`);
			}
			return Response.json(
				{
					jsonrpc: "2.0",
					id: "denied",
					error: { code: -32_001, message: "delegated scope expired" },
				},
				{ status: 401 },
			);
		});
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
			mcpToolName: "list_docs_sites",
		});
		ctx.env = {
			...ctx.env,
			DOCS: { fetch: docsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;

		const result = await new ToolHandler().execute({}, ctx);

		expect(docsFetch).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({
			status: 401,
			data: { error: expect.stringContaining("delegated scope expired") },
		});
	});

	it("does not present Home service auth to Docs as an end-user JWT", async () => {
		const docsFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
			const headers = new Headers(init.headers);
			if (headers.has("X-Forwarded-Authorization")) {
				return Response.json(
					{ error: "forwarded token must be a caller JWT" },
					{ status: 401 },
				);
			}
			return Response.json({
				jsonrpc: "2.0",
				id: (JSON.parse(String(init.body)) as { id: unknown }).id,
				result: {
					resultType: "complete",
					content: [{ type: "text", text: JSON.stringify({ sites: [] }) }],
				},
			});
		});
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
			mcpToolName: "list_docs_sites",
		});
		ctx.env = {
			...ctx.env,
			DOCS: { fetch: docsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;
		ctx.bearerToken = "platform-service-token";
		ctx.callerIdentity = {
			authType: "service",
			kernel: true,
			userId: "home-user-1",
			organizationId: "org_1",
			scopes: ["mcp:content.read"],
		};

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200, data: { sites: [] } });
		expect(docsFetch).toHaveBeenCalledTimes(1);
		const call = docsFetch.mock.calls[0];
		if (!call) throw new Error("Expected one Docs call");
		const init = call[1] as RequestInit;
		const headers = new Headers(init.headers);
		const body = JSON.parse(String(init.body)) as { method: string };
		expect(body.method).toBe("tools/call");
		expect(headers.get("Authorization")).toBe("Bearer platform-service-token");
		expect(headers.get("X-Forwarded-Authorization")).toBeNull();
		expect(headers.get("X-Tedix-Delegated-Scope")).toBe("mcp:content.read");
		expect(headers.get("X-Tedix-Actor-Type")).toBe("kernel");
		expect(headers.get("X-Tedix-Actor-Id")).toBe("home-user-1");
		expect(headers.get("MCP-Protocol-Version")).toBe("2026-07-28");
		expect(headers.get("Mcp-Method")).toBe("tools/call");
		expect(headers.get("Mcp-Name")).toBe("list_docs_sites");
	});

	it("delegates the least Docs scope required by the upstream tool", async () => {
		const docsFetch = methodAwareFetch({
			content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
		});
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
			mcpToolName: "list_docs_sites",
		});
		ctx.env = {
			...ctx.env,
			DOCS: { fetch: docsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		for (const call of docsFetch.mock.calls) {
			const [, init] = call as [string, RequestInit];
			expect(new Headers(init.headers).get("X-Tedix-Delegated-Scope")).toBe(
				"mcp:content.read",
			);
		}
	});

	it("forwards a tenant Git credential to Docs without replacing service auth", async () => {
		const docsFetch = methodAwareFetch({
			content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
		});
		const connectionFetch = vi.fn(async (_request: Request) =>
			Response.json({ json: { accessToken: "github-tenant-token" } }),
		);
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://docs-admin.tedix.dev/mcp",
			mcpToolName: "start_docs_build",
			auth: {
				type: "connection",
				connectionId: "github",
				credentialScope: "tenant",
			},
		});
		ctx.env = {
			...ctx.env,
			API_SERVICE: { fetch: connectionFetch },
			DOCS: { fetch: docsFetch },
			PLATFORM_SERVICE_TOKEN: "platform-service-token",
		} as unknown as CloudflareEnv;
		ctx.bearerToken = "tenant-user-jwt";
		ctx.callerIdentity = {
			authType: "oauth",
			userId: "user-1",
			tediId: "tedi-1",
			organizationId: "org_1",
			scopes: ["mcp:content"],
		};

		const result = await new ToolHandler().execute({ siteId: "site-1" }, ctx);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		expect(connectionFetch).toHaveBeenCalled();
		expect((connectionFetch.mock.calls[0]?.[0] as Request).url).toContain(
			"connections/fetchOrgToken",
		);
		expect(
			await (connectionFetch.mock.calls[0]?.[0] as Request).clone().text(),
		).toContain("org_1");
		for (const call of docsFetch.mock.calls) {
			const [, init] = call as [string, RequestInit];
			const headers = new Headers(init.headers);
			expect(headers.get("Authorization")).toBe(
				"Bearer platform-service-token",
			);
			expect(headers.get("X-Tedix-Provider-Authorization")).toBe(
				"Bearer github-tenant-token",
			);
		}
	});

	it("propagates W3C trace context in HTTP headers and MCP request meta", async () => {
		const ctx = {
			...mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "code",
				_aggregateTediId: "cto_tedi_1",
				_aggregateTediOrgId: "org_1",
				_aggregateTediRemoteName: "run_tedi_turn",
			}),
			traceId: TRACE_UUID,
			tracestate: "vendor=1",
		};

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });

		const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
			typeof vi.fn
		>;
		expect(tediFetch).toHaveBeenCalledTimes(1);

		const [, callRequest] = tediFetch.mock.calls[0] as [string, RequestInit];
		const callHeaders = new Headers(callRequest.headers);
		expect(callHeaders.get("traceparent")).toMatch(
			/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
		);
		expect(callHeaders.get("tracestate")).toBe("vendor=1");

		const body = JSON.parse(String(callRequest.body)) as {
			params: { _meta?: Record<string, unknown> };
		};
		expect(body.params._meta?.traceparent).toMatch(
			/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/,
		);
		expect(body.params._meta?.tracestate).toBe("vendor=1");
	});

	it.each([undefined, "skill-run-1"])(
		"acknowledges a pending turn for caller skillRunId=%s",
		async (skillRunId) => {
			const ctx = mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "run_tedi_turn",
				_aggregateTediId: "cto_tedi_1",
				_aggregateTediOrgId: "org_1",
			});
			ctx.traceId = TRACE_UUID;
			const tediFetch = vi.fn(async () =>
				Response.json(
					{
						success: true,
						accepted: true,
						run_id: "run-9",
					},
					{ status: 202 },
				),
			);
			ctx.env.TEDI_SERVICE = { fetch: tediFetch } as unknown as Fetcher;
			ctx.callerIdentity = {
				...ctx.callerIdentity!,
				...(skillRunId ? { skillRunId } : {}),
			};

			const result = await new ToolHandler().execute(
				{ session_key: "s", text: "hi" },
				ctx,
			);

			expect(result.status).toBe(200);
			// A pending turn carries no in-band task field, so the aggregate synthesizes
			// the run's namespaced Task linkage from run_id (its events are keyed by
			// exactly that id) — otherwise a Tasks client has no id to poll.
			expect((result.data as { task?: unknown }).task).toMatchObject({
				id: "tedi:cto_tedi_1:run-9",
				pollWith: "tasks/get",
			});
			expect(tediFetch).toHaveBeenCalledTimes(1);
			const [url, init] = tediFetch.mock.calls[0]! as unknown as [
				string,
				RequestInit,
			];
			expect(url).toBe("https://cto.tedi.tedix.dev/hooks/inject");
			expect(JSON.parse(String(init.body))).toMatchObject({
				session_key: "s",
				text: "hi",
				client_request_id: "exec_1",
				async: true,
				trace_id: TRACE_UUID,
			});
			const headers = new Headers(init.headers);
			expect(headers.get("X-Service-Binding")).toBe("true");
			expect(headers.get("X-Tedix-Host")).toBe("cto.tedi.tedix.dev");
		},
	);

	it("returns an ephemeral receipt without claiming a ledger-backed task", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
		});
		ctx.env.TEDI_SERVICE = {
			fetch: vi.fn(async () =>
				Response.json(
					{
						success: true,
						accepted: true,
						run_id: "ephemeral",
						session_key: "__test:temporary",
					},
					{ status: 202 },
				),
			),
		} as unknown as Fetcher;
		const result = await new ToolHandler().execute(
			{ session_key: "__test:temporary", text: "hi" },
			ctx,
		);
		expect(result.status).toBe(200);
		expect(result.data).toMatchObject({ pending: true, run_id: "ephemeral" });
		expect((result.data as Record<string, unknown>).task).toBeUndefined();
	});

	it("does NOT synthesize a task linkage for a SETTLED turn (content in-band)", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
		});
		const tediFetch = vi.fn(async () =>
			Response.json({
				success: true,
				ok: true,
				run_id: "run-8",
				assistant: { content: "done" },
			}),
		);
		ctx.env.TEDI_SERVICE = { fetch: tediFetch } as unknown as Fetcher;

		const result = await new ToolHandler().execute(
			{ session_key: "s", text: "hi" },
			ctx,
		);

		expect(result.status).toBe(200);
		expect((result.data as { task?: unknown }).task).toBeUndefined();
	});

	it("routes aggregate ask through the same durable inject hook", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "run_tedi_turn",
			paramMap: { message: "text" },
			staticParams: { session_key: "agent:main:main" },
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
		});
		ctx.toolId = "cto__ask";
		const tediFetch = vi.fn(async () =>
			Response.json({
				success: true,
				ok: true,
				run_id: "run-ask",
				assistant: { content: "done" },
			}),
		);
		ctx.env.TEDI_SERVICE = { fetch: tediFetch } as unknown as Fetcher;

		const result = await new ToolHandler().execute({ message: "hello" }, ctx);

		expect(result.status).toBe(200);
		const [url, init] = tediFetch.mock.calls[0]! as unknown as [
			string,
			RequestInit,
		];
		expect(url).toBe("https://cto.tedi.tedix.dev/hooks/inject");
		expect(JSON.parse(String(init.body))).toEqual({
			session_key: "agent:main:main",
			text: "hello",
			async: true,
			client_request_id: "exec_1",
			trace_id: "trace_1",
		});
	});

	it.each([
		["open_computer", { repository: true }],
		["close_computer", {}],
		["exec", { command: "pwd" }],
		["read_execution", { executionId: "execution-1" }],
		["cancel_execution", { executionId: "execution-1" }],
		["read", { path: "/home/tedi/workstation/a.txt" }],
		["write", { path: "/home/tedi/workstation/a.txt", content: "test" }],
	])(
		"forwards bounded run metadata without changing %s arguments",
		async (name, input) => {
			const ctx = {
				...mcpCtx({
					transport: "mcp",
					mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
					mcpToolName: name as string,
					_aggregateTediId: "cto_tedi_1",
					_aggregateTediOrgId: "org_1",
					_aggregateTediSlug: "cto",
				}),
				requestMeta: {
					"io.tedix/kernelRunId": "child-run-1",
					"io.tedix/workItemId": "work-item-1",
					"io.tedix/traceBundleId": "trace-bundle-1",
					"untrusted/extra": "must-not-forward",
				},
			};
			const result = await new ToolHandler().execute(input, ctx);
			expect(result).toMatchObject({ status: 200, data: { ok: true } });
			const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
				typeof vi.fn
			>;
			const [, request] = tediFetch.mock.calls[0] as [string, RequestInit];
			const body = JSON.parse(String(request.body));
			expect(body.params.name).toBe(name);
			expect(body.params.arguments).toEqual(input);
			expect(body.params._meta).toMatchObject({
				"io.tedix/kernelRunId": "child-run-1",
				"io.tedix/workItemId": "work-item-1",
				"io.tedix/traceBundleId": "trace-bundle-1",
			});
			expect(body.params._meta).not.toHaveProperty("untrusted/extra");
		},
	);

	it("does not forward internal lineage metadata to external MCP servers", async () => {
		const upstream = methodAwareFetch({
			content: [{ type: "text", text: "ok" }],
		});
		vi.stubGlobal("fetch", upstream);
		try {
			const ctx = {
				...mcpCtx({
					transport: "mcp",
					mcpServerUrl: "https://example.com/mcp",
					mcpToolName: "read",
				}),
				requestMeta: {
					"io.tedix/kernelRunId": "private-run",
					"io.tedix/workItemId": "private-work",
					"io.tedix/traceBundleId": "private-trace",
				},
			};
			await new ToolHandler().execute({ path: "a" }, ctx);
			const calls = upstream.mock.calls.map(([, init]) =>
				JSON.parse(String(init.body)),
			);
			const call = calls.find((item) => item.method === "tools/call");
			expect(call).toBeDefined();
			expect(call.params._meta).not.toHaveProperty("io.tedix/kernelRunId");
			expect(call.params._meta).not.toHaveProperty("io.tedix/workItemId");
			expect(call.params._meta).not.toHaveProperty("io.tedix/traceBundleId");
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("keeps upstream structuredContent schema-clean", async () => {
		const ctx = mcpCtx(
			{
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "check_tool_schema_sync",
				_aggregateTediId: "cto_tedi_1",
				_aggregateTediOrgId: "org_1",
				_aggregateTediRemoteName: "check_tool_schema_sync",
			},
			{
				content: [{ type: "text", text: "Schema sync is healthy." }],
				structuredContent: {
					status: "ok",
					appSlug: "acme-unified",
					driftCount: 0,
				},
			},
		);

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({
			status: 200,
			data: {
				status: "ok",
				appSlug: "acme-unified",
				driftCount: 0,
			},
		});
		expect(result.data).not.toHaveProperty("_text");
	});

	it("preserves falsey upstream structuredContent", async () => {
		const ctx = mcpCtx(
			{
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "count_results",
			},
			{
				content: [{ type: "text", text: "fallback" }],
				structuredContent: 0,
			},
		);

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200, data: 0 });
	});

	it("parses canonical JSON spread across upstream text blocks", async () => {
		const ctx = mcpCtx(
			{
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "list_rows",
			},
			{
				content: [
					{ type: "text", text: '{"rows":' },
					{ type: "text", text: "[1]}" },
				],
			},
		);

		const result = await new ToolHandler().execute({}, ctx);

		expect(result).toMatchObject({ status: 200, data: { rows: [1] } });
	});

	it("surfaces an upstream input_required result as an error carrying the retry envelope, not success", async () => {
		const ctx = mcpCtx(
			{
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "repo_commit",
			},
			{
				resultType: "input_required",
				requestState: "opaque-state-1",
				inputRequests: { approval: { method: "elicitation/create" } },
				content: [
					{
						type: "text",
						text: 'Approval required for destructive action "repo_commit". Provide a reason and retry with inputResponses + requestState.',
					},
				],
			},
		);

		const result = await new ToolHandler().execute({}, ctx);

		expect(result.status).toBe(428);
		expect(result.data).toMatchObject({
			resultType: "input_required",
			requestState: "opaque-state-1",
			inputRequests: { approval: { method: "elicitation/create" } },
		});
		const error = (result.data as { error?: string }).error ?? "";
		expect(error).toContain("input_required");
		expect(error).toContain("repo_commit");
		expect(error).toContain("NOT executed");
	});

	it("treats platform-hosted robot upstreams as managed MCP origins, not tedi service-binding hosts", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://reflexos.tedix.tech/mcp",
			mcpToolName: "get_state",
		});
		const upstreamFetch = methodAwareFetch({
			content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = upstreamFetch as unknown as typeof globalThis.fetch;
		try {
			const result = await new ToolHandler().execute({}, ctx);

			expect(result).toMatchObject({ status: 200, data: { ok: true } });

			const apiFetch = (ctx.env.API_SERVICE as Fetcher).fetch as ReturnType<
				typeof vi.fn
			>;
			const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
				typeof vi.fn
			>;
			expect(apiFetch).toHaveBeenCalledTimes(1);
			expect(tediFetch).not.toHaveBeenCalled();
			expect(upstreamFetch).toHaveBeenCalledTimes(2);

			const [, init] = upstreamFetch.mock.calls[1] as [string, RequestInit];
			const headers = new Headers(init.headers);
			expect(headers.get("Authorization")).toBe("Bearer should-not-load");
			expect(headers.get("X-Service-Binding")).toBeNull();
			expect(headers.get("X-Tedix-Host")).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("sends a direct 2026-07-28 request for the first-party tedi binding", async () => {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "code",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
			_aggregateTediRemoteName: "run_tedi_turn",
		});

		await new ToolHandler().execute({}, ctx);

		const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
			typeof vi.fn
		>;
		// The first-party binding is pinned modern: no fallible per-tedi probe.
		expect(tediFetch).toHaveBeenCalledTimes(1);
		const methods = tediFetch.mock.calls.map(
			(c) => JSON.parse(String((c[1] as RequestInit).body)).method,
		);
		expect(methods).toEqual(["tools/call"]);

		const [, callInit] = tediFetch.mock.calls[0] as [string, RequestInit];
		const callHeaders = new Headers(callInit.headers);
		expect(callHeaders.get("MCP-Protocol-Version")).toBe("2026-07-28");
		expect(callHeaders.get("Mcp-Method")).toBe("tools/call");
		expect(callHeaders.get("Mcp-Name")).toBe("code");
		expect(callHeaders.get("Mcp-Session-Id")).toBeNull();

		const body = JSON.parse(String(callInit.body)) as {
			params: { _meta?: Record<string, unknown> };
		};
		expect(body.params._meta?.["io.modelcontextprotocol/protocolVersion"]).toBe(
			"2026-07-28",
		);
	});

	it("does not downgrade the first-party tedi binding after a negative probe result", async () => {
		const ctx = mcpCtx(
			{
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "code",
				_aggregateTediId: "cto_tedi_1",
				_aggregateTediOrgId: "org_1",
				_aggregateTediRemoteName: "run_tedi_turn",
			},
			{ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
			["2025-11-25", "2024-11-05"],
		);

		const result = await new ToolHandler().execute({}, ctx);
		expect(result).toMatchObject({ status: 200, data: { ok: true } });

		const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
			typeof vi.fn
		>;
		// The stale/legacy discovery fixture is never consulted for TEDI_SERVICE.
		expect(tediFetch).toHaveBeenCalledTimes(1);
		const methods = tediFetch.mock.calls.map(
			(c) => JSON.parse(String((c[1] as RequestInit).body)).method,
		);
		expect(methods).toEqual(["tools/call"]);

		const [, callInit] = tediFetch.mock.calls[0] as [string, RequestInit];
		const callHeaders = new Headers(callInit.headers);
		expect(callHeaders.get("Mcp-Session-Id")).toBeNull();
		expect(callHeaders.get("MCP-Protocol-Version")).toBe("2026-07-28");
	});

	// SEP-2243: the tool inputSchema binds arguments to Mcp-Param-* headers,
	// derived from the final params object (post paramMap rename).
	const PARAM_BOUND_SCHEMA = {
		type: "object",
		properties: {
			tenant: { type: "string", "x-mcp-header": "Tenant" },
			token: { type: "string", "x-mcp-header": "Auth-Token" },
			query: { type: "string" },
		},
	};

	it("derives Mcp-Param-* headers from schema bindings on a modern upstream", async () => {
		const ctx = {
			...mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "execute_sql",
				paramMap: { tenantId: "tenant", token: "token", query: "query" },
			}),
			toolInputSchema: PARAM_BOUND_SCHEMA,
		};

		const result = await new ToolHandler().execute(
			{ tenantId: "org_tedix", token: "päss", query: "select 1" },
			ctx,
		);
		expect(result).toMatchObject({ status: 200, data: { ok: true } });

		const tediFetch = (ctx.env.TEDI_SERVICE as Fetcher).fetch as ReturnType<
			typeof vi.fn
		>;
		expect(tediFetch).toHaveBeenCalledTimes(1);
		const [, callInit] = tediFetch.mock.calls[0] as [string, RequestInit];
		const callHeaders = new Headers(callInit.headers);
		// Derived from the final params object: paramMap renamed tenantId→tenant.
		expect(callHeaders.get("Mcp-Param-Tenant")).toBe("org_tedix");
		expect(callHeaders.get("Mcp-Param-Auth-Token")).toBe("=?base64?cMOkc3M=?=");
		expect(callHeaders.get("Mcp-Param-Query")).toBeNull();
		// The binding headers still ride alongside.
		expect(callHeaders.get("Mcp-Method")).toBe("tools/call");
		expect(callHeaders.get("Mcp-Name")).toBe("execute_sql");
		// The arguments themselves are unchanged — headers mirror, not move.
		const body = JSON.parse(String(callInit.body)) as {
			params: { arguments: Record<string, unknown> };
		};
		expect(body.params.arguments).toMatchObject({
			tenant: "org_tedix",
			token: "päss",
			query: "select 1",
		});
	});

	it("refreshes upstream tools and retries HeaderMismatch with current bindings", async () => {
		const ctx = {
			...mcpCtx({
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
				mcpToolName: "execute_sql",
			}),
			toolInputSchema: {
				type: "object",
				properties: {
					tenant: { type: "string", "x-mcp-header": "Tenant" },
					region: { type: "string" },
				},
			},
		};
		let toolCallCount = 0;
		const upstreamFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as {
				id: unknown;
				method: string;
			};
			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});
			}
			if (body.method === "tools/list") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "complete",
						ttlMs: 0,
						cacheScope: "private",
						tools: [
							{
								name: "execute_sql",
								inputSchema: {
									type: "object",
									properties: {
										region: {
											type: "string",
											"x-mcp-header": "Region",
										},
									},
								},
							},
						],
					},
				});
			}
			toolCallCount++;
			if (toolCallCount === 1) {
				return Response.json(
					{
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32020, message: "HeaderMismatch" },
					},
					{ status: 400 },
				);
			}
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					resultType: "complete",
					content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
				},
			});
		});
		(ctx.env.TEDI_SERVICE as Fetcher).fetch = upstreamFetch as Fetcher["fetch"];

		const result = await new ToolHandler().execute(
			{ tenant: "org_tedix", region: "eu-west1" },
			ctx,
		);

		expect(result).toMatchObject({ status: 200, data: { ok: true } });
		const methods = upstreamFetch.mock.calls.map(
			(call) => JSON.parse(String((call[1] as RequestInit).body)).method,
		);
		expect(methods).toEqual(["tools/call", "tools/list", "tools/call"]);
		const firstCall = upstreamFetch.mock.calls[0];
		const retryCall = upstreamFetch.mock.calls[2];
		if (!firstCall || !retryCall) {
			throw new Error("Expected the initial call and one HeaderMismatch retry");
		}
		const firstHeaders = new Headers((firstCall[1] as RequestInit).headers);
		const retryHeaders = new Headers((retryCall[1] as RequestInit).headers);
		expect(firstHeaders.get("Mcp-Param-Tenant")).toBe("org_tedix");
		expect(firstHeaders.get("Mcp-Param-Region")).toBeNull();
		expect(retryHeaders.get("Mcp-Param-Tenant")).toBeNull();
		expect(retryHeaders.get("Mcp-Param-Region")).toBe("eu-west1");
	});

	it("falls back to a November 2025 session without modern request headers", async () => {
		const ctx = {
			...mcpCtx(
				{
					transport: "mcp",
					mcpServerUrl: "https://legacy.example.com/mcp",
					mcpToolName: "execute_sql",
				},
				{ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
				["2025-11-25", "2024-11-05"],
			),
			toolInputSchema: PARAM_BOUND_SCHEMA,
		};
		const upstreamFetch = methodAwareFetch(
			{ content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
			["2025-11-25", "2024-11-05"],
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = upstreamFetch as unknown as typeof globalThis.fetch;

		try {
			const result = await new ToolHandler().execute(
				{ tenant: "org_tedix", token: "päss", query: "select 1" },
				ctx,
			);
			expect(result).toMatchObject({ status: 200, data: { ok: true } });
			expect(upstreamFetch).toHaveBeenCalledTimes(4);
			const methods = upstreamFetch.mock.calls.map(
				(call) => JSON.parse(String((call[1] as RequestInit).body)).method,
			);
			expect(methods).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);

			const initialize = upstreamFetch.mock.calls[1];
			const toolCall = upstreamFetch.mock.calls[3];
			if (!initialize || !toolCall) {
				throw new Error("Expected legacy initialize and tools/call requests");
			}
			const initializeBody = JSON.parse(
				String((initialize[1] as RequestInit).body),
			) as { params: { protocolVersion: string } };
			expect(initializeBody.params.protocolVersion).toBe("2025-11-25");
			const initializeHeaders = new Headers(
				(initialize[1] as RequestInit).headers,
			);
			expect(initializeHeaders.get("MCP-Protocol-Version")).toBeNull();
			const callHeaders = new Headers((toolCall[1] as RequestInit).headers);
			expect(callHeaders.get("MCP-Protocol-Version")).toBe("2025-11-25");
			expect(callHeaders.get("Mcp-Session-Id")).toBe("session_1");
			expect(callHeaders.get("Mcp-Method")).toBeNull();
			expect(callHeaders.get("Mcp-Name")).toBeNull();
			expect(
				[...callHeaders.keys()].filter((name) =>
					name.toLowerCase().startsWith("mcp-param-"),
				),
			).toEqual([]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("resolves an upstream input_required agent-in-the-loop and retries (cd8245c4)", async () => {
		let toolCalls = 0;
		const upstreamFetch = vi.fn(async (_url: unknown, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as {
				id: unknown;
				method: string;
			};
			if (body.method === "server/discover") {
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "complete",
						supportedVersions: ["2026-07-28"],
						capabilities: { tools: {} },
					},
				});
			}
			toolCalls++;
			if (toolCalls === 1) {
				// Upstream halts for a destructive confirmation.
				return Response.json({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						resultType: "input_required",
						inputRequests: {
							approval: {
								method: "elicitation/create",
								params: {
									message: "Confirm the update?",
									requestedSchema: {
										type: "object",
										properties: {
											reason: { type: "string", default: "auto-approved" },
										},
										required: ["reason"],
									},
								},
							},
						},
						requestState: "opaque-upstream-state-xyz",
					},
				});
			}
			// Retry (with echoed inputResponses) executes.
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					resultType: "complete",
					content: [{ type: "text", text: JSON.stringify({ updated: true }) }],
				},
			});
		});

		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "update_thing",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
			_aggregateTediRemoteName: "update_thing",
		});
		(ctx.env.TEDI_SERVICE as unknown as { fetch: typeof upstreamFetch }).fetch =
			upstreamFetch;

		const result = await new ToolHandler().execute({}, ctx);

		// The proxy resolved the upstream's input_required and the retry executed.
		expect(result).toMatchObject({ status: 200, data: { updated: true } });
		expect(toolCalls).toBe(2);

		// The retry echoed the resolved inputResponses + the upstream requestState.
		const toolCallBodies = upstreamFetch.mock.calls
			.map((c) => JSON.parse(String((c[1] as RequestInit).body)))
			.filter((b) => b.method === "tools/call");
		const retry = toolCallBodies[1];
		expect(retry.params.requestState).toBe("opaque-upstream-state-xyz");
		expect(retry.params.inputResponses).toEqual({
			approval: { action: "accept", content: { reason: "auto-approved" } },
		});
		// The first (halted) call declared the elicitation client capability.
		const first = toolCallBodies[0];
		expect(
			first.params._meta["io.modelcontextprotocol/clientCapabilities"],
		).toMatchObject({
			elicitation: { form: {} },
		});
	});
});

describe("caller trust on the tedi inject hop", () => {
	function injectCtx(
		callerIdentity: ToolExecutionContext["callerIdentity"],
		config: Record<string, unknown> = {},
	) {
		const ctx = mcpCtx({
			transport: "mcp",
			mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			mcpToolName: "run_tedi_turn",
			_aggregateTediId: "cto_tedi_1",
			_aggregateTediOrgId: "org_1",
			...config,
		});
		ctx.callerIdentity = callerIdentity;
		const injectFetch = vi.fn(async (url: unknown, init: RequestInit) => {
			expect(String(url)).toBe("https://cto.tedi.tedix.dev/hooks/inject");
			void init;
			return Response.json({ accepted: true }, { status: 202 });
		});
		ctx.env.TEDI_SERVICE = { fetch: injectFetch } as unknown as Fetcher;
		return { ctx, injectFetch };
	}
	const params = {
		text: "hello",
		learning_mode: "off",
		metadata: { source: "caller" },
	};
	function sentBody(fetch: ReturnType<typeof vi.fn>) {
		const [, init] = fetch.mock.calls[0] as [string, RequestInit];
		return {
			headers: new Headers(init.headers),
			body: JSON.parse(String(init.body)) as Record<string, unknown>,
		};
	}

	it("stamps member and keeps learning_mode/metadata for a same-org human", async () => {
		const { ctx, injectFetch } = injectCtx({
			authType: "oauth",
			userId: "user_1",
			organizationId: "org_1",
		});
		const result = await new ToolHandler().execute({ ...params }, ctx);
		expect(result.status).toBe(200);
		const { headers, body } = sentBody(injectFetch);
		expect(headers.get("x-tedix-caller-trust")).toBe("member");
		expect(body.learning_mode).toBe("off");
		expect(body.metadata).toEqual({ source: "caller" });
	});

	it("stamps tedi and strips learning_mode/metadata for a same-org tedi JWT", async () => {
		const { ctx, injectFetch } = injectCtx({
			authType: "tedi",
			tediId: "other_tedi",
			organizationId: "org_1",
		});
		const result = await new ToolHandler().execute({ ...params }, ctx);
		expect(result.status).toBe(200);
		const { headers, body } = sentBody(injectFetch);
		expect(headers.get("x-tedix-caller-trust")).toBe("tedi");
		expect(body.text).toBe("hello");
		expect(body).not.toHaveProperty("learning_mode");
		expect(body).not.toHaveProperty("metadata");
	});

	it("refuses a cross-org caller with 403 before reaching the runtime", async () => {
		const { ctx, injectFetch } = injectCtx({
			authType: "oauth",
			userId: "user_1",
			organizationId: "org_2",
		});
		const result = await new ToolHandler().execute({ ...params }, ctx);
		expect(result.status).toBe(403);
		expect(result.data).toMatchObject({
			error: expect.stringContaining("another organization"),
		});
		expect(injectFetch).not.toHaveBeenCalled();
	});

	it("refuses a same-org-less caller when the target organization is known", async () => {
		const { ctx, injectFetch } = injectCtx({ authType: "oauth", userId: "u" });
		const result = await new ToolHandler().execute({ ...params }, ctx);
		expect(result.status).toBe(403);
		expect(injectFetch).not.toHaveBeenCalled();
	});

	it("lets a platform operator cross organizations as member", async () => {
		const { ctx, injectFetch } = injectCtx({
			authType: "oauth",
			userId: "admin_1",
			organizationId: "org_platform",
			scopes: ["platform:admin"],
		});
		const result = await new ToolHandler().execute({ ...params }, ctx);
		expect(result.status).toBe(200);
		expect(sentBody(injectFetch).headers.get("x-tedix-caller-trust")).toBe(
			"member",
		);
	});

	it("stamps foreign and strips steering fields when the target org is unknown", async () => {
		const { ctx, injectFetch } = injectCtx(
			{ authType: "oauth", userId: "user_1", organizationId: "org_1" },
			{ _aggregateTediOrgId: undefined },
		);
		const result = await new ToolHandler().execute({ ...params }, ctx);
		expect(result.status).toBe(200);
		const { headers, body } = sentBody(injectFetch);
		expect(headers.get("x-tedix-caller-trust")).toBe("foreign");
		expect(body).not.toHaveProperty("learning_mode");
	});
});
