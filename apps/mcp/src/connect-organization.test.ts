import { describe, expect, it } from "vite-plus/test";
import {
	organizationScopedRequest,
	resolveConnectOrganization,
	shouldBindHumanToTedi,
} from "./connect-organization";
import { enforceMcpAccess } from "./index";

const tedix = {
	organizationId: "id-tedix",
	descopeTenantId: "org_tedix",
	gatewaySlug: "tedix-unified",
};
const sample = {
	organizationId: "id-sample",
	descopeTenantId: "org_sample",
	gatewaySlug: "sample-unified",
};

describe("Connect organization targeting", () => {
	it("keeps verified Connect humans unbound while preserving ordinary app policy", () => {
		for (const config of [undefined, {}, { bindHumanToTedi: true }]) {
			expect(
				shouldBindHumanToTedi(config, { organizations: [tedix, sample] }),
			).toBe(false);
			expect(shouldBindHumanToTedi(config, null)).toBe(true);
		}
		expect(shouldBindHumanToTedi({ bindHumanToTedi: false }, null)).toBe(false);
	});
	it("resolves only one live-selected organization for auto and aliases", () => {
		expect(resolveConnectOrganization({ organizations: [tedix] }, "auto")).toBe(
			tedix,
		);
		for (const alias of ["id-tedix", "org_tedix", "tedix", "tedix-unified"]) {
			expect(
				resolveConnectOrganization({ organizations: [tedix, sample] }, alias),
			).toBe(tedix);
		}
	});
	it("rejects empty, unselected, ambiguous and multi-org automatic targets", () => {
		for (const target of ["", "unselected", "auto", "tedix "]) {
			expect(() =>
				resolveConnectOrganization({ organizations: [tedix, sample] }, target),
			).toThrow();
		}
		expect(() =>
			resolveConnectOrganization({ organizations: [] }, "auto"),
		).toThrow();
		expect(() =>
			resolveConnectOrganization(
				{ organizations: [tedix, { ...sample, gatewaySlug: "tedix" }] },
				"tedix",
			),
		).toThrow();
	});
	it("replaces authenticated organization context without modifying the original request", async () => {
		const request = new Request("https://connect.mcp.tedix.dev/mcp", {
			method: "POST",
			headers: {
				"X-Tedix-Organization": "tedix",
				"x-tedix-auth-org-id": "wrong",
				"x-tedix-auth-tedi-id": "hosting-org-tedi",
				"x-tedix-auth-user-id": "human-user",
				"x-tedix-auth-type": "oauth",
				"x-tedix-auth-scopes": "mcp:work.read",
			},
			body: "{}",
		});
		const scoped = organizationScopedRequest(request, tedix.organizationId);
		expect(scoped.headers.get("x-tedix-auth-org-id")).toBe(
			tedix.organizationId,
		);
		expect(scoped.headers.has("X-Tedix-Organization")).toBe(false);
		expect(scoped.headers.has("x-tedix-auth-tedi-id")).toBe(false);
		expect(scoped.headers.get("x-tedix-auth-user-id")).toBe("human-user");
		expect(scoped.headers.get("x-tedix-auth-type")).toBe("oauth");
		expect(request.headers.get("x-tedix-auth-tedi-id")).toBe(
			"hosting-org-tedi",
		);
		expect(scoped.headers.get("x-tedix-auth-scopes")).toBe("mcp:work.read");
		expect(request.headers.get("x-tedix-auth-org-id")).toBe("wrong");
		expect(await scoped.text()).toBe("{}");
	});
	it("only replaces active-tenant matching for the verified gateway on the Connect host", async () => {
		const resolvedApp = {
			app: {
				id: "gateway",
				name: "Tedix",
				slug: tedix.gatewaySlug,
				domain: null,
				organizationId: tedix.organizationId,
			},
			metadata: {
				mcpConfig: {
					authMode: "authenticated" as const,
					capabilities: [],
					enforcePolicies: false,
				},
			},
			tools: [],
		};
		const request = new Request("https://connect.mcp.tedix.dev/mcp", {
			headers: {
				"x-tedix-auth-type": "oauth",
				"x-tedix-auth-org-id": tedix.organizationId,
			},
		});
		const args = {
			request,
			hostname: "connect.mcp.tedix.dev",
			resolvedApp,
			env: {} as CloudflareEnv,
			oauthJwtPayload: null,
			multiOrgSelection: { organizations: [tedix] },
			isDev: false,
		};
		expect(await enforceMcpAccess(args)).toBeNull();
		for (const changed of [
			{ hostname: "tedix-unified.mcp.tedix.dev" },
			{ multiOrgSelection: { organizations: [sample] } },
			{
				resolvedApp: {
					...resolvedApp,
					app: { ...resolvedApp.app, organizationId: sample.organizationId },
				},
			},
		]) {
			expect(
				(await enforceMcpAccess({ ...args, ...changed }))?.response.status,
			).toBe(403);
		}
	});
	it("names only the configured default scopes in the sign-in challenge", async () => {
		const challenge = async (challengeScopes?: string[]) =>
			(
				await enforceMcpAccess({
					request: new Request("https://connect.mcp.tedix.dev/mcp", {
						method: "POST",
					}),
					hostname: "connect.mcp.tedix.dev",
					resolvedApp: {
						app: {
							id: "connect",
							name: "Tedix",
							slug: "connect",
							domain: null,
							organizationId: tedix.organizationId,
						},
						metadata: {
							mcpConfig: {
								authMode: "authenticated" as const,
								capabilities: [],
								enforcePolicies: false,
								toolScopes: { code: ["mcp:work.read", "platform:admin"] },
								...(challengeScopes ? { challengeScopes } : {}),
							},
						},
						tools: [],
					},
					env: {} as CloudflareEnv,
					oauthJwtPayload: null,
					multiOrgSelection: null,
					isDev: false,
				})
			)?.response.headers.get("WWW-Authenticate");
		expect(await challenge()).not.toContain("scope=");
		expect(await challenge(["mcp:work.read", "mcp:work.write"])).toContain(
			'scope="mcp:work.read mcp:work.write"',
		);
	});
});
