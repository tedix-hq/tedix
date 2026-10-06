import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";

const mocks = vi.hoisted(() => ({
	org: vi.fn(),
	billing: vi.fn(),
	activate: vi.fn(),
	plan: vi.fn(),
	workspace: vi.fn(),
	createWorkspace: vi.fn(),
	tedi: vi.fn(),
	createOrg: vi.fn(),
	createTedi: vi.fn(),
	ready: vi.fn(),
}));
vi.mock("./provider-worker-readiness", () => ({
	ensureProviderWorkerReady: mocks.ready,
}));
vi.mock("@orpc/server", async (importOriginal) => ({
	...(await importOriginal<typeof import("@orpc/server")>()),
	createRouterClient: () => ({
		organization: mocks.createOrg,
		tedi: mocks.createTedi,
	}),
}));
vi.mock("../rpc/routers/organizations", () => ({
	createOrganizationContract: {},
	createOrganizationForProvider: mocks.createOrg,
}));
vi.mock("../rpc/routers/tedis/crud", () => ({
	createTediProcedure: {},
	createTediForProvider: mocks.createTedi,
	materializeManagedAppAssignments: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationByDescopeId: mocks.org,
}));
vi.mock("@tedix/db/queries/billing/plans", () => ({
	getBillingEntitlement: mocks.billing,
	activateProviderCustomerBilling: mocks.activate,
	requireActiveBillingPlan: mocks.plan,
}));
vi.mock("@tedix/db/queries/os-workspaces/workspaces", () => ({
	getOsWorkspace: mocks.workspace,
	createOsWorkspace: mocks.createWorkspace,
}));
vi.mock("@tedix/db/queries/tedis", () => ({ getTediBySlug: mocks.tedi }));

import {
	ensureProviderCustomer,
	ensureProviderCustomerForProvider,
	providerCustomerKey,
} from "./provider-customer-provisioning";

const input = {
	providerOrganizationId: "provider",
	providerAppId: "app",
	externalTenantId: "367",
	customer: { name: "Garage", billingPlanKey: "business" as const },
};
const context = { db: {} } as BaseContext;
const active = {
	account: { status: "active", billingMode: "internal" },
	plan: { id: "business-v3" },
};
beforeEach(async () => {
	vi.resetAllMocks();
	const key = await providerCustomerKey("provider", "app", "367");
	mocks.org.mockResolvedValue({
		id: "customer",
		// The handle reads as the customer, not as a digest.
		slug: "acme",
		descopeTenantId: `org_${key}`,
		metadata: { providerCustomerKey: key },
	});
	mocks.plan.mockResolvedValue({ id: "business-v3", allowOverage: true });
	mocks.billing.mockResolvedValue(active);
	mocks.workspace.mockResolvedValue({ id: "workspace", status: "active" });
	mocks.tedi.mockResolvedValue({
		id: "worker",
		status: "active",
		descopeUserId: "identity",
	});
});
describe("automatic provider customer setup", () => {
	it("scopes stable resource keys to provider and host tenant", async () => {
		expect(await providerCustomerKey("provider", "app", "367")).not.toBe(
			await providerCustomerKey("other", "app", "367"),
		);
		expect(await providerCustomerKey("provider", "app", "367")).not.toBe(
			await providerCustomerKey("provider", "app", "368"),
		);
	});
	it("resumes existing resources without resetting identities or billing", async () => {
		expect(await ensureProviderCustomer(context, input)).toEqual({
			customerOrganizationId: "customer",
			primaryWorkspaceId: "workspace",
			primaryTediId: "worker",
		});
		expect(mocks.createOrg).toHaveBeenCalledOnce();
		expect(mocks.createTedi).not.toHaveBeenCalled();
		expect(mocks.activate).not.toHaveBeenCalled();
	});
	it("rejects another owner's resource", async () => {
		mocks.org.mockResolvedValue({ id: "other", metadata: {} });
		await expect(ensureProviderCustomer(context, input)).rejects.toThrow(
			"ownership",
		);
		expect(mocks.activate).not.toHaveBeenCalled();
	});
	it("activates the trial with a version fence and retains its period", async () => {
		mocks.billing.mockResolvedValueOnce({
			account: {
				status: "trial",
				billingMode: "trial",
				entitlementVersion: 1,
				metadata: {},
			},
			plan: { id: "starter-v1" },
		});
		await ensureProviderCustomer(context, input);
		expect(mocks.activate).toHaveBeenCalledWith(
			context.db,
			expect.objectContaining({
				organizationId: "customer",
				entitlementVersion: 1,
				planVersionId: "business-v3",
			}),
		);
		expect(mocks.activate.mock.calls[0][1]).not.toHaveProperty("periodStart");
	});
	it("refuses an operator-modified billing account", async () => {
		mocks.billing.mockResolvedValue({
			account: { status: "suspended", billingMode: "internal" },
			plan: { id: "business-v3" },
		});
		await expect(ensureProviderCustomer(context, input)).rejects.toThrow(
			"billing has changed",
		);
		expect(mocks.activate).not.toHaveBeenCalled();
	});
	it("propagates a failed credential repair instead of activating", async () => {
		mocks.ready.mockRejectedValue(new Error("credential repair failed"));
		await expect(ensureProviderCustomer(context, input)).rejects.toThrow(
			"credential repair failed",
		);
	});
	it("does not suppress failure completing an existing organization's owner binding", async () => {
		mocks.createOrg.mockRejectedValue(new Error("owner binding failed"));
		await expect(ensureProviderCustomer(context, input)).rejects.toThrow(
			"owner binding failed",
		);
		expect(mocks.ready).not.toHaveBeenCalled();
	});
	it("creates missing resources using canonical procedures", async () => {
		mocks.workspace.mockResolvedValueOnce(null);
		mocks.createWorkspace.mockResolvedValue({
			id: "new-workspace",
			status: "active",
		});
		mocks.tedi.mockResolvedValueOnce(null);
		expect(
			(await ensureProviderCustomer(context, input)).primaryWorkspaceId,
		).toBe("new-workspace");
		expect(mocks.createOrg).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Garage",
				metadata: expect.objectContaining({
					providerCustomerKey: expect.any(String),
				}),
			}),
		);
		// Provisioning never dictates the handle; canonical creation derives it
		// from the display name, so no digest reaches the URL.
		expect(mocks.createOrg.mock.calls[0][0]).not.toHaveProperty("slug");
		// Every later resource follows the handle the organization settled on.
		expect(mocks.createTedi).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "customer",
				slug: "acme",
				registerDescopeAih: false,
			}),
		);
	});
});

describe("provider onboarding authority", () => {
	it("rejects a different provider scope before creating resources", () => {
		expect(() =>
			ensureProviderCustomerForProvider(
				{ ...context, organizationId: "other" },
				{
					...input,
					customer: {
						...input.customer,
						ownerUserId: "owner",
						ownerEmail: "owner@example.com",
					},
				},
			),
		).toThrow("Provider scope");
	});
	it("requires a configured human owner", () => {
		expect(() =>
			ensureProviderCustomerForProvider(
				{ ...context, organizationId: "provider" },
				input,
			),
		).toThrow("configured owner");
	});
	it("uses canonical internal provisioning with the configured owner", async () => {
		await ensureProviderCustomerForProvider(
			{ ...context, organizationId: "provider" },
			{
				...input,
				customer: {
					...input.customer,
					ownerUserId: "owner",
					ownerEmail: "owner@example.com",
				},
			},
		);
		expect(mocks.createOrg).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "provider" }),
			expect.objectContaining({
				ownerUserId: "owner",
				ownerEmail: "owner@example.com",
			}),
		);
	});
});
