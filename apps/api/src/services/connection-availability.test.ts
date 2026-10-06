import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	fetchConnectionToken,
	fetchTenantConnectionToken,
} from "@tedix/auth/connections";
import { resolveConnectionAvailability } from "./connection-availability";

vi.mock("@tedix/auth/client", () => ({ getManagementClient: () => ({}) }));
vi.mock("@tedix/auth/connections", () => ({
	fetchConnectionToken: vi.fn(),
	fetchTenantConnectionToken: vi.fn(),
	fetchConnectionTokenByScopes: vi.fn(),
	fetchTenantConnectionTokenByScopes: vi.fn(),
}));
vi.mock("@tedix/db/queries/connection-providers", () => ({
	getConnectionProviderById: async () => ({ descopeAppId: "provider" }),
}));
vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationDescopeTenantId: async () => "tenant",
}));
const input = {
	db: {} as never,
	env: { DESCOPE_MANAGEMENT_KEY: "test" } as never,
	organizationId: "org",
	ownerUserId: "owner",
	providerId: "provider",
	tokenScope: "either" as const,
	scopes: [],
};
afterEach(() => vi.resetAllMocks());
describe("connection availability during partial provider failure", () => {
	it.each([true, false])(
		"keeps a valid authorized fallback (tenant failure=%s)",
		async (tenantFails) => {
			vi.mocked(fetchTenantConnectionToken)[
				tenantFails ? "mockRejectedValue" : "mockResolvedValue"
			](tenantFails ? Error("lookup unavailable") : { accessToken: "opaque" });
			vi.mocked(fetchConnectionToken)[
				tenantFails ? "mockResolvedValue" : "mockRejectedValue"
			](tenantFails ? { accessToken: "opaque" } : Error("lookup unavailable"));
			expect(await resolveConnectionAvailability(input)).toMatchObject({
				connected: true,
				cause: "connected",
			});
		},
	);
	it("does not label a failed lookup plus absent fallback as missing", async () => {
		vi.mocked(fetchTenantConnectionToken).mockRejectedValue(
			Error("lookup unavailable"),
		);
		vi.mocked(fetchConnectionToken).mockResolvedValue(null);
		expect(await resolveConnectionAvailability(input)).toMatchObject({
			connected: false,
			cause: "verification_failed",
		});
	});
	it("keeps truly absent credentials repairable through consent", async () => {
		vi.mocked(fetchTenantConnectionToken).mockResolvedValue(null);
		vi.mocked(fetchConnectionToken).mockResolvedValue(null);
		expect(await resolveConnectionAvailability(input)).toMatchObject({
			connected: false,
			cause: "no_token",
		});
	});
});
