import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ResolvedApp } from "../resolution";
const mocks = vi.hoisted(() => ({
	identity: vi.fn(),
	candidate: vi.fn(),
	bounded: vi.fn(),
}));
vi.mock("./server-factory", () => ({ extractCallerIdentity: mocks.identity }));
vi.mock("./tenant-profile-candidate", () => ({
	resolveTenantProfileCandidate: mocks.candidate,
	tenantProfileCandidateIsBounded: mocks.bounded,
}));
import { isTenantPolicyEdgeAdmission } from "./tenant-edge-policy";
import { enforceMcpAccess } from "../mcp-access";
const app = {
	app: { id: "root", slug: "gateway" },
	metadata: {},
	tools: [{ id: "row", toolId: "gateway__edit", config: { transport: "mcp" } }],
} as unknown as ResolvedApp;
const input = (body: unknown) => ({
	request: new Request("https://gateway.example/mcp", {
		method: "POST",
		body: JSON.stringify(body),
	}),
	app,
	env: {} as CloudflareEnv,
});
const call = {
	method: "tools/call",
	params: { name: "gateway__edit", arguments: { page: "one" } },
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.identity.mockReturnValue({ authType: "external_agent" });
	mocks.candidate.mockResolvedValue({ effect: { disposition: "allow" } });
	mocks.bounded.mockReturnValue(true);
});
describe("tenant policy edge admission", () => {
	it("admits only the exact server-resolved bounded call", async () => {
		expect(await isTenantPolicyEdgeAdmission(input(call))).toBe(true);
		expect(mocks.candidate).toHaveBeenCalledWith(
			expect.anything(),
			app.tools[0],
			{ page: "one" },
		);
		mocks.candidate.mockResolvedValue(null);
		expect(await isTenantPolicyEdgeAdmission(input(call))).toBe(false);
	});
	it("never trusts metadata, batch calls, missing verified identity or explicit scopes", async () => {
		expect(await isTenantPolicyEdgeAdmission(input([call]))).toBe(false);
		expect(
			await isTenantPolicyEdgeAdmission({
				...input(call),
				toolScopes: { gateway__edit: ["connections.admin"] },
			}),
		).toBe(false);
		expect(
			await isTenantPolicyEdgeAdmission({
				...input(call),
				toolScopes: { "*": ["connections.admin"] },
			}),
		).toBe(false);
		expect(
			await isTenantPolicyEdgeAdmission({
				...input(call),
				toolScopes: { edit: ["connections.admin"] },
			}),
		).toBe(false);
		mocks.identity.mockReturnValue(null);
		expect(
			await isTenantPolicyEdgeAdmission(
				input({ ...call, _meta: { verifiedBoundedCall: true } }),
			),
		).toBe(false);
		expect(mocks.candidate).not.toHaveBeenCalled();
	});
	it("uses only the separately verified organization selection", async () => {
		mocks.identity.mockReturnValue({ authType: "oauth", userId: "owner" });
		const organizations = [
			{
				organizationId: "org",
				gatewaySlug: "gateway",
				descopeTenantId: "tenant",
			},
		];
		await isTenantPolicyEdgeAdmission({
			...input(call),
			multiOrgSelection: { organizations },
		});
		expect(mocks.candidate).toHaveBeenCalledWith(
			expect.objectContaining({
				callerIdentity: expect.objectContaining({
					verifiedMultiOrgOrganizations: organizations,
				}),
			}),
			app.tools[0],
			{ page: "one" },
		);
	});
	it("lets an execute-scoped bounded call reach dispatch but denies it without the rule", async () => {
		const resolvedApp = {
			app: { id: "root", slug: "gateway", organizationId: "org" },
			metadata: { mcpConfig: { authMode: "authenticated" } },
			tools: [
				{
					...app.tools[0],
					authRequired: true,
					annotations: { destructiveHint: true },
					writeCapability: "destructive",
					config: {
						transport: "mcp",
						auth: { type: "connection", connectionId: "provider" },
					},
				},
			],
		} as unknown as ResolvedApp;
		const request = (body: unknown = call) =>
			new Request("https://gateway.example/mcp", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-tedix-auth-type": "external_agent",
					"x-tedix-auth-scopes": "connections.execute",
				},
				body: JSON.stringify(body),
			});
		const params = {
			hostname: "gateway.example",
			resolvedApp,
			env: {} as CloudflareEnv,
			oauthJwtPayload: null,
			isDev: false,
		};
		expect(
			await enforceMcpAccess({ ...params, request: request() }),
		).toBeNull();
		mocks.candidate.mockImplementation(async (_agent, _tool, args) =>
			args.page === "one" ? { effect: { disposition: "allow" } } : null,
		);
		expect(
			(
				await enforceMcpAccess({
					...params,
					request: request({
						...call,
						params: { ...call.params, arguments: { page: "other" } },
					}),
				})
			)?.reason,
		).toBe("insufficient_scope");
		const explicitApp = {
			...resolvedApp,
			metadata: {
				mcpConfig: {
					authMode: "authenticated",
					toolScopes: {
						gateway__edit: ["connections.execute", "connections.admin"],
					},
				},
			},
		} as unknown as ResolvedApp;
		expect(
			(
				await enforceMcpAccess({
					...params,
					resolvedApp: explicitApp,
					request: request(),
				})
			)?.reason,
		).toBe("insufficient_scope");
		mocks.candidate.mockResolvedValue(null);
		expect(
			(await enforceMcpAccess({ ...params, request: request() }))?.reason,
		).toBe("insufficient_scope");
	});
});
