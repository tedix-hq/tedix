// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as jwt from "@tedix/auth/jwt";
import type { SessionBrokerRpc } from "@tedix/auth/session-broker";
import {
	LOCAL_DEMO_PROJECT_ID,
	LOCAL_DEMO_TOKEN,
} from "@tedix/auth/local-demo";
import {
	CLI_BROKER_SESSION_COOKIE,
	OS_BROKER_SESSION_COOKIE,
} from "./auth/session-broker";
import {
	OS_CLIENT_ERROR_PATH,
	type OsClientErrorReportV1,
} from "./lib/error-reporting/report";
import {
	WEBMCP_TELEMETRY_PATH,
	type WebMcpTelemetryBatchV1,
} from "./lib/webmcp/telemetry";
import {
	authorizeBrowserMcpBridge,
	authenticateWidgetBridge,
	handleOsRequest,
	type OsRouterEnv,
	type TenantResolver,
} from "./worker";

function assetsReturning(body: string, status = 200): OsRouterEnv {
	return {
		ASSETS: {
			fetch: async () =>
				new Response(body, {
					status,
					headers: { "Content-Type": "text/html; charset=utf-8" },
				}),
		},
	};
}

function envRecordingRequests(): OsRouterEnv & { seen: Request[] } {
	const seen: Request[] = [];
	return {
		seen,
		ASSETS: {
			fetch: async (request: Request) => {
				seen.push(request);
				return new Response("shell", { status: 200 });
			},
		},
	};
}

const API_SERVICE: NonNullable<OsRouterEnv["API_SERVICE"]> = {
	fetch: async () => new Response("unused", { status: 500 }),
};

const createIntent = vi.fn(async () => {
	return {
		authorizeUrl:
			"https://auth.tedix.dev/tedix/session/authorize?intent=intent_123456789012345678901234",
		expiresAt: Math.floor(Date.now() / 1000) + 60,
		intentId: "intent_123456789012345678901234",
	};
});

const SESSION_BROKER: SessionBrokerRpc = {
	createIntent,
	async exchangeCode() {
		return { kind: "logout" };
	},
};

const HOST_SESSION = "header.eyJkY3QiOiJULWhvc3Qtb3JnIn0.signature";

function withApiService<E extends OsRouterEnv>(
	env: E,
): E & { API_SERVICE: typeof API_SERVICE } {
	return { ...env, API_SERVICE };
}

const provisioned: TenantResolver = async () => ({
	provisioned: true,
	descopeTenantId: "T-host-org",
});
const provisionedWithTenant = provisioned;
const unprovisioned: TenantResolver = async () => ({ provisioned: false });
const failing: TenantResolver = async () => {
	throw new Error("resolver down");
};

describe("installation-owned OS host", () => {
	it("serves only the exact configured launcher and keeps managed hosts out", async () => {
		const env = {
			...assetsReturning("own shell"),
			OS_URL: "https://os.acme.example",
		};
		const own = await handleOsRequest(
			new Request("https://os.acme.example/"),
			env,
		);
		expect(own.status).toBe(200);
		expect(await own.text()).toBe("own shell");
		for (const host of [
			"tenant.os.acme.example",
			"os.acme.example.evil.test",
			"os.tedix.dev",
		]) {
			const response = await handleOsRequest(
				new Request(`https://${host}/`),
				env,
			);
			expect(response.status).toBe(404);
		}
	});
});

describe("route-scoped portable relay host gate", () => {
	it("refuses an unauthenticated browser before route verification or MCP", async () => {
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/_tedix/webmcp/portable-call", {
				method: "POST",
				headers: {
					Origin: "https://tedix.os.tedix.dev",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					token: "forged",
					routeId: "workspaces",
					callable: "os.list_os_workspaces",
					args: {},
				}),
			}),
			{
				...assetsReturning("unused"),
				API_SERVICE,
				MCP_SERVICE: { fetch: async () => Response.json({}) },
			},
			provisioned,
		);
		expect(response.status).toBe(401);
	});
});

describe("Descope outbound SDK bridge", () => {
	it.each([false, true])(
		"resolves named selectors from the authenticated API in tenant mode %s",
		async (tenantLevel) => {
			createIntent.mockClear();
			const id = "11111111-1111-4111-8111-111111111111";
			const apiFetch = vi.fn(
				async (input: RequestInfo | URL, init?: RequestInit) => {
					const request =
						input instanceof Request ? input : new Request(input, init);
					if (request.url.includes("getContext"))
						return Response.json({
							json: { authority: { permissions: ["integrations:manage"] } },
						});
					expect(request.url).toContain(
						"connections/preparePersonalConnection",
					);
					expect(
						((await request.json()) as { json: { scope: string } }).json.scope,
					).toBe(tenantLevel ? "tenant" : "user");
					expect(request.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
					expect(request.headers.get("Cookie")).toContain("DS=" + HOST_SESSION);
					return Response.json({
						json: {
							externalIdentifier: `tedix_${id}`,
							userId: "alice",
							scopes: ["Mail.Read"],
						},
					});
				},
			);
			const response = await handleOsRequest(
				new Request(
					"https://acme.os.tedix.dev/auth/descope/v1/outbound/oauth/connect",
					{
						method: "POST",
						headers: {
							Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							appId: "acme-api",
							connectionInstanceId: id,
							tenantLevel,
							...(tenantLevel ? { tenantId: "T-host-org" } : {}),
							options: {
								externalIdentifier: "attacker",
								redirectUrl: "https://acme.os.tedix.dev/oauth/callback",
							},
						}),
					},
				),
				{
					...assetsReturning("unused"),
					DESCOPE_PROJECT_ID: "project",
					API_SERVICE: { fetch: apiFetch },
					OS_SESSION_BROKER: SESSION_BROKER,
				},
				provisionedWithTenant,
			);
			expect(response.status).toBe(200);
			expect(createIntent).toHaveBeenCalledWith(
				expect.objectContaining({
					outboundExternalIdentifier: `tedix_${id}`,
					outboundUserId: "alice",
					outboundScopes: ["Mail.Read"],
					tenantId: tenantLevel ? "T-host-org" : null,
				}),
			);
		},
	);
	it("creates a brokered handoff for a user connection", async () => {
		createIntent.mockClear();
		{
			const response = await handleOsRequest(
				new Request(
					"https://acme.os.tedix.dev/auth/descope/v1/outbound/oauth/connect",
					{
						method: "POST",
						headers: {
							Authorization: "Bearer project:broker-session",
							Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							appId: "acme-api",
							options: {
								redirectUrl: "https://acme.os.tedix.dev/oauth/callback",
							},
						}),
					},
				),
				{
					...withApiService(assetsReturning("unused")),
					DESCOPE_PROJECT_ID: "project",
					OS_SESSION_BROKER: SESSION_BROKER,
				},
				provisionedWithTenant,
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				url: "https://auth.tedix.dev/tedix/session/authorize?intent=intent_123456789012345678901234",
			});
			expect(createIntent).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: "outbound_connect",
					outboundAppId: "acme-api",
					targetOrigin: "https://acme.os.tedix.dev",
					tenantId: null,
					stateHash: expect.stringMatching(/^sha256-[A-Za-z0-9_-]{43}$/),
				}),
			);
		}
	});

	it("rejects a tenant target that differs from the workspace hostname", async () => {
		{
			const response = await handleOsRequest(
				new Request(
					"https://acme.os.tedix.dev/auth/descope/v1/outbound/oauth/connect",
					{
						method: "POST",
						headers: {
							Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							appId: "acme-api",
							tenantId: "T-other-org",
							tenantLevel: true,
							options: {
								redirectUrl: "https://acme.os.tedix.dev/oauth/callback",
							},
						}),
					},
				),
				{
					...withApiService(assetsReturning("unused")),
					DESCOPE_PROJECT_ID: "project",
				},
				provisionedWithTenant,
			);

			expect(response.status).toBe(403);
		}
	});

	it("allows a native tenant connection only with integrations management authority", async () => {
		createIntent.mockClear();
		{
			const response = await handleOsRequest(
				new Request(
					"https://acme.os.tedix.dev/auth/descope/v1/outbound/oauth/connect",
					{
						method: "POST",
						headers: {
							Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							appId: "acme-api",
							tenantId: "T-host-org",
							tenantLevel: true,
							options: {
								redirectUrl: "https://acme.os.tedix.dev/oauth/callback",
							},
						}),
					},
				),
				{
					...assetsReturning("unused"),
					API_SERVICE: {
						fetch: async () =>
							Response.json({
								json: {
									authority: {
										permissions: ["integrations:manage"],
									},
								},
							}),
					},
					DESCOPE_PROJECT_ID: "project",
					OS_SESSION_BROKER: SESSION_BROKER,
				},
				provisionedWithTenant,
			);

			expect(response.status).toBe(200);
			expect(createIntent).toHaveBeenCalledWith(
				expect.objectContaining({
					operation: "outbound_connect",
					outboundAppId: "acme-api",
					tenantId: "T-host-org",
				}),
			);
		}
	});
});

describe("widget bridge identity", () => {
	afterEach(() => vi.restoreAllMocks());

	function widgetBridgeEnv(scopes: () => string[], policyAvailable = true) {
		vi.spyOn(jwt, "validateToken").mockResolvedValue({
			sub: "user-1",
			dct: "T-host-org",
			iat: 1,
			exp: 2,
			iss: "project",
			aud: ["project"],
		});
		const apiFetch = vi.fn(async (_request: Request) =>
			policyAvailable
				? Response.json({ json: { policyVersion: 1, scopes: scopes() } })
				: new Response("policy unavailable", { status: 503 }),
		);
		const mcpFetch = vi.fn(async (request: Request) => {
			const body = (await request.json()) as { id: number; method: string };
			if (!request.headers.get("X-Tedix-Browser-Scopes")) {
				return Response.json({ error: "insufficient_scope" }, { status: 403 });
			}
			return Response.json({
				jsonrpc: "2.0",
				id: body.id,
				result:
					body.method === "server/discover"
						? { supportedVersions: ["2026-07-28"] }
						: { content: [{ type: "text", text: "saved report" }] },
			});
		});
		return {
			...assetsReturning("unused"),
			DESCOPE_PROJECT_ID: "project",
			API_SERVICE: { fetch: apiFetch },
			MCP_SERVICE: { fetch: mcpFetch },
			apiFetch,
			mcpFetch,
		};
	}

	function widgetRequest(kind: "resource" | "mcp") {
		return new Request(
			kind === "resource"
				? "https://tedix.os.tedix.dev/widgets/resource?app=example&uri=ui://widgets/review.html"
				: "https://tedix.os.tedix.dev/widgets/mcp",
			{
				method: kind === "resource" ? "GET" : "POST",
				headers: {
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
					Origin: "https://tedix.os.tedix.dev",
				},
				...(kind === "mcp"
					? {
							body: JSON.stringify({
								app: "example",
								method: "tools/call",
								params: { name: "get_report", arguments: {} },
							}),
						}
					: {}),
			},
		);
	}

	it.each(["resource", "mcp"] as const)(
		"forwards current tenant browser capabilities on the widget %s relay",
		async (kind) => {
			const env = widgetBridgeEnv(() => ["mcp:apps.read"]);
			const response = await handleOsRequest(
				widgetRequest(kind),
				env,
				provisioned,
			);
			expect(response.status).toBe(200);
			expect(env.apiFetch).toHaveBeenCalledTimes(1);
			const policyRequest = env.apiFetch.mock.calls[0]?.[0] as Request;
			expect(policyRequest.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
			expect(policyRequest.headers.get("Cookie")).toContain(
				`DS=${HOST_SESSION}`,
			);
			for (const [upstream] of env.mcpFetch.mock.calls) {
				expect(upstream.headers.get("X-Tedix-Browser-Scopes")).toBe(
					"mcp:apps.read",
				);
				expect(upstream.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
				expect(upstream.headers.get("Authorization")).toBe(
					`Bearer ${HOST_SESSION}`,
				);
			}
		},
	);

	it.each(["resource", "mcp"] as const)(
		"refuses the widget %s relay when policy resolution fails",
		async (kind) => {
			const env = widgetBridgeEnv(() => ["mcp:apps.read"], false);
			const response = await handleOsRequest(
				widgetRequest(kind),
				env,
				provisioned,
			);
			expect(response.status).toBe(403);
			expect(env.mcpFetch).not.toHaveBeenCalled();
		},
	);

	it("re-evaluates revoked browser permissions on the next widget call", async () => {
		let scopes = ["mcp:apps.read"];
		const env = widgetBridgeEnv(() => scopes);
		expect(
			(await handleOsRequest(widgetRequest("mcp"), env, provisioned)).status,
		).toBe(200);
		scopes = [];
		expect(
			(await handleOsRequest(widgetRequest("mcp"), env, provisioned)).status,
		).toBe(403);
		expect(env.apiFetch).toHaveBeenCalledTimes(2);
	});

	it.each(["resource", "mcp"] as const)(
		"refuses the widget %s relay without the policy service binding",
		async (kind) => {
			const env = widgetBridgeEnv(() => ["mcp:apps.read"]);
			const response = await handleOsRequest(
				widgetRequest(kind),
				{ ...env, API_SERVICE: undefined },
				provisioned,
			);
			expect(response.status).toBe(503);
			expect(env.mcpFetch).not.toHaveBeenCalled();
		},
	);

	it("verifies the broker session and projects the exact user and host org", async () => {
		const result = await authenticateWidgetBridge(
			new Request("https://tedix.os.tedix.dev/widgets/resource", {
				headers: {
					Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt`,
				},
			}),
			{
				...assetsReturning("unused"),
				DESCOPE_PROJECT_ID: "project",
			},
			"T-host-org",
			async () => ({
				sub: "user-1",
				dct: "T-host-org",
				iat: 1,
				exp: 2,
				iss: "project",
				aud: ["project"],
			}),
		);

		expect(result?.serviceIdentity).toEqual({
			sessionToken: "session-jwt",
			tenantId: "T-host-org",
		});
		expect(result?.request.headers.get("Cookie")).toContain("DS=session-jwt");
	});

	it("refuses a valid session selected for a different tenant", async () => {
		const result = await authenticateWidgetBridge(
			new Request("https://tedix.os.tedix.dev/widgets/resource", {
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt` },
			}),
			{
				...assetsReturning("unused"),
				DESCOPE_PROJECT_ID: "project",
			},
			"T-host-org",
			async () => ({
				sub: "user-1",
				dct: "T-other",
				iat: 1,
				exp: 2,
				iss: "project",
				aud: ["project"],
			}),
		);

		expect(result).toBeNull();
	});

	it("re-resolves bounded browser MCP scopes for the exact host tenant", async () => {
		const resolve = vi.fn(async () => ["mcp:apps.read", "mcp:work.read"]);
		const request = new Request("https://acme.os.tedix.dev/mcp", {
			headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt` },
		});
		const result = await authorizeBrowserMcpBridge(
			request,
			{ ...assetsReturning("unused") },
			"T-host-org",
			{ sessionToken: "session-jwt", tenantId: "T-host-org" },
			resolve,
		);

		expect(resolve).toHaveBeenCalledWith({
			request,
			env: expect.any(Object),
			hostTenantId: "T-host-org",
		});
		expect(result).toEqual({
			sessionToken: "session-jwt",
			tenantId: "T-host-org",
			browserMcpScopes: ["mcp:apps.read", "mcp:work.read"],
		});
	});

	it("fails closed when browser MCP policy resolution is unavailable", async () => {
		const result = await authorizeBrowserMcpBridge(
			new Request("https://acme.os.tedix.dev/mcp"),
			{ ...assetsReturning("unused") },
			"T-host-org",
			{ sessionToken: "session-jwt", tenantId: "T-host-org" },
			async () => {
				throw new Error("policy unavailable");
			},
		);
		expect(result).toBeNull();
	});

	it("unwraps the direct browser authorization procedure result", async () => {
		const apiFetch = vi.fn(async (_request: Request) =>
			Response.json({
				json: {
					policyVersion: 1,
					scopes: ["mcp:apps.read"],
				},
			}),
		);
		const result = await authorizeBrowserMcpBridge(
			new Request("https://acme.os.tedix.dev/mcp", {
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=session-jwt` },
			}),
			{
				...assetsReturning("unused"),
				API_SERVICE: { fetch: apiFetch },
			},
			"T-host-org",
			{ sessionToken: "session-jwt", tenantId: "T-host-org" },
		);

		expect(result?.browserMcpScopes).toEqual(["mcp:apps.read"]);
		const proxied = apiFetch.mock.calls[0]?.[0] as Request;
		expect(proxied.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
		expect(proxied.headers.get("Cookie")).toContain("DS=session-jwt");
	});
});

describe("/capn server-side gate", () => {
	const CAPN_HEADERS = {
		Upgrade: "websocket",
		Origin: "https://tedix.os.tedix.dev",
	};

	it("requires an authenticated session on a provisioned tenant host", async () => {
		// Replaces the old "404 when the var is unset" case. The pilot var is gone,
		// so the first thing that can refuse a well-formed upgrade is the session:
		// 401 (not 404) proves the route is served and auth is what stopped it.
		const env = withApiService(envRecordingRequests());
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/capn", {
				headers: CAPN_HEADERS,
			}),
			env,
			provisionedWithTenant,
		);
		expect(response.status).toBe(401);
	});

	it("refuses 404 on the central launcher host", async () => {
		// Tenant hosts only — the launcher has no workspace to project.
		const response = await handleOsRequest(
			new Request("https://os.tedix.dev/capn", { headers: CAPN_HEADERS }),
			withApiService(envRecordingRequests()),
			provisionedWithTenant,
		);
		expect(response.status).toBe(404);
	});

	it("reaches the mount, which still refuses a cross-origin upgrade", async () => {
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/capn", {
				headers: {
					Upgrade: "websocket",
					Origin: "https://evil.tedix.dev",
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
				},
			}),
			withApiService(envRecordingRequests()),
			provisionedWithTenant,
		);
		// 403 (not 404) proves the route was reached and the mount's own
		// same-origin check did the refusing.
		expect(response.status).toBe(403);
	});

	it("refuses an unprovisioned tenant host", async () => {
		const response = await handleOsRequest(
			new Request("https://squatter.os.tedix.dev/capn", {
				headers: CAPN_HEADERS,
			}),
			withApiService(envRecordingRequests()),
			unprovisioned,
		);
		expect(response.status).toBe(404);
	});

	it("serves the loopback local-demo lane, authorizing with the local bearer", async () => {
		// Local dev has no broker cookie and no Descope tenant; the SSE lane that
		// used to carry it is retired, so `/capn` must be reachable here. The API
		// preflight DENIES in this test so the assertion stops at the boundary
		// (a granted upgrade needs WebSocketPair, which this environment lacks):
		// a 403 AFTER an API call carrying the local bearer proves the local lane
		// got past the host/session gates and authorized as the local identity.
		const apiRequests: Request[] = [];
		const env = {
			...envRecordingRequests(),
			DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
			TEDIX_LOCAL_DEMO_ENABLED: "true",
			API_SERVICE: {
				fetch: async (request: Request) => {
					apiRequests.push(request);
					return new Response("denied", { status: 403 });
				},
			},
		};
		const response = await handleOsRequest(
			new Request("http://localhost:3030/capn", {
				headers: { Upgrade: "websocket", Origin: "http://localhost:3030" },
			}),
			env,
			unprovisioned,
		);
		expect(response.status).toBe(403);
		expect(apiRequests).toHaveLength(1);
		expect(apiRequests[0]?.headers.get("Authorization")).toBe(
			`Bearer ${LOCAL_DEMO_TOKEN}`,
		);
		// No tenant to assert on a loopback host — apps/api resolves the local
		// identity's own org instead.
		expect(apiRequests[0]?.headers.get("X-Tedix-Tenant-Id")).toBeNull();
	});

	it("does not enable the local-demo lane on a non-loopback origin", async () => {
		const env = {
			...withApiService(envRecordingRequests()),
			DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
			TEDIX_LOCAL_DEMO_ENABLED: "true",
		};
		const response = await handleOsRequest(
			new Request("https://example.com/capn", {
				headers: { Upgrade: "websocket", Origin: "https://example.com" },
			}),
			env,
			unprovisioned,
		);
		expect(response.status).toBe(404);
	});
});

describe("Tedix OS origin router", () => {
	it("serves the CLI CIMD document before tenant resolution", async () => {
		const response = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json",
			),
			assetsReturning("must not serve asset"),
			() => {
				throw new Error("client metadata must not resolve tenants");
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toContain("public");
		expect(await response.json()).toMatchObject({
			client_id: "https://os.tedix.dev/.well-known/oauth-client/tedix-cli.json",
			redirect_uris: ["https://os.tedix.dev/cli/oauth/callback"],
			token_endpoint_auth_method: "none",
		});
	});

	it("reports the deployed sha on /health before tenant resolution", async () => {
		// The tenant resolver throwing proves /health never consults it — an
		// unprovisioned or unresolvable host still reports what code it runs.
		const throwingResolver = () => {
			throw new Error("health must not resolve tenants");
		};
		for (const host of ["https://os.tedix.dev", "https://acme.os.tedix.dev"]) {
			const response = await handleOsRequest(
				new Request(`${host}/health`),
				{
					...withApiService(assetsReturning("shell")),
					OS_SESSION_BROKER: SESSION_BROKER,
					GIT_SHA: "abc123",
				},
				throwingResolver,
			);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				status: "ok",
				deployedSha: "abc123",
			});
		}
	});

	it("accepts a client error report with 204 and the worker's security headers", async () => {
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const response = await handleOsRequest(
			new Request(`https://os.tedix.dev${OS_CLIENT_ERROR_PATH}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					schemaVersion: 1,
					failureSite: "os.route-boundary",
					severity: "error",
					handled: false,
					captureMechanism: "react",
				} satisfies OsClientErrorReportV1),
			}),
			assetsReturning("must not serve asset"),
		);

		expect(response.status).toBe(204);
		// The sink is the whole endpoint, so an accepted report must have logged.
		expect(consoleError).toHaveBeenCalled();
		// Same hardening as every other response this Worker returns: never
		// cached and never indexed.
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Robots-Tag")).toBe(
			"noindex, nofollow, noarchive",
		);
		consoleError.mockRestore();
	});

	it("accepts a WebMCP telemetry batch with 204 and one webmcp.client log line", async () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
		const response = await handleOsRequest(
			new Request(`https://os.tedix.dev${WEBMCP_TELEMETRY_PATH}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					schemaVersion: 1,
					events: [
						{
							tool: "list_work_items",
							scope: "work",
							outcome: "ok",
							durationMs: 12,
						},
					],
				} satisfies WebMcpTelemetryBatchV1),
			}),
			{ ...assetsReturning("must not serve asset"), GIT_SHA: "abc123" },
		);

		expect(response.status).toBe(204);
		expect(consoleLog).toHaveBeenCalledWith(
			"webmcp.client",
			expect.objectContaining({
				event: "webmcp.client",
				tenant: "launcher",
				deployedSha: "abc123",
				events: [
					{
						tool: "list_work_items",
						scope: "work",
						outcome: "ok",
						durationMs: 12,
					},
				],
			}),
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("X-Robots-Tag")).toBe(
			"noindex, nofollow, noarchive",
		);
		consoleLog.mockRestore();
	});

	it("routes an unauthenticated tenant document into its named broker entrypoint", async () => {
		const first = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/workspace/1", {
				headers: { Accept: "text/html" },
			}),
			{
				...withApiService(assetsReturning("shell")),
				OS_SESSION_BROKER: SESSION_BROKER,
			},
			provisionedWithTenant,
		);
		expect(first.status).toBe(302);
		expect(first.headers.get("location")).toBe(
			"https://acme.os.tedix.dev/auth/session-broker/continue?redirect_to=%2Fworkspace%2F1",
		);

		const bounce = await handleOsRequest(
			new Request(first.headers.get("location")!, {
				headers: { "Sec-Fetch-Site": "same-origin" },
			}),
			{
				...withApiService(assetsReturning("shell")),
				OS_SESSION_BROKER: SESSION_BROKER,
			},
			provisionedWithTenant,
		);
		expect(bounce.status).toBe(200);
		expect(bounce.headers.get("X-Frame-Options")).toBe("DENY");
		expect(await bounce.text()).toContain(
			'url=/auth/session-broker/start?redirect_to=%2Fworkspace%2F1"',
		);

		const started = await handleOsRequest(
			new Request(
				"https://acme.os.tedix.dev/auth/session-broker/start?redirect_to=%2Fworkspace%2F1",
				{ headers: { "Sec-Fetch-Site": "same-origin" } },
			),
			{
				...withApiService(assetsReturning("shell")),
				OS_SESSION_BROKER: SESSION_BROKER,
			},
			provisionedWithTenant,
		);
		expect(started.status).toBe(302);
		expect(started.headers.get("location")).toContain(
			"https://auth.tedix.dev/tedix/session/authorize?intent=",
		);
	});

	it("serves the broker failure recovery document without restarting the loop", async () => {
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/?error=reauth_required", {
				headers: { Accept: "text/html" },
			}),
			{
				...withApiService(assetsReturning("recovery-shell")),
				OS_SESSION_BROKER: SESSION_BROKER,
			},
			provisionedWithTenant,
		);

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("recovery-shell");
	});

	it("signs in a visitor who follows a cross-site link to a tenant document", async () => {
		createIntent.mockClear();
		// The exact headers a browser sends when a signed-out human follows a
		// Slack/email link. A 302 preserves them, so the start verb must never be
		// the direct redirect target (it returned a bare 403 in production).
		const crossSiteNavigation = {
			Accept: "text/html",
			Referer: "https://app.slack.com/",
			"Sec-Fetch-Dest": "document",
			"Sec-Fetch-Mode": "navigate",
			"Sec-Fetch-Site": "cross-site",
		};
		const env = {
			...withApiService(assetsReturning("shell")),
			OS_SESSION_BROKER: SESSION_BROKER,
		};
		const first = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/work?tab=mine", {
				headers: crossSiteNavigation,
			}),
			env,
			provisionedWithTenant,
		);
		expect(first.status).toBe(302);
		expect(first.headers.get("location")).toBe(
			"https://acme.os.tedix.dev/auth/session-broker/continue?redirect_to=%2Fwork%3Ftab%3Dmine",
		);

		const bounce = await handleOsRequest(
			new Request(first.headers.get("location")!, {
				headers: crossSiteNavigation,
			}),
			env,
			provisionedWithTenant,
		);
		expect(bounce.status).toBe(200);
		expect(bounce.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
		expect(bounce.headers.get("Cache-Control")).toBe("private, no-store");
		const html = await bounce.text();
		const href = html.match(/content="0; url=([^"]+)"/)?.[1];
		expect(href).toBe(
			"/auth/session-broker/start?redirect_to=%2Fwork%3Ftab%3Dmine",
		);
		expect(createIntent).not.toHaveBeenCalled();

		// The document-initiated navigation the bounce performs.
		const started = await handleOsRequest(
			new Request(new URL(href!, "https://acme.os.tedix.dev"), {
				headers: {
					Accept: "text/html",
					Referer: first.headers.get("location")!,
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "same-origin",
				},
			}),
			env,
			provisionedWithTenant,
		);
		expect(started.status).toBe(302);
		expect(started.headers.get("location")).toContain(
			"https://auth.tedix.dev/tedix/session/authorize?intent=",
		);
		expect(createIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: "issue_session",
				redirectPath: "/work?tab=mine",
			}),
		);
	});

	it("still rejects cross-site fetches and foreign-referer starts", async () => {
		createIntent.mockClear();
		const env = {
			...withApiService(assetsReturning("shell")),
			OS_SESSION_BROKER: SESSION_BROKER,
		};
		const xhr = await handleOsRequest(
			new Request(
				"https://acme.os.tedix.dev/auth/session-broker/start?redirect_to=%2Fwork",
				{
					headers: {
						Origin: "https://attacker.example",
						"Sec-Fetch-Dest": "empty",
						"Sec-Fetch-Mode": "cors",
						"Sec-Fetch-Site": "cross-site",
					},
				},
			),
			env,
			provisionedWithTenant,
		);
		expect(xhr.status).toBe(403);
		const forged = await handleOsRequest(
			new Request(
				"https://acme.os.tedix.dev/auth/session-broker/start?operation=logout",
				{
					headers: {
						Referer: "https://attacker.example/",
						"Sec-Fetch-Dest": "document",
						"Sec-Fetch-Mode": "navigate",
						"Sec-Fetch-Site": "cross-site",
					},
				},
			),
			env,
			provisionedWithTenant,
		);
		expect(forged.status).toBe(403);
		const post = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/auth/session-broker/start", {
				body: new URLSearchParams({ session_token: "attacker" }),
				headers: { Origin: "https://attacker.example" },
				method: "POST",
			}),
			env,
			provisionedWithTenant,
		);
		expect(post.status).toBe(403);
		expect(createIntent).not.toHaveBeenCalled();
	});

	it("rejects a cross-site broker start before creating an intent", async () => {
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/auth/session-broker/start", {
				headers: { "Sec-Fetch-Site": "cross-site" },
			}),
			{
				...withApiService(assetsReturning("shell")),
				OS_SESSION_BROKER: SESSION_BROKER,
			},
			provisionedWithTenant,
		);
		expect(response.status).toBe(403);
	});

	it("uses a distinct HttpOnly launcher session for the browser-to-API boundary", async () => {
		const seen: Request[] = [];
		const response = await handleOsRequest(
			new Request("https://os.tedix.dev/api/rpc/userProfile/getMine", {
				method: "POST",
				headers: {
					Authorization: "Bearer attacker-selected",
					Cookie: `${OS_BROKER_SESSION_COOKIE}=broker-jwt; keep=value`,
				},
				body: "{}",
			}),
			{
				ASSETS: { fetch: async () => new Response("shell") },
				API_SERVICE: {
					fetch: async (request) => {
						seen.push(request);
						return Response.json({ organizations: [] });
					},
				},
			},
			provisioned,
		);
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get("Authorization")).toBeNull();
		expect(seen[0]?.headers.get("Cookie")).toBe("keep=value; DS=broker-jwt");
		expect(seen[0]?.headers.get("X-Tedix-Tenant-Id")).toBeNull();
	});

	it("allows only named launcher bootstrap verbs to use an initial Descope session", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (request) => {
					seen.push(request);
					return Response.json({ json: { created: true } });
				},
			},
		};
		const bootstrap = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/api/rpc/organizations/getMyOrganization",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer attacker-selected",
						Cookie: "DS=initial-descope-jwt; keep=value",
					},
					body: "{}",
				},
			),
			env,
			provisioned,
		);
		expect(bootstrap.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get("Authorization")).toBe(
			"Bearer attacker-selected",
		);
		expect(seen[0]?.headers.get("Cookie")).toBeNull();

		const bearerBootstrap = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/api/rpc/organizations/getMyOrganization",
				{
					method: "POST",
					headers: { Authorization: "Bearer just-issued-descope-jwt" },
					body: "{}",
				},
			),
			env,
			provisioned,
		);
		expect(bearerBootstrap.status).toBe(200);
		expect(seen).toHaveLength(2);
		expect(seen[1]?.headers.get("Authorization")).toBe(
			"Bearer just-issued-descope-jwt",
		);

		const cliBootstrap = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/cli/api/rpc/organizations/getMyOrganization",
				{
					method: "POST",
					headers: { Authorization: "Bearer just-issued-cli-descope-jwt" },
					body: "{}",
				},
			),
			env,
			provisioned,
		);
		expect(cliBootstrap.status).toBe(200);
		expect(seen).toHaveLength(3);
		expect(seen[2]?.headers.get("Authorization")).toBe(
			"Bearer just-issued-cli-descope-jwt",
		);

		const invitationAcceptance = await handleOsRequest(
			new Request("https://os.tedix.dev/api/rpc/members/acceptInvitation", {
				method: "POST",
				headers: { Authorization: "Bearer just-issued-invitation-jwt" },
				body: "{}",
			}),
			env,
			provisioned,
		);
		expect(invitationAcceptance.status).toBe(200);
		expect(seen).toHaveLength(4);
		expect(seen[3]?.headers.get("Authorization")).toBe(
			"Bearer just-issued-invitation-jwt",
		);

		const ordinary = await handleOsRequest(
			new Request("https://os.tedix.dev/api/rpc/organizations/listOsMine", {
				method: "POST",
				headers: { Cookie: "DS=initial-descope-jwt" },
				body: "{}",
			}),
			env,
			provisioned,
		);
		expect(ordinary.status).toBe(401);

		const ordinaryCli = await handleOsRequest(
			new Request("https://os.tedix.dev/cli/api/rpc/organizations/listOsMine", {
				method: "POST",
				headers: { Authorization: "Bearer just-issued-cli-descope-jwt" },
				body: "{}",
			}),
			env,
			provisioned,
		);
		expect(ordinaryCli.status).toBe(401);
		expect(seen).toHaveLength(4);
	});

	it("requires a product session for ordinary API routes at the launcher", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: {
				fetch: async (request) => {
					seen.push(request);
					return new Response("shell");
				},
			},
			API_SERVICE: {
				fetch: async (request) => {
					seen.push(request);
					return new Response("api");
				},
			},
		};
		const response = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/api/rpc/kernelRuntime/listConversations",
			),
			env,
			provisioned,
		);
		expect(response.status).toBe(401);
		expect(seen).toHaveLength(0);
	});

	it("redirects CLI authorization from a tenant host to the apex", async () => {
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/cli/login?port=42123&state=abc"),
			withApiService(envRecordingRequests()),
			provisioned,
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://os.tedix.dev/cli/login?port=42123&state=abc",
		);
	});

	it("relays the exact CLI OAuth callback to its state-bound loopback port", async () => {
		const response = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/cli/oauth/callback?code=code-1&state=nonce.49152&iss=https%3A%2F%2Fauth.tedix.dev",
			),
			assetsReturning("not reached"),
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"http://127.0.0.1:49152/callback?code=code-1&iss=https%3A%2F%2Fauth.tedix.dev&state=nonce.49152",
		);
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
	});

	it("keeps the CLI picker session isolated from OS launcher and tenant APIs", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (request) => {
					seen.push(request);
					return Response.json({ organizations: [] });
				},
			},
		};

		const osCookieOnCli = await handleOsRequest(
			new Request("https://os.tedix.dev/cli/api/rpc/organizations/listMine", {
				method: "POST",
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=os-jwt` },
				body: "{}",
			}),
			env,
			provisioned,
		);
		expect(osCookieOnCli.status).toBe(401);

		const cliCookieOnOs = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/api/rpc/osWorkspaces/list", {
				method: "POST",
				headers: { Cookie: `${CLI_BROKER_SESSION_COOKIE}=cli-jwt` },
				body: "{}",
			}),
			env,
			provisionedWithTenant,
		);
		expect(cliCookieOnOs.status).toBe(401);

		const cli = await handleOsRequest(
			new Request("https://os.tedix.dev/cli/api/rpc/organizations/listMine", {
				method: "POST",
				headers: { Cookie: `${CLI_BROKER_SESSION_COOKIE}=cli-jwt` },
				body: "{}",
			}),
			env,
			provisioned,
		);
		expect(cli.status).toBe(200);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.headers.get("Cookie")).toBe("DS=cli-jwt");
	});

	it("serves the shell for a provisioned tenant host", async () => {
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/", {
				headers: {
					Accept: "text/html",
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
				},
			}),
			withApiService(assetsReturning("shell")),
			provisioned,
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("shell");
	});

	it("leaves tenant HTML free of session-cookie mutations", async () => {
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/", {
				headers: {
					Accept: "text/html",
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
				},
			}),
			withApiService(assetsReturning("shell")),
			provisioned,
		);
		const setCookies = response.headers.getSetCookie();
		expect(setCookies).toHaveLength(0);

		const apex = await handleOsRequest(
			new Request("https://os.tedix.dev/"),
			assetsReturning("shell"),
			provisioned,
		);
		expect(apex.headers.getSetCookie()).toHaveLength(0);
	});

	it("routes tenant documents through the product broker when dct differs", async () => {
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/workspace/1", {
				headers: {
					Accept: "text/html",
					Cookie: `${OS_BROKER_SESSION_COOKIE}=header.eyJkY3QiOiJULW90aGVyIn0.signature`,
				},
			}),
			withApiService(assetsReturning("shell")),
			provisionedWithTenant,
		);
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://acme.os.tedix.dev/auth/session-broker/continue?redirect_to=%2Fworkspace%2F1",
		);
	});

	it("serves a tenant document only when its product cookie matches", async () => {
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/", {
				headers: {
					Accept: "text/html",
					Cookie: `DS=header.eyJkY3QiOiJULW90aGVyIn0.signature; ${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
				},
			}),
			withApiService(assetsReturning("shell")),
			provisionedWithTenant,
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("shell");
	});

	it("refuses an unprovisioned slug without touching assets", async () => {
		const env = withApiService(envRecordingRequests());
		const response = await handleOsRequest(
			new Request("https://squatter.os.tedix.dev/"),
			env,
			unprovisioned,
		);
		expect(response.status).toBe(404);
		expect(env.seen).toHaveLength(0);
	});

	it("fails closed with 503 when resolution is unavailable", async () => {
		const env = withApiService(envRecordingRequests());
		const response = await handleOsRequest(
			new Request("https://anyone.os.tedix.dev/"),
			env,
			failing,
		);
		expect(response.status).toBe(503);
		expect(env.seen).toHaveLength(0);
	});

	it("skips provisioning enforcement only when the binding is absent (local lane)", async () => {
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/"),
			assetsReturning("shell"),
			failing,
		);
		expect(response.status).toBe(200);
	});

	it("proxies /api/* with only the product session and the host tenant", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (proxied: Request) => {
					seen.push(proxied);
					return new Response('{"conversations":[]}', {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				},
			},
		};
		const response = await handleOsRequest(
			new Request(
				"https://acme.os.tedix.dev/api/rpc/kernelRuntime/listConversations?x=1",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer attacker-selected",
						Cookie: `DS=stale; keep=value; ${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
						// A client-supplied override must never reach apps/api.
						"X-Tedix-Tenant-Id": "T-evil",
					},
					body: '{"json":{}}',
				},
			),
			env,
			provisioned,
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe('{"conversations":[]}');
		expect(seen).toHaveLength(1);
		const proxied = seen[0] as Request;
		expect(proxied.url).toBe(
			"https://api/rpc/kernelRuntime/listConversations?x=1",
		);
		expect(proxied.method).toBe("POST");
		expect(proxied.headers.get("Authorization")).toBeNull();
		expect(proxied.headers.get("Cookie")).toBe(
			`keep=value; DS=${HOST_SESSION}`,
		);
		expect(proxied.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
	});

	it("exchanges the httpOnly product session for the scoped WS-token mint", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (proxied: Request) => {
					seen.push(proxied);
					return Response.json({ token: "scoped-token" });
				},
			},
		};
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/api/kernel/ws-token", {
				headers: {
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
				},
			}),
			env,
			provisionedWithTenant,
		);
		expect(response.status).toBe(200);
		expect(seen).toHaveLength(1);
		const proxied = seen[0] as Request;
		expect(proxied.url).toBe("https://api/kernel/ws-token");
		expect(proxied.headers.get("Authorization")).toBe(`Bearer ${HOST_SESSION}`);
		expect(proxied.headers.get("Cookie")).toBeNull();
		expect(proxied.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
	});

	it("buffers the bounded multipart dictation upload across the service binding", async () => {
		let proxied: Request | undefined;
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (request: Request) => {
					proxied = request;
					return Response.json({ text: "Voice test" });
				},
			},
		};
		const body = new FormData();
		body.append(
			"file",
			new Blob(["recorded-audio"], { type: "audio/webm" }),
			"dictation.webm",
		);
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/api/kernel/voice/transcribe", {
				method: "POST",
				headers: {
					Authorization: "Bearer scoped-kernel-token",
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
				},
				body,
			}),
			env,
			provisionedWithTenant,
		);
		expect(response.status).toBe(200);
		expect(proxied?.url).toBe("https://api/kernel/voice/transcribe");
		expect(proxied?.headers.get("Authorization")).toBe(
			"Bearer scoped-kernel-token",
		);
		const forwarded = await proxied?.formData();
		const file = forwarded?.get("file");
		expect(file).toBeInstanceOf(File);
		expect(await (file as File).text()).toBe("recorded-audio");
	});

	it("asserts the HOST org tenant on proxied requests, replacing client lies", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (proxied: Request) => {
					seen.push(proxied);
					return new Response("{}", {
						headers: { "Content-Type": "application/json" },
					});
				},
			},
		};
		await handleOsRequest(
			new Request("https://acme.os.tedix.dev/api/rpc/anything", {
				method: "POST",
				headers: {
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
					// The client's claimed tenant must NEVER survive.
					"X-Tedix-Tenant-Id": "T-evil",
				},
				body: "{}",
			}),
			env,
			provisionedWithTenant,
		);
		expect(seen).toHaveLength(1);
		expect((seen[0] as Request).headers.get("X-Tedix-Tenant-Id")).toBe(
			"T-host-org",
		);
	});

	it("refuses a mismatched product session before the API binding", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (proxied: Request) => {
					seen.push(proxied);
					return new Response("{}");
				},
			},
		};
		const response = await handleOsRequest(
			new Request("https://acme.os.tedix.dev/api/rpc/anything", {
				method: "POST",
				headers: {
					Cookie: `${OS_BROKER_SESSION_COOKIE}=header.eyJkY3QiOiJULW90aGVyIn0.signature`,
				},
				body: "{}",
			}),
			env,
			provisionedWithTenant,
		);

		expect(response.status).toBe(401);
		expect(seen).toHaveLength(0);
	});

	it("strips every browser-supplied internal-trust marker before forwarding to apps/api", async () => {
		const seen: Request[] = [];
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (proxied: Request) => {
					seen.push(proxied);
					return new Response("{}", {
						headers: { "Content-Type": "application/json" },
					});
				},
			},
		};
		await handleOsRequest(
			new Request("https://acme.os.tedix.dev/api/rpc/anything", {
				method: "POST",
				headers: {
					Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
					// A browser forging the internal service-binding trust set. None
					// of these may survive to the trusted apps/api binding, or a
					// future Host/CF-Connecting-IP refactor turns them into a
					// cross-tenant authority grant.
					"X-Service-Binding": "true",
					"X-Tedix-Caller-Type": "mcp-edge-external-agent",
					"X-Tedix-Tedi-Id": "tedi-victim",
					"X-Tedix-Tedi-Scopes": "platform:admin",
					"X-Tedix-Acting-User": "U-attacker",
					"X-Tedix-Admin-Token": "forged",
					"X-Tedix-External-Agent-Principal-Id": "P-forged",
					"x-tedix-auth-type": "service",
				},
				body: "{}",
			}),
			env,
			provisionedWithTenant,
		);
		expect(seen).toHaveLength(1);
		const proxied = seen[0] as Request;
		expect(proxied.headers.get("X-Service-Binding")).toBeNull();
		expect(proxied.headers.get("X-Tedix-Caller-Type")).toBeNull();
		expect(proxied.headers.get("X-Tedix-Tedi-Id")).toBeNull();
		expect(proxied.headers.get("X-Tedix-Tedi-Scopes")).toBeNull();
		expect(proxied.headers.get("X-Tedix-Acting-User")).toBeNull();
		expect(proxied.headers.get("X-Tedix-Admin-Token")).toBeNull();
		expect(
			proxied.headers.get("X-Tedix-External-Agent-Principal-Id"),
		).toBeNull();
		expect(proxied.headers.get("x-tedix-auth-type")).toBeNull();
		// The worker still asserts the host org tenant, so apps/api resolves the
		// caller's OWN cookie identity (authType="user") in the host org — never a
		// forged service-binding principal.
		expect(proxied.headers.get("X-Tedix-Tenant-Id")).toBe("T-host-org");
	});

	it("passes SSE responses through the proxy as a stream with resume headers intact", async () => {
		const body = 'id: home:main:0\ndata: {"kind":"run.started"}\n\n';
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (proxied: Request) => {
					expect(proxied.headers.get("Last-Event-ID")).toBe("home:main:4");
					return new Response(body, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-store",
						},
					});
				},
			},
		};
		const response = await handleOsRequest(
			new Request(
				"https://acme.os.tedix.dev/api/kernel/runtime/conversations/home:main/events/stream",
				{
					headers: {
						"Last-Event-ID": "home:main:4",
						Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}`,
					},
				},
			),
			env,
			provisioned,
		);
		expect(response.headers.get("Content-Type")).toBe("text/event-stream");
		await expect(response.text()).resolves.toBe(body);
	});

	it("gates the proxy behind provisioning and refuses it on the local lane", async () => {
		const env: OsRouterEnv = {
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: { fetch: async () => new Response("unreachable") },
		};
		const gated = await handleOsRequest(
			new Request("https://squatter.os.tedix.dev/api/rpc/anything"),
			env,
			unprovisioned,
		);
		expect(gated.status).toBe(404);

		const local = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/api/rpc/anything", {
				headers: { Cookie: `${OS_BROKER_SESSION_COOKIE}=${HOST_SESSION}` },
			}),
			assetsReturning("shell"),
			failing,
		);
		expect(local.status).toBe(503);
	});

	it("refuses a hostname outside the managed OS suffix", async () => {
		const env = envRecordingRequests();
		const response = await handleOsRequest(
			new Request("https://evil.example.com/"),
			env,
		);
		expect(response.status).toBe(404);
		// The shell must not be reachable at all — not merely unauthenticated.
		expect(env.seen).toHaveLength(0);
	});

	it("refuses a malformed slug without touching assets", async () => {
		const env = envRecordingRequests();
		const response = await handleOsRequest(
			new Request("https://-bad-.os.tedix.dev/"),
			env,
		);
		expect(response.status).toBe(404);
		expect(env.seen).toHaveLength(0);
	});

	it("serves the launcher SPA for the os.tedix.dev apex without resolving a tenant", async () => {
		const response = await handleOsRequest(
			new Request("https://os.tedix.dev/cli/login?port=8976&state=s"),
			assetsReturning("launcher shell"),
		);
		expect(response.status).toBe(200);
		// Security headers apply to the launcher too.
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
	});

	it("serves local development hosts", async () => {
		for (const url of [
			"http://localhost:3010/",
			"http://acme.localhost:3010/canvas",
		]) {
			const response = await handleOsRequest(
				new Request(url),
				assetsReturning("shell"),
			);
			expect(response.status).toBe(200);
		}
	});

	it("sets security headers on asset responses, not only on refusals", async () => {
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/"),
			assetsReturning("shell"),
		);
		expect(response.headers.get("X-Frame-Options")).toBe("DENY");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Cache-Control")).toBe("private, no-store");
		expect(response.headers.get("Referrer-Policy")).toBe(
			"strict-origin-when-cross-origin",
		);
	});

	it("allows only the sandbox proxy asset to frame on the same OS origin", async () => {
		for (const path of ["/sandbox_proxy", "/sandbox_proxy.html?csp=%7B%7D"]) {
			const response = await handleOsRequest(
				new Request(`https://tedix.os.tedix.dev${path}`),
				assetsReturning("sandbox proxy"),
			);
			expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
			expect(response.headers.get("Content-Security-Policy")).toBe(
				"frame-ancestors 'self'",
			);
		}

		const ordinaryAsset = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/canvas"),
			assetsReturning("shell"),
		);
		expect(ordinaryAsset.headers.get("X-Frame-Options")).toBe("DENY");
	});

	it("preserves the upstream asset status and content type", async () => {
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/missing"),
			assetsReturning("not found", 404),
		);
		expect(response.status).toBe(404);
		expect(response.headers.get("Content-Type")).toBe(
			"text/html; charset=utf-8",
		);
	});

	it("passes the original request through to assets unchanged", async () => {
		const env = envRecordingRequests();
		await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/workspace/workspace-1?a=1"),
			env,
		);
		expect(env.seen).toHaveLength(1);
		expect(env.seen[0]?.url).toBe(
			"https://tedix.os.tedix.dev/workspace/workspace-1?a=1",
		);
	});
});

describe("collaboration socket routing", () => {
	const upgradeHeaders = { Upgrade: "websocket" };
	const outputId = "11111111-1111-4111-8111-111111111111";
	const revisionId = "22222222-2222-4222-8222-222222222222";
	const outputDocKey = `output:${outputId}`;

	function collabEnv(options: { authorized: boolean }): OsRouterEnv & {
		apiRequests: Request[];
		roomRequests: Request[];
		roomNames: string[];
	} {
		const apiRequests: Request[] = [];
		const roomRequests: Request[] = [];
		const roomNames: string[] = [];
		return {
			apiRequests,
			roomRequests,
			roomNames,
			ASSETS: { fetch: async () => new Response("shell") },
			API_SERVICE: {
				fetch: async (request: Request) => {
					apiRequests.push(request);
					return options.authorized
						? new Response(
								JSON.stringify({
									json: {
										output: { id: outputId, workspaceId: "ws-1" },
										currentRevision: {
											id: revisionId,
											revision: 2,
											content: {
												kind: "document",
												blocks: [{ type: "paragraph", text: "Canonical" }],
											},
										},
									},
								}),
								{ headers: { "Content-Type": "application/json" } },
							)
						: new Response("forbidden", { status: 403 });
				},
			},
			COLLAB_ROOM: {
				idFromName: (name: string) => {
					roomNames.push(name);
					return name;
				},
				get: () => ({
					fetch: async (request: Request) => {
						roomRequests.push(request);
						// workerd would return 101; undici refuses <200, so a stand-in body marks the room hit.
						return new Response("room-upgrade", { status: 200 });
					},
				}),
			},
		};
	}

	it("routes an authorized upgrade to the workspace room", async () => {
		const env = collabEnv({ authorized: true });
		const response = await handleOsRequest(
			new Request(
				`https://tedix.os.tedix.dev/collab/ws-1/${encodeURIComponent(outputDocKey)}`,
				{
					headers: { ...upgradeHeaders, "X-API-Key": "sk_external" },
				},
			),
			env,
			provisioned,
		);
		await expect(response.text()).resolves.toBe("room-upgrade");
		// ONE request reaches the DO: the upgrade. The canonical body no longer
		// crosses this hop — the room's base is seeded by the client handshake.
		expect(env.roomRequests).toHaveLength(1);
		expect(env.roomNames).toEqual([`tedix:ws-1:${outputDocKey}`]);
		expect(env.apiRequests[0]?.headers.get("X-API-Key")).toBe("sk_external");
		const upgrade = env.roomRequests[0];
		expect(upgrade?.headers.get("Cookie")).toBeNull();
		expect(upgrade?.headers.get("Authorization")).toBeNull();
		expect(upgrade?.headers.get("X-API-Key")).toBeNull();
		expect(upgrade?.headers.get("X-Tedix-Collab-Verified-Session")).toBeNull();
		expect(
			JSON.parse(upgrade?.headers.get("X-Tedix-Collab-Presence") ?? "null"),
		).toMatchObject({
			displayName: "Local collaborator",
			kind: "human",
			role: "owner",
			verified: true,
		});
	});

	it("routes the generated loopback demo through the local room without exposing credentials", async () => {
		const env = {
			...collabEnv({ authorized: true }),
			DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
			TEDIX_LOCAL_DEMO_ENABLED: "true",
		};
		const response = await handleOsRequest(
			new Request(
				`http://localhost:3030/collab/ws-1/${encodeURIComponent(outputDocKey)}`,
				{
					headers: upgradeHeaders,
				},
			),
			env,
			unprovisioned,
		);

		await expect(response.text()).resolves.toBe("room-upgrade");
		expect(env.roomNames).toEqual([`local:ws-1:${outputDocKey}`]);
		expect(env.apiRequests[0]?.headers.get("Authorization")).toBe(
			`Bearer ${LOCAL_DEMO_TOKEN}`,
		);
		const upgrade = env.roomRequests[0];
		expect(upgrade?.headers.get("Authorization")).toBeNull();
		expect(upgrade?.headers.get("Cookie")).toBeNull();
		expect(upgrade?.headers.get("X-API-Key")).toBeNull();
	});

	it("does not enable the local demo credential on a non-loopback origin", async () => {
		const env = {
			...collabEnv({ authorized: true }),
			DESCOPE_PROJECT_ID: LOCAL_DEMO_PROJECT_ID,
			TEDIX_LOCAL_DEMO_ENABLED: "true",
		};
		const response = await handleOsRequest(
			new Request(
				`https://example.com/collab/ws-1/${encodeURIComponent(outputDocKey)}`,
				{
					headers: upgradeHeaders,
				},
			),
			env,
			unprovisioned,
		);

		expect(response.status).toBe(404);
		expect(env.apiRequests).toHaveLength(0);
		expect(env.roomRequests).toHaveLength(0);
	});

	it("refuses when apps/api denies the workspace read", async () => {
		const env = collabEnv({ authorized: false });
		const response = await handleOsRequest(
			new Request(
				`https://tedix.os.tedix.dev/collab/ws-1/${encodeURIComponent(outputDocKey)}`,
				{
					headers: upgradeHeaders,
				},
			),
			env,
			provisioned,
		);
		expect(response.status).toBe(403);
		expect(env.roomRequests).toHaveLength(0);
	});

	it("refuses a non-upgrade request", async () => {
		const env = collabEnv({ authorized: true });
		const response = await handleOsRequest(
			new Request(
				`https://tedix.os.tedix.dev/collab/ws-1/${encodeURIComponent(outputDocKey)}`,
			),
			env,
			provisioned,
		);
		expect(response.status).toBe(426);
	});

	it("refuses a malformed room path", async () => {
		const env = collabEnv({ authorized: true });
		const response = await handleOsRequest(
			new Request("https://tedix.os.tedix.dev/collab/ws-1", {
				headers: upgradeHeaders,
			}),
			env,
			provisioned,
		);
		expect(response.status).toBe(404);
	});

	it("refuses on the launcher host", async () => {
		const env = collabEnv({ authorized: true });
		const response = await handleOsRequest(
			new Request(
				`https://os.tedix.dev/collab/ws-1/${encodeURIComponent(outputDocKey)}`,
				{
					headers: upgradeHeaders,
				},
			),
			env,
			provisioned,
		);
		expect(response.status).toBe(404);
	});
});

describe("oRPC refusals are parseable by the oRPC client", () => {
	// `/api/rpc/*` is an oRPC transport. A `text/plain` refusal reaches the
	// caller as "Malformed Orpc Error Response", not as its reason — so a 401, a
	// 404 and a 503 all look identical. That masking is why a broken cookie
	// handoff on the first-organization bootstrap surfaced to the user only as a
	// generic `session_unavailable` redirect: the 401 could not be read by the
	// code that had to report it.
	const provisioned: TenantResolver = async () => ({
		provisioned: true,
		descopeTenantId: "tenant-1",
	});

	it("returns a JSON oRPC error envelope for an unauthenticated rpc call", async () => {
		const response = await handleOsRequest(
			new Request(
				"https://os.tedix.dev/api/rpc/organizations/getMyOrganization",
				{
					method: "POST",
				},
			),
			{
				...withApiService(envRecordingRequests()),
			},
			provisioned,
		);

		expect(response.status).toBe(401);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		// The exact shape apps/api returns for the same condition, so the client
		// parses a proxy refusal exactly as it parses an origin one.
		const body = (await response.json()) as {
			json?: { code?: string; message?: string };
		};
		expect(body.json?.code).toBe("UNAUTHORIZED");
		expect(body.json?.message).toBe("Authentication required.");
	});

	it("does not emit a JSON envelope for non-rpc paths", async () => {
		// Document navigations and asset routes must keep their existing shape;
		// only the oRPC transport gets the envelope.
		const response = await handleOsRequest(
			new Request("https://os.tedix.dev/capn", {
				headers: { Upgrade: "websocket" },
			}),
			withApiService(envRecordingRequests()),
			provisioned,
		);
		expect(response.headers.get("Content-Type")).toContain("text/plain");
	});
});
