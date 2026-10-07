import { call, os } from "@orpc/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import * as z from "zod";
import { enteredSpans } from "../../test/stubs/cloudflare-workers";
import type { BaseContext } from "./orpc";
import {
	AUTHZ,
	hasOsReadAuthorization,
	authorizeOsShareRecipient,
	CLIENT_ERROR_CODES,
	createError,
	ErrorCodes,
	hasConnectionCredentialResolutionAuthority,
	withConnectionCredentialResolutionAuthority,
	hasRequiredScope,
	isAuthInfrastructureError,
	isExternalAgentSessionExchangeCall,
	isExternalAgentWorkloadExchangeCall,
	logProcedureCall,
	resolveMcpServiceBindingAuthorization,
	resolveForwardedMcpUserTenantContext,
	skipOutputValidation,
	withAuth,
	withAuthorization,
	withExactApiKeyScope,
	withPermission,
} from "./orpc";

describe("optional Home document authorization", () => {
	it.each(["os:read", "settings:manage"])(
		"accepts the same human permission as OS reads: %s",
		(permission) => {
			expect(
				hasOsReadAuthorization({
					authType: "user",
					user: { sub: "operator", permissions: [permission], roles: [] },
				} as BaseContext),
			).toBe(true);
		},
	);
	it("does not trust another tenant's token permissions", () => {
		expect(
			hasOsReadAuthorization({
				authType: "user",
				crossTenantOverrideActive: true,
				user: { sub: "operator", permissions: ["os:read"], roles: [] },
			} as BaseContext),
		).toBe(false);
	});
	it.each(["apikey", "tedi", "service-binding", "m2m"])(
		"requires apps:read for a %s principal",
		(authType) => {
			const context = {
				authType,
				apiKey: { scopes: ["tedis:write"] },
				tediScopes: ["tedis:write"],
				serviceAccount: { scope: "tedis:write" },
			} as BaseContext;
			expect(hasOsReadAuthorization(context)).toBe(false);
			expect(
				hasOsReadAuthorization({
					...context,
					apiKey: { scopes: ["apps:read"] },
					tediScopes: ["apps:read"],
					serviceAccount: { scope: "apps:read" },
				} as BaseContext),
			).toBe(true);
		},
	);
});

const shareAuthMocks = vi.hoisted(() => ({
	getWorkspaceResource: vi.fn(),
	resolveAvailability: vi.fn(),
	resolveUserTenantIdentityContext: vi.fn(),
}));

vi.mock("@tedix/db/queries/principal-identities", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@tedix/db/queries/principal-identities")
		>();
	return {
		...actual,
		resolveUserTenantIdentityContext:
			shareAuthMocks.resolveUserTenantIdentityContext,
	};
});

vi.mock("@tedix/db/queries/os-workspaces/resources", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@tedix/db/queries/os-workspaces/resources")
		>();
	return {
		...actual,
		getOsWorkspaceResource: shareAuthMocks.getWorkspaceResource,
	};
});

vi.mock(
	"../services/os-workspace-resource-availability",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../services/os-workspace-resource-availability")
			>();
		return {
			...actual,
			resolveWorkspaceResourceAvailability: shareAuthMocks.resolveAvailability,
		};
	},
);

describe("OS share recipient authorization", () => {
	const source = {
		workspaceResourceId: "00000000-0000-4000-8000-000000000001",
		workspaceId: "00000000-0000-4000-8000-000000000002",
		providerId: "github",
		resourceType: "repository",
		providerResourceId: "tedix-hq/tedix",
		connectionScope: "tenant" as const,
		requiredScopes: ["repo:read"],
		operations: ["read"],
	};
	const envelope = { version: 1 as const, sources: [source] };
	const resource = {
		id: source.workspaceResourceId,
		organizationId: "org-1",
		workspaceId: source.workspaceId,
		slot: "repository",
		providerId: source.providerId,
		connectionScope: source.connectionScope,
		requiredScopes: JSON.stringify(source.requiredScopes),
		resourceType: source.resourceType,
		providerResourceId: source.providerResourceId,
		name: "Tedix",
		metadata: "{}",
		status: "active" as const,
		createdByKind: "user" as const,
		createdById: "user-1",
		createdAt: "2026-09-22T10:00:00.000Z",
		updatedAt: "2026-09-22T10:00:00.000Z",
		removedAt: null,
	};

	function env() {
		const session = {
			batch: vi.fn(),
			getBookmark: () => null,
			prepare: vi.fn(),
		};
		return {
			DB: { withSession: () => session } as unknown as D1Database,
			ENVIRONMENT: "development",
			DESCOPE_PROJECT_ID: "local-development-disabled",
			TEDIX_LOCAL_DEMO_ENABLED: "true",
		} as CloudflareEnv;
	}

	function request(authenticated = true) {
		return new Request("http://localhost/os-shared/token", {
			headers: authenticated
				? { Authorization: "Bearer tedix-local-demo" }
				: undefined,
		});
	}

	beforeEach(() => {
		shareAuthMocks.getWorkspaceResource.mockReset();
		shareAuthMocks.resolveAvailability.mockReset();
		shareAuthMocks.resolveUserTenantIdentityContext.mockReset();
		shareAuthMocks.getWorkspaceResource.mockResolvedValue(resource);
		shareAuthMocks.resolveAvailability.mockResolvedValue({
			status: "available",
			reason: null,
			checkedAt: "2026-09-22T10:00:00.000Z",
		});
		shareAuthMocks.resolveUserTenantIdentityContext.mockResolvedValue({
			organizationId: "org-1",
			canonicalUserId: "user-1",
			memberRole: "owner",
			memberPermissionOverrides: [],
		});
	});

	it("denies anonymous and wrong-organization recipients but permits an authorized same-org recipient", async () => {
		await expect(
			authorizeOsShareRecipient(request(false), env(), {
				organizationId: "org-1",
				role: "viewer",
				accessEnvelope: envelope,
			}),
		).resolves.toBe(false);

		shareAuthMocks.resolveUserTenantIdentityContext.mockResolvedValueOnce({
			organizationId: "org-2",
			canonicalUserId: "user-1",
			memberRole: "owner",
			memberPermissionOverrides: [],
		});
		await expect(
			authorizeOsShareRecipient(request(), env(), {
				organizationId: "org-1",
				role: "viewer",
				accessEnvelope: envelope,
			}),
		).resolves.toBe(false);

		await expect(
			authorizeOsShareRecipient(request(), env(), {
				organizationId: "org-1",
				role: "viewer",
				accessEnvelope: envelope,
			}),
		).resolves.toBe(true);
	});

	it("permits envelope-free Gadget and workspace recipients only after the existing JWT and tenant checks", async () => {
		await expect(
			authorizeOsShareRecipient(request(), env(), {
				organizationId: "org-1",
				role: "use",
			}),
		).resolves.toBe(true);
		await expect(
			authorizeOsShareRecipient(request(false), env(), {
				organizationId: "org-1",
				role: "use",
			}),
		).resolves.toBe(false);

		shareAuthMocks.resolveUserTenantIdentityContext.mockResolvedValueOnce({
			organizationId: "org-2",
			canonicalUserId: "user-1",
			memberRole: "owner",
			memberPermissionOverrides: [],
		});
		await expect(
			authorizeOsShareRecipient(request(), env(), {
				organizationId: "org-1",
				role: "viewer",
			}),
		).resolves.toBe(false);
		expect(shareAuthMocks.getWorkspaceResource).not.toHaveBeenCalled();
	});

	it.each([
		["missing", undefined],
		["removed", { ...resource, status: "removed" as const }],
		["provider mismatch", { ...resource, providerResourceId: "other/repo" }],
		["narrowed scopes", { ...resource, requiredScopes: "[]" }],
	])("fails closed for a %s live source", async (_label, liveResource) => {
		shareAuthMocks.getWorkspaceResource.mockResolvedValue(liveResource);
		await expect(
			authorizeOsShareRecipient(request(), env(), {
				organizationId: "org-1",
				role: "viewer",
				accessEnvelope: envelope,
			}),
		).resolves.toBe(false);
		expect(shareAuthMocks.resolveAvailability).not.toHaveBeenCalled();
	});

	it("fails closed when provider availability cannot be verified", async () => {
		shareAuthMocks.resolveAvailability.mockResolvedValue({
			status: "check_failed",
			reason: "Provider unavailable",
			checkedAt: "2026-09-22T10:00:00.000Z",
		});
		await expect(
			authorizeOsShareRecipient(request(), env(), {
				organizationId: "org-1",
				role: "viewer",
				accessEnvelope: envelope,
			}),
		).resolves.toBe(false);
	});
});

describe("user authentication infrastructure failures", () => {
	it("stops credential fallback for a retryable organization lookup failure", () => {
		expect(
			isAuthInfrastructureError(
				createError(
					ErrorCodes.SERVICE_UNAVAILABLE,
					"Organization identity is temporarily unavailable",
				),
			),
		).toBe(true);
		expect(
			isAuthInfrastructureError(
				createError(ErrorCodes.FORBIDDEN, "Organization scope is required"),
			),
		).toBe(false);
	});
});

describe("forwarded MCP authentication failures", () => {
	afterEach(() => vi.restoreAllMocks());
	const handler = vi.fn(async () => "ok");
	const guarded = os.$context<BaseContext>().use(withAuth).handler(handler);
	function context(payload: Record<string, unknown>, failure: Error) {
		const token = `e30.${btoa(JSON.stringify(payload))}.signature`;
		return {
			url: new URL("https://api/rpc/osWorkspaces/outputs/get"),
			env: { ENVIRONMENT: "production", DESCOPE_PROJECT_ID: "real-project" },
			headers: new Headers({
				"X-Service-Binding": "true",
				"X-Tedix-Caller-Type": "mcp-edge-user",
				"X-Forwarded-Authorization": `Bearer ${token}`,
				"X-Tedix-Org-Id": "org_tedix",
			}),
			db: {
				select: () => {
					throw failure;
				},
			},
		} as unknown as BaseContext;
	}

	function localContext() {
		const ctx = context(
			{},
			createError(ErrorCodes.FORBIDDEN, "Identity lookup denied"),
		);
		Object.assign(ctx.env, {
			ENVIRONMENT: "development",
			DESCOPE_PROJECT_ID: "local-development-disabled",
			TEDIX_LOCAL_DEMO_ENABLED: "true",
		});
		ctx.headers.set("X-Forwarded-Authorization", "Bearer tedix-local-demo");
		ctx.headers.set("X-Tedix-Mcp-Caller-Scopes", "mcp:apps.read");
		return ctx;
	}

	it("resolves the internal local credential as a user without skipping identity authorization", async () => {
		const ctx = localContext();
		await expect(
			call(guarded, undefined, { context: ctx }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Identity lookup denied",
		});
		expect(ctx.user?.sub).toBe("local-demo-owner");
		expect(ctx.authType).toBe("user");
		expect(ctx.user?.scopes).toContain("mcp:apps.read");
		expect(handler).not.toHaveBeenCalled();
	});

	it.each([
		{ ENVIRONMENT: "production" },
		{ DESCOPE_PROJECT_ID: "real-project" },
		{ TEDIX_LOCAL_DEMO_ENABLED: "false" },
	])(
		"rejects the demo credential outside explicit local mode: %j",
		async (env) => {
			const ctx = localContext();
			Object.assign(ctx.env, env);
			await expect(
				call(guarded, undefined, { context: ctx }),
			).rejects.toMatchObject({
				code: "UNAUTHORIZED",
				message: "Forwarded MCP user token is not decodable",
			});
			expect(handler).not.toHaveBeenCalled();
		},
	);

	it("rejects other opaque credentials even in local mode", async () => {
		const ctx = localContext();
		ctx.headers.set("X-Forwarded-Authorization", "Bearer wrong-demo-token");
		await expect(
			call(guarded, undefined, { context: ctx }),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Forwarded MCP user token is not decodable",
		});
	});

	it("reports dependency failures as unavailable without exposing SQL or admitting the request", async () => {
		const failure = new Error(
			"Failed query: select secret from organizations; params: private",
		);
		const ctx = context(
			{
				sub: "user-1",
				iss: "https://api.descope.com/project",
				exp: 4_000_000_000,
			},
			failure,
		);
		ctx.url = new URL("https://api/rpc/skills/mineCandidates");
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			call(guarded, undefined, { context: ctx }),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: "Forwarded MCP identity resolution is temporarily unavailable",
			cause: failure,
		});
		expect(handler).not.toHaveBeenCalled();
		expect(
			info.mock.calls.map(([event]) => [event.phase, event.status]),
		).toEqual([
			["auth.forwarded", "started"],
			["auth.user", "started"],
		]);
		expect(
			errorLog.mock.calls.map(([event]) => [event.phase, event.status]),
		).toEqual([
			["auth.user", "failed"],
			["auth.forwarded", "failed"],
		]);
		expect(
			JSON.stringify([...info.mock.calls, ...errorLog.mock.calls]),
		).not.toContain("private");
	});

	it("preserves an expired token rejection before querying the database", async () => {
		await expect(
			call(guarded, undefined, {
				context: context(
					{ sub: "user-1", exp: 1 },
					new Error("must not query"),
				),
			}),
		).rejects.toMatchObject({
			code: "UNAUTHORIZED",
			message: "Forwarded MCP user token is expired",
		});
		expect(handler).not.toHaveBeenCalled();
	});

	it("preserves explicit authorization errors from identity resolution", async () => {
		await expect(
			call(guarded, undefined, {
				context: context(
					{
						sub: "user-1",
						iss: "https://api.descope.com/project",
						exp: 4_000_000_000,
					},
					createError(ErrorCodes.FORBIDDEN, "Access denied"),
				),
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN", message: "Access denied" });
		expect(handler).not.toHaveBeenCalled();
	});
});

describe("MCP service-binding authorization delegation", () => {
	it("requires both a bounded tool id and a verified forwarded machine principal", () => {
		const headers = new Headers({ "X-Tedix-Mcp-Tool-Id": "work_items:list" });
		expect(resolveMcpServiceBindingAuthorization(headers, {})).toBeUndefined();
		expect(
			resolveMcpServiceBindingAuthorization(headers, {
				tediId: "tedi-1",
				tediScopes: ["mcp:messaging"],
			}),
		).toEqual({ source: "mcp-tool", toolId: "work_items:list" });
		expect(
			resolveMcpServiceBindingAuthorization(headers, {
				externalAgentPrincipalId: "principal-1",
			}),
		).toEqual({ source: "mcp-tool", toolId: "work_items:list" });
		expect(
			resolveMcpServiceBindingAuthorization(
				new Headers({ "X-Tedix-Mcp-Tool-Id": "../admin" }),
				{ externalAgentPrincipalId: "principal-1" },
			),
		).toBeUndefined();
	});

	it("accepts a bounded tool identity for a skill-runtime tedi without a forwarded scope list", () => {
		expect(
			resolveMcpServiceBindingAuthorization(
				new Headers({ "X-Tedix-Mcp-Tool-Id": "create_os_output" }),
				{ tediId: "tedi-1", tediScopes: [] },
			),
		).toEqual({ source: "mcp-tool", toolId: "create_os_output" });
	});
});

describe("connection credential resolution authority", () => {
	const headers = new Headers({
		"X-Tedix-Mcp-Tool-Id": "acme_official_tedix.search_products",
	});

	it.each(["connections.read", "connections.execute"])(
		"accepts a verified MCP human actor with %s",
		(scope) => {
			expect(
				hasConnectionCredentialResolutionAuthority({
					authType: "service-binding",
					gatewayEndUserId: "user-1",
					headers,
					tediScopes: [scope],
				}),
			).toBe(true);
		},
	);

	it("runs the full credential middleware for a verified human read actor", async () => {
		const guarded = os
			.$context<BaseContext>()
			.use(
				withAuthorization(
					{
						handlerOwnedUserAuthorization:
							"Internal credential provenance is checked below.",
					},
					"connections.read",
				),
			)
			.use(withConnectionCredentialResolutionAuthority)
			.handler(async () => "credential-resolved");
		const context = {
			authType: "service-binding",
			gatewayEndUserId: "user-1",
			headers,
			tediScopes: ["connections.read"],
		} as BaseContext;
		await expect(call(guarded, undefined, { context })).resolves.toBe(
			"credential-resolved",
		);
		await expect(
			call(guarded, undefined, {
				context: { ...context, gatewayEndUserId: undefined },
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(guarded, undefined, {
				context: {
					...context,
					authType: "user",
					user: { sub: "user-1" },
				} as BaseContext,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("rejects transport trust without the actor, tool, and granular scope", () => {
		expect(
			hasConnectionCredentialResolutionAuthority({
				authType: "service-binding",
				headers,
				tediScopes: ["connections.execute"],
			}),
		).toBe(false);
		expect(
			hasConnectionCredentialResolutionAuthority({
				authType: "service-binding",
				gatewayEndUserId: "user-1",
				headers,
				tediScopes: [],
			}),
		).toBe(false);
		expect(
			hasConnectionCredentialResolutionAuthority({
				authType: "service-binding",
				gatewayEndUserId: "user-1",
				headers: new Headers({ "X-Tedix-Mcp-Tool-Id": "../admin" }),
				tediScopes: ["connections.execute"],
			}),
		).toBe(false);
	});

	it("preserves direct platform-principal access", () => {
		expect(
			hasConnectionCredentialResolutionAuthority({
				apiKey: {
					id: "key-1",
					name: "platform",
					organizationId: "org-1",
					scopes: ["platform:admin"],
				},
				authType: "apikey",
				headers: new Headers(),
			}),
		).toBe(true);
	});
});

describe("external-agent session exchange marker", () => {
	const headers = new Headers({
		"X-Tedix-Caller-Type": "mcp-edge-external-agent-session-exchange",
	});

	it("is accepted only on the two bootstrap procedures", () => {
		expect(
			isExternalAgentSessionExchangeCall(
				headers,
				new URL("https://api/rpc/externalAgentIdentity/openSession"),
			),
		).toBe(true);
		expect(
			isExternalAgentSessionExchangeCall(
				headers,
				new URL("https://api/rpc/externalAgentIdentity/issueMcpCredential"),
			),
		).toBe(true);
		expect(
			isExternalAgentSessionExchangeCall(
				headers,
				new URL("https://api/rpc/externalAgentIdentity/endSession"),
			),
		).toBe(false);
	});
});

describe("external-agent workload exchange marker", () => {
	const headers = new Headers({
		"X-Tedix-Caller-Type": "mcp-edge-external-agent-workload-exchange",
	});

	it("is accepted only on workload authorization and credential issuance", () => {
		expect(
			isExternalAgentWorkloadExchangeCall(
				headers,
				new URL(
					"https://api/rpc/externalAgentIdentity/authorizeWorkloadSession",
				),
			),
		).toBe(true);
		expect(
			isExternalAgentWorkloadExchangeCall(
				headers,
				new URL("https://api/rpc/externalAgentIdentity/issueMcpCredential"),
			),
		).toBe(true);
		expect(
			isExternalAgentWorkloadExchangeCall(
				headers,
				new URL("https://api/rpc/externalAgentIdentity/openSession"),
			),
		).toBe(false);
	});
});

describe("logProcedureCall", () => {
	it("spans the fixed procedure name without recording the result", async () => {
		enteredSpans.length = 0;
		const result = await logProcedureCall({
			context: {
				env: { ENVIRONMENT: "production" },
			} as unknown as BaseContext,
			path: ["apps", "list"],
			next: async () => "private result",
		});

		expect(result).toBe("private result");
		expect(enteredSpans).toContainEqual({
			name: "tedix.api.orpc",
			attributes: { "tedix.orpc.procedure": "apps.list" },
		});
		expect(JSON.stringify(enteredSpans)).not.toContain("private result");
	});

	it("retains safe request correlation on the existing failure log", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		const traceId = "5eed0006-0000-4000-8000-000000000006";
		await expect(
			logProcedureCall({
				context: {
					env: { ENVIRONMENT: "production" },
					headers: new Headers({
						"X-Tedix-Trace-Id": traceId,
						authorization: "Bearer secret",
					}),
				} as unknown as BaseContext,
				path: ["apps", "sync"],
				next: async () => {
					throw new Error("secret payload");
				},
			}),
		).rejects.toThrow("secret payload");
		expect(log.mock.calls[0]?.[1]).toMatchObject({ traceId });
		expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
	});

	it("classifies a transient database failure as unavailable without exposing its query", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		await expect(
			logProcedureCall({
				context: {
					env: { ENVIRONMENT: "production" },
				} as unknown as BaseContext,
				path: ["externalAgentIdentity", "openSession"],
				next: async () => {
					throw new Error("secret SQL", {
						cause: new Error("D1_ERROR: Network connection lost"),
					});
				},
			}),
		).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
			message: "Database temporarily unavailable; retry shortly",
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const ctx = (environment: string) =>
		({ env: { ENVIRONMENT: environment } }) as unknown as BaseContext;

	it("stays quiet on a successful call in production", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await logProcedureCall({
			context: ctx("production"),
			path: ["apps", "list"],
			next: async () => "ok",
		});

		expect(result).toBe("ok");
		expect(log).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	// Coverage is now uniform, so severity has to carry the signal: a 4xx is the
	// caller's problem and only warns, while 5xx and non-oRPC throws are ours and
	// are logged as errors in every environment.
	it("warns on an expected client error but does not error", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			logProcedureCall({
				context: ctx("production"),
				path: ["apps", "get"],
				next: async () => {
					throw createError(ErrorCodes.NOT_FOUND, "nope");
				},
			}),
		).rejects.toThrow("nope");

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[0]).toContain("apps.get");
		expect(error).not.toHaveBeenCalled();
	});

	it("errors on a server-side failure", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			logProcedureCall({
				context: ctx("production"),
				path: ["apps", "sync"],
				next: async () => {
					throw new Error("boom");
				},
			}),
		).rejects.toThrow("boom");

		expect(error).toHaveBeenCalledTimes(1);
		expect(error.mock.calls[0]?.[0]).toContain("apps.sync");
		expect(warn).not.toHaveBeenCalled();
	});

	it("never logs request payloads, tokens, messages, or validation values", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const secret = "sk_live_should_never_reach_logs";
		const error = createError(
			ErrorCodes.BAD_REQUEST,
			`invalid token ${secret}`,
			{
				issues: [
					{
						path: ["credentials", "token"],
						message: `request payload contained ${secret}`,
						input: { authorization: secret },
					},
				],
				body: { prompt: secret },
			},
		);

		await expect(
			logProcedureCall({
				context: ctx("production"),
				path: ["apps", "create"],
				next: async () => {
					throw error;
				},
			}),
		).rejects.toThrow(secret);

		const serializedLog = JSON.stringify(warn.mock.calls);
		expect(serializedLog).not.toContain(secret);
		expect(serializedLog).not.toContain("request payload contained");
		expect(serializedLog).toContain("credentials.token");
		expect(serializedLog).toContain("sha256");
	});

	it("redacts non-Error thrown values wholesale", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		const secret = "Bearer body-secret";

		await expect(
			logProcedureCall({
				context: ctx("production"),
				path: ["apps", "sync"],
				next: async () => Promise.reject({ body: secret }),
			}),
		).rejects.toEqual({ body: secret });

		const serializedLog = JSON.stringify(errorLog.mock.calls);
		expect(serializedLog).not.toContain(secret);
		expect(serializedLog).toContain("thrownValueRedacted");
	});

	it("traces start and completion only in development", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		await logProcedureCall({
			context: ctx("development"),
			path: ["apps", "list"],
			next: async () => "ok",
		});

		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls[0]?.[0]).toContain("apps.list - Started");
		expect(log.mock.calls[1]?.[0]).toContain("apps.list - Completed");
	});
});

describe("ErrorCodes stay oRPC standard codes", () => {
	// Under v1 this asserted the resolved HTTP status per code, read straight off
	// the thrown ORPCError. oRPC v2 removed both hooks: `ORPCError` no longer
	// carries `status` (the handler codec resolves it from the code) and neither
	// `COMMON_ORPC_ERROR_DEFS` nor `fallbackORPCErrorStatus` is exported any more.
	//
	// The invariant that matters is unchanged and still worth pinning: every value
	// must be a code oRPC recognises, because an unrecognised one silently
	// resolves to 500 no matter what a contract's `.errors()` map declares. The
	// recognised set is mirrored here from oRPC's own COMMON_ORPC_ERROR_DEFS.
	const ORPC_STANDARD_CODES = new Set([
		"BAD_REQUEST",
		"UNAUTHORIZED",
		"FORBIDDEN",
		"NOT_FOUND",
		"METHOD_NOT_SUPPORTED",
		"NOT_ACCEPTABLE",
		"TIMEOUT",
		"CONFLICT",
		"PRECONDITION_FAILED",
		"PAYLOAD_TOO_LARGE",
		"UNSUPPORTED_MEDIA_TYPE",
		"UNPROCESSABLE_CONTENT",
		"TOO_MANY_REQUESTS",
		"CLIENT_CLOSED_REQUEST",
		"INTERNAL_SERVER_ERROR",
		"NOT_IMPLEMENTED",
		"BAD_GATEWAY",
		"SERVICE_UNAVAILABLE",
		"GATEWAY_TIMEOUT",
	]);

	it("never lets a non-standard code into the table", () => {
		const nonStandard = Object.values(ErrorCodes).filter(
			(code) => !ORPC_STANDARD_CODES.has(code),
		);

		expect(nonStandard).toEqual([]);
	});

	it("preserves the exact code set", () => {
		expect(Object.values(ErrorCodes).sort()).toEqual([
			"BAD_GATEWAY",
			"BAD_REQUEST",
			"CONFLICT",
			"FORBIDDEN",
			"INTERNAL_SERVER_ERROR",
			"NOT_FOUND",
			"SERVICE_UNAVAILABLE",
			"TOO_MANY_REQUESTS",
			"UNAUTHORIZED",
			"UNPROCESSABLE_CONTENT",
		]);
	});

	// The 4xx/5xx split drives the log level in logProcedureCall, so keep it
	// exact: anything not listed here is treated as our fault and logged as an
	// error in every environment.
	it("classifies exactly the 4xx codes as client errors", () => {
		expect([...CLIENT_ERROR_CODES].sort()).toEqual([
			"BAD_REQUEST",
			"CONFLICT",
			"FORBIDDEN",
			"NOT_FOUND",
			"TOO_MANY_REQUESTS",
			"UNAUTHORIZED",
			"UNPROCESSABLE_CONTENT",
		]);
		for (const code of CLIENT_ERROR_CODES) {
			expect(ORPC_STANDARD_CODES.has(code)).toBe(true);
		}
	});
});

describe("forwarded MCP user organization context", () => {
	// Tedix JWTs only carry the current tenant's claims, so membership in the
	// forwarded target org can only be confirmed via a live D1 lookup
	// (`memberRole`, resolved by the caller through `getMemberByUserId`) — the
	// forwarded token itself can no longer stand in for that check.
	it("grants context from the live D1 member role", () => {
		const context = resolveForwardedMcpUserTenantContext({
			targetOrg: {
				id: "org_acme_uuid",
				descopeTenantId: "T_acme",
			},
			memberRole: "owner",
		});

		expect(context).toEqual({
			organizationId: "org_acme_uuid",
			userRole: "owner",
			activeTenantId: "T_acme",
		});
	});

	it("fails closed when there is no D1 member role", () => {
		const context = resolveForwardedMcpUserTenantContext({
			targetOrg: {
				id: "org_acme_uuid",
				descopeTenantId: "T_acme",
			},
		});

		expect(context).toBeNull();
	});
});

describe("procedure scope enforcement", () => {
	it("requires an explicitly delegated scope for service bindings", () => {
		expect(
			hasRequiredScope({ authType: "service-binding" }, "apps:write"),
		).toBe(false);
		expect(
			hasRequiredScope(
				{ authType: "service-binding", tediScopes: ["apps:write"] },
				"apps:write",
			),
		).toBe(true);
		expect(
			hasRequiredScope(
				{
					authType: "service-binding",
					serviceBindingAuthorization: {
						source: "mcp-tool",
						toolId: "create_os_output",
					},
					tediScopes: [],
				},
				"mcp:skills.write",
			),
		).toBe(true);
		expect(
			hasRequiredScope(
				{
					authType: "service-binding",
					serviceBindingAuthorization: {
						source: "mcp-tool",
						toolId: "work_items:list",
					},
				},
				"apps:write",
			),
		).toBe(true);
		expect(
			hasRequiredScope(
				{
					authType: "service-binding",
					serviceBindingAuthorization: {
						source: "mcp-tool",
						toolId: "create_os_output",
					},
					tediScopes: [],
				},
				"mcp:skills.write",
			),
		).toBe(true);
		expect(hasRequiredScope({ authType: "user" }, "apps:write")).toBe(true);
	});

	it("does not substitute platform authority for resource capabilities", () => {
		expect(
			hasRequiredScope(
				{
					authType: "apikey",
					apiKey: {
						id: "key_1",
						organizationId: "org_1",
						name: "platform automation",
						scopes: ["platform:admin"],
					},
				},
				"apps:write",
			),
		).toBe(false);
		expect(
			hasRequiredScope(
				{
					authType: "m2m",
					serviceAccount: {
						clientId: "platform-worker",
						scope: "platform:admin",
					},
				},
				"apps:write",
			),
		).toBe(false);
	});

	it("rejects removed broad MCP parent scopes", () => {
		expect(
			hasRequiredScope(
				{
					authType: "apikey",
					apiKey: {
						id: "key_1",
						organizationId: "org_1",
						name: "content automation",
						scopes: ["mcp:content"],
					},
				},
				"mcp:content.read",
			),
		).toBe(false);
		expect(
			hasRequiredScope(
				{
					authType: "m2m",
					serviceAccount: {
						clientId: "content-worker",
						scope: "mcp:content",
					},
				},
				"mcp:content.admin",
			),
		).toBe(false);
		expect(
			hasRequiredScope(
				{
					authType: "apikey",
					apiKey: {
						id: "key_1",
						organizationId: "org_1",
						name: "read-only content automation",
						scopes: ["mcp:content.read"],
					},
				},
				"mcp:content.write",
			),
		).toBe(false);
	});

	it("requires exact scopes for direct tedi JWTs", () => {
		expect(
			hasRequiredScope(
				{ authType: "tedi", tediScopes: ["apps:write"] },
				"apps:write",
			),
		).toBe(true);
		expect(
			hasRequiredScope(
				{ authType: "tedi", tediScopes: ["platform:admin", "*"] },
				"apps:write",
			),
		).toBe(false);
		expect(hasRequiredScope({ authType: "tedi" }, "apps:write")).toBe(false);
	});
});

describe("composite two-plane authorization", () => {
	const guarded = os
		.$context<BaseContext>()
		.use(withAuthorization("apps:read", "apps:read"))
		.handler(async () => "ok");

	it("enforces RBAC for users", async () => {
		const user = {
			authType: "user",
			user: { sub: "u1", permissions: ["apps:read"], roles: [] },
		} as BaseContext;
		await expect(call(guarded, undefined, { context: user })).resolves.toBe(
			"ok",
		);
		await expect(
			call(guarded, undefined, {
				context: {
					...user,
					user: { sub: "u2", permissions: [], roles: [] },
				},
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("enforces scopes for machine credentials", async () => {
		const apiKey = (scopes: string[]) =>
			({
				authType: "apikey",
				apiKey: { id: "k1", name: "key", organizationId: "o1", scopes },
			}) as BaseContext;
		await expect(
			call(guarded, undefined, { context: apiKey(["apps:read"]) }),
		).resolves.toBe("ok");
		await expect(
			call(guarded, undefined, { context: apiKey(["apps:write"]) }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("accepts platform RBAC for humans and platform:admin for AIH users", async () => {
		const guardedPlatform = os
			.$context<BaseContext>()
			.use(AUTHZ.platformAdmin)
			.handler(async () => "ok");
		await expect(
			call(guardedPlatform, undefined, {
				context: {
					authType: "user",
					user: { sub: "u1", permissions: [], roles: ["platform-admin"] },
				} as BaseContext,
			}),
		).resolves.toBe("ok");
		await expect(
			call(guardedPlatform, undefined, {
				context: {
					authType: "user",
					user: {
						sub: "u2",
						permissions: [],
						roles: [],
						scope: "platform:admin",
					},
				} as BaseContext,
			}),
		).resolves.toBe("ok");
		await expect(
			call(guardedPlatform, undefined, {
				context: {
					authType: "user",
					user: {
						sub: "u3",
						permissions: [],
						roles: [],
						scope: "mcp:settings.admin",
					},
				} as BaseContext,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("separates service-binding transport trust from procedure authority", async () => {
		await expect(
			call(guarded, undefined, {
				context: { authType: "service-binding" } as BaseContext,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			call(guarded, undefined, {
				context: {
					authType: "service-binding",
					tediScopes: ["apps:read"],
				} as BaseContext,
			}),
		).resolves.toBe("ok");
		await expect(
			call(guarded, undefined, {
				context: {
					authType: "service-binding",
					serviceBindingAuthorization: {
						source: "mcp-tool",
						toolId: "apps:list",
					},
				} as BaseContext,
			}),
		).resolves.toBe("ok");
	});

	// Cross-tenant override: the token's roles/permissions are scoped to its own
	// `dct`, so under an override they must NOT authorize anything in the target
	// org — only the resolved-org membership role (`userRole`) may.
	it("ignores token permission claims under a cross-tenant override", async () => {
		const tokenGrantsButNotMember = {
			authType: "user",
			crossTenantOverrideActive: true,
			// Token proves owner in its OWN tenant, but no membership resolved in
			// the addressed org, so userRole is unset -> must be denied.
			user: { sub: "u1", permissions: ["apps:read"], roles: ["owner"] },
		} as BaseContext;
		await expect(
			call(guarded, undefined, { context: tokenGrantsButNotMember }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("honors the resolved-org membership role under a cross-tenant override", async () => {
		const memberOfTargetOrg = {
			authType: "user",
			crossTenantOverrideActive: true,
			userRole: "owner",
			// Token claims are empty for the target org; authorization comes from
			// the resolved membership role only.
			user: { sub: "u1", permissions: [], roles: [] },
		} as BaseContext;
		await expect(
			call(guarded, undefined, { context: memberOfTargetOrg }),
		).resolves.toBe("ok");
	});

	it("still trusts token claims for same-tenant requests (no override)", async () => {
		const sameTenant = {
			authType: "user",
			user: { sub: "u1", permissions: ["apps:read"], roles: [] },
		} as BaseContext;
		await expect(
			call(guarded, undefined, { context: sameTenant }),
		).resolves.toBe("ok");
	});

	it("rejects stale admin claims after a same-tenant member demotion", async () => {
		const manageTeam = os
			.$context<BaseContext>()
			.use(withPermission("team:manage"))
			.handler(async () => "ok");
		const demotedMember = {
			authType: "user",
			userRole: "member",
			user: {
				sub: "u1",
				permissions: ["team:manage"],
				roles: ["admin"],
			},
		} as BaseContext;
		await expect(
			call(manageTeam, undefined, {
				context: demotedMember,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("keeps custom Descope permissions when the built-in role is current", async () => {
		const manageTeam = os
			.$context<BaseContext>()
			.use(withPermission("team:manage"))
			.handler(async () => "ok");
		const customRoleMember = {
			authType: "user",
			userRole: "member",
			user: {
				sub: "u1",
				permissions: ["team:manage"],
				roles: ["member", "team-manager"],
			},
		} as BaseContext;
		await expect(
			call(manageTeam, undefined, {
				context: customRoleMember,
			}),
		).resolves.toBe("ok");
	});

	it("refuses an omitted or empty human authorization declaration", () => {
		if (false) {
			// @ts-expect-error A missing human plane must not compile.
			withAuthorization(null, "apps:read");
		}

		expect(() => withAuthorization([] as never, "apps:read")).toThrow(
			"non-empty permission set",
		);
		expect(() =>
			withAuthorization({ anyOf: [] as never }, "apps:read"),
		).toThrow("non-empty anyOf set");
		expect(() =>
			withAuthorization(
				{ handlerOwnedUserAuthorization: "too short" },
				"apps:read",
			),
		).toThrow("requires a specific rationale");
	});

	it("keeps an explicitly identity-bound human path role-free", async () => {
		const identityBound = os
			.$context<BaseContext>()
			.use(
				withAuthorization(
					{
						handlerOwnedUserAuthorization:
							"The handler binds the returned records to the authenticated human subject.",
					},
					"apps:read",
				),
			)
			.handler(async ({ context }) => context.user?.sub ?? "denied");

		await expect(
			call(identityBound, undefined, {
				context: {
					authType: "user",
					user: { sub: "u1", permissions: [], roles: [] },
				} as BaseContext,
			}),
		).resolves.toBe("u1");
	});
});

describe("exact API-key scope authorization", () => {
	const guarded = os
		.$context<BaseContext>()
		.use(withExactApiKeyScope("os:fleet-run"))
		.handler(async () => "ok");
	const apiKey = (scopes: string[]) =>
		({
			authType: "apikey",
			apiKey: { id: "k1", name: "key", organizationId: "o1", scopes },
		}) as BaseContext;

	it("accepts only an API key carrying the literal fleet scope", async () => {
		await expect(
			call(guarded, undefined, { context: apiKey(["os:fleet-run"]) }),
		).resolves.toBe("ok");
		for (const context of [
			apiKey([]),
			apiKey(["*"]),
			apiKey(["platform:admin"]),
			apiKey(["os:fleet-run", "*"]),
			{
				authType: "user",
				user: { sub: "u1", permissions: [], roles: ["platform-admin"] },
			},
			{ authType: "service-binding", serviceBinding: { caller: "trusted" } },
		]) {
			await expect(
				call(guarded, undefined, { context: context as BaseContext }),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});
});

describe("skipOutputValidation", () => {
	// A procedure whose declared output schema WOULD reject the value the handler
	// actually returns. If the runtime Zod parse runs, invoking it throws; if the
	// parse is skipped, the malformed value passes straight through. This makes the
	// test prove the mechanism rather than a tautology: the unwrapped procedure
	// must reject, the wrapped one must not.
	//
	// This is a regression guard for the oRPC v2 rename. beta.23 renamed the
	// singular `outputSchema` internal to a plural `outputSchemas` array and gates
	// validation on the `disableOutputValidation` config flag. The pre-fix helper
	// set a stale singular `outputSchema` key, which was a silent no-op — every
	// wrapped read endpoint kept paying for the Zod parse it was built to skip.
	const malformedProcedure = os
		.output(z.object({ n: z.number() }))
		.handler(async () => ({ n: "not-a-number" }) as unknown as { n: number });

	it("rejects a malformed return value WITHOUT the wrapper (proves the schema bites)", async () => {
		await expect(
			call(malformedProcedure, undefined, { context: {} }),
		).rejects.toThrow(/output validation/i);
	});

	it("passes the same malformed value THROUGH when wrapped (parse actually skipped)", async () => {
		const wrapped = skipOutputValidation(malformedProcedure);
		const result = await call(wrapped, undefined, { context: {} });
		expect(result).toEqual({ n: "not-a-number" });
	});

	it("flips the v2 `disableOutputValidation` config flag, not the stale singular key", () => {
		const wrapped = skipOutputValidation(malformedProcedure) as unknown as {
			["~orpc"]: {
				disableOutputValidation?: boolean;
				outputSchemas?: unknown[];
			};
		};
		// The flag the beta.23 executor actually gates on.
		expect(wrapped["~orpc"].disableOutputValidation).toBe(true);
		// The plural schema array is preserved (type inference + OpenAPI still work).
		expect(Array.isArray(wrapped["~orpc"].outputSchemas)).toBe(true);
		expect(wrapped["~orpc"].outputSchemas?.length).toBeGreaterThan(0);
	});
});
