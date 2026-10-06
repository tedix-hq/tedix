import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	getOrganizationById: vi.fn(),
	getBillingEntitlement: vi.fn(),
	updateOrganization: vi.fn(),
	emitAuditEvent: vi.fn(),
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
	updateOrganization: mocks.updateOrganization,
}));
vi.mock("@tedix/db/queries/billing/plans", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/billing/plans")>()),
	getBillingEntitlement: mocks.getBillingEntitlement,
}));
vi.mock("../audit-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("../audit-helpers")>()),
	emitAuditEvent: mocks.emitAuditEvent,
}));

import { organizationsContractRouter } from "./organizations";

const ORGANIZATION_ID = "5eed0026-0000-4000-8000-000000000026";

function context(platform: boolean): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage"],
			roles: platform ? ["platform-admin"] : ["org-admin"],
			sub: "user-1",
		},
		userRole: "owner",
	} as BaseContext;
}

describe("CMS custom-domain entitlement repair", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getOrganizationById.mockResolvedValue({
			id: ORGANIZATION_ID,
			features: { maxApps: 1, customDomain: false, os: true },
		});
		mocks.getBillingEntitlement.mockResolvedValue({
			account: { status: "active" },
			plan: { planKey: "business" },
		});
		mocks.updateOrganization.mockResolvedValue({});
		mocks.emitAuditEvent.mockResolvedValue(undefined);
	});

	it("rejects an organization owner without platform authority", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: context(false),
		});
		await expect(
			client.repairCmsDomainEntitlement({ organizationId: ORGANIZATION_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateOrganization).not.toHaveBeenCalled();
	});

	it("rejects a plan that does not include custom domains", async () => {
		mocks.getBillingEntitlement.mockResolvedValue({
			account: { status: "active" },
			plan: { planKey: "starter" },
		});
		const client = createRouterClient(organizationsContractRouter, {
			context: context(true),
		});
		await expect(
			client.repairCmsDomainEntitlement({ organizationId: ORGANIZATION_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.updateOrganization).not.toHaveBeenCalled();
	});

	it("repairs only the feature and audits the Business plan decision", async () => {
		const client = createRouterClient(organizationsContractRouter, {
			context: context(true),
		});
		await expect(
			client.repairCmsDomainEntitlement({ organizationId: ORGANIZATION_ID }),
		).resolves.toEqual({
			organizationId: ORGANIZATION_ID,
			planKey: "business",
			customDomain: true,
			repaired: true,
		});
		expect(mocks.updateOrganization).toHaveBeenCalledWith(
			expect.anything(),
			ORGANIZATION_ID,
			{ features: { maxApps: 1, os: true } },
		);
		expect(mocks.emitAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "organization.cms_domain_entitlement_repaired",
				organizationId: ORGANIZATION_ID,
			}),
		);
	});
});
