import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

const mocks = vi.hoisted(() => ({
	checkSlugAvailable: vi.fn(),
	emitAuditEvent: vi.fn(),
	getMemberByUserId: vi.fn(),
	getOrganizationById: vi.fn(),
	getOrganizationAggregatorGateways: vi.fn(),
	ensureOrganizationUnifiedGateway: vi.fn(),
	autoProvisionFirstTedi: vi.fn(),
	updateOrganization: vi.fn(),
}));

vi.mock("../../lib/tedi-provisioning", () => ({
	autoProvisionFirstTedi: mocks.autoProvisionFirstTedi,
}));

vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMemberByUserId: mocks.getMemberByUserId,
	getOrganizationAggregatorGateways: mocks.getOrganizationAggregatorGateways,
}));

vi.mock("../../lib/organization-mcp-gateway", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../lib/organization-mcp-gateway")
	>()),
	ensureOrganizationUnifiedGateway: mocks.ensureOrganizationUnifiedGateway,
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
	isSlugAvailable: mocks.checkSlugAvailable,
	updateOrganization: mocks.updateOrganization,
}));

vi.mock("../audit-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../audit-helpers")>()),
	emitAuditEvent: mocks.emitAuditEvent,
}));

function userContext(): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: [],
			roles: [],
			sub: "user-1",
			email: "new-user@example.com",
		},
	} as BaseContext;
}

function machineContext(): BaseContext {
	return {
		apiKey: {
			id: "key-1",
			name: "test",
			organizationId: ORGANIZATION_ID,
			scopes: ["apps:write"],
		},
		authType: "apikey",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		url: new URL("https://api.tedix.test/rpc/organizations"),
	} as BaseContext;
}

describe("organizations.completeOsOnboarding", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getOrganizationById.mockResolvedValue({
			id: ORGANIZATION_ID,
			name: "Personal Workspace",
			slug: "personal-a1b2c3d4",
			type: "personal",
			descopeTenantId: "personal_user-1",
			features: { maxApps: 1, sso: false },
			createdAt: "2026-08-17T00:00:00.000Z",
			updatedAt: "2026-08-17T00:00:00.000Z",
		});
		mocks.getMemberByUserId.mockResolvedValue({
			organizationId: ORGANIZATION_ID,
			descopeUserId: "user-1",
			role: "owner",
			status: "active",
		});
		mocks.checkSlugAvailable.mockResolvedValue(true);
		mocks.getOrganizationAggregatorGateways.mockResolvedValue(new Map());
		mocks.autoProvisionFirstTedi.mockResolvedValue({
			tediId: "tedi-default",
			slug: "tedi-default",
			name: "Example Tedi",
		});
		mocks.ensureOrganizationUnifiedGateway.mockResolvedValue({
			appId: "gateway-app-1",
			descopeResourceId: "MS-gateway-1",
			gatewaySlug: "acme-studio-unified",
			mcpUrl: "https://acme-studio-unified.mcp.tedix.dev/mcp",
		});
		mocks.updateOrganization.mockImplementation(
			async (_db: unknown, _id: string, updates: Record<string, unknown>) => ({
				id: ORGANIZATION_ID,
				type: "personal",
				descopeTenantId: "personal_user-1",
				createdAt: "2026-08-17T00:00:00.000Z",
				updatedAt: "2026-08-17T01:00:00.000Z",
				...updates,
			}),
		);
	});

	it("enables the owner's existing organization without needing tenant context", async () => {
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(
			client.completeOsOnboarding({
				organizationId: ORGANIZATION_ID,
				name: "Acme Studio",
				slug: "acme-studio",
			}),
		).resolves.toMatchObject({
			id: ORGANIZATION_ID,
			name: "Acme Studio",
			slug: "acme-studio",
			features: { maxApps: 1, sso: false, os: true },
		});

		expect(mocks.updateOrganization).toHaveBeenCalledWith(
			expect.anything(),
			ORGANIZATION_ID,
			expect.objectContaining({
				name: "Acme Studio",
				slug: "acme-studio",
				features: { maxApps: 1, sso: false, os: true },
			}),
		);
		expect(mocks.ensureOrganizationUnifiedGateway).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			{
				organizationId: ORGANIZATION_ID,
				organizationName: "Acme Studio",
				organizationSlug: "acme-studio",
				gatewaySlug: undefined,
			},
		);
		expect(mocks.autoProvisionFirstTedi).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			ORGANIZATION_ID,
			undefined,
			"user-1",
		);
		expect(
			mocks.autoProvisionFirstTedi.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.ensureOrganizationUnifiedGateway.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "organization.os_onboarding_completed",
				organizationId: ORGANIZATION_ID,
			}),
		);
	});

	it("keeps the OS origin disabled until gateway provisioning succeeds", async () => {
		mocks.ensureOrganizationUnifiedGateway.mockRejectedValue(
			new Error("Descope unavailable"),
		);
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(
			client.completeOsOnboarding({
				organizationId: ORGANIZATION_ID,
				name: "Acme",
				slug: "acme",
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(mocks.updateOrganization).not.toHaveBeenCalled();
		expect(mocks.emitAuditEvent).not.toHaveBeenCalled();
	});

	it("keeps the OS origin disabled until default tedi provisioning succeeds", async () => {
		mocks.autoProvisionFirstTedi.mockRejectedValue(
			new Error("identity unavailable"),
		);
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(
			client.completeOsOnboarding({
				organizationId: ORGANIZATION_ID,
				name: "Acme",
				slug: "acme",
			}),
		).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
		expect(mocks.ensureOrganizationUnifiedGateway).not.toHaveBeenCalled();
		expect(mocks.updateOrganization).not.toHaveBeenCalled();
	});

	it("rejects a member who is not the active owner", async () => {
		mocks.getMemberByUserId.mockResolvedValue({
			organizationId: ORGANIZATION_ID,
			descopeUserId: "user-1",
			role: "member",
			status: "active",
		});
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: userContext(),
		});

		await expect(
			client.completeOsOnboarding({
				organizationId: ORGANIZATION_ID,
				name: "Acme",
				slug: "acme",
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateOrganization).not.toHaveBeenCalled();
	});

	it("never allows machine credentials to perform account onboarding", async () => {
		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: machineContext(),
		});

		await expect(
			client.completeOsOnboarding({
				organizationId: ORGANIZATION_ID,
				name: "Acme",
				slug: "acme",
			}),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});

describe("personal Descope tenant reconciliation", () => {
	function managementClient(options?: {
		addTenant?: { ok: boolean; error?: Record<string, string> };
		addTenantRoles?: { ok: boolean; error?: Record<string, string> };
		loadTenant?: { ok: boolean };
		userTenants?: Array<{ tenantId: string; roleNames?: string[] }>;
	}) {
		return {
			management: {
				tenant: {
					createWithId: vi.fn().mockResolvedValue({ ok: true }),
					load: vi.fn().mockResolvedValue(options?.loadTenant ?? { ok: true }),
				},
				user: {
					addTenant: vi
						.fn()
						.mockResolvedValue(options?.addTenant ?? { ok: true }),
					addTenantRoles: vi
						.fn()
						.mockResolvedValue(options?.addTenantRoles ?? { ok: true }),
					loadByUserId: vi.fn().mockResolvedValue({
						ok: true,
						data: {
							loginIds: ["new-user@example.com"],
							userTenants: options?.userTenants ?? [],
						},
					}),
				},
			},
		};
	}

	it("associates the user before assigning owner roles", async () => {
		const { __organizationsTest } = await import("./organizations");
		const mgmt = managementClient();

		await __organizationsTest.ensurePersonalDescopeTenantMembership(
			mgmt as never,
			{
				fallbackLoginId: "fallback@example.com",
				name: "New User's Workspace",
				tenantId: "personal_user-1",
				userId: "user-1",
			},
		);

		expect(mgmt.management.user.addTenant).toHaveBeenCalledWith(
			"new-user@example.com",
			"personal_user-1",
		);
		expect(mgmt.management.user.addTenantRoles).toHaveBeenCalledWith(
			"new-user@example.com",
			"personal_user-1",
			["owner", "admin"],
		);
		expect(
			mgmt.management.user.addTenant.mock.invocationCallOrder[0],
		).toBeLessThan(
			mgmt.management.user.addTenantRoles.mock.invocationCallOrder[0]!,
		);
	});

	it("short-circuits without re-writing when already an owner of the existing tenant", async () => {
		const { __organizationsTest } = await import("./organizations");
		// Existing tenant (load ok, not created by this request) and the user is
		// already a member carrying the owner roles — the redundant addTenant /
		// addTenantRoles that fired on every getMyOrganization call must be skipped.
		const mgmt = managementClient({
			loadTenant: { ok: true },
			userTenants: [
				{ tenantId: "personal_user-1", roleNames: ["owner", "admin"] },
			],
		});

		await __organizationsTest.ensurePersonalDescopeTenantMembership(
			mgmt as never,
			{
				fallbackLoginId: "fallback@example.com",
				name: "New User's Workspace",
				tenantId: "personal_user-1",
				userId: "user-1",
			},
		);

		expect(mgmt.management.user.addTenant).not.toHaveBeenCalled();
		expect(mgmt.management.user.addTenantRoles).not.toHaveBeenCalled();
	});

	it("still provisions when the user is a member but missing an owner role", async () => {
		const { __organizationsTest } = await import("./organizations");
		const mgmt = managementClient({
			loadTenant: { ok: true },
			userTenants: [{ tenantId: "personal_user-1", roleNames: ["admin"] }],
		});

		await __organizationsTest.ensurePersonalDescopeTenantMembership(
			mgmt as never,
			{
				fallbackLoginId: "fallback@example.com",
				name: "New User's Workspace",
				tenantId: "personal_user-1",
				userId: "user-1",
			},
		);

		expect(mgmt.management.user.addTenantRoles).toHaveBeenCalledWith(
			"new-user@example.com",
			"personal_user-1",
			["owner", "admin"],
		);
	});

	it("retries tenant creation with a user-unique name when the name collides", async () => {
		// Descope tenant names are unique per project, so the empty-profile
		// fallback name ("Personal Workspace") collides with the first user that
		// took it and reports E073307 — the same code as a duplicate tenant ID.
		const mgmt = managementClient({ loadTenant: { ok: false } });
		mgmt.management.tenant.createWithId
			.mockResolvedValueOnce({
				ok: false,
				error: {
					errorCode: "E073307",
					errorDescription:
						"Failed to save tenant, tenant ID or Name already exists",
				},
			})
			.mockResolvedValueOnce({ ok: true });
		const { __organizationsTest } = await import("./organizations");

		await __organizationsTest.ensurePersonalDescopeTenantMembership(
			mgmt as never,
			{
				fallbackLoginId: "fallback@example.com",
				name: "Personal Workspace",
				tenantId: "personal_user-1",
				userId: "user-1",
			},
		);

		expect(mgmt.management.tenant.createWithId).toHaveBeenNthCalledWith(
			2,
			"personal_user-1",
			"Personal Workspace user-1",
			[],
		);
		expect(mgmt.management.user.addTenant).toHaveBeenCalledWith(
			"new-user@example.com",
			"personal_user-1",
		);
	});

	it("treats a duplicate tenant ID as a concurrent create and continues", async () => {
		const mgmt = managementClient();
		mgmt.management.tenant.load
			.mockResolvedValueOnce({ ok: false })
			.mockResolvedValueOnce({ ok: true });
		mgmt.management.tenant.createWithId.mockResolvedValue({
			ok: false,
			error: {
				errorCode: "E073307",
				errorDescription:
					"Failed to save tenant, tenant ID or Name already exists",
			},
		});
		const { __organizationsTest } = await import("./organizations");

		await __organizationsTest.ensurePersonalDescopeTenantMembership(
			mgmt as never,
			{
				fallbackLoginId: "fallback@example.com",
				name: "New User's Workspace",
				tenantId: "personal_user-1",
				userId: "user-1",
			},
		);

		expect(mgmt.management.tenant.createWithId).toHaveBeenCalledOnce();
		expect(mgmt.management.user.addTenantRoles).toHaveBeenCalledOnce();
	});

	it("fails closed when tenant creation is rejected for another reason", async () => {
		const mgmt = managementClient({ loadTenant: { ok: false } });
		mgmt.management.tenant.createWithId.mockResolvedValue({
			ok: false,
			error: { errorCode: "E-test", errorDescription: "permission denied" },
		});
		const { __organizationsTest } = await import("./organizations");

		await expect(
			__organizationsTest.ensurePersonalDescopeTenantMembership(mgmt as never, {
				fallbackLoginId: "fallback@example.com",
				name: "New User's Workspace",
				tenantId: "personal_user-1",
				userId: "user-1",
			}),
		).rejects.toThrow(/Failed to create personal Descope tenant/);
		expect(mgmt.management.user.addTenant).not.toHaveBeenCalled();
	});

	it("accepts idempotent already-associated responses", async () => {
		const { __organizationsTest } = await import("./organizations");
		const alreadyAssociated = {
			ok: false,
			error: {
				errorCode: "E023002",
				errorDescription:
					"Failed to add user to tenant, user already part of the tenant",
			},
		};

		await expect(
			__organizationsTest.ensurePersonalDescopeTenantMembership(
				managementClient({
					addTenant: alreadyAssociated,
					addTenantRoles: alreadyAssociated,
				}) as never,
				{
					fallbackLoginId: "fallback@example.com",
					name: "New User's Workspace",
					tenantId: "personal_user-1",
					userId: "user-1",
				},
			),
		).resolves.toBeUndefined();
	});

	it("retries association while a newly created tenant propagates", async () => {
		vi.useFakeTimers();
		try {
			const mgmt = managementClient({ loadTenant: { ok: false } });
			mgmt.management.user.addTenant
				.mockResolvedValueOnce({
					ok: false,
					error: {
						errorCode: "E112201",
						errorDescription: "Tenant does not belong to the specified project",
					},
				})
				.mockResolvedValueOnce({ ok: true });
			const { __organizationsTest } = await import("./organizations");

			const reconciliation =
				__organizationsTest.ensurePersonalDescopeTenantMembership(
					mgmt as never,
					{
						fallbackLoginId: "fallback@example.com",
						name: "New User's Workspace",
						tenantId: "personal_user-1",
						userId: "user-1",
					},
				);
			await vi.advanceTimersByTimeAsync(250);
			await reconciliation;

			expect(mgmt.management.tenant.createWithId).toHaveBeenCalledOnce();
			expect(mgmt.management.user.addTenant).toHaveBeenCalledTimes(2);
			expect(mgmt.management.user.addTenantRoles).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails closed when Descope rejects the membership", async () => {
		const { __organizationsTest } = await import("./organizations");

		await expect(
			__organizationsTest.ensurePersonalDescopeTenantMembership(
				managementClient({
					addTenant: {
						ok: false,
						error: {
							errorCode: "E-test",
							errorDescription: "permission denied",
						},
					},
				}) as never,
				{
					fallbackLoginId: "fallback@example.com",
					name: "New User's Workspace",
					tenantId: "personal_user-1",
					userId: "user-1",
				},
			),
		).rejects.toThrow(/Failed to associate personal Descope tenant/);
	});
});
