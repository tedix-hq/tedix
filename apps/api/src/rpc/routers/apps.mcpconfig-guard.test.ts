import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

// The guard resolves `getAppBySlug` from the direct app-records module and
// `getOrganizationById` from `@tedix/db/queries/organizations`. Override only
// those two functions via importOriginal so apps.ts's many other imports from
// those modules keep their real (pure) implementations. The privileged-key and
// platform-bypass paths never reach the db, so those tests are mock-agnostic.
const mocks = vi.hoisted(() => ({
	getAppById: vi.fn(),
	getAppBySlug: vi.fn(),
	getOrganizationById: vi.fn(),
}));

vi.mock("@tedix/db/queries/app-records", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		getAppById: mocks.getAppById,
		getAppBySlug: mocks.getAppBySlug,
	};
});

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, getOrganizationById: mocks.getOrganizationById };
});

import { assertTenantMcpConfigAllowed } from "./apps";

const CALLER_ORG = "org-caller";
const TEDIX_ORG = "org-tedix-uuid";
const OTHER_ORG = "org-other";

const db = {} as BaseContext["db"];

/** Tenant (non-platform) context: no platform scopes anywhere. */
const tenantCtx = (): BaseContext =>
	({ authType: "user", user: { sub: "u1" } }) as unknown as BaseContext;

/** Platform principal via a platform:admin API key. */
const platformCtx = (): BaseContext =>
	({
		authType: "api_key",
		apiKey: { scopes: ["platform:admin"] },
	}) as unknown as BaseContext;

beforeEach(() => {
	mocks.getAppById.mockReset();
	mocks.getAppBySlug.mockReset();
	mocks.getOrganizationById.mockReset();
});

describe("assertTenantMcpConfigAllowed", () => {
	it("lets platform principals set otherwise-forbidden keys", async () => {
		await expect(
			assertTenantMcpConfigAllowed(db, platformCtx(), CALLER_ORG, {
				mcpConfig: { upstreamMcpUrl: "https://evil.example/mcp" },
			}),
		).resolves.toBeUndefined();
		expect(mocks.getAppBySlug).not.toHaveBeenCalled();
	});

	it("rejects tenant-set platform-managed mcpConfig keys", async () => {
		for (const key of [
			"inactiveAggregateApps",
			"forwardedQueryParams",
			"connectionProviderId",
			"descopeResourceId",
			"upstreamMcpUrl",
		]) {
			await expect(
				assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
					mcpConfig: { [key]: "x" },
				}),
			).rejects.toThrow();
		}
		// The forbidden-key check short-circuits before any db lookup.
		expect(mocks.getAppBySlug).not.toHaveBeenCalled();
	});

	it("allows aggregateApps that reference an app in the caller's own org", async () => {
		mocks.getAppBySlug.mockResolvedValue({
			id: "app-1",
			slug: "mine",
			organizationId: CALLER_ORG,
		});
		await expect(
			assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
				aggregateApps: [{ slug: "mine" }],
			}),
		).resolves.toBeUndefined();
		// Same-org short-circuits before resolving the org row.
		expect(mocks.getOrganizationById).not.toHaveBeenCalled();
	});

	it("allows aggregateApps that reference a tedix platform app", async () => {
		mocks.getAppBySlug.mockResolvedValue({
			id: "app-fc",
			slug: "firecrawl-tedix",
			organizationId: TEDIX_ORG,
		});
		mocks.getOrganizationById.mockResolvedValue({
			id: TEDIX_ORG,
			slug: "tedix",
		});
		await expect(
			assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
				aggregateApps: [{ slug: "firecrawl-tedix" }],
			}),
		).resolves.toBeUndefined();
	});

	it("rejects aggregateApps that reference another tenant's app", async () => {
		mocks.getAppBySlug.mockResolvedValue({
			id: "app-x",
			slug: "victim",
			organizationId: OTHER_ORG,
		});
		mocks.getOrganizationById.mockResolvedValue({
			id: OTHER_ORG,
			slug: "victim-co",
			descopeTenantId: "org_victim",
		});
		await expect(
			assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
				aggregateApps: [{ slug: "victim" }],
			}),
		).rejects.toThrow(/outside your organization/);
	});

	it("checks an entry's appId, not its slug, because reads resolve by id", async () => {
		// The slug names the caller's own app; the id names another tenant's.
		mocks.getAppBySlug.mockResolvedValue({
			id: "app-mine",
			slug: "mine",
			organizationId: CALLER_ORG,
		});
		mocks.getAppById.mockResolvedValue({
			id: "app-x",
			slug: "victim",
			organizationId: OTHER_ORG,
		});
		mocks.getOrganizationById.mockResolvedValue({
			id: OTHER_ORG,
			slug: "sample",
			descopeTenantId: "org_sample",
		});
		await expect(
			assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
				aggregateApps: [
					{ slug: "mine", appId: "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a" },
				],
			}),
		).rejects.toThrow(/outside your organization/);
		expect(mocks.getAppBySlug).not.toHaveBeenCalled();
	});

	it("rejects aggregateApps that reference an unknown slug", async () => {
		mocks.getAppBySlug.mockResolvedValue(null);
		await expect(
			assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
				aggregateApps: [{ slug: "does-not-exist" }],
			}),
		).rejects.toThrow(/unknown app slug/);
	});

	it("rejects a same-zone *.mcp.tedix.dev upstream for EVERY principal", async () => {
		// Hard invariant (CLAUDE.md "MCP Platform"): proxying another
		// *.mcp.tedix.dev app through upstreamMcpUrl loops the request back into
		// the Worker serving it — reject-write even for platform principals.
		for (const ctx of [platformCtx(), tenantCtx()]) {
			await expect(
				assertTenantMcpConfigAllowed(db, ctx, CALLER_ORG, {
					mcpConfig: {
						upstreamMcpUrl: "https://firecrawl.mcp.tedix.dev/mcp",
					},
				}),
			).rejects.toThrow(/same-zone MCP edge/);
		}
		expect(mocks.getAppBySlug).not.toHaveBeenCalled();
	});

	it("does not misread lookalike hosts or non-URL upstream values as same-zone", async () => {
		// Suffix-anchored host check, not substring matching: a third-party host
		// embedding the zone string stays allowed for platform principals, and a
		// non-URL value falls through to the forbidden-key policy for tenants.
		await expect(
			assertTenantMcpConfigAllowed(db, platformCtx(), CALLER_ORG, {
				mcpConfig: {
					upstreamMcpUrl: "https://notmcp.tedix.dev.evil.example/mcp",
				},
			}),
		).resolves.toBeUndefined();
		await expect(
			assertTenantMcpConfigAllowed(db, tenantCtx(), CALLER_ORG, {
				mcpConfig: { upstreamMcpUrl: "not a url" },
			}),
		).rejects.toThrow(/platform-managed/);
	});
});
