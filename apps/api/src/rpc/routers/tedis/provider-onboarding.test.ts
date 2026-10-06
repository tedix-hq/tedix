import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
const mocks = vi.hoisted(() => ({
	organization: vi.fn(),
	provision: vi.fn(),
	configure: vi.fn(),
	validate: vi.fn(),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.organization,
	setProviderOnboardingConfiguration: mocks.configure,
}));
vi.mock("./provider-installations", () => ({
	provisionInstallation: mocks.provision,
	validateProviderInstallationIdentity: mocks.validate,
}));
import {
	activateProviderCustomer,
	configureProviderOnboarding,
	getProviderOnboardingStatus,
} from "./provider-onboarding";
import { tedisOs } from "./helpers";
const ORG = "11111111-1111-4111-8111-111111111111";
const INSTALLATION = "22222222-2222-4222-8222-222222222222";
const defaults = {
	enabled: true,
	providerAppId: "33333333-3333-4333-8333-333333333333",
	providerApiKeyId: "44444444-4444-4444-8444-444444444444",
	allowedOrigin: "https://host.example",
	hostTenantArgument: "companyId",
	hostTenantNamespace: "provider",
	ownerUserId: "configured-owner",
	ownerEmail: "owner@example.com",
	billingPlanKey: "business" as const,
	sponsoredCapacity: {
		enabled: true,
		budgetRevision: 1,
		maxTransfersPerBudgetDay: 1,
		lowWatermarkTokens: 100,
		lowWatermarkSpendMicros: 100,
		transferTokens: 1000,
		transferSpendMicros: 1000,
	},
};
function context(): BaseContext {
	return {
		authType: "user",
		organizationId: ORG,
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		url: new URL("https://api.example/rpc"),
		user: {
			sub: "provider-admin",
			permissions: ["settings:manage"],
			roles: [],
			aud: "test",
			dct: "test",
			exp: 2,
			iat: 1,
			iss: "test",
		},
	} as BaseContext;
}
const router = tedisOs.router({
	activateProviderCustomer,
	configureProviderOnboarding,
	getProviderOnboardingStatus,
});
const client = (ctx = context()) =>
	createRouterClient(router, { context: ctx });
const input = { name: "Garage", externalTenantId: "42" };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.organization.mockResolvedValue({
		id: ORG,
		metadata: { providerOnboarding: defaults },
	});
	mocks.provision.mockResolvedValue({ id: INSTALLATION });
	mocks.configure.mockResolvedValue({ id: ORG });
	mocks.validate.mockResolvedValue(undefined);
});
describe("provider console customer setup", () => {
	it("derives all privileged fields from provider defaults and starts with access off", async () => {
		await expect(client().activateProviderCustomer(input)).resolves.toEqual({
			installationId: INSTALLATION,
		});
		expect(mocks.organization).toHaveBeenCalledWith(expect.anything(), ORG);
		expect(mocks.provision).toHaveBeenCalledWith(
			expect.objectContaining({
				user: expect.objectContaining({ sub: "provider-admin" }),
			}),
			expect.objectContaining({
				providerOrganizationId: ORG,
				providerAppId: defaults.providerAppId,
				providerApiKeyId: defaults.providerApiKeyId,
				externalTenantId: "42",
				allowedOrigin: defaults.allowedOrigin,
				customer: expect.objectContaining({
					name: "Garage",
					ownerUserId: "configured-owner",
					ownerEmail: "owner@example.com",
					billingPlanKey: "business",
					sponsoredCapacity: defaults.sponsoredCapacity,
				}),
				provenance: {
					widgetAccess: expect.objectContaining({
						revision: 1,
						policy: {
							version: 1,
							enabled: false,
							users: "selected",
							allowedUserIds: [],
							deniedUserIds: [],
						},
					}),
				},
			}),
			true,
		);
	});
	it("exposes only configured status", async () => {
		await expect(client().getProviderOnboardingStatus({})).resolves.toEqual({
			configured: true,
		});
	});
	it.each([
		undefined,
		{ ...defaults, enabled: false },
		{ ...defaults, allowedOrigin: "broken" },
	])("rejects absent, disabled or malformed defaults", async (config) => {
		mocks.organization.mockResolvedValue({
			metadata: { providerOnboarding: config },
		});
		await expect(client().getProviderOnboardingStatus({})).resolves.toEqual({
			configured: false,
		});
		await expect(
			client().activateProviderCustomer(input),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.provision).not.toHaveBeenCalled();
	});
	it("rejects a user lacking settings authority", async () => {
		const ctx = context();
		ctx.user!.permissions = [];
		await expect(
			client(ctx).activateProviderCustomer(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.provision).not.toHaveBeenCalled();
	});
	it.each([["embedded:session"], ["apps:write"], ["platform:admin"]])(
		"rejects machine credentials even with scope %s",
		async (scopes) => {
			const ctx = {
				...context(),
				authType: "apikey",
				user: undefined,
				apiKey: {
					id: defaults.providerApiKeyId,
					name: "host",
					organizationId: ORG,
					scopes,
				},
			} as BaseContext;
			await expect(
				client(ctx).activateProviderCustomer(input),
			).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.provision).not.toHaveBeenCalled();
		},
	);
	it("cannot target another provider through caller fields", async () => {
		await expect(
			client().activateProviderCustomer({
				...input,
				providerOrganizationId: INSTALLATION,
			} as typeof input),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.provision).not.toHaveBeenCalled();
	});
	it("never loads another organization's defaults", async () => {
		const ctx = { ...context(), organizationId: INSTALLATION };
		mocks.organization.mockResolvedValue({ id: INSTALLATION, metadata: {} });
		await expect(
			client(ctx).activateProviderCustomer(input),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.organization).toHaveBeenCalledWith(
			expect.anything(),
			INSTALLATION,
		);
		expect(mocks.provision).not.toHaveBeenCalled();
	});
	it("rejects missing organization scope", async () => {
		await expect(
			client({
				...context(),
				organizationId: undefined,
			}).activateProviderCustomer(input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("platform provider setup", () => {
	function platformClient() {
		const ctx = {
			...context(),
			authType: "apikey",
			user: undefined,
			apiKey: {
				id: defaults.providerApiKeyId,
				name: "platform",
				organizationId: ORG,
				scopes: ["platform:admin"],
			},
		} as BaseContext;
		return client(ctx);
	}
	it("writes validated defaults for the explicit provider with platform authority", async () => {
		await expect(
			platformClient().configureProviderOnboarding({
				providerOrganizationId: ORG,
				config: defaults,
			}),
		).resolves.toEqual({ configured: true });
		expect(mocks.validate).toHaveBeenCalledWith(expect.anything(), {
			providerOrganizationId: ORG,
			providerAppId: defaults.providerAppId,
			providerApiKeyId: defaults.providerApiKeyId,
		});
		expect(mocks.configure).toHaveBeenCalledWith(
			expect.anything(),
			ORG,
			defaults,
		);
	});
	it("rejects ordinary provider administrators", async () => {
		await expect(
			client().configureProviderOnboarding({
				providerOrganizationId: ORG,
				config: defaults,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.configure).not.toHaveBeenCalled();
	});
	it("does not write when integration ownership validation rejects", async () => {
		mocks.validate.mockRejectedValueOnce(new Error("foreign app/key"));
		await expect(
			platformClient().configureProviderOnboarding({
				providerOrganizationId: ORG,
				config: defaults,
			}),
		).rejects.toThrow("foreign app/key");
		expect(mocks.configure).not.toHaveBeenCalled();
	});
});
