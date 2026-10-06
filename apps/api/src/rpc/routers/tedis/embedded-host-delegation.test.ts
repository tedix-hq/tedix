import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { issueGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import type { BaseContext } from "../../orpc";
import { resolveEmbeddedHostDelegationProcedure } from "./embedded-host-delegation";

vi.mock("@tedix/db/queries/connection-providers", () => ({
	getConnectionProviderByDescopeAppId: async () =>
		state.registryMissing
			? undefined
			: {
					credentialProfile: {
						authHeader: "Authorization",
						authTemplate: "{token}",
					},
				},
}));
const state = vi.hoisted(() => ({
	paused: false,
	registryMissing: false,
	sourceAuth: {} as {
		authHeader?: string;
		authTemplate?: string;
		authEncoding?: "base64";
	},
}));
const orgId = "11111111-1111-4111-8111-111111111111";
const tediId = "22222222-2222-4222-8222-222222222222";
const appId = "33333333-3333-4333-8333-333333333333";
const installationId = "44444444-4444-4444-8444-444444444444";
const providerOrg = "55555555-5555-4555-8555-555555555555";
const audience = "https://api.example.com";
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: async () => ({
		id: orgId,
		descopeTenantId: "org_customer",
	}),
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTediByIdForOrganization: async () => ({
		id: tediId,
		organizationId: orgId,
		status: "active",
	}),
}));
vi.mock("@tedix/db/queries/app-records", () => ({
	getAppById: async () => ({ id: appId, organizationId: providerOrg }),
	getAppMetadataJson: () => ({
		mcpConfig: {
			embeddedHostDelegation: { audience },
			openApiSync: {
				connectionProviderId: "source-provider",
				authScopes: ["orders.read"],
				...state.sourceAuth,
			},
		},
	}),
}));
vi.mock("@tedix/db/queries/provider-installations", () => ({
	getProviderInstallationById: async () => ({
		id: installationId,
		status: state.paused ? "paused" : "active",
		customerOrganizationId: orgId,
		providerOrganizationId: providerOrg,
		primaryTediId: tediId,
		providerAppId: appId,
		externalTenantId: "8042",
		allowedOrigin: "https://host.example.com",
		hostTenantNamespace: "provider",
	}),
}));

async function token(
	overrides: Partial<Parameters<typeof issueGatewayBrowserToken>[0]> = {},
) {
	return issueGatewayBrowserToken({
		secret: "test-secret",
		subject: "host:42",
		expiresAt: Math.floor(Date.now() / 1000) + 60,
		tediId,
		tenantId: "org_customer",
		hostUserId: "42",
		hostOrganizationId: "8042",
		hostTenantNamespace: "provider",
		allowedOrigin: "https://host.example.com",
		providerAppId: appId,
		providerInstallationId: installationId,
		embeddedAssistantCallables: ["provider.read_record"],
		hostDelegation: {
			token: "opaque.provider.assertion",
			audience,
			expiresAt: Math.floor(Date.now() / 1000) + 60,
		},
		...overrides,
	});
}
function client(overrides: Partial<BaseContext> = {}) {
	return createRouterClient(
		{ resolve: resolveEmbeddedHostDelegationProcedure },
		{
			context: {
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": orgId,
					"X-Tedix-Tedi-Id": tediId,
				}),
				authType: "service-binding",
				organizationId: orgId,
				tediId,
				db: {},
				env: { SECRETS_MASTER_KEY: "test-secret" },
				...overrides,
			} as BaseContext,
		},
	);
}
const input = {
	tediId,
	organizationId: orgId,
	sourceAppId: appId,
	callable: "provider.read_record",
	audience,
};
beforeEach(() => {
	state.paused = false;
	state.registryMissing = false;
	state.sourceAuth = {};
});
describe("provider delegation resolver", () => {
	it("returns only provider assertion for verified current installation", async () => {
		const result = await client().resolve({ ...input, token: await token() });
		expect(result).toMatchObject({
			token: "opaque.provider.assertion",
			audience,
			providerOrganizationId: providerOrg,
		});
	});
	it("uses source OpenAPI transport settings without a global provider template", async () => {
		state.registryMissing = true;
		state.sourceAuth = {
			authHeader: "Authorization",
			authTemplate: "{token}",
			authEncoding: "base64",
		};
		expect(
			await client().resolve({ ...input, token: await token() }),
		).toMatchObject({
			connectionProviderId: "source-provider",
			authHeader: "Authorization",
			authTemplate: "{token}",
			authEncoding: "base64",
		});
	});
	it("rejects incomplete explicit source auth instead of using another template", async () => {
		state.sourceAuth = { authHeader: "Authorization" };
		await expect(
			client().resolve({ ...input, token: await token() }),
		).rejects.toThrow();
	});
	it.each([
		{ callable: "provider.write_record" },
		{ callable: "other.read_record" },
		{ audience: "https://other.example.com" },
	])("rejects changed callable or audience %j", async (override) => {
		await expect(
			client().resolve({ ...input, ...override, token: await token() }),
		).rejects.toThrow();
	});
	it("rejects forged, expired, wrong worker, tenant, source and host company proofs", async () => {
		for (const overrides of [
			{ secret: "forged" },
			{
				expiresAt: Math.floor(Date.now() / 1000) - 1,
				hostDelegation: undefined,
			},
			{ tediId: appId },
			{ tenantId: "org_other" },
			{ providerAppId: tediId },
			{ hostOrganizationId: "1" },
		]) {
			await expect(
				client().resolve({ ...input, token: await token(overrides) }),
			).rejects.toThrow();
		}
	});
	it("denies paused installation and non-service or foreign-org access", async () => {
		const proof = await token();
		state.paused = true;
		await expect(
			client().resolve({ ...input, token: proof }),
		).rejects.toThrow();
		state.paused = false;
		await expect(
			client({ authType: "apikey", headers: new Headers() }).resolve({
				...input,
				token: proof,
			}),
		).rejects.toThrow();
		await expect(
			client({
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Org-Id": providerOrg,
					"X-Tedix-Tedi-Id": tediId,
				}),
			}).resolve({
				...input,
				token: proof,
			}),
		).rejects.toThrow();
	});
});
