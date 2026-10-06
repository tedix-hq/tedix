/**
 * `organizations.update` must MERGE the metadata column, not replace it.
 *
 * That one JSON column holds both profile fields and enforcement config:
 * `aiGatewayPolicy` (daily spend cap, token limit, allowed model tiers) and
 * `browserEgress` (allow/deny hostnames). The runtime reads both straight from
 * D1, and the contract schema lists only the profile fields — so zod strips the
 * enforcement keys off the input and a wholesale write erases them with no
 * error and no audit event. The org profile form sends `{website,
 * contactEmail}`, which is the whole payload it takes to wipe an org's spend
 * cap.
 */

import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";

const ORGANIZATION_ID = "0b90b0e2-14da-4a34-bd35-a416ab604f25";

const SEEDED_METADATA = {
	aiGatewayPolicy: {
		dailySpendLimitMicros: 5_000_000,
		allowedModelTiers: ["economy"],
	},
	browserEgress: {
		deniedHostnames: ["admin.example.com"],
		allowedHostnames: [],
	},
	onboardingNotes: "keep me",
	website: "https://old.example.com",
};

const mocks = vi.hoisted(() => ({
	getOrganizationById: vi.fn(),
	updateOrganization: vi.fn(),
	checkSlugAvailable: vi.fn(),
	getOrganizationBySlug: vi.fn(),
	getOrganizationByDescopeId: vi.fn(),
	bindOrganizationExternalIdentity: vi.fn(),
	addMember: vi.fn(),
	getMemberByUserId: vi.fn(),
	upsertUserForExternalIdentity: vi.fn(),
	autoProvisionFirstTedi: vi.fn(),
}));

vi.mock("../../lib/tedi-provisioning", () => ({
	autoProvisionFirstTedi: mocks.autoProvisionFirstTedi,
}));

vi.mock("@tedix/db/queries/organizations", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/organizations")>()),
	getOrganizationById: mocks.getOrganizationById,
	updateOrganization: mocks.updateOrganization,
	checkSlugAvailable: mocks.checkSlugAvailable,
	isSlugAvailable: mocks.checkSlugAvailable,
	getOrganizationBySlug: mocks.getOrganizationBySlug,
	getOrganizationByDescopeId: mocks.getOrganizationByDescopeId,
	bindOrganizationExternalIdentity: mocks.bindOrganizationExternalIdentity,
}));

vi.mock("@tedix/db/queries/organization-members", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	addMember: mocks.addMember,
	getMemberByUserId: mocks.getMemberByUserId,
}));
vi.mock("@tedix/db/queries/users", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/queries/users")>()),
	upsertUserForExternalIdentity: mocks.upsertUserForExternalIdentity,
}));

function adminContext(): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: {
			ENVIRONMENT: "test",
			DESCOPE_PROJECT_ID: "project",
		} as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORGANIZATION_ID,
		userRole: "admin",
		url: new URL("https://api.tedix.test/rpc/organizations"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["settings:manage", "team:manage"],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

describe("organizations.update metadata merge", () => {
	it("preserves enforcement config when the profile form saves two fields", async () => {
		mocks.getOrganizationById.mockResolvedValue({
			id: ORGANIZATION_ID,
			name: "Acme",
			slug: "acme",
			type: "organization",
			descopeTenantId: null,
			metadata: SEEDED_METADATA,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		});
		mocks.updateOrganization.mockImplementation(
			async (_db: unknown, _id: string, data: Record<string, unknown>) => ({
				id: ORGANIZATION_ID,
				name: "Acme",
				slug: "acme",
				type: "organization",
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-02T00:00:00.000Z",
				...data,
			}),
		);

		const { organizationsContractRouter } = await import("./organizations");
		const client = createRouterClient(organizationsContractRouter, {
			context: adminContext(),
		});

		await client.update({
			organizationId: ORGANIZATION_ID,
			metadata: { website: "https://acme.com" },
		});

		const written = mocks.updateOrganization.mock.calls.at(-1)?.[2] as {
			metadata: Record<string, unknown>;
		};
		// The edit lands…
		expect(written.metadata.website).toBe("https://acme.com");
		// …and everything the form never loaded survives it.
		expect(written.metadata.aiGatewayPolicy).toEqual(
			SEEDED_METADATA.aiGatewayPolicy,
		);
		expect(written.metadata.browserEgress).toEqual(
			SEEDED_METADATA.browserEgress,
		);
		expect(written.metadata.onboardingNotes).toBe("keep me");
	});
});

it("tenant administrators cannot forge an automatic provider identity", async () => {
	const { organizationsContractRouter } = await import("./organizations");
	const client = createRouterClient(organizationsContractRouter, {
		context: adminContext(),
	});
	await expect(
		client.update({
			organizationId: ORGANIZATION_ID,
			metadata: { providerCustomerKey: "a".repeat(32) },
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});

describe("provider organization recovery", () => {
	// Provisioning no longer passes a handle: canonical creation derives it from
	// the display name, and re-entry resolves on the deterministic tenant id.
	const input = {
		name: "Garage",
		metadata: { providerCustomerKey: "key" },
		ownerUserId: "configured-owner",
		ownerEmail: "owner@example.com",
	};
	it("resumes owner binding after the organization was already inserted", async () => {
		const { createOrganizationForProvider } = await import("./organizations");
		mocks.checkSlugAvailable.mockResolvedValue(false);
		// Renamed since the first pass: resume must still find it by tenant id,
		// and must reuse the handle it already has rather than minting another.
		mocks.getOrganizationByDescopeId.mockResolvedValue({
			id: ORGANIZATION_ID,
			name: "Garage",
			slug: "acme",
			descopeTenantId: "org_key",
			metadata: { providerCustomerKey: "key" },
			createdAt: "2026-09-12T00:00:00Z",
			updatedAt: "2026-09-12T00:00:00Z",
		});
		mocks.getMemberByUserId.mockResolvedValue(undefined);
		mocks.upsertUserForExternalIdentity.mockResolvedValue({
			id: "canonical-owner",
		});
		mocks.addMember
			.mockRejectedValueOnce(new Error("injected membership failure"))
			.mockResolvedValueOnce({ role: "owner", status: "active" });
		await expect(
			createOrganizationForProvider(adminContext(), input),
		).rejects.toThrow("injected membership failure");
		await expect(
			createOrganizationForProvider(adminContext(), input),
		).resolves.toHaveProperty("id", ORGANIZATION_ID);
		expect(mocks.autoProvisionFirstTedi).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			ORGANIZATION_ID,
			null,
			"configured-owner",
		);
		expect(mocks.addMember).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				descopeUserId: "configured-owner",
				email: "owner@example.com",
			}),
		);
	});
	it("resolves re-entry on the tenant id, never on the handle", async () => {
		const { createOrganizationForProvider } = await import("./organizations");
		mocks.checkSlugAvailable.mockResolvedValue(false);
		mocks.getOrganizationByDescopeId.mockResolvedValue({
			id: ORGANIZATION_ID,
			name: "Garage",
			slug: "acme",
			descopeTenantId: "org_key",
			metadata: { providerCustomerKey: "key" },
			createdAt: "2026-09-12T00:00:00Z",
			updatedAt: "2026-09-12T00:00:00Z",
		});
		mocks.getMemberByUserId.mockResolvedValue(undefined);
		mocks.upsertUserForExternalIdentity.mockResolvedValue({
			id: "canonical-owner",
		});
		mocks.addMember.mockResolvedValue({ role: "owner", status: "active" });
		await expect(
			createOrganizationForProvider(adminContext(), input),
		).resolves.toHaveProperty("id", ORGANIZATION_ID);
		expect(mocks.getOrganizationByDescopeId).toHaveBeenCalledWith(
			expect.anything(),
			"org_key",
		);
		expect(mocks.getOrganizationBySlug).not.toHaveBeenCalled();
	});
	it("refuses an explicitly requested handle owned by a different provider key", async () => {
		const { createOrganizationForProvider } = await import("./organizations");
		mocks.checkSlugAvailable.mockResolvedValue(false);
		mocks.getOrganizationByDescopeId.mockResolvedValue(undefined);
		await expect(
			createOrganizationForProvider(adminContext(), {
				...input,
				slug: "taken-handle",
			}),
		).rejects.toThrow("already taken");
	});
});

it("tenant administrators cannot replace protected provider onboarding defaults", async () => {
	const { organizationsContractRouter } = await import("./organizations");
	const client = createRouterClient(organizationsContractRouter, {
		context: adminContext(),
	});
	await expect(
		client.update({
			organizationId: ORGANIZATION_ID,
			metadata: {
				providerOnboarding: {
					enabled: true,
					providerAppId: "11111111-1111-4111-8111-111111111111",
					providerApiKeyId: "22222222-2222-4222-8222-222222222222",
					allowedOrigin: "https://host.example",
					hostTenantArgument: "companyId",
					hostTenantNamespace: "provider",
					ownerUserId: "attacker",
					ownerEmail: "attacker@example.com",
					billingPlanKey: "enterprise",
					sponsoredCapacity: {
						enabled: true,
						budgetRevision: 1,
						maxTransfersPerBudgetDay: 1,
						lowWatermarkTokens: 0,
						lowWatermarkSpendMicros: 0,
						transferTokens: 1000,
						transferSpendMicros: 1000,
					},
				},
			},
		}),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
