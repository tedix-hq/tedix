import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { bindTestContexts } from "../test-context";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

const mocks = vi.hoisted(() => ({
	ensurePersonalOrg: vi.fn(),
	ensureOrgAndMember: vi.fn(),
	autoProvisionFirstTedi: vi.fn(),
	getOrganizationAggregatorGateways: vi.fn(),
	ensureOrganizationUnifiedGateway: vi.fn(),
}));

vi.mock("@tedix/db/queries/organization-sync", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-sync")
	>()),
	ensurePersonalOrg: mocks.ensurePersonalOrg,
	ensureOrgAndMember: mocks.ensureOrgAndMember,
}));

vi.mock("../../lib/tedi-provisioning", () => ({
	autoProvisionFirstTedi: mocks.autoProvisionFirstTedi,
}));

vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getOrganizationAggregatorGateways: mocks.getOrganizationAggregatorGateways,
}));

vi.mock("../../lib/organization-mcp-gateway", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/organization-mcp-gateway")
	>()),
	ensureOrganizationUnifiedGateway: mocks.ensureOrganizationUnifiedGateway,
}));

const { userContext } = bindTestContexts({
	organizationId: null,
	url: "https://api.tedix.test/rpc/organizations",
	env: {
		ENVIRONMENT: "test",
		DESCOPE_PROJECT_ID: "P2fictional",
		TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
	} as CloudflareEnv,
	// A caller with no tenant claim onboards through the personal org path.
	user: { tenantId: null, claims: { email: "new-user@example.com" } },
});

const PERSONAL_ORG = {
	id: ORGANIZATION_ID,
	name: "New User's Workspace",
	slug: "personal-a1b2c3d4",
	type: "personal",
	descopeTenantId: "personal_user-1",
	logoUrl: null,
	description: null,
	appsCount: null,
	features: {},
	metadata: null,
	createdAt: "2026-08-17T00:00:00.000Z",
	updatedAt: "2026-08-17T00:00:00.000Z",
};

const MEMBER = {
	id: "1b6c8f3a-9d2e-4b1f-8c7a-5e6d7f8a9b0c",
	organizationId: ORGANIZATION_ID,
	descopeUserId: "user-1",
	email: "new-user@example.com",
	name: null,
	avatarUrl: null,
	role: "owner",
	customPermissions: null,
	status: "active",
	invitedAt: null,
	invitedBy: null,
	inviteAcceptedAt: null,
	lastActiveAt: null,
	createdAt: "2026-08-17T00:00:00.000Z",
	updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("organizations.getMyOrganization gateway assignment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.ensurePersonalOrg.mockResolvedValue({
			organization: { ...PERSONAL_ORG },
			member: { ...MEMBER },
			created: true,
		});
		mocks.autoProvisionFirstTedi.mockResolvedValue({
			tediId: "tedi-default",
			slug: "tedi-default",
			name: "New's Tedi",
		});
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(new Map());
		mocks.ensureOrganizationUnifiedGateway.mockResolvedValue({
			appId: "gateway-app-1",
			descopeResourceId: "MS-gateway-1",
			gatewaySlug: "personal-a1b2c3d4-unified",
			mcpUrl: "https://personal-a1b2c3d4-unified.mcp.tedix.dev/mcp",
		});
	});

	it("assigns and syncs the first tedi to the unified gateway before OS is enabled", async () => {
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(client.getMyOrganization({})).resolves.toMatchObject({
			organization: { id: ORGANIZATION_ID },
			created: { organization: true, member: true },
		});

		expect(mocks.ensureOrganizationUnifiedGateway).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{
				organizationId: ORGANIZATION_ID,
				organizationName: "New User's Workspace",
				organizationSlug: "personal-a1b2c3d4",
				gatewaySlug: undefined,
			},
		);
		expect(
			mocks.autoProvisionFirstTedi.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.ensureOrganizationUnifiedGateway.mock.invocationCallOrder[0]!,
		);
	});

	it("re-enters the reconciler while the gateway is not ready, then retries cheaply", async () => {
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});
		// First attempt: tedi already exists, gateway still provisioning.
		mocks.ensurePersonalOrg.mockResolvedValue({
			organization: { ...PERSONAL_ORG },
			member: { ...MEMBER },
			created: false,
		});
		mocks.autoProvisionFirstTedi.mockResolvedValue(null);

		await expect(client.getMyOrganization({})).resolves.toMatchObject({
			organization: { id: ORGANIZATION_ID },
		});
		expect(mocks.ensureOrganizationUnifiedGateway).toHaveBeenCalledOnce();

		// Retry: the gateway now reports ready, so the launcher read stays cheap.
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([
				[
					ORGANIZATION_ID,
					{ slug: "personal-a1b2c3d4-unified", customMcpDomain: null },
				],
			]),
		);
		await expect(client.getMyOrganization({})).resolves.toMatchObject({
			organization: { id: ORGANIZATION_ID },
		});
		expect(mocks.ensureOrganizationUnifiedGateway).toHaveBeenCalledOnce();
	});

	it("re-runs the reconciler when this request created the tedi behind a ready gateway", async () => {
		mocks.ensurePersonalOrg.mockResolvedValue({
			organization: { ...PERSONAL_ORG, features: { os: true } },
			member: { ...MEMBER },
			created: false,
		});
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(
			new Map([
				[
					ORGANIZATION_ID,
					{ slug: "personal-a1b2c3d4-unified", customMcpDomain: null },
				],
			]),
		);
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(client.getMyOrganization({})).resolves.toMatchObject({
			organization: { id: ORGANIZATION_ID },
		});

		expect(mocks.ensureOrganizationUnifiedGateway).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			expect.objectContaining({
				organizationId: ORGANIZATION_ID,
				gatewaySlug: "personal-a1b2c3d4-unified",
			}),
		);
	});

	it("surfaces gateway assignment failure as retryable sign-in failure", async () => {
		mocks.ensureOrganizationUnifiedGateway.mockRejectedValue(
			new Error("Descope unavailable"),
		);
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(client.getMyOrganization({})).rejects.toMatchObject({
			code: "SERVICE_UNAVAILABLE",
		});
	});
});
