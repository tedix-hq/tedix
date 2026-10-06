import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

/**
 * Cross-surface directory router suite.
 *
 * Pins three properties: (1) each surface's `provisioned`/`canonicalUrl` is
 * driven by its live D1 signal, (2) an org without a minted Descope tenant is
 * fully disabled regardless of per-surface signals, and (3) the read is scoped
 * strictly to the caller — `listMyWorkspaces` never leaves `user.sub` and
 * `resolveWorkspace` returns null for an org the caller does not actively
 * belong to.
 */

const mocks = vi.hoisted(() => ({
	getUserOrganizationMemberships: vi.fn(),
	getOrganizationAggregatorGateways: vi.fn(),
	getMemberByUserId: vi.fn(),
	getOrganizationById: vi.fn(),
	getOrganizationSurfaceSignals: vi.fn(),
}));

vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getUserOrganizationMemberships: mocks.getUserOrganizationMemberships,
	getOrganizationAggregatorGateways: mocks.getOrganizationAggregatorGateways,
	getMemberByUserId: mocks.getMemberByUserId,
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
}));

vi.mock("@tedix/db/queries/tenant-directory", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/tenant-directory")
	>()),
	getOrganizationSurfaceSignals: mocks.getOrganizationSurfaceSignals,
}));

import { directoryContractRouter } from "./directory";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

function membership(overrides: Record<string, unknown> = {}) {
	return {
		member: { id: "m", organizationId: ORG_A },
		organizationId: ORG_A,
		organizationName: "Acme",
		organizationSlug: "acme",
		organizationLogoUrl: null,
		organizationType: "organization",
		descopeTenantId: "T-acme",
		appsCount: 1,
		tediCount: 1,
		...overrides,
	};
}

function signals(overrides: Record<string, unknown> = {}) {
	return {
		os: false,
		cmsEnabled: false,
		cmsDomain: null,
		...overrides,
	};
}

function createContext(sub: string | undefined): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "production" } as CloudflareEnv,
		headers: new Headers(),
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/directory"),
		user: sub
			? {
					aud: "test",
					exp: 2,
					iat: 1,
					iss: "https://auth.tedix.test",
					sub,
					permissions: ["apps:read"],
					roles: [],
				}
			: undefined,
	} as BaseContext;
}

function createClient(context: BaseContext) {
	return createRouterClient(directoryContractRouter, { context });
}

function surfaceMap(surfaces: Array<{ surface: string }>) {
	return new Map(surfaces.map((s) => [s.surface, s]));
}

beforeEach(() => {
	for (const m of Object.values(mocks)) m.mockReset();
	mocks.getOrganizationAggregatorGateways.mockResolvedValue(new Map());
	mocks.getOrganizationSurfaceSignals.mockResolvedValue(new Map());
});

describe("directory.listMyWorkspaces", () => {
	it("scopes enumeration to the caller's own sub", async () => {
		mocks.getUserOrganizationMemberships.mockResolvedValue([membership()]);
		const client = createClient(createContext("user-1"));

		await client.listMyWorkspaces({});

		expect(mocks.getUserOrganizationMemberships).toHaveBeenCalledTimes(1);
		expect(mocks.getUserOrganizationMemberships.mock.calls[0]?.[1]).toBe(
			"user-1",
		);
		expect(mocks.getUserOrganizationMemberships.mock.calls[0]?.[2]).toEqual({
			activeOnly: true,
		});
	});

	it("rejects a machine principal with no verified subject", async () => {
		const client = createClient(createContext(undefined));
		await expect(client.listMyWorkspaces({})).rejects.toThrow();
		expect(mocks.getUserOrganizationMemberships).not.toHaveBeenCalled();
	});

	it("enumerates each surface from its live provision signal", async () => {
		mocks.getUserOrganizationMemberships.mockResolvedValue([membership()]);
		mocks.getOrganizationSurfaceSignals.mockResolvedValue(
			new Map([[ORG_A, signals({ os: true, cmsEnabled: true })]]),
		);
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([[ORG_A, { slug: "acme-unified", customMcpDomain: null }]]),
		);

		const { data } = await createClient(
			createContext("user-1"),
		).listMyWorkspaces({});

		expect(data).toHaveLength(1);
		const record = data[0]!;
		expect(record.org.provisionComplete).toBe(true);
		const byName = surfaceMap(record.surfaces);
		expect(byName.get("os")).toMatchObject({
			provisioned: true,
			canonicalUrl: "https://acme.os.tedix.dev/",
			handoffUrl:
				"https://acme.os.tedix.dev/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F",
		});
		expect(byName.get("mcp")).toMatchObject({
			provisioned: true,
			canonicalUrl: "https://acme-unified.mcp.tedix.dev/mcp",
			handoffUrl: null,
		});
		expect(byName.get("cms")).toMatchObject({
			provisioned: true,
			canonicalUrl: "https://acme.cms.tedix.dev/_emdash/admin",
			handoffUrl:
				"https://acme.cms.tedix.dev/_emdash/api/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F_emdash%2Fadmin",
		});
	});

	it("leaves an unsignaled surface unprovisioned with a null url", async () => {
		mocks.getUserOrganizationMemberships.mockResolvedValue([membership()]);
		mocks.getOrganizationSurfaceSignals.mockResolvedValue(
			new Map([[ORG_A, signals({ os: true })]]),
		);

		const { data } = await createClient(
			createContext("user-1"),
		).listMyWorkspaces({});
		const byName = surfaceMap(data[0]!.surfaces);
		expect(byName.get("os")?.provisioned).toBe(true);
		expect(byName.get("cms")).toMatchObject({
			provisioned: false,
			canonicalUrl: null,
			handoffUrl: null,
		});
		expect(byName.get("mcp")).toMatchObject({
			provisioned: false,
			canonicalUrl: null,
			handoffUrl: null,
		});
		expect(byName.size).toBe(3);
	});

	it("disables every surface when the org has no Descope tenant", async () => {
		mocks.getUserOrganizationMemberships.mockResolvedValue([
			membership({ descopeTenantId: null }),
		]);
		mocks.getOrganizationSurfaceSignals.mockResolvedValue(
			new Map([[ORG_A, signals({ os: true, cmsEnabled: true })]]),
		);
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([[ORG_A, { slug: "acme-unified", customMcpDomain: null }]]),
		);

		const { data } = await createClient(
			createContext("user-1"),
		).listMyWorkspaces({});
		expect(data[0]!.org.provisionComplete).toBe(false);
		for (const surface of data[0]!.surfaces) {
			expect(surface.provisioned).toBe(false);
			expect(surface.canonicalUrl).toBeNull();
			expect(surface.handoffUrl).toBeNull();
		}
	});

	it("prefers a per-surface custom domain over the platform subdomain", async () => {
		mocks.getUserOrganizationMemberships.mockResolvedValue([membership()]);
		mocks.getOrganizationSurfaceSignals.mockResolvedValue(
			new Map([
				[
					ORG_A,
					signals({
						cmsEnabled: true,
						cmsDomain: "blog.acme.com",
					}),
				],
			]),
		);
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([
				[ORG_A, { slug: "acme-unified", customMcpDomain: "mcp.acme.com" }],
			]),
		);

		const { data } = await createClient(
			createContext("user-1"),
		).listMyWorkspaces({});
		const byName = surfaceMap(data[0]!.surfaces);
		expect(byName.get("mcp")).toMatchObject({
			provisioned: true,
			canonicalUrl: "https://mcp.acme.com/mcp",
			handoffUrl: null,
			customDomain: "mcp.acme.com",
		});
		expect(byName.get("cms")).toMatchObject({
			canonicalUrl: "https://blog.acme.com/_emdash/admin",
			handoffUrl:
				"https://acme.cms.tedix.dev/_emdash/api/auth/session-broker/start?tenant_id=T-acme&redirect_to=%2F_emdash%2Fadmin",
			customDomain: "blog.acme.com",
		});
		expect(byName.has("tedi")).toBe(false);
	});

	it("uses the tedix.tech platform domain outside production", async () => {
		mocks.getUserOrganizationMemberships.mockResolvedValue([membership()]);
		mocks.getOrganizationSurfaceSignals.mockResolvedValue(
			new Map([[ORG_A, signals({ os: true })]]),
		);
		const ctx = createContext("user-1");
		ctx.env = { ENVIRONMENT: "development" } as CloudflareEnv;

		const { data } = await createClient(ctx).listMyWorkspaces({});
		expect(surfaceMap(data[0]!.surfaces).get("os")?.canonicalUrl).toBe(
			"https://acme.os.tedix.tech/",
		);
	});
});

describe("directory.resolveWorkspace", () => {
	it("returns null for an org the caller is not a member of (no cross-tenant leak)", async () => {
		mocks.getMemberByUserId.mockResolvedValue(undefined);
		const client = createClient(createContext("user-1"));

		const result = await client.resolveWorkspace({ organizationId: ORG_B });

		expect(result).toBeNull();
		// Binding runs BEFORE any org fetch: the record is never read.
		expect(mocks.getMemberByUserId).toHaveBeenCalledWith(
			expect.anything(),
			ORG_B,
			"user-1",
		);
		expect(mocks.getOrganizationById).not.toHaveBeenCalled();
	});

	it("returns null when the caller's membership is not active", async () => {
		mocks.getMemberByUserId.mockResolvedValue({ status: "invited" });
		const result = await createClient(createContext("user-1")).resolveWorkspace(
			{ organizationId: ORG_A },
		);
		expect(result).toBeNull();
		expect(mocks.getOrganizationById).not.toHaveBeenCalled();
	});

	it("resolves the record for an active member", async () => {
		mocks.getMemberByUserId.mockResolvedValue({ status: "active" });
		mocks.getOrganizationById.mockResolvedValue({
			id: ORG_A,
			slug: "acme",
			name: "Acme",
			descopeTenantId: "T-acme",
			features: { os: true },
		});
		mocks.getOrganizationSurfaceSignals.mockResolvedValue(
			new Map([[ORG_A, signals({ os: true })]]),
		);

		const result = await createClient(createContext("user-1")).resolveWorkspace(
			{ organizationId: ORG_A },
		);

		expect(result?.org.provisionComplete).toBe(true);
		expect(surfaceMap(result!.surfaces).get("os")).toMatchObject({
			provisioned: true,
			canonicalUrl: "https://acme.os.tedix.dev/",
		});
	});

	it("rejects a machine principal with no verified subject", async () => {
		const client = createClient(createContext(undefined));
		await expect(
			client.resolveWorkspace({ organizationId: ORG_A }),
		).rejects.toThrow();
		expect(mocks.getMemberByUserId).not.toHaveBeenCalled();
	});
});
