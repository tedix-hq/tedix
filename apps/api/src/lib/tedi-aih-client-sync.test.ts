import type { App } from "@tedix/db/schema/apps";
import { resolveTediScopes } from "@tedix/auth/app-assignment-policy";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ loadByUserId: vi.fn() }));

vi.mock("@tedix/auth/client", () => ({
	getManagementClient: () => ({
		management: { user: { loadByUserId: mocks.loadByUserId } },
	}),
}));

import {
	attestTediDescopeSubject,
	isTediCapabilityDowngrade,
	constrainToApprovedMcpServerScopes,
	resolveTediAihClientScopesForApp,
} from "./tedi-aih-client-sync";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("attestTediDescopeSubject", () => {
	it("returns non-secret proof for the canonical live Descope subject", async () => {
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: {
				userId: "U-reviewer",
				loginIds: ["tedi:code-reviewer", "code-reviewer@tedix.tech"],
				customAttributes: {
					tediId: "5eed0039-0000-4000-8000-000000000039",
					entityType: "tedi",
				},
			},
		});

		const result = await attestTediDescopeSubject(
			{
				DESCOPE_PROJECT_ID: "P-test",
				DESCOPE_MANAGEMENT_KEY: "K-test",
			},
			{
				id: "5eed0039-0000-4000-8000-000000000039",
				name: "Code Reviewer",
				slug: "code-reviewer",
				descopeUserId: "U-reviewer",
			},
		);

		expect(mocks.loadByUserId).toHaveBeenCalledWith("U-reviewer");
		expect(result).toMatchObject({
			source: "descope_management_api",
			subjectId: "U-reviewer",
			subjectIdMatches: true,
			expectedLoginId: "tedi:code-reviewer",
			loginIdPresent: true,
			entityTypeMatches: true,
			tediIdMatches: true,
			verified: true,
		});
		expect(result).not.toHaveProperty("customAttributes");
		expect(result).not.toHaveProperty("email");
	});

	it("fails closed when the live subject does not match the tedi", async () => {
		mocks.loadByUserId.mockResolvedValue({
			ok: true,
			data: {
				userId: "U-reviewer",
				loginIds: ["someone-else"],
				customAttributes: { tediId: "different", entityType: "human" },
			},
		});

		const result = await attestTediDescopeSubject(
			{
				DESCOPE_PROJECT_ID: "P-test",
				DESCOPE_MANAGEMENT_KEY: "K-test",
			},
			{
				id: "5eed0039-0000-4000-8000-000000000039",
				name: "Code Reviewer",
				slug: "code-reviewer",
				descopeUserId: "U-reviewer",
			},
		);

		expect(result).toMatchObject({
			verified: false,
			loginIdPresent: false,
			entityTypeMatches: false,
			tediIdMatches: false,
		});
	});
});

describe("constrainToApprovedMcpServerScopes", () => {
	it("keeps only scopes admitted by the target Descope Resource", () => {
		expect(
			constrainToApprovedMcpServerScopes(
				["mcp:work.admin", "mcp:settings.admin", "platform:admin"],
				{
					connectionsScopes: [
						{ name: "mcp:work.admin" },
						{ name: "platform:admin" },
					],
				},
			),
		).toEqual(["mcp:work.admin", "platform:admin"]);
	});
});

function appWithMcpConfig(mcpConfig: Record<string, unknown>): App {
	return {
		id: "app-1",
		name: "Test App",
		slug: "test-app",
		organizationId: "org-1",
		metadata: { mcpConfig },
	} as App;
}

describe("resolveTediAihClientScopesForApp", () => {
	it("combines tedi runtime and profile scopes for tedi MCP bridge operators", () => {
		const app = appWithMcpConfig({
			upstreamMcpUrl: "https://cto.tedi.tedix.dev/mcp",
		});

		const platformAdminScopes = resolveTediAihClientScopesForApp({
			app,
			role: "operator",
			tedi: { mcpCapabilityProfile: "platform_admin" },
		});
		expect(platformAdminScopes).toEqual(
			[...resolveTediScopes("platform_admin"), "tedi:admin"].sort(),
		);
		expect(platformAdminScopes).toContain("mcp:work.admin");

		const standardScopes = resolveTediAihClientScopesForApp({
			app,
			role: "operator",
			tedi: { mcpCapabilityProfile: "standard" },
		});
		expect(standardScopes).toEqual(
			[...resolveTediScopes("standard"), "tedi:admin"].sort(),
		);
		expect(standardScopes).not.toContain("mcp:work.admin");

		const observerScopes = resolveTediAihClientScopesForApp({
			app,
			role: "observer",
			tedi: { mcpCapabilityProfile: "platform_admin" },
		});
		expect(observerScopes).toContain("tedi:brain.read");
		expect(observerScopes).toContain("tedi:config.read");
		expect(observerScopes).not.toContain("tedi:admin");
		expect(observerScopes.every((scope) => scope.endsWith(".read"))).toBe(true);
	});

	it("keeps app MCP capability scopes for normal MCP apps", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-app",
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "operator",
				tedi: { mcpCapabilityProfile: "platform_admin" },
			}),
		).toEqual([...resolveTediScopes("platform_admin")].sort());
	});

	it("constrains app MCP capability scopes to the target app scope surface", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-globex",
			toolScopes: {
				content: ["mcp:content.write"],
				observe: ["mcp:observe.read"],
				settings: ["mcp:settings"],
			},
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "operator",
				tedi: { mcpCapabilityProfile: "platform_admin" },
			}),
		).toEqual([
			"connections.admin",
			"connections.execute",
			"mcp:content.write",
			"mcp:observe.read",
			"mcp:settings.admin",
			"mcp:settings.read",
			"mcp:settings.write",
		]);
	});

	it("includes platform-injected Work scopes for aggregate Tedi operators", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-acme",
			aggregateTedis: [{ slug: "acme-operator", namespace: "operator" }],
			toolScopes: {
				content: ["mcp:content.write"],
				observe: ["mcp:observe.read"],
			},
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "operator",
				tedi: { mcpCapabilityProfile: "standard" },
			}),
		).toEqual([
			"connections.execute",
			"mcp:content.write",
			"mcp:observe.read",
			"mcp:work.read",
			"mcp:work.write",
		]);
	});

	it("does not broaden aggregate Tedi observers to Work writes", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-acme",
			aggregateTedis: [{ slug: "acme-operator", namespace: "operator" }],
			toolScopes: { observe: ["mcp:observe.read"] },
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "observer",
				tedi: { mcpCapabilityProfile: "platform_admin" },
			}),
		).toEqual(["connections.read", "mcp:observe.read"]);
	});

	it("does not grant Work scopes for collaboration-only Tedi bridges", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-collaboration",
			aggregateTedis: [{ slug: "assistant", surface: "collaboration" }],
			toolScopes: { messaging: ["mcp:messaging.write"] },
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "operator",
				tedi: { mcpCapabilityProfile: "standard" },
			}),
		).toEqual(["connections.execute", "mcp:messaging.write"]);
	});

	it("keeps observer connection grants read-only", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-app",
			toolScopes: { content: ["mcp:content.write"] },
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "observer",
				tedi: { mcpCapabilityProfile: "platform_admin" },
			}),
		).toEqual(["connections.read"]);
	});

	it("does not grant profile-wide mcp scopes to connected-only aggregates", () => {
		const app = appWithMcpConfig({
			descopeResourceId: "MS-connected",
			connectionProviderId: "firecrawl",
			aggregateApps: [{ slug: "firecrawl" }],
		});

		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "operator",
				tedi: { mcpCapabilityProfile: "platform_admin" },
			}),
		).toEqual(["connections.admin", "connections.execute"]);
		expect(
			resolveTediAihClientScopesForApp({
				app,
				role: "observer",
				tedi: { mcpCapabilityProfile: "platform_admin" },
			}),
		).toEqual(["connections.read"]);
	});
});

describe("isTediCapabilityDowngrade", () => {
	// Downgrades are the security-critical direction — the managed AIH M2M
	// client(s) must shed the removed scopes, so the re-sync must fail CLOSED.
	it("flags org_admin -> standard (drops mcp:settings) as a downgrade", () => {
		expect(isTediCapabilityDowngrade("org_admin", "standard")).toBe(true);
	});

	it("flags platform_admin -> org_admin (drops platform:admin) as a downgrade", () => {
		expect(isTediCapabilityDowngrade("platform_admin", "org_admin")).toBe(true);
	});

	it("flags platform_admin -> standard as a downgrade", () => {
		expect(isTediCapabilityDowngrade("platform_admin", "standard")).toBe(true);
	});

	// Upgrades / lateral / no-op only ADD scope (or none). These stay
	// best-effort and must NOT be treated as downgrades.
	it("does not flag standard -> org_admin (an upgrade)", () => {
		expect(isTediCapabilityDowngrade("standard", "org_admin")).toBe(false);
	});

	it("does not flag org_admin -> platform_admin (an upgrade)", () => {
		expect(isTediCapabilityDowngrade("org_admin", "platform_admin")).toBe(
			false,
		);
	});

	it("does not flag an unchanged profile (no-op)", () => {
		expect(isTediCapabilityDowngrade("org_admin", "org_admin")).toBe(false);
	});

	// An unknown/null profile resolves to `standard` scopes on both sides, so a
	// null -> standard or standard -> null move is not a downgrade.
	it("treats null/unknown as the standard baseline (standard -> null is not a downgrade)", () => {
		expect(isTediCapabilityDowngrade("standard", null)).toBe(false);
		expect(isTediCapabilityDowngrade(null, "standard")).toBe(false);
	});

	it("flags org_admin -> null (drops mcp:settings vs the standard baseline)", () => {
		expect(isTediCapabilityDowngrade("org_admin", null)).toBe(true);
	});
});
