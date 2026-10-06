import { describe, expect, it, vi } from "vite-plus/test";

import worker, {
	handleMcpRequest,
	readAggregateActivationEpoch,
	writeAggregateActivationEpoch,
} from "./index";

const { resolveGateway } = vi.hoisted(() => ({ resolveGateway: vi.fn() }));
vi.mock("./resolution", async (importOriginal) => ({
	...(await importOriginal<typeof import("./resolution")>()),
	resolveAppFromHostname: resolveGateway,
}));

vi.mock("./auth-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("./auth-helpers")>()),
	validateAuth: vi.fn(async () => ({
		type: "oauth",
		userId: "human",
		organizationId: "hosting-org",
		scopes: [],
		payload: { sub: "human", dct: "org_tedix" },
	})),
	validateHumanMcpSelection: vi.fn(async () => ({
		organizations: [
			{
				organizationId: "org-id",
				descopeTenantId: "org_tedix",
				gatewaySlug: "tedix-unified",
			},
		],
	})),
	resolveAihM2mClientScopeContext: vi.fn(async () => null),
}));

function createEnv(overrides: Record<string, unknown> = {}) {
	return {
		...overrides,
	} as unknown as CloudflareEnv;
}

describe("aggregate activation epoch revision plane", () => {
	it("prefers the KV Instant pointer without reading the R2 fallback", async () => {
		const instantGet = vi.fn(async () => "instant-epoch");
		const r2Get = vi.fn(async () => new Response("r2-epoch"));
		const env = createEnv({
			AGGREGATE_EPOCH_KV: { get: instantGet },
			AGGREGATE_CACHE: { get: r2Get },
		});

		await expect(readAggregateActivationEpoch(env)).resolves.toEqual({
			value: "instant-epoch",
			cacheable: true,
		});
		expect(instantGet).toHaveBeenCalledWith("aggregate-activation/v1/current");
		expect(r2Get).not.toHaveBeenCalled();
	});

	it.each([
		["missing", async () => null],
		["invalid", async () => "bad\nepoch"],
		["unavailable", async () => Promise.reject(new Error("private detail"))],
	])("falls back to R2 when KV Instant is %s", async (_case, getInstant) => {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const r2Get = vi.fn(async () => new Response("r2-fallback-epoch"));
		const env = createEnv({
			AGGREGATE_EPOCH_KV: { get: vi.fn(getInstant) },
			AGGREGATE_CACHE: { get: r2Get },
		});

		await expect(readAggregateActivationEpoch(env)).resolves.toEqual({
			value: "r2-fallback-epoch",
			cacheable: true,
		});
		expect(r2Get).toHaveBeenCalledWith("aggregate-activation/v1/current");
		expect(JSON.stringify(warnings.mock.calls)).not.toContain("private detail");
		warnings.mockRestore();
	});

	it("writes the pointer to KV Instant and R2 before snapshots are purged", async () => {
		const instantPut = vi.fn(async () => undefined);
		const r2Put = vi.fn(async () => undefined);
		const env = createEnv({
			AGGREGATE_EPOCH_KV: { put: instantPut },
			AGGREGATE_CACHE: { put: r2Put },
		});

		await writeAggregateActivationEpoch(env, "next-epoch");

		expect(instantPut).toHaveBeenCalledWith(
			"aggregate-activation/v1/current",
			"next-epoch",
		);
		expect(r2Put).toHaveBeenCalledWith(
			"aggregate-activation/v1/current",
			"next-epoch",
		);
	});

	it("removes an old Instant pointer and keeps the R2 fallback when its write fails", async () => {
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const instantDelete = vi.fn(async () => undefined);
		const r2Put = vi.fn(async () => undefined);
		const env = createEnv({
			AGGREGATE_EPOCH_KV: {
				put: vi.fn(async () => Promise.reject(new Error("private detail"))),
				delete: instantDelete,
			},
			AGGREGATE_CACHE: { put: r2Put },
		});

		await expect(
			writeAggregateActivationEpoch(env, "fallback-epoch"),
		).resolves.toBeUndefined();
		expect(r2Put).toHaveBeenCalledWith(
			"aggregate-activation/v1/current",
			"fallback-epoch",
		);
		expect(instantDelete).toHaveBeenCalledWith(
			"aggregate-activation/v1/current",
		);
		expect(JSON.stringify(warnings.mock.calls)).not.toContain("private detail");
		warnings.mockRestore();
	});
});

describe("Connect compact protocol organization routing", () => {
	const organization = {
		organizationId: "org-id",
		descopeTenantId: "org_tedix",
		gatewaySlug: "tedix-unified",
	};
	const connect = {
		app: { id: "connect", slug: "connect", name: "Tedix Connect" },
		metadata: { mcpConfig: { codeMode: true, multiOrgConsent: true } },
		tools: [],
	} as never;
	const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext;
	function request(method: string, target?: string) {
		return new Request("https://connect.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"MCP-Protocol-Version": "2026-07-28",
				"Mcp-Method": method,
				"x-tedix-auth-type": "oauth",
				"x-tedix-auth-user-id": "human",
				"x-tedix-auth-org-id": "hosting-org",
				...(target === undefined ? {} : { "X-Tedix-Organization": target }),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method,
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {
							extensions: { "io.modelcontextprotocol/tasks": {} },
						},
					},
				},
			}),
		});
	}
	it.each(["server/discover", "tools/list"])(
		"routes %s to the selected gateway before compact responses",
		async (method) => {
			resolveGateway.mockResolvedValue({
				app: {
					id: "gateway",
					slug: "tedix-unified",
					name: "Tedix",
					organizationId: "org-id",
				},
				metadata: {
					mcpConfig: {
						codeMode: true,
						authMode: "authenticated",
						enforcePolicies: false,
					},
				},
				tools: [],
			});
			const response = await handleMcpRequest(
				request(method, "tedix"),
				connect,
				createEnv(),
				ctx,
				{ organizations: [organization] },
			);
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				result: Record<string, unknown>;
			};
			if (method === "server/discover") {
				expect(body.result).toMatchObject({
					supportedVersions: ["2026-07-28"],
					capabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } },
					_meta: {
						"io.modelcontextprotocol/serverInfo": { name: "Tedix MCP" },
					},
				});
			} else {
				expect(JSON.stringify(body.result)).toContain(
					"tedix-unified Code Mode surface",
				);
			}
		},
	);
	it.each(["server/discover", "tools/list"])(
		"rejects an unselected organization before %s",
		async (method) => {
			resolveGateway.mockClear();
			const response = await handleMcpRequest(
				request(method, "unselected"),
				connect,
				createEnv(),
				ctx,
				{ organizations: [organization] },
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual(
				expect.objectContaining({ error: "organization_target_invalid" }),
			);
			expect(resolveGateway).not.toHaveBeenCalled();
		},
	);
	it("does not advertise Home Tasks on untargeted Connect", async () => {
		const response = await handleMcpRequest(
			request("server/discover"),
			connect,
			createEnv(),
			ctx,
			{ organizations: [organization] },
		);
		const body = (await response.json()) as {
			result: { capabilities: { extensions: Record<string, unknown> } };
		};
		expect(body.result.capabilities.extensions).not.toHaveProperty(
			"io.modelcontextprotocol/tasks",
		);
	});
	it.each(["tedix", "unselected"])(
		"routes the public fetch path for target %s before discovery",
		async (target) => {
			resolveGateway.mockImplementation(
				async ({ appSlug }: { appSlug: string }) =>
					appSlug === "connect"
						? {
								app: {
									id: "connect",
									slug: "connect",
									name: "Tedix Connect",
									organizationId: "hosting-org",
								},
								metadata: {
									mcpConfig: {
										codeMode: true,
										multiOrgConsent: true,
										authMode: "authenticated",
										descopeResourceId: "connect-resource",
										enforcePolicies: false,
									},
								},
								tools: [],
							}
						: {
								app: {
									id: "gateway",
									slug: "tedix-unified",
									name: "Tedix",
									organizationId: "org-id",
								},
								metadata: {
									mcpConfig: {
										codeMode: true,
										authMode: "authenticated",
										enforcePolicies: false,
									},
								},
								tools: [],
							},
			);
			const original = request("server/discover", target);
			const headers = new Headers(original.headers);
			headers.set("Authorization", "Bearer fixture");
			const response = await worker.fetch(
				new Request(original, { headers }),
				createEnv({
					ENVIRONMENT: "production",
					DESCOPE_PROJECT_ID: "Pfixture",
					MCP_URL: "https://mcp.tedix.dev",
				}),
				ctx,
			);
			const body = await response.json();
			expect(response.status, JSON.stringify(body)).toBe(
				target === "tedix" ? 200 : 403,
			);
			if (target === "tedix")
				expect(body).toMatchObject({
					result: {
						capabilities: {
							extensions: { "io.modelcontextprotocol/tasks": {} },
						},
					},
				});
			else expect(body).toMatchObject({ error: "organization_target_invalid" });
		},
	);
	it("requires a verified human grant before compact discovery", async () => {
		const response = await handleMcpRequest(
			request("server/discover", "tedix"),
			connect,
			createEnv(),
			ctx,
			null,
		);
		expect(response.status).toBe(403);
	});
});

describe("credential-free local MCP resource boundary", () => {
	it.each([false, true])(
		"keeps tenant matching after verified local authentication (wrong tenant %s)",
		async (wrongTenant) => {
			const { validateAuth } = await import("./auth-helpers");
			const actual =
				await vi.importActual<typeof import("./auth-helpers")>(
					"./auth-helpers",
				);
			const env = createEnv({
				ENVIRONMENT: "development",
				DESCOPE_PROJECT_ID: "local-development-disabled",
				MCP_URL: "http://localhost:3000",
				API_SERVICE: {
					fetch: vi.fn(async () =>
						Response.json({
							json: {
								descopeTenantId: wrongTenant
									? "other-tenant"
									: "personal_local-demo-owner",
							},
						}),
					),
				},
			});
			const request = new Request(
				"http://localhost:3000/mcp?appSlug=demo-unified",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer tedix-local-demo",
						"Content-Type": "application/json",
						"MCP-Protocol-Version": "2026-07-28",
						"Mcp-Method": "server/discover",
					},
					body: JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						method: "server/discover",
						params: {
							_meta: {
								"io.modelcontextprotocol/protocolVersion": "2026-07-28",
								"io.modelcontextprotocol/clientCapabilities": {},
								"io.modelcontextprotocol/clientInfo": {
									name: "local-proof",
									version: "1",
								},
							},
						},
					}),
				},
			);
			vi.mocked(validateAuth).mockResolvedValueOnce(
				await actual.validateAuth(request, env),
			);
			resolveGateway.mockResolvedValue({
				app: {
					id: "local-app",
					slug: "demo-unified",
					name: "Local",
					organizationId: wrongTenant
						? "wrong-local-org"
						: "matching-local-org",
				},
				metadata: {
					mcpConfig: {
						codeMode: true,
						authMode: "authenticated",
						enforcePolicies: false,
					},
				},
				tools: [],
			});
			const response = await worker.fetch(request, env, {
				waitUntil: vi.fn(),
			} as unknown as ExecutionContext);
			expect(
				response.status,
				JSON.stringify(await response.clone().json()),
			).toBe(wrongTenant ? 403 : 200);
		},
	);
	it("still requires a provider resource for ordinary OAuth despite a forged local header", async () => {
		resolveGateway.mockResolvedValue({
			app: {
				id: "cloud-app",
				slug: "cloud",
				name: "Cloud",
				organizationId: "cloud-org",
			},
			metadata: { mcpConfig: { codeMode: true, authMode: "authenticated" } },
			tools: [],
		});
		const request = new Request("https://cloud.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				Authorization: "Bearer fixture",
				"X-Tedix-Auth-Local-Demo": "true",
				"MCP-Protocol-Version": "2026-07-28",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "server/discover",
				params: {
					_meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
				},
			}),
		});
		const response = await worker.fetch(
			request,
			createEnv({
				ENVIRONMENT: "production",
				DESCOPE_PROJECT_ID: "Pfixture",
				MCP_URL: "https://mcp.tedix.dev",
			}),
			{ waitUntil: vi.fn() } as unknown as ExecutionContext,
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "human_mcp_resource_not_configured",
		});
	});
});
