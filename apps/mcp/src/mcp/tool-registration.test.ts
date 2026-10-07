import { describe, expect, it } from "vite-plus/test";
import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import { clientSupportsTasks } from "@tedix/mcp-shared/tasks";
import { evaluateMcpToolScopeAuthorization } from "./codemode-auth";
import { enforceMcpAccess } from "../index";
import { buildHomeSurfaceTools } from "./home-surface";
import type { AppTool, ServerContext } from "./server-context";
import {
	enforceNativeToolScopeGate,
	resolveToolRequestMeta,
	resolveWireAnnotations,
} from "./tool-registration";

const HOME_TOOLS = buildHomeSurfaceTools();
const byId = new Map(HOME_TOOLS.map((tool) => [tool.toolId, tool]));

describe("delegated direct HTTP tools/call", () => {
	it("rejects an innocuous D1 alias backed by workItems/complete", async () => {
		const request = new Request("https://tedix-unified.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-tedix-auth-type": "tedi",
				"x-tedix-auth-credential-mode": "delegated-mcp",
				"x-tedix-auth-scopes": "mcp:apps.write",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "finish_task", arguments: {} },
			}),
		});
		const decision = await enforceMcpAccess({
			request,
			hostname: "tedix-unified.mcp.tedix.dev",
			resolvedApp: {
				app: { slug: "tedix-unified", organizationId: "org-1" },
				metadata: {
					mcpConfig: {
						authMode: "authenticated",
						toolScopes: { finish_task: ["mcp:apps.write"] },
					},
				},
				tools: [
					plainTool({
						toolId: "finish_task",
						config: { endpoint: "workItems/complete" },
					}),
				],
			} as unknown as Parameters<typeof enforceMcpAccess>[0]["resolvedApp"],
			env: {} as CloudflareEnv,
			oauthJwtPayload: null,
			isDev: false,
		});
		expect(decision?.response.status).toBe(403);
		expect(await decision?.response.json()).toMatchObject({
			error: "delegated_work_tool_denied",
		});
	});
});

describe("verified Connect tenant authority", () => {
	const selection = {
		organizations: [
			{
				organizationId: "selected-org",
				descopeTenantId: "org_selected",
				gatewaySlug: "selected",
			},
		],
	};
	async function check(
		options: {
			slug?: string;
			hostname?: string;
			enabled?: boolean;
			selection?: typeof selection | null;
		} = {},
	) {
		return enforceMcpAccess({
			request: new Request("https://connect.mcp.tedix.dev/mcp", {
				headers: { "x-tedix-auth-type": "oauth" },
			}),
			hostname: options.hostname ?? "connect.mcp.tedix.dev",
			resolvedApp: {
				app: { slug: options.slug ?? "connect", organizationId: "app-owner" },
				metadata: {
					mcpConfig: {
						authMode: "authenticated",
						multiOrgConsent: options.enabled ?? true,
					},
				},
				tools: [],
			} as unknown as Parameters<typeof enforceMcpAccess>[0]["resolvedApp"],
			env: {} as CloudflareEnv,
			oauthJwtPayload: { dct: "org_unrelated_active" },
			multiOrgSelection: options.selection,
			isDev: false,
		});
	}
	it("uses a live verified selection despite an unrelated active browser tenant", async () => {
		expect(await check({ selection })).toBeNull();
	});
	it.each([
		{ selection: null },
		{ selection: { organizations: [] } },
		{ selection, slug: "ordinary-app" },
		{ selection, enabled: false },
		{ selection, hostname: "other.mcp.tedix.dev" },
	])(
		"retains tenant enforcement without canonical Connect selection: %j",
		async (options) => {
			expect((await check(options))?.response.status).toBe(403);
		},
	);
});

/**
 * Minimal server context: appMetadata is null (no mcpConfig) so the home
 * namespace fallback resolves targeted lifecycle writes to `mcp:messaging` —
 * the same seam the Code Mode path uses.
 */
function ctx(
	caller: { authType: string; scopes?: string[] } | undefined,
): Pick<ServerContext, "appMetadata" | "callerIdentity"> {
	return {
		appMetadata: null,
		callerIdentity: caller as ServerContext["callerIdentity"],
	};
}

/** A plain (non-home) tool, used to prove the gate is scoped to home__* only. */
function plainTool(overrides: Partial<AppTool>): AppTool {
	return {
		id: "tool-row-id",
		toolId: "search_listings",
		title: "Search listings",
		description: null,
		toolTypeId: "rpc",
		inputSchema: { type: "object", properties: {} },
		outputSchema: null,
		config: null,
		icons: null,
		executionTaskSupport: null,
		annotations: null,
		meta: null,
		invocationStatus: null,
		fileParams: null,
		adapterScope: null,
		resultStrategy: null,
		outputTemplate: null,
		widgetKey: null,
		widgetRoute: null,
		widgetAccessible: null,
		visibility: null,
		widgetDescription: null,
		widgetPrefersBorder: null,
		widgetDomain: null,
		schemaDialect: null,
		schemaSource: null,
		schemaSourceRef: null,
		schemaSourceHash: null,
		schemaSyncedAt: null,
		sortOrder: null,
		enabled: true,
		createdAt: null,
		updatedAt: null,
		...overrides,
	};
}

function structured(result: CallToolResultLike): Record<string, unknown> {
	return (result?.structuredContent ?? {}) as Record<string, unknown>;
}

type CallToolResultLike = ReturnType<typeof enforceNativeToolScopeGate>;

const SINGLE_WRITES = [
	"home__create_work_item",
	"home__update_work_item",
	"home__accept_work_item",
	"home__complete_work_item",
	"home__cancel_work_item",
] as const;
const WORK_SCOPE_BY_TOOL: Record<(typeof SINGLE_WRITES)[number], string> = {
	home__create_work_item: "mcp:work.write",
	home__update_work_item: "mcp:work.write",
	home__accept_work_item: "mcp:work.admin",
	home__complete_work_item: "mcp:work.write",
	home__cancel_work_item: "mcp:work.admin",
};

describe("resolveToolRequestMeta", () => {
	it("preserves request capabilities when a deferred callback omits mcpReq metadata", () => {
		const requestMeta = {
			[MCP_CLIENT_CAPABILITIES_META_KEY]: {
				extensions: { [MCP_TASKS_EXTENSION]: {} },
			},
		};
		const resolved = resolveToolRequestMeta(undefined, requestMeta);
		expect(resolved).toEqual(requestMeta);
		expect(clientSupportsTasks(resolved)).toBe(true);
	});

	it("lets callback-local metadata override the original request value", () => {
		expect(
			resolveToolRequestMeta(
				{ requestState: "callback" },
				{ requestState: "original", traceparent: "trace" },
			),
		).toEqual({ requestState: "callback", traceparent: "trace" });
	});
});

describe("native tools/call scope gate (home__* + aggregate) — enforceNativeToolScopeGate", () => {
	it("(a) denies callers missing the exact Work capability", () => {
		for (const id of SINGLE_WRITES) {
			const tool = byId.get(id)!;
			const scope = WORK_SCOPE_BY_TOOL[id];

			// Unauthenticated → fail-closed.
			const anon = enforceNativeToolScopeGate(ctx(undefined), tool);
			expect(anon?.isError, id).toBe(true);
			expect(structured(anon).error, id).toBe("insufficient_scope");
			expect(structured(anon).required_scopes, id).toEqual([scope]);

			// Authenticated but only an unrelated read scope → still denied.
			const unrelated = enforceNativeToolScopeGate(
				ctx({ authType: "oauth", scopes: ["mcp:observe"] }),
				tool,
			);
			expect(unrelated?.isError, id).toBe(true);
			expect(structured(unrelated).error, id).toBe("insufficient_scope");
			expect(structured(unrelated).missing_scopes, id).toEqual([scope]);
		}
	});

	it("(b) allows callers with the exact Work capability", () => {
		for (const id of SINGLE_WRITES) {
			const tool = byId.get(id)!;
			expect(
				enforceNativeToolScopeGate(
					ctx({ authType: "oauth", scopes: [WORK_SCOPE_BY_TOOL[id]] }),
					tool,
				),
				id,
			).toBeNull();
		}
	});

	it("(c) a trusted service-binding caller (edge→api) bypasses the scope gate for every home tool", () => {
		for (const tool of HOME_TOOLS) {
			expect(
				enforceNativeToolScopeGate(ctx({ authType: "service" }), tool),
				tool.toolId,
			).toBeNull();
		}
	});

	it("requires messaging write for Home turns and delegation retries", () => {
		for (const id of ["ask", "home__retry_delegation"]) {
			const tool = byId.get(id)!;
			const requiredScope = "mcp:messaging.write";
			// Both operations create or change durable Home state.
			expect(
				enforceNativeToolScopeGate(
					ctx({ authType: "oauth", scopes: [requiredScope] }),
					tool,
				),
				id,
			).toBeNull();
			expect(
				enforceNativeToolScopeGate(
					ctx({ authType: "oauth", scopes: ["mcp:messaging.read"] }),
					tool,
				)?.isError,
				id,
			).toBe(true);
			// But the gate is genuinely active: a scopeless caller is denied.
			const denied = enforceNativeToolScopeGate(
				ctx({ authType: "oauth", scopes: [] }),
				tool,
			);
			expect(denied?.isError, id).toBe(true);
			expect(structured(denied).required_scopes, id).toEqual([requiredScope]);
		}
	});

	it("does not gate non-home tools — request-level enforcement still owns those (no hybrid/public regression)", () => {
		// A normal D1 tool with no meta.source: even a scopeless, unauthenticated
		// caller proceeds here (it is enforced at the request level, not on the
		// native dispatch). Applying the fallback resolver here would over-gate
		// hybrid/public tools.
		expect(
			enforceNativeToolScopeGate(
				ctx(undefined),
				plainTool({ toolId: "search_listings", meta: null }),
			),
		).toBeNull();

		// An aggregate-shaped tool that carries no `_aggregateNamespace` in config
		// is still left alone: the marker, not `meta.source`, is what identifies a
		// tool the request-level gate could not see.
		expect(
			enforceNativeToolScopeGate(
				ctx({ authType: "oauth", scopes: [] }),
				plainTool({
					toolId: "cto__run_tedi_turn",
					meta: { source: "aggregateTedis", tediSlug: "cto" },
					config: null,
				}),
			),
		).toBeNull();
	});

	it("(d) gates aggregate-namespace tools, which gate 1 cannot resolve", () => {
		// Regression: aggregate tools are appended to `cachedData.tools` after
		// `enforceMcpAccess` has resolved scopes, and its unknown-name fallback is
		// an exact `toolScopes[toolName]` lookup that a prefixed name like
		// `cto__delete_app` never matches — so `requiredScopes` came back
		// undefined and the whole scope block was skipped. Gate 2 then returned
		// null for anything that was not `meta.source === "homeSurface"`, leaving
		// these tools with no scope gate on native dispatch.
		const aggregateTool = plainTool({
			toolId: "cto__delete_app",
			meta: { source: "aggregateTedis", tediSlug: "cto" },
			config: { _aggregateNamespace: "app_config", endpoint: "appConfig/x" },
		});

		// Unauthenticated → fail-closed.
		const anon = enforceNativeToolScopeGate(ctx(undefined), aggregateTool);
		expect(anon?.isError).toBe(true);
		expect(structured(anon).error).toBe("insufficient_scope");

		// Authenticated with an unrelated scope → still denied. The required
		// capability is resolved from the aggregate namespace (`app_config` →
		// `mcp:settings.admin`), exactly as Code Mode resolves it.
		const unrelated = enforceNativeToolScopeGate(
			ctx({ authType: "oauth", scopes: ["mcp:observe.read"] }),
			aggregateTool,
		);
		expect(unrelated?.isError).toBe(true);
		expect(structured(unrelated).error).toBe("insufficient_scope");

		// The denial is machine-readable for SEP-2350 scope-union step-up.
		expect(
			(unrelated?._meta as Record<string, unknown> | undefined)?.[
				"mcp/www_authenticate"
			],
		).toBeDefined();

		// Holding the capability proceeds.
		expect(
			enforceNativeToolScopeGate(
				ctx({ authType: "oauth", scopes: ["mcp:settings.admin"] }),
				aggregateTool,
			),
		).toBeNull();

		// A trusted service caller bypasses, as everywhere else.
		expect(
			enforceNativeToolScopeGate(ctx({ authType: "service" }), aggregateTool),
		).toBeNull();
	});

	it("(e) fails closed — not 500 — when an aggregate tool has no capability mapping", () => {
		// `resolveMcpToolRequiredScopes` throws for an unmapped tool. Surface it as
		// a `scope_mapping_missing` denial rather than letting it escape as a 500,
		// mirroring the Code Mode path, which already denies these same tools.
		const result = enforceNativeToolScopeGate(
			ctx({ authType: "oauth", scopes: ["mcp:apps.admin"] }),
			plainTool({
				toolId: "cto__ping",
				config: { _aggregateNamespace: "cto" },
				writeCapability: null,
				annotations: null,
			}),
		);
		expect(result?.isError).toBe(true);
		expect(structured(result).error).toBe("scope_mapping_missing");
	});
});

describe("shared scope evaluator — evaluateMcpToolScopeAuthorization", () => {
	it("mirrors the Code Mode decision for the Work Item write tools", () => {
		const expected = Object.fromEntries(
			Object.entries(WORK_SCOPE_BY_TOOL).map(([id, scope]) => [id, { scope }]),
		);
		for (const [id, { scope }] of Object.entries(expected)) {
			const tool = byId.get(id)!;
			// Missing → not authorized, surfaces the concrete required + missing scope.
			const denied = evaluateMcpToolScopeAuthorization(
				ctx({ authType: "oauth", scopes: [] }),
				tool,
				"home",
			);
			expect(denied.authorized, id).toBe(false);
			if (!denied.authorized) {
				expect(denied.requiredScopes, id).toEqual([scope]);
				expect(denied.missingScopes, id).toEqual([scope]);
			}
			// Only the exact resource scope authorizes.
			expect(
				evaluateMcpToolScopeAuthorization(
					ctx({ authType: "oauth", scopes: [scope] }),
					tool,
					"home",
				).authorized,
				id,
			).toBe(true);
			expect(
				evaluateMcpToolScopeAuthorization(
					ctx({ authType: "oauth", scopes: ["platform:admin"] }),
					tool,
					"home",
				).authorized,
				id,
			).toBe(false);
		}
	});
});

/**
 * The declared write capability lives in a D1 column, but every gate that
 * classifies a tool reads MCP `annotations` off the wire. This projection is the
 * only thing that connects them.
 */
describe("resolveWireAnnotations", () => {
	it("emits NO annotations for an undeclared, unannotated tool", () => {
		// Must not synthesize hints: absent has to stay distinguishable from false
		// downstream, or the fail-closed gate has nothing to fail closed on.
		expect(
			resolveWireAnnotations(
				plainTool({ annotations: null, writeCapability: null }),
			),
		).toBeUndefined();
	});

	it("projects a declaration for a tool whose upstream sends no annotations", () => {
		expect(
			resolveWireAnnotations(
				plainTool({
					toolId: "createJiraIssue",
					annotations: null,
					writeCapability: "write",
				}),
			),
		).toEqual({ readOnlyHint: false, destructiveHint: false });
		expect(
			resolveWireAnnotations(
				plainTool({
					toolId: "cms_provision_service_key",
					annotations: null,
					writeCapability: "destructive",
				}),
			),
		).toEqual({ readOnlyHint: false, destructiveHint: true });
	});

	it("keeps the provider's own hints authoritative", () => {
		expect(
			resolveWireAnnotations(
				plainTool({
					annotations: { readOnlyHint: true },
					writeCapability: "write",
				}),
			),
		).toEqual({ readOnlyHint: true, destructiveHint: false });
	});
});

describe("configured catalog retains existing scope lanes", () => {
	it("keeps plain rows edge-owned and aggregate rows native-gated", () => {
		const row = plainTool({
			toolId: "find_tools",
			config: { transport: "catalog", endpoint: "catalog/search" },
			annotations: { readOnlyHint: true },
		});
		const context = {
			appMetadata: {
				mcpConfig: { toolScopes: { find_tools: ["mcp:catalog.read"] } },
			},
			callerIdentity: { authType: "oauth", scopes: ["mcp:work.read"] },
		} as unknown as ServerContext;
		expect(enforceNativeToolScopeGate(context, row)).toBeNull();
		const aggregate = {
			...row,
			config: { ...row.config, _aggregateNamespace: "fictional" },
		};
		expect(enforceNativeToolScopeGate(context, aggregate)?.isError).toBe(true);
		Object.assign(context, {
			callerIdentity: { authType: "oauth", scopes: ["mcp:catalog.read"] },
		});
		expect(enforceNativeToolScopeGate(context, aggregate)).toBeNull();
	});
});

it("never lends catalog-read authority to reviewed writes, platform aliases or unknown RPC operations", () => {
	for (const endpoint of [
		"organizations/cancel",
		"workspaceApps/create",
		"providerEvents/list",
		"tedis/inspectRuntimeOutbox",
		"unreviewed/unknown",
	]) {
		const context = {
			appMetadata: {
				mcpConfig: { authMode: "authenticated", enforcePolicies: false },
			},
			callerIdentity: { authType: "oauth", scopes: ["mcp:catalog.read"] },
		} as unknown as ServerContext;
		const row = plainTool({
			toolId: "customer__inspect_endpoint",
			config: { transport: "rpc", endpoint, _aggregateNamespace: "customer" },
			annotations: { readOnlyHint: true },
		});
		expect(enforceNativeToolScopeGate(context, row)?.isError, endpoint).toBe(
			true,
		);
	}
});

it("nativeDirect cannot bypass the owning delegated Work or missing-scope decision", () => {
	const row = plainTool({
		toolId: "read_work",
		toolTypeId: "rpc",
		config: {
			transport: "rpc",
			endpoint: "workItems/list",
			nativeDirect: true,
			_aggregateNamespace: "work",
		},
	});
	const ctx = {
		callerIdentity: { authType: "oauth", scopes: ["mcp:catalog.read"] },
		appMetadata: {
			mcpConfig: { toolScopes: { read_work: ["mcp:work.read"] } },
		},
	} as unknown as ServerContext;
	expect(evaluateMcpToolScopeAuthorization(ctx, row, "work")).toMatchObject({
		authorized: false,
		missingScopes: ["mcp:work.read"],
	});
	const delegated = {
		...ctx,
		callerIdentity: {
			authType: "tedi" as const,
			credentialMode: "delegated-mcp",
			scopes: ["mcp:work.write", "mcp:work.read"],
		},
	};
	expect(
		evaluateMcpToolScopeAuthorization(delegated, row, "work"),
	).toMatchObject({
		authorized: false,
	});
});
